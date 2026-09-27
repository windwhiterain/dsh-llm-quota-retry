#!/usr/bin/env node
/**
 * Offline probe for dsh-llm-quota-retry: drives `apply()` against a fake
 * Cordis context so every decision, event, and state transition is checked
 * without a Harness.
 *
 * Run with `node probe/probe.mjs` from the package directory. Exits non-zero
 * on the first failed check.
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { QUOTA_EXCEEDED_CODE, resolvePolicy } from '../lib/policy.js'

/** Minimal Cordis context surface the plugin uses. */
function createContext() {
  const hooks = new Map()
  const emitted = []
  const services = new Map()
  const cleanups = []
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    on(event, listener) {
      const list = hooks.get(event) ?? []
      list.push(listener)
      hooks.set(event, list)
      let live = true
      return () => {
        if (!live) return false
        live = false
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
        return true
      }
    },
    emit(event, payload) {
      emitted.push({ event, payload })
    },
    provide(serviceName, value) {
      services.set(serviceName, value)
      return () => services.delete(serviceName)
    },
    effect(callback) {
      cleanups.push(callback)
    },
    hooks,
    emitted,
    services,
    async dispose() {
      for (const effect of [...cleanups].reverse()) {
        const cleanup = effect()
        if (typeof cleanup === 'function') await cleanup()
      }
    },
  }
}

/** Run the registered `agent/request-error` waterfall over one payload. */
async function dispatchFailure(context, payload) {
  const chain = [...(context.hooks.get('agent/request-error') ?? [])]
  const run = index => index >= chain.length
    ? Promise.resolve(undefined)
    : chain[index](payload, () => run(index + 1))
  return run(0)
}

/** Deliver one committed Session event to the registered observers. */
function dispatchSessionEvent(context, session, event) {
  for (const listener of context.hooks.get('session/event') ?? []) listener(session, event)
}

const session = { id: 'probe-session' }
const agent = { session }
const quotaFailure = { message: 'insufficient balance', code: QUOTA_EXCEEDED_CODE }
const request = {
  agent,
  turn: 1,
  step: 1,
  provider: 'probe-provider',
  failure: quotaFailure,
  retryPolicy: undefined,
  signal: new AbortController().signal,
}
const successEvent = { type: 'assistant/message', seq: 7, time: Date.now(), data: { turn: 1, step: 1 } }

const checks = []
function check(name, run) {
  checks.push({ name, run })
}

function enteredOf(context) {
  return context.emitted.filter(entry => entry.event === 'llm-quota-retry/entered')
}

function leftOf(context) {
  return context.emitted.filter(entry => entry.event === 'llm-quota-retry/left')
}

check('a non-quota failure delegates and records no state', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  const delegated = await dispatchFailure(context, {
    ...request,
    failure: { message: 'slow down', code: 'RATE_LIMIT' },
  })
  assert.equal(delegated, undefined)
  assert.equal(context.services.get('llmQuotaRetry').isRetrying(session), false)
  assert.equal(context.emitted.length, 0)
})

check('a quota failure waits the configured interval and returns a retry decision', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 20 })
  const started = Date.now()
  const decision = await dispatchFailure(context, request)
  assert.deepEqual(decision, { kind: 'retry' })
  assert.ok(Date.now() - started >= 20, 'the wait must elapse before the retry decision')
})

check('entering announces the interval, provider, and attempt count once', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  await dispatchFailure(context, request)
  const entered = enteredOf(context)
  assert.equal(entered.length, 1)
  const payload = entered[0].payload
  assert.equal(payload.session, session)
  assert.equal(payload.agent, agent)
  assert.equal(payload.provider, 'probe-provider')
  assert.equal(payload.attempts, 1)
  assert.equal(payload.pending, true)
  assert.equal(payload.nextAttemptAt - payload.enteredAt, 5)
  assert.equal(payload.failure, quotaFailure)
})

check('a repeated quota failure resumes the entry without announcing entry again', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  await dispatchFailure(context, request)
  const firstEnteredAt = enteredOf(context)[0].payload.enteredAt
  await dispatchFailure(context, request)
  assert.equal(enteredOf(context).length, 1)
  const state = context.services.get('llmQuotaRetry').stateOf(session)
  assert.equal(state.attempts, 2)
  assert.equal(state.enteredAt, firstEnteredAt)
})

