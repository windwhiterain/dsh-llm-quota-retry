#!/usr/bin/env node
/**
 * Offline probe for dsh-llm-quota-retry: drives `apply()` against a fake
 * Cordis context so every decision, event, state transition, command, and
 * projection value is checked without a Harness.
 *
 * Run with `node probe/probe.mjs` from the package directory. Exits non-zero
 * on the first failed check.
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { QUOTA_EXCEEDED_CODE, isExhaustedAllowanceFailure, resolvePolicy } from '../lib/policy.js'

/** Minimal `ctx.sessionProjections` surface the plugin registers against. */
function createProjectionRegistry() {
  const definitions = new Map()
  return {
    definitions,
    register(definition) {
      definitions.set(definition.key, definition)
      return () => definitions.delete(definition.key)
    },
    /** Fold one Session from `init`, the only path the probe needs. */
    stateOf(session) {
      const definition = definitions.get('quotaRetry')
      return definition === undefined ? undefined : definition.init(session.header, 0)
    },
    view(session) {
      const definition = definitions.get('quotaRetry')
      if (definition === undefined) return undefined
      return definition.wire.view(this.stateOf(session))
    },
  }
}

/** Minimal `ctx.commands` surface, with a probe-side runner. */
function createCommandRegistry() {
  const commands = new Map()
  return {
    commands,
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
    run(agent, rawInput) {
      const definition = commands.get('quota-retry')
      assert.ok(definition !== undefined, 'the plugin must register /quota-retry')
      return definition.handler({ agent, rawInput })
    },
  }
}

/** Minimal `ctx.storageDomain` surface over a shared record store. */
function createStorageDomain(store) {
  return {
    open() {
      return Promise.resolve({
        table: () => ({
          entries: () => store.entries(),
          put: (key, value) => {
            store.set(key, value)
            return Promise.resolve()
          },
        }),
        close: () => Promise.resolve(),
      })
    },
  }
}

/** Minimal `ctx.sessions` surface resolving parent links for the inheritance walk. */
function createSessionRegistry(parents) {
  return {
    get(id) {
      return parents.has(id) ? { header: { parentSession: parents.get(id) } } : undefined
    },
  }
}

/**
 * Minimal Cordis context. `withStorage` decides whether `ctx.inject(['storageDomain'])`
 * finds its dependency, which is how the probe covers the durable and
 * process-local paths with the same plugin code.
 */
function createContext({ store = new Map(), parents = new Map(), withStorage = false } = {}) {
  const hooks = new Map()
  const emitted = []
  const cleanups = []
  const projections = createProjectionRegistry()
  const commandsRegistry = createCommandRegistry()
  const services = new Map([
    ['sessionProjections', projections],
    ['commands', commandsRegistry],
    ['sessions', createSessionRegistry(parents)],
  ])
  if (withStorage) services.set('storageDomain', createStorageDomain(store))

  function effect(callback) {
    // Cordis runs the callback at registration and keeps its returned disposer.
    const cleanup = callback()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }

  const context = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    effect,
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
    get(name) {
      return services.get(name)
    },
    inject(dependencies, callback) {
      if (dependencies.some(name => !services.has(name))) return
      const child = { effect, logger: context.logger }
      for (const name of dependencies) child[name] = services.get(name)
      callback(child)
    },
    provide(serviceName, value) {
      services.set(serviceName, value)
      return () => services.delete(serviceName)
    },
    hooks,
    emitted,
    projections,
    commands: commandsRegistry,
    store,
    parents,
    get service() {
      return services.get('llmQuotaRetry')
    },
    async dispose() {
      for (const cleanup of [...cleanups].reverse()) await cleanup()
    },
  }
  return context
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

/** Await the microtask and timer queues, so the storage domain's `open()` settles. */
async function settled() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

const session = { id: 'probe-session', header: { id: 'probe-session' } }
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

check('config validation rejects unknown keys, invalid intervals, and non-boolean defaults', () => {
  assert.throws(() => resolvePolicy({ longTermDelayMs: 0 }), /greater than 0/)
  assert.throws(() => resolvePolicy({ longTermDelayMs: Number.POSITIVE_INFINITY }), /positive finite number/)
  assert.throws(() => resolvePolicy({ longTermDelayMs: 2_147_483_648 }), /no greater than 2147483647/)
  assert.throws(() => resolvePolicy({ defaultEnabled: 'yes' }), /defaultEnabled must be a boolean/)
  assert.throws(() => resolvePolicy({ quickRetries: 3 }), /unknown config key "quickRetries"/)
  assert.deepEqual(resolvePolicy({}), { longTermDelayMs: 3_600_000, defaultEnabled: false })
  assert.deepEqual(resolvePolicy({ longTermDelayMs: 1000, defaultEnabled: true }), {
    longTermDelayMs: 1000,
    defaultEnabled: true,
  })
})

