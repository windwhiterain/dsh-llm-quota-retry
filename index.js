/**
 * Long-term quota recovery for the agent loop's failed-request extension point.
 *
 * A model request that fails because the account is out of allowance keeps its
 * open step alive with one further attempt per configured interval — one hour
 * by default, without an attempt limit. That covers the canonical quota code
 * and an `AUTH` failure whose text names a spent usage limit, because a
 * provider that meters a rolling window reports exhaustion as a 403 permission
 * error. Every other failure delegates unchanged. Earlier recovery policies
 * keep their own behavior, so compose this row after
 * `@deepseek-ai/dsh-llm-retry` and its normal-mode retries for eligible codes
 * run first, delegating here only once its budget is spent.
 *
 * Long-term retry is per Session and off by default. The switch is durable
 * (`llm_quota_retry` storage domain), written through `/quota-retry`, and
 * published to the Web composer as the `quotaRetry` Session projection. A
 * forked or delegated Session takes its nearest ancestor's explicit setting
 * once, as a snapshot.
 *
 * Each Session's live retry state is readable through `ctx.llmQuotaRetry` and
 * announced through `llm-quota-retry/entered` and `llm-quota-retry/left`. That
 * state is in-memory and lives only as long as the entry: unloading or
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
  normalizeSettingRecord,
  parseRetryCommand,
  resolveInheritedSetting,
  resolvePolicy,
  settingSource,
} from './lib/policy.js'

export const name = 'llm-quota-retry'

/** Storage domain owning this plugin's durable per-Session settings. */
const DOMAIN_NAME = 'llm_quota_retry'

/** Table holding one record per Session that owns a setting. */
const DOMAIN_TABLE = 'sessions'

/** Session projection key the Web composer reads the switch from. */
const PROJECTION_KEY = 'quotaRetry'

/** Slash command both the composer chip and a typed line write through. */
const COMMAND_NAME = 'quota-retry'

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
 *   attempts and `defaultEnabled` sets the switch a Session starts from.
 *   Unknown keys and invalid values throw at activation.
 */
export function apply(ctx, config = {}) {
  const policy = resolvePolicy(config)
  const ledger = new QuotaRetryLedger()
  const lifetime = new AbortController()
  const active = new Set()
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
  }))

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

  async function recover({ agent, turn, step, provider, failure, signal }) {
    const session = agent.session
    if (signal.aborted) return
    if (!enabledForSession(session)) return
    const now = Date.now()
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
  })

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
    lifetime.abort(new Error('llm-quota-retry plugin disposed'))
    await Promise.allSettled([...active])
    ledger.clear()
  }, 'llm-quota-retry: abort and drain active waits')
}