check('the published service reports the armed wait while the interval runs', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000 })
  const service = context.services.get('llmQuotaRetry')
  const controller = new AbortController()
  const pending = dispatchFailure(context, { ...request, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(service.isRetrying(session), true)
  assert.equal(service.stateOf(session).pending, true)
  assert.equal(service.stateOf(session).attempts, 1)
  assert.equal(Object.isFrozen(service.stateOf(session)), true)
  controller.abort()
  assert.equal(await pending, undefined)
})

check('an aborted wait keeps the entry, clears pending, and announces no leave', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000 })
  const controller = new AbortController()
  const pending = dispatchFailure(context, { ...request, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  assert.equal(await pending, undefined)
  const service = context.services.get('llmQuotaRetry')
  assert.equal(service.isRetrying(session), true)
  assert.equal(service.stateOf(session).pending, false)
  assert.equal(leftOf(context).length, 0)
})

check('a non-aborted wait keeps the entry armed until it settles', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  const service = context.services.get('llmQuotaRetry')
  const before = service.stateOf(session)
  assert.equal(before, undefined)
  const decision = await dispatchFailure(context, request)
  assert.deepEqual(decision, { kind: 'retry' })
  assert.equal(service.stateOf(session).pending, false)
  assert.equal(service.stateOf(session).attempts, 1)
})

check('a successful assistant message leaves long-term retry and reports its timing', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  await dispatchFailure(context, request)
  dispatchSessionEvent(context, session, successEvent)
  const left = leftOf(context)
  assert.equal(left.length, 1)
  const payload = left[0].payload
  assert.equal(payload.attempts, 1)
  assert.equal(payload.provider, 'probe-provider')
  assert.equal(payload.durationMs, payload.leftAt - payload.enteredAt)
  assert.ok(payload.durationMs >= 0)
  assert.equal(context.services.get('llmQuotaRetry').isRetrying(session), false)
  assert.equal(context.services.get('llmQuotaRetry').stateOf(session), undefined)
})

check('an interrupted assistant message is not recovery', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  await dispatchFailure(context, request)
  dispatchSessionEvent(context, session, {
    type: 'assistant/message',
    seq: 8,
    time: Date.now(),
    data: { turn: 1, step: 1, interrupted: true },
  })
  assert.equal(leftOf(context).length, 0)
  assert.equal(context.services.get('llmQuotaRetry').isRetrying(session), true)
})

check('an unrelated assistant attempt is not recovery', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  await dispatchFailure(context, request)
  dispatchSessionEvent(context, session, { type: 'assistant/attempt', seq: 9, time: Date.now(), data: { turn: 1, step: 1 } })
  assert.equal(leftOf(context).length, 0)
})

check('a later quota failure after recovery announces entry again', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  await dispatchFailure(context, request)
  dispatchSessionEvent(context, session, successEvent)
  await dispatchFailure(context, request)
  assert.equal(enteredOf(context).length, 2)
  assert.equal(context.services.get('llmQuotaRetry').stateOf(session).attempts, 1)
})

check('disposal aborts a pending wait and drops the service', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000 })
  const pending = dispatchFailure(context, request)
  await new Promise(resolve => setTimeout(resolve, 10))
  await context.dispose()
  assert.equal(await pending, undefined)
  assert.equal(leftOf(context).length, 0)
})

check('config validation rejects unknown keys and invalid intervals', async () => {
  assert.throws(() => resolvePolicy({ longTermDelayMs: 0 }), /greater than 0/)
  assert.throws(() => resolvePolicy({ longTermDelayMs: Number.POSITIVE_INFINITY }), /positive finite number/)
  assert.throws(() => resolvePolicy({ longTermDelayMs: 2_147_483_648 }), /no greater than 2147483647/)
  assert.throws(() => resolvePolicy({ quickRetries: 3 }), /unknown config key "quickRetries"/)
  assert.deepEqual(resolvePolicy({}), { longTermDelayMs: 3_600_000 })
  assert.deepEqual(resolvePolicy({ longTermDelayMs: 1000 }), { longTermDelayMs: 1000 })
})

for (const { name, run } of checks) {
  await run()
  console.log(`ok  ${name}`)
}
console.log(`\n${checks.length} probe checks passed`)