check('only an exhausted allowance triggers long-term retry', () => {
  assert.equal(isExhaustedAllowanceFailure({ message: 'insufficient balance', code: QUOTA_EXCEEDED_CODE }), true)
  assert.equal(isExhaustedAllowanceFailure({
    message: `403 {"error":{"type":"permission_error","message":"You've reached your 5-hour usage limit. `
      + 'Your quota will reset when the current 5-hour window ends."}}',
    code: 'AUTH',
  }), true)
  assert.equal(isExhaustedAllowanceFailure({ message: 'HTTP 403: permission denied', code: 'AUTH' }), false)
  assert.equal(isExhaustedAllowanceFailure({ message: '401: Invalid API-key provided.', code: 'AUTH' }), false)
  assert.equal(isExhaustedAllowanceFailure({ message: 'slow down', code: 'RATE_LIMIT' }), false)
  assert.equal(isExhaustedAllowanceFailure({ code: 'AUTH' }), false)
})

check('a non-quota failure delegates and records no state', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  const delegated = await dispatchFailure(context, {
    ...request,
    failure: { message: 'slow down', code: 'RATE_LIMIT' },
  })
  assert.equal(delegated, undefined)
  assert.equal(context.service.isRetrying(session), false)
  assert.equal(context.emitted.length, 0)
})

check('a session that has not opted in delegates its quota failure too', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  const delegated = await dispatchFailure(context, request)
  assert.equal(delegated, undefined)
  assert.equal(context.service.isRetrying(session), false)
  assert.equal(context.emitted.length, 0)
})

check('an opted-in session waits the configured interval and returns a retry decision', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 20, defaultEnabled: true })
  const started = Date.now()
  const decision = await dispatchFailure(context, request)
  assert.deepEqual(decision, { kind: 'retry' })
  assert.ok(Date.now() - started >= 20, 'the wait must elapse before the retry decision')
})

check('an AUTH failure naming a spent allowance retries, and a rejected key does not', async () => {
  const allowance = {
    ...request,
    failure: {
      message: `403 {"error":{"type":"permission_error","message":"You've reached your 5-hour usage limit."}}`,
      code: 'AUTH',
    },
  }
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  assert.deepEqual(await dispatchFailure(context, allowance), { kind: 'retry' })
  const state = context.service.stateOf(session)
  assert.equal(state.attempts, 1)
  assert.equal(enteredOf(context)[0].payload.failure, allowance.failure)

  const rejected = createContext()
  apply(rejected, { longTermDelayMs: 5, defaultEnabled: true })
  const delegated = await dispatchFailure(rejected, {
    ...request,
    failure: { message: '401: Invalid API-key provided.', code: 'AUTH' },
  })
  assert.equal(delegated, undefined)
  assert.equal(rejected.service.isRetrying(session), false)
  assert.equal(rejected.emitted.length, 0)
})

check('entering announces the interval, provider, and attempt count once', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
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
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  await dispatchFailure(context, request)
  const firstEnteredAt = enteredOf(context)[0].payload.enteredAt
  await dispatchFailure(context, request)
  assert.equal(enteredOf(context).length, 1)
  const state = context.service.stateOf(session)
  assert.equal(state.attempts, 2)
  assert.equal(state.enteredAt, firstEnteredAt)
})

check('the published service reports the armed wait while the interval runs', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true })
  const controller = new AbortController()
  const pending = dispatchFailure(context, { ...request, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(context.service.isRetrying(session), true)
  assert.equal(context.service.stateOf(session).pending, true)
  assert.equal(context.service.stateOf(session).attempts, 1)
  assert.equal(Object.isFrozen(context.service.stateOf(session)), true)
  controller.abort()
  assert.equal(await pending, undefined)
})

check('an aborted turn keeps the entry, clears pending, and announces no leave', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true })
  const controller = new AbortController()
  const pending = dispatchFailure(context, { ...request, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  assert.equal(await pending, undefined)
  assert.equal(context.service.isRetrying(session), true)
  assert.equal(context.service.stateOf(session).pending, false)
  assert.equal(leftOf(context).length, 0)
})

check('a successful assistant message leaves long-term retry as recovered', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  await dispatchFailure(context, request)
  dispatchSessionEvent(context, session, successEvent)
  const left = leftOf(context)
  assert.equal(left.length, 1)
  const payload = left[0].payload
  assert.equal(payload.reason, 'recovered')
  assert.equal(payload.attempts, 1)
  assert.equal(payload.provider, 'probe-provider')
  assert.equal(payload.durationMs, payload.leftAt - payload.enteredAt)
  assert.equal(context.service.isRetrying(session), false)
  assert.equal(context.service.stateOf(session), undefined)
})

