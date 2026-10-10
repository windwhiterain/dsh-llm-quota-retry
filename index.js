/**
 * Long-term quota recovery for the agent loop's failed-request extension point.
 *
 * A model request that fails because the account is out of allowance keeps its
 * open step alive with one further attempt per configured interval — one hour
 * by default, without an attempt limit. That covers the canonical quota code
 * and an `AUTH` or `RATE_LIMIT` failure whose text names a spent usage limit,
 * because a provider that meters a rolling window reports exhaustion as a 403
 * permission error and a Token Plan provider reports it as a 429. Every other
 * failure delegates unchanged. Earlier recovery policies keep their own
 * behavior, so compose this row after `@deepseek-ai/dsh-llm-retry` and its
 * normal-mode retries for eligible codes run first, delegating here only once
 * its budget is spent.
 *
 * Which listener of that extension point runs first is not something a row
 * order decides — plugins register as their services appear, and a reload moves
 * a listener to the end — so a provider named in `nativeRetryFirstProviders`
 * does not depend on it. Such a provider meters ordinary throttling as a spent
 * allowance, and this plugin then runs that provider's own native schedule
 * itself: the same bounded exponential backoff, the same attempt budget, taken
 * from the resolved policy the failed request carries, and only when the native
 * policy has not already spent this step's budget on its own.
 *
 * Long-term retry is per Session and on by default, so an exhausted allowance
 * is waited out without a per-Session opt-in. The switch is durable
 * (`llm_quota_retry` storage domain), written through `/quota-retry`, and
 * published to the Web composer as the `quotaRetry` Session projection. A
 * forked or delegated Session takes its nearest ancestor's explicit setting
 * once, as a snapshot.
 *
 * The same switch covers the response to an exhausted allowance as a whole.
 * Before waiting out an interval, this plugin tries to move the Session to
 * another route of its *pool* — a named, ordered list of interchangeable
 * provider/model pairs — and retries at once when it can. Which route that is
 * comes from balance scripts (`balances`: one command per provider printing one
 * JSON object on stdout) and from the providers that reported exhaustion
 * themselves, so a deployment whose providers publish no balance endpoint still
 * fails over rather than waiting an hour. A Session with the switch off is not
 * moved. See the README's "Route pools and balance sources".
 *
 * Which pool governs a Session is a setting of its own, in the same record and
 * with the same inheritance: written through `/quota-pool` or the composer chip
 * beside the switch, or by a delegation plugin that created the Session from a
 * pooled template. A Session that states none follows the route it is on — a
 * route exactly one pool holds names that pool — so an ordinary Session whose
 * model is pooled fails over without being told to, and `off` opts out of route
 * moves entirely. When one has to be chosen, the Session records it as
 * `model/selection`, the event the model picker itself writes, so the Client
 * shows the route in use; the deployment default for new Sessions is never
 * changed by a failover.
 *
 * Each Session's live retry state is readable through `ctx.llmQuotaRetry` —
 * along with `pickRoute` (choose a route for a Session that does not exist yet),
 * `setPool` (put a Session under a pool's care), `poolOf`, and `report` — and the
 * retry is announced through `llm-quota-retry/entered`,
 * `llm-quota-retry/failover`, and `llm-quota-retry/left`. That state is
 * in-memory and lives only as long as the entry and the readings: unloading or
 * restarting the host drops a pending wait together with its entry.
 *
 * This plugin imports no Harness package, so its bundle needs no dependencies
 * and the Session and Agent values it handles stay opaque.
 *
 * @module dsh-llm-quota-retry
 */

import {
  QuotaRetryLedger,
  cancellableDelay,
  effectiveEnabled,
  isExhaustedAllowanceFailure,
  isSuccessfulResponse,
  nativeQuickDelayMs,
  normalizeSettingRecord,
  ownedSettingOf,
  parsePoolCommand,
  parseRetryCommand,
  poolSettingOf,
  poolSourceOf,
  reservedPoolNames,
  RESERVED_POOL_NAMES,
  resolveInheritedSetting,
  resolvePolicy,
  settingSource,
} from './lib/policy.js'
import { ROUTE_CONFIG_KEYS, RouteState, resolveRoutes } from './lib/routes.js'
import { createBalanceRegistry } from './lib/balance.js'
import { collectProviders, createProviderCheck } from './lib/providers.js'

export const name = 'llm-quota-retry'

