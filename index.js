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
 * Each Session's live retry state is readable through `ctx.llmQuotaRetry` —
 * along with `pickRoute` (choose a route for a Session that does not exist yet),
 * `assignPool`, and `report` — and the retry is announced through
 * `llm-quota-retry/entered`, `llm-quota-retry/failover`, and
 * `llm-quota-retry/left`. That state is in-memory and lives only as long as the
 * entry and the readings: unloading or restarting the host drops a pending wait
 * together with its entry.
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
  normalizeSettingRecord,
  parseRetryCommand,
  resolveInheritedSetting,
  resolvePolicy,
  settingSource,
} from './lib/policy.js'
import { ROUTE_CONFIG_KEYS, RouteState, resolveRoutes } from './lib/routes.js'
import { createBalanceRegistry } from './lib/balance.js'

export const name = 'llm-quota-retry'

/** Storage domain owning this plugin's durable per-Session settings. */
const DOMAIN_NAME = 'llm_quota_retry'

/** Table holding one record per Session that owns a setting. */
const DOMAIN_TABLE = 'sessions'

/** Session projection key the Web composer reads the switch from. */
const PROJECTION_KEY = 'quotaRetry'

/** Slash command both the composer chip and a typed line write through. */
const COMMAND_NAME = 'quota-retry'

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
 *   attempts, `defaultEnabled` sets the switch a Session starts from, `balances`
 *   describes how to read each provider's remaining allowance, and `pools` names
 *   the ordered route lists a Session may be moved between. `failOpen` decides
 *   what a route nothing reported on means, and `exhaustedCooldownMs` how long a
 *   provider stays marked after it reported exhaustion. Unknown keys and invalid
 *   values throw at activation.
 */
