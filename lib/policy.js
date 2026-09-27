/**
 * Pure policy for dsh-llm-quota-retry: row-config validation, the cancellable
 * wait, the success detector, and the per-Session retry ledger.
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

/** One hour between long-term attempts when the row sets no interval. */
export const DEFAULT_LONG_TERM_DELAY_MS = 3_600_000

/** Largest delay `setTimeout` accepts; also the upper bound on the interval. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Validate the row config and freeze the resolved interval.
 * @param config - raw Loader row config; omission selects the defaults.
 * @returns the frozen resolved policy.
 * @throws when the config is not an object, carries an unknown key, or sets a
 *   non-positive, non-finite, or oversized interval.
 */
export function resolvePolicy(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('llm-quota-retry: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (key !== 'longTermDelayMs') throw new Error(`llm-quota-retry: unknown config key "${key}"`)
  }
  const longTermDelayMs = config.longTermDelayMs ?? DEFAULT_LONG_TERM_DELAY_MS
  if (typeof longTermDelayMs !== 'number' || !Number.isFinite(longTermDelayMs)) {
    throw new Error('llm-quota-retry: longTermDelayMs must be a positive finite number')
  }
  if (longTermDelayMs <= 0 || longTermDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-quota-retry: longTermDelayMs must be greater than 0 and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return Object.freeze({ longTermDelayMs })
}

/**
 * Wait one delay, settling early when either fused signal aborts.
 * @param delayMs - wait length in milliseconds.
 * @param signal - fused turn-abort and plugin-lifetime cancellation.
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
 * Per-Session long-term retry state.
 *
 * One entry lives from the first quota takeover in a Session until one model
 * request in that Session succeeds. Aborting a wait clears only the entry's
 * pending marker, so the next quota failure resumes the same entry and keeps
 * its original `enteredAt`.
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
   * @returns true exactly when this call opened the entry, so the caller
   *   announces `entered` once per entry.
   */
  enter(session, facts, now) {
    const existing = this.#entries.get(session)
    if (existing !== undefined) {
      existing.provider = facts.provider
      existing.turn = facts.turn
      existing.step = facts.step
      return false
    }
    this.#entries.set(session, {
      provider: facts.provider,
      turn: facts.turn,
      step: facts.step,
      enteredAt: now,
      attempts: 0,
      pending: false,
      nextAttemptAt: undefined,
    })
    return true
  }

  /**
   * Record one scheduled long-term wait as armed.
   * @param session - Session whose wait was just scheduled.
   * @param now - epoch milliseconds the wait starts at.
   * @param delayMs - scheduled wait length.
   * @returns the frozen snapshot the caller publishes, or undefined when the
   *   entry is gone (the wait was settled by a concurrent leave).
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
   * Remove the entry because a model request in the Session succeeded.
   * @param session - Session whose request succeeded.
   * @returns the removed entry, or undefined when there was none.
   */
  leave(session) {
    const entry = this.#entries.get(session)
    if (entry === undefined) return undefined
    this.#entries.delete(session)
    return entry
  }

  /** Drop every entry; used when the plugin unloads. */
  clear() {
    this.#entries.clear()
  }
}
