/**
 * Pure policy for dsh-llm-quota-retry: row-config validation, the cancellable
 * wait, the success detector, per-Session setting resolution, command parsing,
 * and the per-Session retry ledger.
 *
 * This module imports nothing, so the probe drives every decision directly
 * without a Harness context.
 *
 * @module dsh-llm-quota-retry/policy
 */

/**
 * Canonical provider-neutral failure code for an exhausted account quota or
 * balance. A protocol constant owned by `@deepseek-ai/dsh-llm/error`, which
 * every shipped adapter maps its insufficient-balance wording onto.
 */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'

/**
 * Canonical provider-neutral code for a credential the provider rejected. An
 * adapter that tests the bare HTTP status before the body reports a spent
 * rolling allowance as this code, so the text names the spent allowance while
 * the code does not.
 */
export const AUTH_CODE = 'AUTH'

/**
 * Canonical provider-neutral code for a request-rate limit, which a provider
 * that meters a Token Plan also uses to report a spent allowance. Its text is
 * the only thing that separates the two.
 */
const RATE_LIMIT_CODE = 'RATE_LIMIT'

/**
 * English provider wording that names an exhausted allowance rather than a
 * rejected credential or a burst of concurrent requests: an allowance noun
 * preceded by the verb that spent it ("You've reached your 5-hour usage
 * limit"). The gap excludes sentence ends and semicolons, so advice that
 * follows the failure — "; upgrade your plan for more quota" — cannot supply
 * the noun.
 */
const SPENT_ALLOWANCE_EN = new RegExp(
  String.raw`\b(?:reach(?:ed|es)?|hit|exceed(?:ed|s)?|exhaust(?:ed|s)?)\b[^.;\n]{0,40}`
  + String.raw`\b(?:usage[\s_-]+limit|quota|allowance|balance|credits?)\b`,
  'i',
)

/**
 * Chinese provider wording for the same condition: the verb that spent the
 * allowance before its noun ("已达到 Token Plan 用量上限"), or an allowance
 * noun reported as insufficient ("余额不足"). The gap excludes sentence
 * punctuation for the same reason as {@link SPENT_ALLOWANCE_EN}, because a
 * Token Plan failure appends upgrade advice right after the failure.
 */
const SPENT_ALLOWANCE_ZH = new RegExp(
  String.raw`(?:达到|已达|超出|超过|耗尽|用尽|用完)[^。！？：；\n]{0,20}(?:用量上限|额度|配额|余额|积分)`
  + String.raw`|(?:额度|配额|余额|积分)(?:已)?不足`,
)

/**
 * Whether one failed model request is the account being out of allowance for
 * now, and therefore worth waiting out.
 *
 * The canonical quota code needs no wording check. `AUTH` and `RATE_LIMIT` do:
 * a provider that meters a rolling window or a Token Plan reports the spent
 * allowance under a permission or rate-limit class, and its body is the only
 * thing that tells that apart from a credential the provider will keep
 * rejecting or an ordinary burst of concurrent requests.
 *
 * @param failure - the terminal `LlmFailure` carried by the failed request.
 * @returns true for the canonical quota code, or for an `AUTH` or `RATE_LIMIT`
 *   failure whose text names a spent allowance.
 */
export function isExhaustedAllowanceFailure(failure) {
  if (failure.code === QUOTA_EXCEEDED_CODE) return true
  if (failure.code !== AUTH_CODE && failure.code !== RATE_LIMIT_CODE) return false
  const message = String(failure.message ?? '')
  return SPENT_ALLOWANCE_EN.test(message) || SPENT_ALLOWANCE_ZH.test(message)
}

/**
 * The wait one native-style quick retry of an exhausted allowance uses, as
 * `@deepseek-ai/dsh-llm-retry` computes it for the same failure.
 *
 * The mirror is the same formula rather than an estimate, because the
 * provider's own resolved policy travels with the failed request: a quick retry
 * of a provider that meters its rate limit as a spent allowance has to wait as
 * long as the native policy would have waited, not as long as this plugin
 * guesses. A wait the provider asked for through `providerRetryAfterMs` is
 * honored while it fits under the policy's ceiling, because the native policy
 * hands a longer one to the next listener instead of retrying.
 *
 * @param retryPolicy - the failed request's resolved policy, absent when the
 *   route declares none.
 * @param failure - the terminal `LlmFailure` carried by the failed request.
 * @param attempt - the one-based quick attempt this wait is for.
 * @param random - sample used for the symmetric jitter around the local delay.
 * @returns the wait in milliseconds, or undefined when the native policy holds
 *   no bounded schedule for this failure: no policy, unbounded `always` mode,
 *   or a provider wait longer than `maxDelayMs`.
 */