export function apply(ctx, config = {}) {
  const policy = resolvePolicy(config, ROUTE_CONFIG_KEYS)
  const routes = resolveRoutes(config)
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
  /** Session -> the pool a caller assigned it to, when one did. */
  const assignedPools = new WeakMap()
  /** Session -> the route its last resolved request used. */
  const usedRoutes = new WeakMap()
  /** Session id -> the Session's own record, the fold and command write path. */
  const records = new Map()
  /** Session projection state -> its client value, for a stable wire reference. */
  const views = new Map()
  let domain = null
  /** Settles once the storage domain is open or has failed; null while unavailable. */
  let storageOpening = null

  ctx.provide('llmQuotaRetry', Object.freeze({
    isRetrying: session => ledger.isRetrying(session),
    stateOf: session => ledger.stateOf(session),
    pickRoute: poolName => pickRoute(poolName),
    assignPool: (session, poolName) => assignPool(session, poolName),
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
    if (routes.pools[poolName] === undefined) return undefined
    await balances.refreshStale({ wait: true })
    const chosen = routeState.pick(poolName, Date.now())
    ctx.logger.info(
      `llm-quota-retry: pool "${poolName}" answers ${chosen.provider}/${chosen.model}`,
    )
    return chosen
  }

  /**
   * Put a Session under one pool's care, so a route the pools share is not left
   * to inference.
   * @param session - the Session to assign.
   * @param poolName - the pool that governs it.
   * @returns whether the pool exists; an unknown name assigns nothing.
   */
  function assignPool(session, poolName) {
    if (routes.pools[poolName] === undefined) return false
    assignedPools.set(session, poolName)
    return true
  }

  /**
   * The pool that governs one Session's use of one route.
   *
   * An assigned pool wins while the Session is still on one of its routes; a
   * route the Session moved to by itself (the user's model picker) belongs to no
   * pool as far as this Session is concerned, so its choice is left alone.
   * Without an assignment, a route exactly one pool holds names that pool.
   *
   * @param session - the Session making the request.
   * @param route - the route the request would use.
   * @returns the pool name, or undefined when this Session is not pooled.
   */
  function poolFor(session, route) {
    const assigned = assignedPools.get(session)
    if (assigned !== undefined) {
      const pool = routes.pools[assigned]
      const member = pool?.routes.some(entry => entry.provider === route.provider && entry.model === route.model)
      return member === true ? assigned : undefined
    }
    return routeState.poolOfRoute(route.provider, route.model)?.name
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
      id => records.get(id)?.enabled ?? null,
    )
    if (found === null) return
    writeRecord(sessionId, { enabled: found.value, inheritedFrom: found.fromId })
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
  const disposeSuccessListener = ctx.on('session/event', (session, event) => {
    if (!ledger.isRetrying(session) || !isSuccessfulResponse(event)) return
    endEntry(session, 'recovered')
  })

  // A request is proposed as this Session's route, and this is where a pooled
  // Session is moved off one that cannot answer. The decision reads cached
  // readings and marks only: it starts no script and waits for nothing, because
  // a model request must never be held behind a balance probe.
  const disposeRequest = ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    const session = agent.session
    const route = { provider: resolved.provider, model: resolved.model }
    if (!enabledForSession(session)) {
      usedRoutes.set(session, route)
      return resolved
    }
    const poolName = poolFor(session, route)
    const replacement = poolName === undefined
      ? undefined
      : routeState.replacementFor(poolName, route, Date.now())
    if (replacement === undefined) {
      usedRoutes.set(session, route)
      return resolved
    }
    ctx.logger.info(
      `llm-quota-retry: session ${session.id} moves from ${route.provider}/${route.model} `
      + `to ${replacement.provider}/${replacement.model} (pool "${poolName}")`,
    )
    usedRoutes.set(session, { provider: replacement.provider, model: replacement.model })
    return {
      ...resolved,
      provider: replacement.provider,
      model: replacement.model,
      ...replacement.reasoningEffort === undefined ? {} : { reasoningEffort: replacement.reasoningEffort },
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
    const used = usedRoutes.get(session)
    if (used === undefined) return undefined
    const poolName = poolFor(session, used)
    if (poolName === undefined) return undefined
    const route = routeState.replacementFor(poolName, used, now)
    return route === undefined ? undefined : { pool: poolName, route }
  }

  async function recover({ agent, turn, step, provider, failure, signal }) {
    const session = agent.session
    if (signal.aborted) return
    if (!enabledForSession(session)) return
    const now = Date.now()
    // The provider itself just reported that it has nothing left. That is a
    // stronger fact than any reading, so it decides before a probe does, and the
    // refresh below is how the mark is withdrawn once the provider recovers.
    routeState.noteExhausted(provider, now)
    void balances.refresh(provider)

    const failover = failoverFor(session, now)
    if (failover !== undefined) {
      const used = usedRoutes.get(session)
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
    if (shown.length === 0) {
      const names = report.map(pool => pool.name)
      return only === ''
        ? 'no route pools are configured'
        : `no pool named "${only}"; configured pools: ${names.length === 0 ? '(none)' : names.join(', ')}`
    }
    return shown.map((pool) => {
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
    }).join('\n')
  }

  /**
   * Fold one Session's switch and its origin into the projection state,
   * returning the previous object when nothing observable changed (the
   * registry's change gate compares references).
   * @param sessionId - the Session being projected.
   * @param previous - the state this Session was last folded into.
   * @returns the next state.
   */
  function stateFor(sessionId, previous) {
    const record = records.get(sessionId)
    const enabled = effectiveEnabled(record, policy.defaultEnabled)
    const source = settingSource(record, policy.defaultEnabled)
    if (previous !== undefined && previous.enabled === enabled && previous.source === source) return previous
    return { sessionId, enabled, source }
  }

  /**
   * Identity-stable client value for one projection state, so an unchanged
   * setting suppresses publication.
   * @param state - the Session's current projection state.
   * @returns the wire value the composer chip reads.
   */
  function viewOf(state) {
    const cached = views.get(state.sessionId)
    if (cached !== undefined && cached.state === state) return cached.value
    const value = { enabled: state.enabled, defaultEnabled: policy.defaultEnabled, source: state.source }
    views.set(state.sessionId, { state, value })
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
    lifetime.abort(new Error('llm-quota-retry plugin disposed'))
    await Promise.allSettled([...active])
    ledger.clear()
  }, 'llm-quota-retry: abort and drain active waits')
}
