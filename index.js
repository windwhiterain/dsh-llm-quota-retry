/**
 * Long-term quota recovery for the agent loop's failed-request extension point.
 *
 * A model request that fails with the canonical quota code keeps its open step
 * alive with one further attempt per configured interval — one hour by
 * default, without an attempt limit. Earlier recovery policies still own their
 * own budgets: compose this row after `@deepseek-ai/dsh-llm-retry`, whose
 * normal-mode retries for eligible codes then run first and delegate here once
 * its budget is spent. Every non-quota failure delegates unchanged.
 *
 * Each Session's retry state is readable through `ctx.llmQuotaRetry` and
 * announced through `llm-quota-retry/entered` and `llm-quota-retry/left`. The
 * state is in-memory and lives only as long as the entry: unloading or
 * restarting the host drops a pending wait together with its entry.
 *
 * This plugin imports no Harness package, so its bundle needs no dependencies
 * and the Session and Agent values it handles stay opaque.
 *
 * @module dsh-llm-quota-retry
 */

import {
  QUOTA_EXCEEDED_CODE,
  QuotaRetryLedger,
  cancellableDelay,
  isSuccessfulResponse,
  resolvePolicy,
} from './lib/policy.js'

export const name = 'llm-quota-retry'

/**
 * Install quota-triggered long-term request recovery.
 * @param ctx - plugin context that owns the listener, the published service,
 *   and the active waits.
 * @param config - row config; `longTermDelayMs` sets the interval between
 *   attempts. Unknown keys and invalid intervals throw at activation.
 */
export function apply(ctx, config = {}) {
  const policy = resolvePolicy(config)
  const ledger = new QuotaRetryLedger()
  const lifetime = new AbortController()
  const active = new Set()

  ctx.provide('llmQuotaRetry', Object.freeze({
    isRetrying: session => ledger.isRetrying(session),
    stateOf: session => ledger.stateOf(session),
  }))

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  // Model-request success is the only evidence that the account's quota is
  // usable again, so it is the only transition that ends an entry.
  const disposeLeftListener = ctx.on('session/event', (session, event) => {
    if (!ledger.isRetrying(session) || !isSuccessfulResponse(event)) return
    const left = ledger.leave(session)
    if (left === undefined) return
    const leftAt = Date.now()
    ctx.emit('llm-quota-retry/left', {
      session,
      leftAt,
      durationMs: leftAt - left.enteredAt,
      provider: left.provider,
      turn: left.turn,
      step: left.step,
      enteredAt: left.enteredAt,
      attempts: left.attempts,
    })
  })

  async function recover({ agent, turn, step, provider, failure, signal }) {
    if (signal.aborted) return
    const session = agent.session
    const now = Date.now()
    const created = ledger.enter(session, { provider, turn, step }, now)
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
      AbortSignal.any([signal, lifetime.signal]),
    )
    ledger.settle(session)
    if (!elapsed) return
    return { kind: 'retry' }
  }

  const disposeRequestError = ctx.on('agent/request-error', (payload, next) => {
    if (payload.failure.code !== QUOTA_EXCEEDED_CODE) return next()
    // A waterfall may have captured this callback before its registration was
    // removed; lifetime cancellation must keep that stale callback from
    // scheduling a wait after disposal.
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    return track(recover(payload))
  })

  ctx.effect(() => async () => {
    disposeLeftListener()
    disposeRequestError()
    lifetime.abort(new Error('llm-quota-retry plugin disposed'))
    await Promise.allSettled([...active])
    ledger.clear()
  }, 'llm-quota-retry: abort and drain active waits')
}