check('an interrupted assistant message is not recovery', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  await dispatchFailure(context, request)
  dispatchSessionEvent(context, session, {
    type: 'assistant/message',
    seq: 8,
    time: Date.now(),
    data: { turn: 1, step: 1, interrupted: true },
  })
  assert.equal(leftOf(context).length, 0)
  assert.equal(context.service.isRetrying(session), true)
})

check('a later quota failure after recovery announces entry again', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  await dispatchFailure(context, request)
  dispatchSessionEvent(context, session, successEvent)
  await dispatchFailure(context, request)
  assert.equal(enteredOf(context).length, 2)
  assert.equal(context.service.stateOf(session).attempts, 1)
})

check('the switch starts from the deployment default and the projection reports it', async () => {
  const off = createContext()
  apply(off, { longTermDelayMs: 5 })
  assert.deepEqual(off.projections.view(session), { enabled: false, defaultEnabled: false, source: 'default' })
  off.parents.set('probe-session', 'no-such-parent')
  const on = createContext()
  apply(on, { longTermDelayMs: 5, defaultEnabled: true })
  assert.deepEqual(on.projections.view(session), { enabled: true, defaultEnabled: true, source: 'default' })
})

check('/quota-retry on and off move the switch and the projection follows', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  const enable = await context.commands.run(agent, 'on')
  assert.equal(enable.kind, 'success')
  assert.deepEqual(context.projections.view(session), { enabled: true, defaultEnabled: false, source: 'session' })
  const disable = await context.commands.run(agent, 'off')
  assert.equal(disable.kind, 'success')
  assert.deepEqual(context.projections.view(session), { enabled: false, defaultEnabled: false, source: 'session' })
})

check('/quota-retry default restores the deployment default, and status reports it', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  await context.commands.run(agent, 'off')
  const restored = await context.commands.run(agent, 'default')
  assert.equal(restored.kind, 'success')
  assert.deepEqual(context.projections.view(session), { enabled: true, defaultEnabled: true, source: 'default' })
  const reported = await context.commands.run(agent, 'status')
  assert.match(reported.text, /long-term quota retry on \(deployment default\)/)
})

check('/quota-retry rejects an unknown argument', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  const outcome = await context.commands.run(agent, 'maybe')
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.text, /expected on, off, default, or status/)
})

check('turning the switch off aborts the pending wait and ends the entry as disabled', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true })
  const controller = new AbortController()
  const pending = dispatchFailure(context, { ...request, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(context.service.stateOf(session).pending, true)
  await context.commands.run(agent, 'off')
  assert.equal(await pending, undefined)
  const left = leftOf(context)
  assert.equal(left.length, 1)
  assert.equal(left[0].payload.reason, 'disabled')
  assert.equal(left[0].payload.attempts, 1)
  assert.equal(context.service.isRetrying(session), false)
})

check('a forked session inherits its nearest ancestor\'s explicit setting once', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  const grandparent = { id: 'grandparent-session', header: { id: 'grandparent-session' } }
  await context.commands.run({ session: grandparent }, 'on')
  context.parents.set('parent-session', 'grandparent-session')
  context.parents.set('child-session', 'parent-session')
  const child = { id: 'child-session', header: { id: 'child-session', parentSession: 'parent-session' } }
  assert.deepEqual(context.projections.view(child), { enabled: true, defaultEnabled: false, source: 'inherited' })
  // The inherited snapshot is this session's own value, so the origin stays visible.
  const cleared = await context.commands.run({ session: child }, 'default')
  assert.equal(cleared.kind, 'success')
  assert.deepEqual(context.projections.view(child), { enabled: false, defaultEnabled: false, source: 'default' })
})

check('an explicit setting survives a host restart through the storage domain', async () => {
  const store = new Map()
  const parents = new Map()
  const first = createContext({ store, parents, withStorage: true })
  apply(first, { longTermDelayMs: 5 })
  await first.commands.run(agent, 'on')
  await settled()
  assert.equal(store.get('probe-session').enabled, true)

  const second = createContext({ store, parents, withStorage: true })
  apply(second, { longTermDelayMs: 5 })
  await settled()
  assert.deepEqual(second.projections.view(session), { enabled: true, defaultEnabled: false, source: 'session' })
})

check('without a storage domain the setting stays in the process', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  await context.commands.run(agent, 'on')
  assert.deepEqual(context.projections.view(session), { enabled: true, defaultEnabled: false, source: 'session' })
})

check('disposal aborts a pending wait, drops the service, and leaves nothing behind', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true })
  const pending = dispatchFailure(context, request)
  await new Promise(resolve => setTimeout(resolve, 10))
  await context.dispose()
  assert.equal(await pending, undefined)
  assert.equal(leftOf(context).length, 0)
})

for (const { name, run } of checks) {
  await run()
  console.log(`ok  ${name}`)
}
console.log(`\n${checks.length} probe checks passed`)
