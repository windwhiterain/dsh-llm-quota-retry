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

/** One hour between long-term attempts when the row sets no interval. */
export const DEFAULT_LONG_TERM_DELAY_MS = 3_600_000

/** Largest delay `setTimeout` accepts; also the upper bound on the interval. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Validate the row config and freeze the resolved policy.
 * @param config - raw Loader row config; omission selects the defaults.
 * @returns the frozen resolved policy.
 * @throws when the config is not an object, carries an unknown key, sets a
 *   non-positive, non-finite, or oversized interval, or gives a non-boolean
 *   default for the per-Session setting.
 */
export function resolvePolicy(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('llm-quota-retry: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (key !== 'longTermDelayMs' && key !== 'defaultEnabled') {
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
  const defaultEnabled = config.defaultEnabled ?? false
  if (typeof defaultEnabled !== 'boolean') {
    throw new Error('llm-quota-retry: defaultEnabled must be a boolean')
  }
  return Object.freeze({ longTermDelayMs, defaultEnabled })
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
 * @param record - value read from the storage domain.
 * @returns the normalized record, or null when it carries nothing usable.
 */
export function normalizeSettingRecord(record) {
  if (record === null || typeof record !== 'object') return null
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : null
  const inheritedFrom = typeof record.inheritedFrom === 'string' && record.inheritedFrom !== ''
    ? record.inheritedFrom
    : undefined
  if (enabled === null && inheritedFrom === undefined) return null
  return { enabled, ...inheritedFrom === undefined ? {} : { inheritedFrom } }
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
 * Find the nearest ancestor Session that owns an explicit setting.
 *
 * The walk is cycle-guarded: a corrupt header chain must not hang the fold.
 *
 * @param startId - the parent to start from.
 * @param parentOf - resolve one Session's direct parent.
 * @param overrideOf - resolve one Session's own explicit value, or null when it owns none.
 * @returns the nearest owning ancestor and its value, or null when none owns one.
 */
export function resolveInheritedSetting(startId, parentOf, overrideOf) {
  const seen = new Set()
  let current = startId
  while (typeof current === 'string' && current !== '' && !seen.has(current)) {
    seen.add(current)
    const value = overrideOf(current)
    if (value !== null) return { fromId: current, value }
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
 */
export class QuotaRetryLedger {
  #entries = new Map()

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