/** Storage domain owning this plugin's durable per-Session settings. */
const DOMAIN_NAME = 'llm_quota_retry'

/** Table holding one record per Session that owns a setting. */
const DOMAIN_TABLE = 'sessions'

/** Session projection key the Web composer reads the switch from. */
const PROJECTION_KEY = 'quotaRetry'

/** Slash command both the composer chip and a typed line write through. */
const COMMAND_NAME = 'quota-retry'

/** Slash command choosing this Session's route pool. */
const POOL_COMMAND_NAME = 'quota-pool'

/** Slash command reporting the configured route pools and their readings. */
const ROUTE_COMMAND_NAME = 'quota-routes'

/**
 * The storage and projection facilities call only `parse` on their schemas, so
 * record validation belongs to {@link normalizeSettingRecord}.
 */
const PASSTHROUGH_SCHEMA = { parse: value => value }

/**
 * Install quota-triggered long-term request recovery.
 * @param ctx - plugin context that owns the listeners, the published service,
 *   the durable settings, and the active waits.
 * @param config - row config: `longTermDelayMs` sets the interval between
 *   attempts, `defaultEnabled` sets the switch a Session starts from,
 *   `nativeRetryFirstProviders` names the providers whose exhausted allowance
 *   runs the native retry schedule first, `balances` describes how to read each
 *   provider's remaining allowance, and `pools` names the ordered route lists a
 *   Session may be moved between. `failOpen` decides what a route nothing
 *   reported on means, and `exhaustedCooldownMs` how long a provider stays
 *   marked after it reported exhaustion. Unknown keys and invalid values throw
 *   at activation.
 */
