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
import { DEFAULT_ENABLED, QUOTA_EXCEEDED_CODE, isExhaustedAllowanceFailure, resolvePolicy } from '../lib/policy.js'

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
    runNamed(name, rawInput) {
      const definition = commands.get(name)
      assert.ok(definition !== undefined, `the plugin must register /${name}`)
      return definition.handler({ rawInput })
    },
  }
}

/**
 * Minimal `ctx.subprocess` surface: each spawn answers with the next queued
 * stdout, so a probe decides what a balance script "printed" without a process.
 * A queued `null` stands for a script that failed.
 */
function createSubprocess(outputs = []) {
  const spawned = []
  return {
    spawned,
    spawn(spec) {
      spawned.push(spec)
      const queued = outputs.length === 0 ? '' : outputs.shift()
      const failed = queued === null
      return {
        done: Promise.resolve({ exitCode: failed ? 3 : 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: failed ? '' : queued, nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: failed ? 'balance script failed' : '', nextOffset: 0, lossy: false }) },
        },
        terminate() {},
        waitForExit: () => Promise.resolve(true),
      }
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
function createContext({ store = new Map(), parents = new Map(), withStorage = false, subprocess = null, credentials = null } = {}) {
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
  if (subprocess !== null) services.set('subprocess', subprocess)
  if (credentials !== null) services.set('credentials', credentials)

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

/**
 * Run the registered `agent/request` waterfall the way a model request does,
 * with `proposal` as what the Session would otherwise use.
 * @param context - the fake context.
 * @param caller - the Agent making the request.
 * @param proposal - the provider/model the request resolves to without this plugin.
 * @returns the config the request goes out with.
 */
async function dispatchRequest(context, caller, proposal) {
  const chain = [...(context.hooks.get('agent/request') ?? [])]
  const run = index => index >= chain.length
    ? Promise.resolve(proposal)
    : chain[index]({ agent: caller }, () => run(index + 1))
  return run(0)
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
  assert.equal(DEFAULT_ENABLED, true, 'a session that owns no setting starts on')
  assert.deepEqual(resolvePolicy({}), { longTermDelayMs: 3_600_000, defaultEnabled: true })
  assert.deepEqual(resolvePolicy({ longTermDelayMs: 1000, defaultEnabled: false }), {
    longTermDelayMs: 1000,
    defaultEnabled: false,
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

check('a Token Plan 429 naming a spent plan allowance triggers, and ordinary throttling does not', () => {
  assert.equal(isExhaustedAllowanceFailure({
    message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：'
      + '请升级 Token Plan 套餐或购买积分补充用量。 (2056)"},"request_id":"070a9228c3b31a147bf2c735d4a84de8"}',
    code: 'RATE_LIMIT',
  }), true)
  assert.equal(isExhaustedAllowanceFailure({ message: '请求过于频繁，请稍后再试', code: 'RATE_LIMIT' }), false)
  assert.equal(isExhaustedAllowanceFailure({ message: '账户余额不足，请充值', code: 'RATE_LIMIT' }), true)
  assert.equal(isExhaustedAllowanceFailure({ message: 'HTTP 429: rate limit reached', code: 'RATE_LIMIT' }), false)
  // The upgrade advice a Token Plan failure appends must not supply the noun.
  assert.equal(isExhaustedAllowanceFailure({
    message: '429 request throttled; upgrade your plan for more quota',
    code: 'RATE_LIMIT',
  }), false)
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

check('a session whose switch is off delegates its quota failure too', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: false })
  const delegated = await dispatchFailure(context, request)
  assert.equal(delegated, undefined)
  assert.equal(context.service.isRetrying(session), false)
  assert.equal(context.emitted.length, 0)
})

check('an enabled session waits the configured interval and returns a retry decision', async () => {
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

check('a rate-limit failure naming a spent plan allowance retries, and throttling does not', async () => {
  const spentPlan = {
    ...request,
    failure: {
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：'
        + '请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}',
      code: 'RATE_LIMIT',
    },
  }
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  assert.deepEqual(await dispatchFailure(context, spentPlan), { kind: 'retry' })
  assert.equal(enteredOf(context)[0].payload.failure, spentPlan.failure)

  const throttled = createContext()
  apply(throttled, { longTermDelayMs: 5, defaultEnabled: true })
  const delegated = await dispatchFailure(throttled, {
    ...request,
    failure: { message: '429 request throttled, retry shortly', code: 'RATE_LIMIT' },
  })
  assert.equal(delegated, undefined)
  assert.equal(throttled.service.isRetrying(session), false)
  assert.equal(throttled.emitted.length, 0)
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
  const on = createContext()
  apply(on, { longTermDelayMs: 5 })
  assert.deepEqual(on.projections.view(session), { enabled: true, defaultEnabled: true, source: 'default' })
  const off = createContext()
  apply(off, { longTermDelayMs: 5, defaultEnabled: false })
  off.parents.set('probe-session', 'no-such-parent')
  assert.deepEqual(off.projections.view(session), { enabled: false, defaultEnabled: false, source: 'default' })
})

check('/quota-retry off and on move the switch and the projection follows', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  const disable = await context.commands.run(agent, 'off')
  assert.equal(disable.kind, 'success')
  assert.deepEqual(context.projections.view(session), { enabled: false, defaultEnabled: true, source: 'session' })
  const enable = await context.commands.run(agent, 'on')
  assert.equal(enable.kind, 'success')
  assert.deepEqual(context.projections.view(session), { enabled: true, defaultEnabled: true, source: 'session' })
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
  apply(context, { longTermDelayMs: 5, defaultEnabled: false })
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
  apply(first, { longTermDelayMs: 5, defaultEnabled: false })
  await first.commands.run(agent, 'on')
  await settled()
  assert.equal(store.get('probe-session').enabled, true)

  const second = createContext({ store, parents, withStorage: true })
  apply(second, { longTermDelayMs: 5, defaultEnabled: false })
  await settled()
  assert.deepEqual(second.projections.view(session), { enabled: true, defaultEnabled: false, source: 'session' })
})

check('without a storage domain the setting stays in the process', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: false })
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

check('a pooled session moves to a route with allowance and retries at once', async () => {
  const context = createContext()
  apply(context, {
    longTermDelayMs: 60_000,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] } },
    balances: [{ provider: 'second', script: ['probe-script'], minimumRemaining: 1 }],
  })
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'first', model: 'one' }), {
    provider: 'first',
    model: 'one',
  })

  const started = Date.now()
  const decision = await dispatchFailure(context, { ...request, provider: 'first' })
  assert.deepEqual(decision, { kind: 'retry' })
  assert.ok(Date.now() - started < 1_000, 'a route with allowance is taken now, not after the interval')

  const failover = context.emitted.find(entry => entry.event === 'llm-quota-retry/failover')
  assert.ok(failover !== undefined, 'the move is announced')
  assert.equal(failover.payload.from.provider, 'first')
  assert.equal(failover.payload.to.provider, 'second')
  assert.equal(failover.payload.pool, 'medium')
  assert.equal(enteredOf(context).length, 0, 'no long-term entry is opened when a route can take over')

  const after = await dispatchRequest(context, agent, { provider: 'first', model: 'one' })
  assert.deepEqual(after, { provider: 'second', model: 'two' },
    'the next request of that session is proposed on the replacement route')
})

