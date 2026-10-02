/**
 * The provider names a route configuration names, checked against the LLM
 * adapters the composition actually registered.
 *
 * A pool route's provider is written verbatim into the `model/selection` event
 * this plugin emits, so a name no adapter serves does not fail where it was
 * written: it fails later, on a model request, as the LLM runtime's `NO_ADAPTER`.
 * The same name in `balances` is only a lookup key into this plugin's own
 * readings, so a mismatch there costs a reading rather than a request. Both are
 * reported together, because one typo in one provider name is usually both at
 * once.
 *
 * The check cannot run once during activation. Composition order decides when each
 * adapter registers, and a provider plugin inserted after this row registers its
 * adapter after `apply()` has returned, so a name missing at activation says
 * nothing about whether it will ever arrive. Nothing in the harness announces
 * that the composition has finished, so the check reports at the earliest point
 * that can answer it — the first request to route, or `/quota-routes` — and, on
 * the announcements the composition does make, only for a set two consecutive
 * announcements agree on. Every announcement registers at least one adapter, so
 * such a set means no configured provider is still on its way.
 *
 * @module dsh-llm-quota-retry/providers
 */

/**
 * Where the configuration named each provider.
 * @typedef {object} ProviderNames
 * @property {ReadonlyMap<string, readonly string[]>} sites The config paths that
 *   named each provider, in configured order.
 * @property {ReadonlySet<string>} routeProviders The providers a pool route
 *   names, as opposed to the ones only a balance source names.
 */

/**
 * Collect every provider a resolved route configuration names, and where.
 * @param routes - the resolved route policy from `resolveRoutes`.
 * @returns {@link ProviderNames} for that policy.
 */
export function collectProviders(routes) {
  /** @type {Map<string, string[]>} */
  const sites = new Map()
  const routeProviders = new Set()
  const note = (provider, site) => {
    const known = sites.get(provider)
    if (known === undefined) sites.set(provider, [site])
    else known.push(site)
  }
  for (const pool of Object.values(routes.pools)) {
    pool.routes.forEach((route, index) => {
      routeProviders.add(route.provider)
      note(route.provider, `pools.${pool.name}.routes[${index}]`)
    })
  }
  routes.balances.forEach((balance, index) => note(balance.provider, `balances[${index}]`))
  return {
    sites: new Map([...sites].map(([provider, named]) => [provider, Object.freeze(named)])),
    routeProviders,
  }
}

/**
 * One sentence naming the providers no adapter serves, and every config path that
 * named each. The phrasing is shared by the log line, the thrown refusal, and
 * `/quota-routes`, so a deployment sees one description of the same defect however
 * it is read.
 * @param missing - the provider names, in configured order.
 * @param sites - the config paths that named each provider.
 * @returns the sentence.
 */
function describeMissing(missing, sites) {
  const named = missing.map(name => `"${name}" (named by ${sites.get(name).join(', ')})`).join('; ')
  return `llm-quota-retry: no LLM adapter is registered for ${missing.length === 1 ? 'provider' : 'providers'} `
    + `${named}; a model request on one of them fails with NO_ADAPTER.`
}

/**
 * The running check: which configured providers no adapter serves, reported once
 * per change rather than once per announcement.
 *
 * An adapter is registered by the plugin that owns it and every registration
 * announces itself through `llm/adapters-updated`, which is what lets the check
 * follow the composition rather than guess at it. Only registered adapters count:
 * a provider a directory declares but has not activated yet cannot serve a
 * request, so treating it as known would bless exactly the route that fails.
 *
 * @param sites - the config paths that named each provider.
 * @param routeProviders - the providers a pool route names.
 * @param resolveLlm - reads the LLM runtime service. Absent means the composition
 *   has no LLM service at all, and there is then nothing to check against.
 * @param logger - the host logger the report is written to.
 * @returns the check's operations.
 */
export function createProviderCheck({ sites, routeProviders, resolveLlm, logger }) {
  const names = [...sites.keys()]
  /** The last reported set, as its joined key; undefined until the first report. */
  let reported
  /** The set the last announcement found; undefined until the first one. */
  let announced

  function scan() {
    const llm = resolveLlm()
    if (llm === undefined) return { missing: [], registered: [] }
    const registered = llm.listProviders().map(entry => entry.id)
    const known = new Set(registered)
    return { missing: names.filter(name => !known.has(name)), registered }
  }

  /**
   * The configured providers no adapter serves right now.
   * @returns their names, in configured order.
   */
  function unregistered() {
    return scan().missing
  }

  /**
   * Re-check after a composition announcement, reporting only a set two
   * consecutive announcements agree on.
   * @returns the configured providers no adapter serves, in configured order.
   */
  function observe() {
    const missing = unregistered()
    const key = missing.join(' ')
    const settled = key === announced
    announced = key
    return settled ? verify() : missing
  }

  /**
   * Re-check every configured provider and report a change.
   * @returns the configured providers no adapter serves, in configured order.
   */
  function verify() {
    const { missing, registered } = scan()
    const key = missing.join(' ')
    if (key === reported) return missing
    const first = reported === undefined
    reported = key
    if (missing.length === 0) {
      // A provider plugin composing after this row was never a defect, so its
      // arrival is not news; only a set that shrinks out of a reported one is.
      if (!first) logger.info('llm-quota-retry: every provider this configuration names now has a registered adapter')
      return missing
    }
    const known = [...registered].sort().join(', ')
    logger.error(`${describeMissing(missing, sites)} Registered providers: ${known === '' ? '(none)' : known}`)
    return missing
  }

  /**
   * Refuse a pool whose routes name providers no adapter serves.
   *
   * A balance source naming one is not a refusal: it costs a reading rather than
   * a request, so a deployment whose balance script is misnamed still delegates,
   * and only the report says so.
   *
   * @param pool - the pool a caller asked to route from.
   * @throws when a route of it names a provider no adapter serves.
   */
  function assertRoutable(pool) {
    verify()
    const dead = unregistered().filter(name => routeProviders.has(name))
    if (dead.length === 0) return
    throw new Error(`${describeMissing(dead, sites)} Pool "${pool.name}" names ${dead.join(', ')}.`)
  }

  /**
   * The report `/quota-routes` puts above the pools, so the state a person reads
   * names the same defect the log does.
   * @returns one line naming every misconfigured provider, or undefined when
   *   every configured provider has an adapter.
   */
  function describe() {
    const missing = unregistered()
    return missing.length === 0 ? undefined : describeMissing(missing, sites)
  }

  return { assertRoutable, describe, observe, unregistered, verify }
}