export function apply(ctx, config = {}) {
  const policy = resolvePolicy(config, ROUTE_CONFIG_KEYS)
  const routes = resolveRoutes(config)
  /** Every configured pool name, in configured order, as the chips list them. */
  const poolNames = Object.freeze(Object.keys(routes.pools))
  // A pool named after a word the command answers itself could never be selected,
  // and the composer menu reserves one option id of its own, so this is a
  // configuration error rather than a silently unreachable pool.
  const reserved = reservedPoolNames(poolNames)
  if (reserved.length > 0) {
    throw new Error(
      `llm-quota-retry: pool ${reserved.length === 1 ? 'name' : 'names'} `
      + `${reserved.map(name => `"${name}"`).join(', ')} cannot be used; /quota-pool answers `
      + `${RESERVED_POOL_NAMES.join(', ')} itself`,
    )
  }
  const routeState = new RouteState(routes)
  const ledger = new QuotaRetryLedger()
  const lifetime = new AbortController()
  const active = new Set()
  const balances = createBalanceRegistry({
    getSubprocess: () => ctx.get('subprocess'),
    getCredentials: () => ctx.get('credentials'),
    routes,
    state: routeState,
    logger: ctx.logger,
    lifetime,
  })
  // A route's provider reaches a model request as this plugin's own
  // `model/selection`, so a name no adapter serves is a configuration defect worth
  // naming rather than a `NO_ADAPTER` worth debugging at the request. Composition
  // order decides when each adapter appears and nothing announces that the
  // composition has finished, so this follows the announcements and the first
  // routing decision instead of deciding once here.
  const providerCheck = createProviderCheck({
    ...collectProviders(routes),
    resolveLlm: () => ctx.get('llm'),
    logger: ctx.logger,
  })
  const disposeAdaptersUpdated = ctx.on('llm/adapters-updated', () => { providerCheck.observe() })
  /** Session id -> the route its last request used, for failover and the chip. */
  const usedRoutes = new Map()
  /**
   * Sessions that were just put in a pool, so their next request moves into it
   * even when the model they are on belongs to no pool. A pool change is a
   * choice, and a choice applies at once.
   */
  const pendingChoices = new WeakSet()
  /** Session id -> the Session's own record, the fold and command write path. */
  const records = new Map()
  /** Session projection state -> its client value, for a stable wire reference. */
  const views = new Map()
  /** Session -> the step whose native retry budget `@deepseek-ai/dsh-llm-retry` spent. */
  const nativeSpent = new WeakMap()
  let domain = null
  /** Settles once the storage domain is open or has failed; null while unavailable. */
  let storageOpening = null

  ctx.provide('llmQuotaRetry', Object.freeze({
    isRetrying: session => ledger.isRetrying(session),
    stateOf: session => ledger.stateOf(session),
    pickRoute: poolName => pickRoute(poolName),
    setPool: (session, poolName) => setPool(session, poolName),
    poolOf: session => effectivePoolName(session.id),
    report: () => routeState.report(Date.now()),
  }))

  /**
   * Choose the route a new Session should start on, refreshing stale readings
   * first.
   *
   * This is the delegation-time decision, so it may wait for a script; a
   * model-request decision never does. An unknown pool answers `undefined`,
   * because that is a configuration error at the caller rather than a route
   * choice, and the caller reports it as one.
   *
   * @param poolName - the pool to choose from.
   * @returns the chosen route, or undefined when no pool by that name exists.
   */
  async function pickRoute(poolName) {
    const pool = routes.pools[poolName]
    if (pool === undefined) return undefined
    providerCheck.assertRoutable(pool)
    // Only the pool's own providers are probed: a route a pool cannot use is not
    // worth a round trip before a delegation.
    await balances.refreshStale({ wait: true, providers: pool.routes.map(route => route.provider) })
    const chosen = routeState.pick(poolName, Date.now())
    ctx.logger.info(
      `llm-quota-retry: pool "${poolName}" answers ${chosen.provider}/${chosen.model}`,
    )
    return chosen
  }

  /**
   * Put a Session under one pool's care, or take it out of every pool.
   *
   * This is the one write path for the pool setting: the `/quota-pool` command
   * and the composer chip go through it, and so does a delegation plugin that
   * creates a child from a pooled template. The choice applies to the Session's
   * next request, where a live Agent exists to record it — see the request hook.
   *
   * @param session - the Session to put in the pool.
   * @param poolName - the pool that governs it, or `null` to opt out of route
   *   moves entirely.
   * @returns whether the pool exists; an unknown name changes nothing.
   */
  function setPool(session, poolName) {
    if (poolName !== null && routes.pools[poolName] === undefined) return false
    applyInheritance(session.id, session.header?.parentSession ?? null)
    const record = records.get(session.id) ?? { enabled: null }
    writeRecord(session.id, { ...record, pool: poolName })
    pendingChoices.add(session)
    return true
  }

  /**
   * The pool that governs one Session right now, named the way the chip shows it:
   * the one the Session states, or the one its route belongs to when nobody
   * stated one.
   * @param sessionId - the Session to name.
   * @returns the pool name, or undefined when no pool governs this Session.
   */
  function effectivePoolName(sessionId) {
    const setting = poolSettingOf(records.get(sessionId))
    if (setting.explicit) return setting.name ?? undefined
    const route = usedRoutes.get(sessionId)
    return route === undefined ? undefined : routeState.poolOfRoute(route.provider, route.model)?.name
  }

  /**
   * The pool that governs one Session's use of one route.
   *
   * A stated pool wins while the Session is still on one of its routes; a route
   * the Session moved to by itself (the user's model picker) belongs to no pool
   * as far as this Session is concerned, so its choice is left alone. Without a
   * stated pool, a route exactly one pool holds names that pool.
   *
   * @param session - the Session making the request.
   * @param route - the route the request would use.
   * @returns the pool name, or undefined when this Session is not pooled.
   */
  function poolFor(session, route) {
    const setting = poolSettingOf(records.get(session.id))
    if (setting.explicit) {
      if (setting.name === null) return undefined
      const pool = routes.pools[setting.name]
      const member = pool?.routes.some(entry => entry.provider === route.provider && entry.model === route.model)
      return member === true ? setting.name : undefined
    }
    return routeState.poolOfRoute(route.provider, route.model)?.name
  }

  /**
   * Record the route a Session is about to use, on the Session itself when it can
   * be recorded there.
   *
   * The event is `model/selection` — the one the model picker appends — so the
   * Client's picker shows the route a pool chose instead of the model the Session
   * was created with. The deployment default is deliberately untouched: a quota
   * failover must not change the model new Sessions start from.
   *
   * @param session - the Session whose route this is.
   * @param route - the route it will use.
   */
  function applyRoute(session, route) {
    usedRoutes.set(session.id, { provider: route.provider, model: route.model })
    if (typeof session.append !== 'function') return
    session.append('model/selection', {
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    })
  }

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  /** The Session service, read lazily so the plugin works without it. */
  function sessionsService() {
    return ctx.get('sessions')
  }

  /**
   * Give a forked or delegated Session its nearest ancestor's explicit
   * setting once, as a snapshot. A Session that already owns a record has
   * spent its inheritance, which is what keeps `default` from re-inheriting.
   * @param sessionId - the inheriting Session.
   * @param parentId - its direct parent, absent for a top-level Session.
   */
  function applyInheritance(sessionId, parentId) {
    if (parentId === null || parentId === undefined) return
    if (records.has(sessionId)) return
    const found = resolveInheritedSetting(
      parentId,
      id => sessionsService()?.get(id)?.header?.parentSession ?? null,
      id => ownedSettingOf(records.get(id)),
    )
    if (found === null) return
    writeRecord(sessionId, { ...found.owned, inheritedFrom: found.fromId })
  }

  /**
   * Write one Session's record, durably when the domain is open; an absent or
   * failed domain degrades to a process-local value rather than failing the
   * switch.
   * @param sessionId - the Session the record belongs to.
   * @param record - the record to store.
   */
  function writeRecord(sessionId, record) {
    records.set(sessionId, record)
    void persistRecord(sessionId, record)
  }

  /**
   * Persist one record, waiting for the domain to finish opening first so a
   * setting written during activation is not dropped.
   * @param sessionId - the Session the record belongs to.
   * @param record - the record to store.
   */
  async function persistRecord(sessionId, record) {
    const ready = storageOpening
    if (ready !== null) await ready
    const open = domain
    if (open === null) return
    await open.table(DOMAIN_TABLE).put(sessionId, { ...record, updatedAt: Date.now() })
  }

  /**
   * The effective switch for one Session, resolving inheritance first.
   * @param session - Session whose setting is read.
   * @returns whether long-term retry is enabled for it.
   */
  function enabledForSession(session) {
    applyInheritance(session.id, session.header?.parentSession ?? null)
    return effectiveEnabled(records.get(session.id), policy.defaultEnabled)
  }

  /**
   * End one Session's entry and announce it.
   * @param session - Session whose entry ends.
   * @param reason - why the entry ended.
   */
  function endEntry(session, reason) {
    const left = ledger.leave(session)
    if (left === undefined) return
    const leftAt = Date.now()
    ctx.emit('llm-quota-retry/left', {
      session,
      reason,
      leftAt,
      durationMs: leftAt - left.enteredAt,
      provider: left.provider,
      turn: left.turn,
      step: left.step,
      enteredAt: left.enteredAt,
      attempts: left.attempts,
    })
  }

  // Model-request success is the only evidence that the account's quota is
  // usable again, so it is the only automatic transition that ends an entry.
  // A native retry is read here as well, because it is the only evidence of
  // whether the provider's own policy already spent this step's retries — the
  // one case in which this plugin must not spend another wait of its own.
  const disposeSuccessListener = ctx.on('session/event', (session, event) => {
    if (event.type === 'llm/retry') {
      noteNativeRetry(session, event.data)
      return
    }
    if (!ledger.isRetrying(session) || !isSuccessfulResponse(event)) return
    endEntry(session, 'recovered')
  })

  // A request is proposed as this Session's route, and this is where a pooled
  // Session is moved into its pool's choice or off a route that is out of
  // allowance. The decision reads cached readings and marks only: it starts no
  // script and waits for nothing, because a model request must never be held
  // behind a balance probe. A reading below the route's own threshold does not
  // move an open Session — that threshold decides which route a Session starts
  // on, not whether it is interrupted.
  const disposeRequest = ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    const session = agent.session
    const route = { provider: resolved.provider, model: resolved.model }
    const choosing = pendingChoices.delete(session)
    if (!enabledForSession(session)) {
      usedRoutes.set(session.id, route)
      return resolved
    }
    // A Session just put in a pool is moved into it even when the model it is on
    // belongs to no pool: choosing a pool is choosing to leave that model behind.
    const stated = poolSettingOf(records.get(session.id))
    const poolName = choosing && stated.explicit && stated.name !== null
      ? stated.name
      : poolFor(session, route)
    if (poolName === undefined) {
      usedRoutes.set(session.id, route)
      return resolved
    }
    const now = Date.now()
    const chosen = choosing
      ? routeState.pick(poolName, now)
      : routeState.replacementFor(poolName, route, now)
    if (chosen === undefined) {
      usedRoutes.set(session.id, route)
      return resolved
    }
    const moved = chosen.provider !== route.provider || chosen.model !== route.model
    if (moved) {
      ctx.logger.info(
        `llm-quota-retry: session ${session.id} moves from ${route.provider}/${route.model} `
        + `to ${chosen.provider}/${chosen.model} (pool "${poolName}")`,
      )
    }
    applyRoute(session, chosen)
    if (!moved) return resolved
    return {
      ...resolved,
      provider: chosen.provider,
      model: chosen.model,
      ...chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort },
    }
  })

  /**
   * The route a pooled Session can move to right now, for a request that just
   * failed an exhausted allowance.
   * @param session - the Session whose request failed.
   * @param now - epoch milliseconds of the failure.
   * @returns the replacement route and its pool, or undefined when this Session
   *   is not pooled or no route of its pool can answer.
   */
  function failoverFor(session, now) {
    const used = usedRoutes.get(session.id)
    if (used === undefined) return undefined
    const poolName = poolFor(session, used)
    if (poolName === undefined) return undefined
    const route = routeState.replacementFor(poolName, used, now)
    return route === undefined ? undefined : { pool: poolName, route }
  }

  /**
   * Remember that the provider's own retry policy spent its whole budget on one
   * step. An unbounded `always` policy declares no `maxRetries`, so only the
   * last retry of a bounded one proves a budget is gone.
   *
   * @param session - the Session the retry ran for.
   * @param data - one `llm/retry` event's data.
   */
  function noteNativeRetry(session, data) {
    if (data.maxRetries === undefined || data.retry < data.maxRetries) return
    nativeSpent.set(session, { turn: data.turn, step: data.step, provider: data.provider })
  }

  /**
   * Whether the native retry policy already spent this step's budget on this
   * provider, which is what happens when this row is composed after
   * `@deepseek-ai/dsh-llm-retry` and that policy lists the failure as eligible.
   * @param session - the Session making the request.
   * @param turn - the failing request's turn.
   * @param step - the failing request's step.
   * @param provider - the failing request's provider.
   * @returns true when no quick wait of this plugin's own is left to spend.
   */
  function nativeBudgetSpent(session, turn, step, provider) {
    const spent = nativeSpent.get(session)
    return spent !== undefined
      && spent.turn === turn && spent.step === step && spent.provider === provider
  }

  /**
   * The short native-style wait one failed request deserves before this plugin
   * treats it as an outage, or undefined when the native policy owns it.
   *
   * Only a provider the row names is eligible, and only while its own policy
   * holds a bounded schedule this plugin can mirror: no policy and unbounded
   * `always` mode leave the failure to this plugin's hourly wait, and a budget
   * the native policy already spent leaves the step to it.
   *
   * @param session - the Session whose request failed.
   * @param request - the failing request's turn, step, provider, failure, and
   *   resolved retry policy.
   * @returns the attempt and its wait, or undefined when none applies.
   */
  function quickRetryFor(session, { turn, step, provider, failure, retryPolicy }) {
    if (!policy.nativeRetryFirstProviders.includes(provider)) return undefined
    if (nativeBudgetSpent(session, turn, step, provider)) return undefined
    const maxAttempts = retryPolicy?.mode === 'normal' ? retryPolicy.maxRetries : 0
    return ledger.quickAttempt(
      session,
      turn,
      step,
      maxAttempts,
      attempt => nativeQuickDelayMs(retryPolicy, failure, attempt),
    )
  }

  async function recover({ agent, turn, step, provider, failure, retryPolicy, signal }) {
    const session = agent.session
    if (signal.aborted) return
    if (!enabledForSession(session)) return
    // A provider the row names meters its own rate limit as a spent allowance,
    // so its own short schedule runs first: waiting out an hour for a limit that
    // clears in seconds is the failure this answers, and a provider that is only
    // throttled must not be marked out of allowance or moved off either.
    const quick = quickRetryFor(session, { turn, step, provider, failure, retryPolicy })
    if (quick !== undefined) {
      ctx.logger.info(
        `llm-quota-retry: provider "${provider}" returned ${failure.code}; `
        + `native quick retry ${quick.attempt} in ${Math.round(quick.delayMs)}ms`,
      )
      const elapsed = await cancellableDelay(
        quick.delayMs,
        AbortSignal.any([signal, lifetime.signal]),
      )
      if (!elapsed) return
      return { kind: 'retry' }
    }
    const now = Date.now()
    // The provider itself just reported that it has nothing left. That is a
    // stronger fact than any reading, so it decides before a probe does, and the
    // refresh below is how the mark is withdrawn once the provider recovers.
    routeState.noteExhausted(provider, now)
    void balances.refresh(provider)

    const failover = failoverFor(session, now)
    if (failover !== undefined) {
      const used = usedRoutes.get(session.id)
      ctx.emit('llm-quota-retry/failover', {
        session,
        agent,
        failure,
        from: used,
        to: failover.route,
        pool: failover.pool,
        at: now,
      })
      ctx.logger.info(
        `llm-quota-retry: provider "${provider}" returned ${failure.code}; `
        + `retrying on ${failover.route.provider}/${failover.route.model} (pool "${failover.pool}")`,
      )
      // The Session itself records the move, so the model picker shows the route
      // the retry actually uses rather than the one that just refused it.
      applyRoute(session, failover.route)
      return { kind: 'retry' }
    }

    const { created, signal: entrySignal } = ledger.enter(session, { provider, turn, step }, now)
    const state = ledger.schedule(session, now, policy.longTermDelayMs)
    if (state === undefined) return
    if (created) {
      ctx.emit('llm-quota-retry/entered', { session, agent, failure, ...state })
    }
    ctx.logger.info(
      `llm-quota-retry: provider "${provider}" returned ${failure.code}; `
      + `attempt ${state.attempts} in ${policy.longTermDelayMs}ms`,
    )
    const elapsed = await cancellableDelay(
      policy.longTermDelayMs,
      AbortSignal.any([signal, lifetime.signal, entrySignal]),
    )
    ledger.settle(session)
    if (!elapsed) return
    return { kind: 'retry' }
  }

  const disposeRequestError = ctx.on('agent/request-error', (payload, next) => {
    if (!isExhaustedAllowanceFailure(payload.failure)) return next()
    // A waterfall may have captured this callback before its registration was
    // removed; lifetime cancellation must keep that stale callback from
    // scheduling a wait after disposal.
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    return track(recover(payload))
  })

  ctx.inject(['storageDomain'], (child) => {
    child.effect(() => {
      let disposed = false
      const opening = child.storageDomain.open({
        name: DOMAIN_NAME,
        version: 1,
        global: { schema: PASSTHROUGH_SCHEMA, initial: { schema: 1 } },
        tables: { [DOMAIN_TABLE]: { valueSchema: PASSTHROUGH_SCHEMA } },
      }).then((opened) => {
        if (disposed) {
          void opened.close()
          return () => {}
        }
        domain = opened
        for (const [sessionId, record] of opened.table(DOMAIN_TABLE).entries()) {
          const normalized = normalizeSettingRecord(record)
          if (normalized !== null) records.set(sessionId, normalized)
        }
        child.logger.info(`llm-quota-retry: ${records.size} session setting(s) restored`)
        return () => {
          domain = null
          storageOpening = null
          return opened.close()
        }
      }).catch((error) => {
        child.logger.warn(
          'llm-quota-retry: session settings cannot be persisted '
          + `(${error instanceof Error ? error.message : String(error)}); they stay in memory for this process`,
        )
        return () => {}
      })
      storageOpening = opening
      return async () => {
        disposed = true
        const close = await opening
        await close()
      }
    })
  })

  ctx.inject(['sessionProjections'], (child) => {
    child.effect(() => child.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: PASSTHROUGH_SCHEMA,
      init: (header) => {
        // The composer must show an inherited setting before the Session's
        // first request resolves one, so inheritance applies at first
        // observation.
        applyInheritance(header.id, header.parentSession ?? null)
        return stateFor(header.id)
      },
      apply: state => stateFor(state.sessionId, state),
      wire: {
        viewSchema: PASSTHROUGH_SCHEMA,
        view: state => viewOf(state),
      },
    }))
  })

  ctx.inject(['commands'], (child) => {
    child.effect(() => child.commands.register({
      name: COMMAND_NAME,
      description: 'Turn this session\'s long-term retry through an exhausted quota on or off',
      input: { hint: '<on|off|default|status>' },
      handler: ({ agent, rawInput }) => runCommand(agent, rawInput ?? ''),
    }))
    child.effect(() => child.commands.register({
      name: POOL_COMMAND_NAME,
      description: 'Choose the route pool this session falls back to when a provider is out of allowance',
      input: { hint: '<pool|off|default|status>' },
      handler: ({ agent, rawInput }) => runPoolCommand(agent, rawInput ?? ''),
    }))
    child.effect(() => child.commands.register({
      name: ROUTE_COMMAND_NAME,
      description: 'Report the configured route pools and what each route\'s balance script last reported',
      input: { hint: '[pool]' },
      handler: ({ rawInput }) => ({ kind: 'success', text: reportRoutes(String(rawInput ?? '').trim()) }),
    }))
  })

  /**
   * The human-readable state of the route pools, as one block of lines.
   * @param only - a pool name to narrow the report to; empty for every pool.
   * @returns the report text.
   */
  function reportRoutes(only) {
    const report = routeState.report(Date.now())
    const shown = only === '' ? report : report.filter(pool => pool.name === only)
    const misconfigured = providerCheck.describe()
    const blocks = misconfigured === undefined ? [] : [misconfigured, '']
    if (shown.length === 0) {
      const names = report.map(pool => pool.name)
      blocks.push(only === ''
        ? 'no route pools are configured'
        : `no pool named "${only}"; configured pools: ${names.length === 0 ? '(none)' : names.join(', ')}`)
      return blocks.join('\n')
    }
    blocks.push(...shown.map((pool) => {
      const lines = pool.routes.map((route) => {
        const reading = route.reading
        const balance = reading === undefined
          ? 'no reading'
          : `${reading.remaining}${reading.resetsAt === undefined ? '' : `, resets ${reading.resetsAt}`}`
            + `${reading.error === undefined ? '' : ` (${reading.error})`}`
        const mark = route.exhaustedAt === undefined
          ? ''
          : ` [exhausted ${new Date(route.exhaustedAt).toISOString()}]`
        return `  ${route.usable ? 'ok ' : 'no '} ${route.provider}/${route.model} — ${balance}${mark}`
      })
      return `pool "${pool.name}":\n${lines.join('\n')}`
    }))
    return blocks.join('\n')
  }

  /**
   * Fold one Session's switch, pool, and their origins into the projection state,
   * returning the previous object when nothing observable changed (the registry's
   * change gate compares references).
   *
   * The pool reported is the *effective* one: the name the Session states, or the
   * one the route it is on belongs to. `undefined` when no pool governs it.
   *
   * @param sessionId - the Session being projected.
   * @param previous - the state this Session was last folded into.
   * @returns the next state.
   */
  function stateFor(sessionId, previous) {
    const record = records.get(sessionId)
    const enabled = effectiveEnabled(record, policy.defaultEnabled)
    const source = settingSource(record, policy.defaultEnabled)
    const poolSource = poolSourceOf(record)
    const setting = poolSettingOf(record)
    const pool = setting.explicit
      ? setting.name
      : effectivePoolName(sessionId)
    if (previous !== undefined
      && previous.enabled === enabled
      && previous.source === source
      && previous.pool === pool
      && previous.poolSource === poolSource) return previous
    return { sessionId, enabled, source, pool, poolSource }
  }

  /**
   * Identity-stable client value for one projection state, so an unchanged
   * setting suppresses publication.
   * @param state - the Session's current projection state.
   * @returns the wire value the composer chips read.
   */
  function viewOf(state) {
    const cached = views.get(state.sessionId)
    if (cached !== undefined && cached.state === state && cached.pools === poolNames) return cached.value
    const value = {
      enabled: state.enabled,
      defaultEnabled: policy.defaultEnabled,
      source: state.source,
      pool: state.pool ?? null,
      poolSource: state.poolSource,
      pools: poolNames,
    }
    views.set(state.sessionId, { state, pools: poolNames, value })
    return value
  }

  /**
   * Apply one `/quota-retry` invocation.
   * @param agent - the Agent the command runs for.
   * @param rawInput - the text after the command name.
   * @returns the command outcome.
   */
  async function runCommand(agent, rawInput) {
    const session = agent.session
    const parsed = parseRetryCommand(rawInput)
    switch (parsed.kind) {
      case 'report':
        return { kind: 'success', text: report(session) }
      case 'set':
        applyInheritance(session.id, session.header?.parentSession ?? null)
        writeRecord(session.id, { enabled: parsed.enabled })
        applySwitch(session)
        return {
          kind: 'success',
          text: `long-term quota retry ${parsed.enabled ? 'on' : 'off'} for this session`,
        }
      case 'default':
        applyInheritance(session.id, session.header?.parentSession ?? null)
        writeRecord(session.id, { enabled: null })
        applySwitch(session)
        return {
          kind: 'success',
          text: 'long-term quota retry back to the deployment default '
            + `(${policy.defaultEnabled ? 'on' : 'off'})`,
        }
      case 'invalid':
        return { kind: 'error', text: parsed.reason }
      default:
        return { kind: 'error', text: 'quota-retry: unsupported request' }
    }
  }

  /**
   * Apply one `/quota-pool` invocation.
   * @param agent - the Agent the command runs for.
   * @param rawInput - the text after the command name.
   * @returns the command outcome.
   */
  async function runPoolCommand(agent, rawInput) {
    const session = agent.session
    const parsed = parsePoolCommand(rawInput, poolNames)
    switch (parsed.kind) {
      case 'report':
        return { kind: 'success', text: reportPool(session) }
      case 'set': {
        // The status line names what the pool answers now, so a person choosing one
        // sees which route the next request takes. This is a user action, so it may
        // wait for the pool's own providers to be read — and it runs before
        // `setPool`, so a pool that cannot route leaves no half-applied choice
        // behind.
        const chosen = await pickRoute(parsed.pool)
        setPool(session, parsed.pool)
        return {
          kind: 'success',
          text: `route pool "${parsed.pool}" governs this session; its next request uses `
            + `${chosen.provider}/${chosen.model}`,
        }
      }
      case 'off':
        setPool(session, null)
        return {
          kind: 'success',
          text: 'route moves are off for this session: an exhausted allowance is waited out '
            + 'without changing provider',
        }
      case 'default': {
        applyInheritance(session.id, session.header?.parentSession ?? null)
        const record = records.get(session.id) ?? { enabled: null }
        const { pool: _dropped, ...rest } = record
        writeRecord(session.id, rest)
        return {
          kind: 'success',
          text: `this session states no pool again; ${reportPool(session)}`,
        }
      }
      case 'invalid':
        return { kind: 'error', text: parsed.reason }
      default:
        return { kind: 'error', text: 'quota-pool: unsupported request' }
    }
  }

  /**
   * The human-readable route pool for one Session.
   * @param session - the Session to report.
   * @returns one line naming the effective pool, where the setting came from, and
   *   the route the Session is on.
   */
  function reportPool(session) {
    const record = records.get(session.id)
    const source = poolSourceOf(record)
    const pool = effectivePoolName(session.id)
    const route = usedRoutes.get(session.id)
    const origin = source === 'off'
      ? 'route moves are off for this session'
      : source === 'inherited'
        ? `inherited from ${record.inheritedFrom}`
        : source === 'session'
          ? 'stated by this session'
          : pool === undefined
            ? 'no pool governs this session'
            : 'inferred from the route this session is on'
    return `route pool ${pool === undefined ? '(none)' : `"${pool}"`} — ${origin}`
      + `; configured pools: ${poolNames.length === 0 ? '(none)' : poolNames.join(', ')}`
      + `; this session is on ${route === undefined ? 'no request yet' : `${route.provider}/${route.model}`}`
  }

  /**
   * Enforce the switch on an entry that is already open: turning it off ends
   * the entry, which aborts its pending wait instead of leaving a timer to
   * wake an hour later.
   * @param session - the Session whose switch just changed.
   */
  function applySwitch(session) {
    if (enabledForSession(session)) return
    endEntry(session, 'disabled')
  }

  /**
   * The human-readable current setting for one Session.
   * @param session - the Session to report.
   * @returns one line naming the switch, its origin, and any live attempt.
   */
  function report(session) {
    const record = records.get(session.id)
    const source = settingSource(record, policy.defaultEnabled)
    const enabled = effectiveEnabled(record, policy.defaultEnabled)
    const state = ledger.stateOf(session)
    const origin = source === 'inherited'
      ? `inherited from ${record.inheritedFrom}`
      : source === 'default' ? 'deployment default' : 'this session'
    return `long-term quota retry ${enabled ? 'on' : 'off'} (${origin})`
      + `${state === undefined ? '' : ` — waiting since ${new Date(state.enteredAt).toISOString()}, `
        + `${state.attempts} attempt(s)`}`
  }

  ctx.effect(() => async () => {
    disposeSuccessListener()
    disposeRequestError()
    disposeRequest()
    disposeAdaptersUpdated()
    lifetime.abort(new Error('llm-quota-retry plugin disposed'))
    await Promise.allSettled([...active])
    ledger.clear()
  }, 'llm-quota-retry: abort and drain active waits')
}