export function nativeQuickDelayMs(retryPolicy, failure, attempt, random = Math.random) {
  if (retryPolicy === undefined || retryPolicy.mode !== 'normal') return undefined
  const asked = failure?.providerRetryAfterMs
  if (Number.isFinite(asked) && asked > 0) {
    return asked > retryPolicy.maxDelayMs ? undefined : asked
  }
  const exponent = Math.min(attempt - 1, 1024)
  const exponential = Math.min(retryPolicy.initialDelayMs * 2 ** exponent, retryPolicy.maxDelayMs)
  const jitter = 1 - retryPolicy.jitterRatio + 2 * retryPolicy.jitterRatio * random()
  return Math.min(exponential * jitter, retryPolicy.maxDelayMs)
}

/** One hour between long-term attempts when the row sets no interval. */
export const DEFAULT_LONG_TERM_DELAY_MS = 3_600_000

/**
 * The switch a Session that owns no setting starts from when the row sets no
 * default: long-term retry is on, so an exhausted allowance is waited out
 * without a per-Session opt-in.
 */
export const DEFAULT_ENABLED = true

/** Largest delay `setTimeout` accepts; also the upper bound on the interval. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Row-config keys this policy owns; the route policy contributes its own. */
const RETRY_CONFIG_KEYS = Object.freeze(['longTermDelayMs', 'defaultEnabled', 'nativeRetryFirstProviders'])

/**
 * Validate the whitelist of providers whose exhausted allowance runs the native
 * retry schedule before this plugin answers it.
 *
 * A provider is named by its harness provider id, the same key a route's
 * `provider` is and the same key a model request is routed through.
 *
 * @param raw - raw Loader row value; omission selects an empty whitelist.
 * @returns the frozen provider ids, in configured order.
 * @throws when the value is not an array of distinct, non-empty provider ids.
 */
function resolveNativeRetryFirstProviders(raw) {
  if (raw === undefined) return Object.freeze([])
  if (!Array.isArray(raw)) throw new Error('llm-quota-retry: nativeRetryFirstProviders must be an array of provider ids')
  const seen = new Set()
  for (const provider of raw) {
    if (typeof provider !== 'string' || provider.trim() === '') {
      throw new Error('llm-quota-retry: nativeRetryFirstProviders must contain only non-empty provider ids')
    }
    if (seen.has(provider)) {
      throw new Error(`llm-quota-retry: nativeRetryFirstProviders names provider "${provider}" twice`)
    }
    seen.add(provider)
  }
  return Object.freeze([...raw])
}

/**
 * Validate the row config and freeze the resolved policy.
 * @param config - raw Loader row config; omission selects the defaults.
 * @param extraKeys - keys owned by another resolved policy in this package
 *   (the route policy), which this validator accepts without reading. The caller
 *   validates them, so the allowlist stays one list per concern.
 * @returns the frozen resolved policy.
 * @throws when the config is not an object, carries an unknown key, sets a
 *   non-positive, non-finite, or oversized interval, gives a non-boolean
 *   default for the per-Session setting, or names an unusable provider in the
 *   native-retry-first whitelist.
 */
export function resolvePolicy(config = {}, extraKeys = []) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('llm-quota-retry: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!RETRY_CONFIG_KEYS.includes(key) && !extraKeys.includes(key)) {
      throw new Error(`llm-quota-retry: unknown config key "${key}"`)
    }
  }
  const longTermDelayMs = config.longTermDelayMs ?? DEFAULT_LONG_TERM_DELAY_MS
  if (typeof longTermDelayMs !== 'number' || !Number.isFinite(longTermDelayMs)) {
    throw new Error('llm-quota-retry: longTermDelayMs must be a positive finite number')
  }
  if (longTermDelayMs <= 0 || longTermDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-quota-retry: longTermDelayMs must be greater than 0 and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const defaultEnabled = config.defaultEnabled ?? DEFAULT_ENABLED
  if (typeof defaultEnabled !== 'boolean') {
    throw new Error('llm-quota-retry: defaultEnabled must be a boolean')
  }
  const nativeRetryFirstProviders = resolveNativeRetryFirstProviders(config.nativeRetryFirstProviders)
  return Object.freeze({ longTermDelayMs, defaultEnabled, nativeRetryFirstProviders })
}