check('a pool with nothing usable falls back to the long-term wait', async () => {
  const context = createContext()
  apply(context, {
    longTermDelayMs: 15,
    pools: { medium: { routes: [{ provider: 'only', model: 'solo' }] } },
  })
  await dispatchRequest(context, agent, { provider: 'only', model: 'solo' })
  const started = Date.now()
  const decision = await dispatchFailure(context, { ...request, provider: 'only' })
  assert.deepEqual(decision, { kind: 'retry' })
  assert.ok(Date.now() - started >= 15, 'the interval is what a single-route pool still uses')
  assert.equal(context.emitted.some(entry => entry.event === 'llm-quota-retry/failover'), false)
  assert.equal(enteredOf(context).length, 1)
})

check('the switch off leaves a pooled session on the route it proposed', async () => {
  const context = createContext()
  apply(context, {
    longTermDelayMs: 5,
    defaultEnabled: false,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] } },
  })
  await dispatchRequest(context, agent, { provider: 'first', model: 'one' })
  assert.equal(await dispatchFailure(context, { ...request, provider: 'first' }), undefined)
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'first', model: 'one' }), {
    provider: 'first',
    model: 'one',
  }, 'switching the plugin off for a session means it does not move that session')
})

check('a shared route is not guessed, and assignPool settles it', async () => {
  const context = createContext()
  apply(context, {
    longTermDelayMs: 60_000,
    pools: {
      left: { routes: [{ provider: 'both', model: 'either' }, { provider: 'fallback', model: 'backup' }] },
      right: { routes: [{ provider: 'both', model: 'either' }, { provider: 'other', model: 'spare' }] },
    },
  })
  await dispatchRequest(context, agent, { provider: 'both', model: 'either' })
  await dispatchFailure(context, { ...request, provider: 'both' })
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'both', model: 'either' }), {
    provider: 'both',
    model: 'either',
  }, 'two pools claim the route, so neither is applied to a session that named none')

  assert.equal(context.service.assignPool(session, 'left'), true)
  const moved = await dispatchRequest(context, agent, { provider: 'both', model: 'either' })
  assert.equal(moved.provider, 'fallback', 'the assigned pool decides, and it skips the exhausted route')
  assert.equal(context.service.assignPool(session, 'nowhere'), false, 'an unknown pool assigns nothing')
})