/**
 * Wait one delay, settling early when either fused signal aborts.
 * @param delayMs - wait length in milliseconds.
 * @param signal - fused turn-abort, plugin-lifetime, and entry cancellation.
 * @returns true when the delay elapsed, false when a signal aborted it.
 */
export function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Settle when one signal aborts, so a cancelled turn stops waiting for work whose
 * result it will never read.
 *
 * The work itself is left alone: a run this plugin shares between several waiting
 * callers must outlive the one caller that gives up on it.
 *
 * @param signal - the abort signal to stop waiting for.
 * @returns a promise that resolves on abort.
 */
export function aborted(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/**
 * Whether one committed Session event proves a model request succeeded.
 * An interrupted assistant message carries partial output from a request the
 * turn aborted, so it is not recovery.
 * @param event - one committed Session event.
 * @returns true for a completed, non-interrupted assistant message.
 */
export function isSuccessfulResponse(event) {
  return event.type === 'assistant/message' && event.data.interrupted !== true
}

/**
 * Accept one stored setting record, keeping only the fields this plugin owns.
 *
 * A record carries the retry switch and the route pool. `enabled: null` means
 * the switch was cleared back to the deployment default; `pool` **absent** means
 * no explicit pool (the plugin infers one from the route the Session is on),
 * while `pool: null` is an explicit opt-out of route moves.
 *
 * @param record - value read from the storage domain.
 * @returns the normalized record, or null when it carries nothing usable.
 */
export function normalizeSettingRecord(record) {
  if (record === null || typeof record !== 'object') return null
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : null
  const pool = record.pool === null
    ? null
    : typeof record.pool === 'string' && record.pool !== '' ? record.pool : undefined
  const inheritedFrom = typeof record.inheritedFrom === 'string' && record.inheritedFrom !== ''
    ? record.inheritedFrom
    : undefined
  if (enabled === null && pool === undefined && inheritedFrom === undefined) return null
  return {
    enabled,
    ...pool === undefined ? {} : { pool },
    ...inheritedFrom === undefined ? {} : { inheritedFrom },
  }
}

/**
 * The explicit settings one record owns, for inheritance.
 * @param record - a normalized record, or undefined when the Session owns none.
 * @returns the fields the record states explicitly, or null when it states none.
 */
export function ownedSettingOf(record) {
  if (record === undefined) return null
  const owned = {
    ...record.enabled === null ? {} : { enabled: record.enabled },
    ...record.pool === undefined ? {} : { pool: record.pool },
  }
  return Object.keys(owned).length === 0 ? null : owned
}

/**
 * The effective setting for one Session: its own record, or the deployment default.
 * @param record - the Session's record, or undefined when it owns none.
 * @param defaultEnabled - the row's configured default.
 * @returns whether long-term retry is enabled for that Session.
 */
export function effectiveEnabled(record, defaultEnabled) {
  return record?.enabled ?? defaultEnabled
}

/**
 * Where one Session's effective setting came from, for the composer chip.
 * @param record - the Session's record, or undefined when it owns none.
 * @param defaultEnabled - the row's configured default.
 * @returns `default` (no record, or a cleared one), `inherited`, or `session`.
 */
export function settingSource(record, defaultEnabled) {
  if (record === undefined || record.enabled === null) return 'default'
  return record.inheritedFrom === undefined ? 'session' : 'inherited'
}

/**
 * The route pool one Session's record states.
 *
 * Three states, deliberately distinct: no explicit pool (`explicit` false) leaves
 * the choice to inference from the model the Session is on, an explicit name
 * pins it, and an explicit `null` is the opt-out — this Session's provider is
 * never changed, whatever its route belongs to.
 *
 * @param record - the Session's record, or undefined when it owns none.
 * @returns whether the record states a pool, and the name it states (`null` for
 *   the opt-out).
 */
export function poolSettingOf(record) {
  if (record === undefined || record.pool === undefined) return { explicit: false, name: null }
  return { explicit: true, name: record.pool }
}

/**
 * Where one Session's route pool came from, for the composer chip.
 * @param record - the Session's record, or undefined when it owns none.
 * @returns `off` for the opt-out, `inherited` or `session` for an explicit pool,
 *   and `default` when the plugin infers one.
 */
export function poolSourceOf(record) {
  const setting = poolSettingOf(record)
  if (!setting.explicit) return 'default'
  if (setting.name === null) return 'off'
  return record.inheritedFrom === undefined ? 'session' : 'inherited'
}

/**
 * Find the nearest ancestor Session that owns an explicit setting.
 *
 * The walk is cycle-guarded: a corrupt header chain must not hang the fold. It
 * stops at the first ancestor that states anything, and copies what it states, so
 * a Session that inherited a pool and nothing else does not keep walking for a
 * switch the deployment default already answers.
 *
 * @param startId - the parent to start from.
 * @param parentOf - resolve one Session's direct parent.
 * @param ownedOf - resolve one Session's own explicit fields, or null when it states none.
 * @returns the nearest stating ancestor and what it states, or null when none does.
 */
export function resolveInheritedSetting(startId, parentOf, ownedOf) {
  const seen = new Set()
  let current = startId
  while (typeof current === 'string' && current !== '' && !seen.has(current)) {
    seen.add(current)
    const owned = ownedOf(current)
    if (owned !== null) return { fromId: current, owned }
    current = parentOf(current)
  }
  return null
}

/**
 * Read one `/quota-retry` argument.
 * @param rawInput - the text after the command name.
 * @returns a report request, an explicit value, a request to restore the
 *   deployment default, or an invalid request naming the accepted arguments.
 */
export function parseRetryCommand(rawInput) {
  const argument = String(rawInput ?? '').trim().toLowerCase()
  if (argument === '' || argument === 'status') return { kind: 'report' }
  if (argument === 'on' || argument === 'enable' || argument === 'enabled') return { kind: 'set', enabled: true }
  if (argument === 'off' || argument === 'disable' || argument === 'disabled') return { kind: 'set', enabled: false }
  if (argument === 'default' || argument === 'reset') return { kind: 'default' }
  return { kind: 'invalid', reason: `quota-retry: expected on, off, default, or status; got "${String(rawInput ?? '')}"` }
}

/**
 * The words `/quota-pool` answers itself, which a pool therefore cannot be
 * named: a pool called `off` could never be selected, and a pool called
 * `default` could never be told apart from clearing the setting.
 */
export const RESERVED_POOL_NAMES = Object.freeze([
  'status',
  'off',
  'none',
  'disable',
  'disabled',
  'default',
  'reset',
  'auto',
  // The composer menu's own error row, which a pool option id would shadow.
  'error',
])

/**
 * Which configured pool names the command vocabulary already owns.
 * @param poolNames - every configured pool name.
 * @returns the offending names, in configured order.
 */
export function reservedPoolNames(poolNames) {
  return poolNames.filter(name => RESERVED_POOL_NAMES.includes(name.toLowerCase()))
}

/**
 * Read one `/quota-pool` argument.
 *
 * A pool name is matched exactly as configured, because it is a name the
 * deployment chose; the three keywords are compared case-insensitively because a
 * typed line should not depend on shift.
 *
 * @param rawInput - the text after the command name.
 * @param poolNames - every configured pool name, in configured order.
 * @returns a report request, a pool to set, the opt-out, a request to clear the
 *   explicit pool, or an invalid request naming the accepted arguments.
 */
export function parsePoolCommand(rawInput, poolNames) {
  const text = String(rawInput ?? '').trim()
  const argument = text.toLowerCase()
  if (argument === '' || argument === 'status') return { kind: 'report' }
  if (poolNames.includes(text)) return { kind: 'set', pool: text }
  if (argument === 'off' || argument === 'none' || argument === 'disable' || argument === 'disabled') {
    return { kind: 'off' }
  }
  if (argument === 'default' || argument === 'reset' || argument === 'auto') return { kind: 'default' }
  return {
    kind: 'invalid',
    reason: `quota-pool: expected ${poolNames.length === 0 ? 'a pool name' : `one of ${poolNames.join(', ')}`}, `
      + `off, default, or status; got "${text}"`,
  }
}

/**
 * Per-Session long-term retry state.
 *
 * One entry lives from the first quota takeover in a Session until a model
 * request in that Session succeeds or the Session's setting turns off.
 * Aborting a wait for any other reason clears only the entry's pending marker,
 * so the next quota failure resumes the same entry and keeps its original
 * `enteredAt`.
 *
 * Every entry owns an AbortController: ending the entry aborts its wait, so a
 * switch turned off mid-wait stops the session immediately instead of leaving
 * a timer that would wake an hour later.
 *
 * A quick native-style retry runs before an entry exists at all, so its budget
 * is counted separately and per step: it is spent on the failing step's own
 * attempts and starts over on the next one. A Session already waiting out a long
 * interval has passed that stage and never spends it again.
 */
export class QuotaRetryLedger {
  #entries = new Map()

  /** Session -> the quick attempts its current step has spent. */
  #quick = new WeakMap()

  /**
   * @param session - Session whose retry state is read.
   * @returns true while the Session holds an unresolved quota retry entry.
   */
  isRetrying(session) {
    return this.#entries.has(session)
  }

  /**
   * @param session - Session whose retry state is read.
   * @returns a frozen snapshot of the entry, or undefined when the Session is
   *   not in long-term retry.
   */
  stateOf(session) {
    const entry = this.#entries.get(session)
    if (entry === undefined) return undefined
    return Object.freeze({
      retrying: true,
      pending: entry.pending,
      provider: entry.provider,
      turn: entry.turn,
      step: entry.step,
      enteredAt: entry.enteredAt,
      attempts: entry.attempts,
      nextAttemptAt: entry.nextAttemptAt,
    })
  }

  /**
   * Open the Session's entry, or refresh the location of an entry that is
   * already open.
   * @param session - Session that just failed a request with the quota code.
   * @param facts - provider, turn, and step of the failing request.
   * @param now - epoch milliseconds of this takeover.
   * @returns `created` true exactly when this call opened the entry (so the
   *   caller announces `entered` once per entry), plus the entry's own
   *   cancellation signal.
   */
  enter(session, facts, now) {
    const existing = this.#entries.get(session)
    if (existing !== undefined) {
      existing.provider = facts.provider
      existing.turn = facts.turn
      existing.step = facts.step
      return { created: false, signal: existing.control.signal }
    }
    const control = new AbortController()
    this.#entries.set(session, {
      provider: facts.provider,
      turn: facts.turn,
      step: facts.step,
      enteredAt: now,
      attempts: 0,
      pending: false,
      nextAttemptAt: undefined,
      control,
    })
    return { created: true, signal: control.signal }
  }

  /**
   * Reserve one quick native-style attempt for the Session's current step, and
   * the wait it should make.
   *
   * An attempt is spent only when a wait is actually armed: `delayOf` answers
   * the wait for a candidate attempt, and `undefined` means the native policy
   * would not retry this failure at all, which must not consume budget.
   *
   * @param session - Session whose request just failed.
   * @param turn - the failing request's turn.
   * @param step - the failing request's step.
   * @param maxAttempts - the native policy's retry budget for one step.
   * @param delayOf - resolve the wait for one attempt number.
   * @returns the attempt number and its wait, or undefined when the quick
   *   budget is spent, a long-term entry is open, or no wait applies.
   */
  quickAttempt(session, turn, step, maxAttempts, delayOf) {
    if (this.#entries.has(session)) return undefined
    const previous = this.#quick.get(session)
    const spent = previous !== undefined && previous.turn === turn && previous.step === step
      ? previous.attempts
      : 0
    if (spent >= maxAttempts) return undefined
    const delayMs = delayOf(spent + 1)
    if (delayMs === undefined) return undefined
    this.#quick.set(session, { turn, step, attempts: spent + 1 })
    return { attempt: spent + 1, delayMs }
  }

  /**
   * Record one scheduled long-term wait as armed.
   * @param session - Session whose wait was just scheduled.
   * @param now - epoch milliseconds the wait starts at.
   * @param delayMs - scheduled wait length.
   * @returns the frozen snapshot the caller publishes, or undefined when the
   *   entry is gone (the wait was ended by a concurrent leave).
   */
  schedule(session, now, delayMs) {
    const entry = this.#entries.get(session)
    if (entry === undefined) return undefined
    entry.attempts += 1
    entry.pending = true
    entry.nextAttemptAt = now + delayMs
    return this.stateOf(session)
  }

  /**
   * Clear the pending marker once a wait settles, whatever its outcome.
   * @param session - Session whose wait settled.
   * @returns the updated snapshot, or undefined when the entry is gone.
   */
  settle(session) {
    const entry = this.#entries.get(session)
    if (entry === undefined) return undefined
    entry.pending = false
    return this.stateOf(session)
  }

  /**
   * Remove the entry and abort its wait.
   * @param session - Session whose entry ends.
   * @returns the removed entry, or undefined when there was none.
   */
  leave(session) {
    const entry = this.#entries.get(session)
    if (entry === undefined) return undefined
    this.#entries.delete(session)
    entry.control.abort(new Error('llm-quota-retry entry ended'))
    return entry
  }

  /** Abort every wait and drop every entry; used when the plugin unloads. */
  clear() {
    for (const entry of this.#entries.values()) {
      entry.control.abort(new Error('llm-quota-retry plugin disposed'))
    }
    this.#entries.clear()
  }
}