check('pickRoute reads the scripts, then answers in declared order from the cache', async () => {
  const scripts = createSubprocess(['{"remaining": 0}', '{"remaining": 9}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'low', model: 'l' }, { provider: 'high', model: 'h' }] } },
    balances: [
      { provider: 'low', script: ['probe-script'], minimumRemaining: 1 },
      { provider: 'high', script: ['probe-script'], minimumRemaining: 1 },
    ],
  })
  const chosen = await context.service.pickRoute('medium')
  assert.deepEqual(chosen, { provider: 'high', model: 'h' },
    'the route whose script reported no allowance is skipped')
  assert.equal(scripts.spawned.length, 2, 'both scripts ran')
  assert.deepEqual(scripts.spawned[0].argv, ['probe-script'])

  await context.service.pickRoute('medium')
  assert.equal(scripts.spawned.length, 2, 'a reading inside its refresh interval is not probed again')
  assert.equal(await context.service.pickRoute('unknown-pool'), undefined)
})

check('a failing balance script costs a reading, not the request', async () => {
  const scripts = createSubprocess([null])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'broken', model: 'b' }, { provider: 'other', model: 'o' }] } },
    balances: [{ provider: 'broken', script: ['probe-script'], minimumRemaining: 1 }],
  })
  // A script that fails leaves the provider with no reading, which fail-open
  // treats as usable: the pool's declared order still answers.
  const chosen = await context.service.pickRoute('medium')
  assert.deepEqual(chosen, { provider: 'broken', model: 'b' })
  assert.equal(context.service.report().length, 1)
})

check('/quota-routes reports pools, readings, and exhaustion marks', async () => {
  const scripts = createSubprocess(['{"remaining": 4, "resetsAt": "2026-01-01T00:00:00.000Z"}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    longTermDelayMs: 5,
    pools: {
      medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] },
      empty: { routes: [{ provider: 'third', model: 'three' }] },
    },
    balances: [{ provider: 'first', script: ['probe-script'], minimumRemaining: 1, unit: 'percent' }],
  })
  await dispatchRequest(context, agent, { provider: 'first', model: 'one' })
  await dispatchFailure(context, { ...request, provider: 'first' })

  const text = (await context.commands.runNamed('quota-routes', '')).text
  assert.match(text, /pool "medium"/)
  assert.match(text, /no\s+first\/one — 4, resets 2026-01-01T00:00:00.000Z \[exhausted /)
  assert.match(text, /ok\s+second\/two — no reading/)
  assert.match(text, /pool "empty"/)
  const narrowed = (await context.commands.runNamed('quota-routes', 'empty')).text
  assert.match(narrowed, /pool "empty"/)
  assert.equal(/pool "medium"/.test(narrowed), false)
  assert.match((await context.commands.runNamed('quota-routes', 'nope')).text, /no pool named "nope"; configured pools: medium, empty/)
})

check('the published service keeps its retry surface and adds the route surface', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  assert.deepEqual(Object.keys(context.service).sort(), ['assignPool', 'isRetrying', 'pickRoute', 'report', 'stateOf'])
  assert.deepEqual(context.service.report(), [])
  assert.equal(await context.service.pickRoute('nothing'), undefined)
  assert.equal(context.service.assignPool(session, 'nothing'), false)
})

check('a balance script receives the credential its apiKeyEnv names', async () => {
  const scripts = createSubprocess(['{"remaining": 3}'])
  const resolved = []
  const context = createContext({
    subprocess: scripts,
    credentials: {
      resolve: async (ref) => {
        resolved.push(ref)
        return ref === 'PROBE_KEY' ? { value: 'resolved-secret', source: 'file' } : undefined
      },
    },
  })
  apply(context, {
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }] } },
    balances: [{ provider: 'first', script: ['probe-script'], apiKeyEnv: 'PROBE_KEY', minimumRemaining: 1 }],
  })
  assert.deepEqual(await context.service.pickRoute('medium'), { provider: 'first', model: 'one' })
  assert.deepEqual(resolved, ['PROBE_KEY'], 'the reference is resolved per run, not cached')
  assert.deepEqual(scripts.spawned[0].env, { PROBE_KEY: 'resolved-secret' })
})

check('an unconfigured credential leaves the script to report it', async () => {
  const scripts = createSubprocess(['{"remaining": 3}'])
  const context = createContext({
    subprocess: scripts,
    credentials: { resolve: async () => undefined },
  })
  apply(context, {
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }] } },
    balances: [
      { provider: 'first', script: ['probe-script'], apiKeyEnv: 'MISSING_KEY', minimumRemaining: 1, env: { HINT: 'x' } },
    ],
  })
  assert.deepEqual(await context.service.pickRoute('medium'), { provider: 'first', model: 'one' })
  assert.deepEqual(scripts.spawned[0].env, { HINT: 'x' }, 'a missing credential adds no entry, and the row env still arrives')
})

for (const { name, run } of checks) {
  await run()
  console.log(`ok  ${name}`)
}
console.log(`\n${checks.length} probe checks passed`)
