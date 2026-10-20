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
  const listeners = new Set()
  return {
    definitions,
    register(definition) {
      definitions.set(definition.key, definition)
      return () => definitions.delete(definition.key)
    },
    /** The Host's change feed, for a delegator publishing its children. */
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** One delegating Session publishing a view, as the Host would announce it. */
    publish(session, key, value) {
      for (const listener of listeners) listener(session, key, value, 0)
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
    runNamed(name, rawInput, agent = undefined) {
      const definition = commands.get(name)
      assert.ok(definition !== undefined, `the plugin must register /${name}`)
      return definition.handler({ agent, rawInput })
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
function createContext({ store = new Map(), parents = new Map(), withStorage = false, subprocess = null, credentials = null, agents = new Map() } = {}) {
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
  if (agents.size > 0) services.set('agents', { get: id => agents.get(id) })

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
 * @param signal - the turn-abort signal the payload carries; omitted when the
 *   proposal carries none, which is what a caller that predates the field does.
 * @returns the config the request goes out with.
 */
async function dispatchRequest(context, caller, proposal, signal = undefined) {
  const chain = [...(context.hooks.get('agent/request') ?? [])]
  const run = index => index >= chain.length
    ? Promise.resolve(proposal)
    : chain[index]({ agent: caller, signal }, () => run(index + 1))
  return run(0)
}

/** Await the microtask and timer queues, so the storage domain's `open()` settles. */
async function settled() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Session events the fake Session recorded, in order. */
const appended = []

/**
 * The expected client value for a Session whose route pool is untouched.
 * @param enabled - the effective retry switch.
 * @param source - where the switch came from.
 * @param defaultEnabled - the deployment default.
 * @param pools - the configured pool names.
 * @returns the full expected projection value.
 */
function switchView(enabled, source, defaultEnabled, pools = []) {
  return { enabled, defaultEnabled, source, pool: null, poolSource: 'default', pools }
}

/**
 * One fake Session.
 * @param id - the Session id.
 * @param parent - its direct parent, absent for a top-level Session.
 * @returns the fake Session.
 */
function fakeSession(id, parent) {
  return {
    id,
    header: { id, ...(parent === undefined ? {} : { parentSession: parent }) },
    append(type, data) {
      appended.push({ id, type, data })
      return { type, seq: appended.length, time: Date.now(), data }
    },
  }
}

const session = fakeSession('probe-session')
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
  assert.equal(DEFAULT_ENABLED, false, 'a session that owns no setting starts off')
  assert.deepEqual(resolvePolicy({}), {
    longTermDelayMs: 3_600_000,
    defaultEnabled: false,
    nativeRetryFirstProviders: [],
    delegatedChildren: [],
  })
  assert.deepEqual(resolvePolicy({ longTermDelayMs: 1000, defaultEnabled: true }), {
    longTermDelayMs: 1000,
    defaultEnabled: true,
    nativeRetryFirstProviders: [],
    delegatedChildren: [],
  })
})

check('delegated work is declared as projection sources, or not at all', () => {
  assert.deepEqual(
    resolvePolicy({ delegatedChildren: [{ projectionKey: 'subagentTemplates' }] }).delegatedChildren,
    [{ projectionKey: 'subagentTemplates', rowsField: 'children', sessionIdField: 'childSessionId' }],
    'the field names a delegator publishes are the defaults',
  )
  assert.throws(() => resolvePolicy({ delegatedChildren: 'subagentTemplates' }), /must be an array of projection sources/)
  assert.throws(() => resolvePolicy({ delegatedChildren: [null] }), /delegatedChildren\[0\] must be an object/)
  assert.throws(() => resolvePolicy({ delegatedChildren: [{}] }), /projectionKey must be a non-empty string/)
  assert.throws(
    () => resolvePolicy({ delegatedChildren: [{ projectionKey: 'a', nameField: 'name' }] }),
    /delegatedChildren\[0\] has unknown key "nameField"/,
    'a field this plugin never reads is a configuration error, not a hint',
  )
  assert.throws(() => resolvePolicy({ delegatedChildren: [{ projectionKey: 'a', rowsField: '' }] }), /field names must be non-empty strings/)
  assert.throws(
    () => resolvePolicy({ delegatedChildren: [{ projectionKey: 'a' }, { projectionKey: 'a' }] }),
    /names projection "a" twice/,
  )
})

check('the switch is off by default and on for work the deployment declares delegated', () => {
  const parent = fakeSession('probe-parent')
  // A delegator that keeps its children looking like full sessions gives them a
  // root header: no depth, no subagent origin.
  const child = fakeSession('probe-child', 'probe-parent')
  const subagent = fakeSession('probe-subagent')
  subagent.header = { id: 'probe-subagent', delegationDepth: 1 }
  const agents = new Map([
    ['probe-parent', { session: parent }],
    ['probe-child', { session: child }],
    ['probe-subagent', { session: subagent }],
  ])

  const declared = createContext({ agents })
  apply(declared, { longTermDelayMs: 5, delegatedChildren: [{ projectionKey: 'subagentTemplates' }] })
  declared.projections.publish(parent, 'subagentTemplates', {
    children: [{ childSessionId: 'probe-child', name: 'Medium' }],
  })
  assert.equal(declared.projections.stateOf(subagent).enabled, true, 'a header that says subagent is delegated work')
  assert.equal(declared.projections.stateOf(child).enabled, true, 'a root session the delegator names is delegated work too')
  assert.equal(declared.projections.stateOf(parent).enabled, false, 'the delegating conversation itself is left alone')

  declared.projections.publish(parent, 'subagentTemplates', { children: [] })
  assert.equal(
    declared.projections.stateOf(child).enabled,
    false,
    'a delegator that no longer names the child hands it back to the default',
  )

  const undeclared = createContext({ agents })
  apply(undeclared, { longTermDelayMs: 5 })
  undeclared.projections.publish(parent, 'subagentTemplates', {
    children: [{ childSessionId: 'probe-child', name: 'Medium' }],
  })
  assert.equal(undeclared.projections.stateOf(subagent).enabled, true, 'a subagent needs no configuration')
  assert.equal(
    undeclared.projections.stateOf(child).enabled,
    false,
    'a root session whose projection the deployment declared no source for is not delegated work',
  )
  assert.equal(undeclared.projections.stateOf(parent).enabled, false)
})

check('the native-first provider list takes harness provider ids, once each', () => {
  assert.deepEqual(resolvePolicy({ nativeRetryFirstProviders: ['qwen', 'kimi'] }).nativeRetryFirstProviders, [
    'qwen',
    'kimi',
  ])
  assert.throws(() => resolvePolicy({ nativeRetryFirstProviders: 'qwen' }), /must be an array of provider ids/)
  assert.throws(() => resolvePolicy({ nativeRetryFirstProviders: ['qwen', ''] }), /only non-empty provider ids/)
  assert.throws(() => resolvePolicy({ nativeRetryFirstProviders: ['qwen', 'qwen'] }), /names provider "qwen" twice/)
  assert.equal(
    Object.isFrozen(resolvePolicy({ nativeRetryFirstProviders: ['qwen'] }).nativeRetryFirstProviders),
    true,
    'a deployment cannot add a provider to the list after activation',
  )
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
  const omitted = createContext()
  apply(omitted, { longTermDelayMs: 5 })
  assert.deepEqual(omitted.projections.view(session), {
    enabled: false,
    defaultEnabled: false,
    source: 'default',
    pool: null,
    poolSource: 'default',
    pools: [],
  }, 'a Session that owns no setting starts off, so this plugin never redraws a picker')
  const on = createContext()
  apply(on, { longTermDelayMs: 5, defaultEnabled: true })
  assert.deepEqual(on.projections.view(session), {
    enabled: true,
    defaultEnabled: true,
    source: 'default',
    pool: null,
    poolSource: 'default',
    pools: [],
  })
  const off = createContext()
  apply(off, { longTermDelayMs: 5, defaultEnabled: false })
  off.parents.set('probe-session', 'no-such-parent')
  assert.deepEqual(off.projections.view(session), {
    enabled: false,
    defaultEnabled: false,
    source: 'default',
    pool: null,
    poolSource: 'default',
    pools: [],
  })
})

check('/quota-retry off and on move the switch and the projection follows', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  const disable = await context.commands.run(agent, 'off')
  assert.equal(disable.kind, 'success')
  assert.deepEqual(context.projections.view(session), {
    enabled: false,
    defaultEnabled: true,
    source: 'session',
    pool: null,
    poolSource: 'default',
    pools: [],
  })
  const enable = await context.commands.run(agent, 'on')
  assert.equal(enable.kind, 'success')
  assert.deepEqual(context.projections.view(session), {
    enabled: true,
    defaultEnabled: true,
    source: 'session',
    pool: null,
    poolSource: 'default',
    pools: [],
  })
})

check('/quota-retry default restores the deployment default, and status reports it', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true })
  await context.commands.run(agent, 'off')
  const restored = await context.commands.run(agent, 'default')
  assert.equal(restored.kind, 'success')
  assert.deepEqual(context.projections.view(session), {
    enabled: true,
    defaultEnabled: true,
    source: 'default',
    pool: null,
    poolSource: 'default',
    pools: [],
  })
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
  assert.deepEqual(context.projections.view(child), switchView(true, 'inherited', false))
  // The inherited snapshot is this session's own value, so the origin stays visible.
  const cleared = await context.commands.run({ session: child }, 'default')
  assert.equal(cleared.kind, 'success')
  assert.deepEqual(context.projections.view(child), switchView(false, 'default', false))
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
  assert.deepEqual(second.projections.view(session), switchView(true, 'session', false))
})

check('without a storage domain the setting stays in the process', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: false })
  await context.commands.run(agent, 'on')
  assert.deepEqual(context.projections.view(session), switchView(true, 'session', false))
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
    defaultEnabled: true,
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

check('a reading below the threshold leaves a running session where it is', async () => {
  const scripts = createSubprocess(['{"remaining": 0}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] } },
    balances: [{ provider: 'first', script: ['probe-script'], minimumRemaining: 1 }],
  })
  assert.deepEqual(
    await context.service.pickRoute('medium'),
    { provider: 'second', model: 'two' },
    'a session that has not started avoids the route below its threshold',
  )
  // A model no pool holds is what a session starts on before it is moved onto one,
  // so its next request is the one that has to be left alone.
  await dispatchRequest(context, agent, { provider: 'elsewhere', model: 'elsewhere' })
  assert.deepEqual(
    await dispatchRequest(context, agent, { provider: 'first', model: 'one' }),
    { provider: 'first', model: 'one' },
    'a session already running on it is not interrupted for a threshold',
  )
})

check('a pool with nothing usable falls back to the long-term wait', async () => {
  const context = createContext()
  apply(context, {
    defaultEnabled: true,
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

check('a shared route is not guessed, and setPool settles it', async () => {
  const context = createContext()
  apply(context, {
    defaultEnabled: true,
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

  assert.equal(context.service.setPool(session, 'left'), true)
  const moved = await dispatchRequest(context, agent, { provider: 'both', model: 'either' })
  assert.equal(moved.provider, 'fallback', 'the stated pool decides, and it skips the exhausted route')
  assert.equal(context.service.setPool(session, 'nowhere'), false, 'an unknown pool sets nothing')
})

check('pickRoute reads the scripts, then answers from what they reported', async () => {
  const scripts = createSubprocess(['{"remaining": 0}', '{"remaining": 9}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
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

  assert.deepEqual(await context.service.pickRoute('medium'), { provider: 'high', model: 'h' })
  assert.equal(scripts.spawned.length, 2, 'a reading inside its refresh interval is not asked for again')
  assert.equal(await context.service.pickRoute('unknown-pool'), undefined)
})

check('a failing balance script costs a reading, not the request', async () => {
  const scripts = createSubprocess([null])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
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
    defaultEnabled: true,
    longTermDelayMs: 5,
    pools: {
      medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] },
      empty: { routes: [{ provider: 'third', model: 'three' }] },
      held: {
        midSessionSwitch: false,
        routes: [{ provider: 'fourth', model: 'four' }],
      },
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
  assert.match(text, /pool "held" \(refuses mid-session switching\):/,
    'the report says why a pool never moves a Session by itself')
  const narrowed = (await context.commands.runNamed('quota-routes', 'empty')).text
  assert.match(narrowed, /pool "empty"/)
  assert.equal(/pool "medium"/.test(narrowed), false)
  assert.match(
    (await context.commands.runNamed('quota-routes', 'nope')).text,
    /no pool named "nope"; configured pools: medium, empty, held/,
  )
})

check('the published service keeps its retry surface and adds the route surface', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5 })
  assert.deepEqual(
    Object.keys(context.service).sort(),
    ['isRetrying', 'pickRoute', 'poolOf', 'report', 'setPool', 'stateOf'],
  )
  assert.deepEqual(context.service.report(), [])
  assert.equal(await context.service.pickRoute('nothing'), undefined)
  assert.equal(context.service.setPool(session, 'nothing'), false)
  assert.equal(context.service.poolOf(session), undefined)
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
    defaultEnabled: true,
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
    defaultEnabled: true,
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }] } },
    balances: [
      { provider: 'first', script: ['probe-script'], apiKeyEnv: 'MISSING_KEY', minimumRemaining: 1, env: { HINT: 'x' } },
    ],
  })
  assert.deepEqual(await context.service.pickRoute('medium'), { provider: 'first', model: 'one' })
  assert.deepEqual(scripts.spawned[0].env, { HINT: 'x' }, 'a missing credential adds no entry, and the row env still arrives')
})

check('choosing a route probes only that pool\'s providers', async () => {
  const scripts = createSubprocess(['{"remaining": 0}', '{"remaining": 0}', '{"remaining": 0}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 5,
    pools: {
      first: { routes: [{ provider: 'inside', model: 'i' }] },
      second: { routes: [{ provider: 'outside', model: 'o' }] },
    },
    balances: [
      { provider: 'inside', script: ['probe-script'], minimumRemaining: 1 },
      { provider: 'outside', script: ['probe-script'], minimumRemaining: 1 },
    ],
  })
  assert.deepEqual(await context.service.pickRoute('second'), { provider: 'outside', model: 'o' })
  const probed = scripts.spawned.map(spec => spec.argv[0])
  assert.deepEqual(probed, ['probe-script'], 'only the asked pool\'s provider ran its script')
  // The first pool's own provider is still unread, so asking for it probes now.
  await context.service.pickRoute('first')
  assert.equal(scripts.spawned.length, 2)
})

check('pickRoute draws a route in proportion to what each one has left', async () => {
  const scripts = createSubprocess([
    JSON.stringify({ remaining: 90, windows: [{ name: 'five-hour', remaining: 90, capacity: 100 }] }),
    JSON.stringify({ remaining: 30, windows: [{ name: 'five-hour', remaining: 30, capacity: 100 }] }),
  ])
  const context = createContext({ subprocess: scripts })
  let draw = 0.5
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'rich', model: 'r' }, { provider: 'poor', model: 'p' }] } },
    balances: [
      { provider: 'rich', script: ['probe-script'] },
      { provider: 'poor', script: ['probe-script'] },
    ],
  }, { random: () => draw })

  // Weights 0.9 and 0.3: the first three quarters of the range are the richer route.
  assert.deepEqual(await context.service.pickRoute('medium'), { provider: 'rich', model: 'r' })
  draw = 0.76
  assert.deepEqual(await context.service.pickRoute('medium'), { provider: 'poor', model: 'p' },
    'the rest of the range belongs to the poorer route')

  const report = context.service.report()
  assert.equal(report[0].routes[0].score, 0.9)
  assert.equal(report[0].routes[1].score, 0.3)
  const text = (await context.commands.runNamed('quota-routes', 'medium')).text
  assert.match(text, /rich\/r — 90 \(score 0\.900\)/)
  assert.match(text, /poor\/p — 30 \(score 0\.300\)/)
})

check('a failover draws from the scored routes, and an unread one is only a fallback', async () => {
  const medium = {
    routes: [
      { provider: 'first', model: 'one' },
      { provider: 'second', model: 'two' },
      { provider: 'third', model: 'three' },
    ],
  }

  /**
   * Start a session on the pool's own draw, then fail the route it started on and
   * answer where the retry went.
   * @param startDraw - the sample the starting draw is given.
   * @param draw - the sample the failover draw is given.
   * @param readings - one script output per balance row, in declared order.
   * @param balances - the balance rows of this scenario.
   * @returns the provider the failed request was moved to.
   */
  async function failoverFrom(startDraw, draw, readings, balances) {
    const context = createContext({ subprocess: createSubprocess([...readings]) })
    let sample = startDraw
    apply(context, { longTermDelayMs: 60_000, defaultEnabled: true, pools: { medium }, balances }, { random: () => sample })
    await context.service.pickRoute('medium')
    // The first request is the starting draw, so the session is already running on
    // the route the failover below has to leave.
    const started = await dispatchRequest(context, agent, { provider: 'first', model: 'one' })
    sample = draw
    const before = context.emitted.length
    assert.deepEqual(await dispatchFailure(context, { ...request, provider: started.provider }), { kind: 'retry' })
    const moved = context.emitted.slice(before).find(entry => entry.event === 'llm-quota-retry/failover')
    assert.ok(moved !== undefined, 'the failed request moved to another route of its pool')
    return moved.payload.to.provider
  }

  const readings = [
    '{"remaining": 80, "windows": [{"name": "weekly", "remaining": 80, "capacity": 100}]}',
    '{"remaining": 40, "windows": [{"name": "weekly", "remaining": 40, "capacity": 100}]}',
    '{"remaining": 20, "windows": [{"name": "weekly", "remaining": 20, "capacity": 100}]}',
  ]
  const balances = [
    { provider: 'first', script: ['probe-script'] },
    { provider: 'second', script: ['probe-script'] },
    { provider: 'third', script: ['probe-script'] },
  ]
  assert.equal(await failoverFrom(0, 0.99, readings, balances), 'third',
    'the two weights left add up to the whole range, and the smaller one holds its end')
  assert.equal(await failoverFrom(0, 0.5, readings, balances), 'second',
    'half of the range is the route with half the headroom of the one above it')

  assert.equal(
    await failoverFrom(
      0,
      0.999,
      [readings[0]],
      [{ provider: 'first', script: ['probe-script'] }],
    ),
    'second',
    'an unread route is unknown rather than plentiful, so declared order decides between two of them',
  )
})

check('a pool that refuses mid-session switching waits where the session is', async () => {
  const context = createContext()
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: {
      held: {
        midSessionSwitch: false,
        routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }],
      },
    },
  })
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'first', model: 'one' }), {
    provider: 'first',
    model: 'one',
  }, 'with nothing scored, the pool\'s declared order answers the session\'s start')
  const pending = dispatchFailure(context, { ...request, provider: 'first' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(
    context.emitted.some(entry => entry.event === 'llm-quota-retry/failover'),
    false,
    'the plugin does not move a session of a pool that refuses it',
  )
  assert.equal(enteredOf(context).length, 1, 'the exhausted allowance is waited out where it is')
  await context.dispose()
  assert.equal(await pending, undefined)
})

check('a session that has not started is drawn from its pool by headroom', async () => {
  const scripts = createSubprocess(['{"remaining": 20}', '{"remaining": 80}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: { medium: { routes: [{ provider: 'rich', model: 'r' }, { provider: 'poor', model: 'p' }] } },
    balances: [
      { provider: 'rich', script: ['probe-script'], capacity: 100 },
      { provider: 'poor', script: ['probe-script'], capacity: 100 },
    ],
  }, { random: () => 0.9 })
  await context.service.pickRoute('medium')
  assert.deepEqual(
    await dispatchRequest(context, agent, { provider: 'rich', model: 'r' }),
    { provider: 'poor', model: 'p' },
    'the route a session starts on is drawn from the pool, not taken from the model it was created with',
  )
  assert.deepEqual(
    await dispatchRequest(context, agent, { provider: 'poor', model: 'p' }),
    { provider: 'poor', model: 'p' },
    'a session that has started keeps its route while that provider still has allowance',
  )
  await context.dispose()
})

check('a pool that refuses mid-session switching still starts a session by headroom', async () => {
  const scripts = createSubprocess(['{"remaining": 80}', '{"remaining": 20}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: {
      held: {
        midSessionSwitch: false,
        routes: [{ provider: 'rich', model: 'r' }, { provider: 'poor', model: 'p' }],
      },
    },
    balances: [
      { provider: 'rich', script: ['probe-script'], capacity: 100 },
      { provider: 'poor', script: ['probe-script'], capacity: 100 },
    ],
  }, { random: () => 0.9 })
  await context.service.pickRoute('held')
  const started = await dispatchRequest(context, agent, { provider: 'rich', model: 'r' })
  assert.deepEqual(started, { provider: 'poor', model: 'p' },
    'choosing the route a session starts on is not a mid-session switch')
  const pending = dispatchFailure(context, { ...request, provider: 'poor' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(
    context.emitted.some(entry => entry.event === 'llm-quota-retry/failover'),
    false,
    'and the pool still refuses to move it once it is running',
  )
  await context.dispose()
  assert.equal(await pending, undefined)
})

check('a route the pool drew survives the model-selection cache the Host resolves first', async () => {
  const scripts = createSubprocess(['{"remaining": 0}', '{"remaining": 50}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: {
      held: {
        midSessionSwitch: false,
        routes: [{ provider: 'qwen', model: 'q' }, { provider: 'kimi', model: 'k' }],
      },
    },
    balances: [
      { provider: 'qwen', script: ['probe-script'], minimumRemaining: 1 },
      { provider: 'kimi', script: ['probe-script'], minimumRemaining: 1 },
    ],
  })
  // The Host's `installModelSelection` registers a listener per Agent, after this
  // plugin, and resolves every request from the selection captured at prompt
  // assembly. A route a request never used stays in that cache, so the cache
  // proposes the pre-move route again until some request actually uses it.
  const picked = { provider: 'qwen', model: 'q' }
  context.on('agent/request', async (_payload, next) => ({ ...await next(), ...picked }))
  assert.deepEqual(await dispatchRequest(context, agent, { ...picked }), { provider: 'kimi', model: 'k' },
    'the starting route is drawn from the pool')
  assert.deepEqual(await dispatchRequest(context, agent, { ...picked }), { provider: 'kimi', model: 'k' },
    'and the next request keeps it instead of falling back to the cache')
  assert.deepEqual(await dispatchRequest(context, agent, { ...picked }), { provider: 'kimi', model: 'k' })
  await context.dispose()
})

check('a model the user selects ends the route this plugin applied', async () => {
  const scripts = createSubprocess(['{"remaining": 0}', '{"remaining": 50}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: {
      held: {
        midSessionSwitch: false,
        routes: [{ provider: 'qwen', model: 'q' }, { provider: 'kimi', model: 'k' }],
      },
    },
    balances: [
      { provider: 'qwen', script: ['probe-script'], minimumRemaining: 1 },
      { provider: 'kimi', script: ['probe-script'], minimumRemaining: 1 },
    ],
  })
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'qwen', model: 'q' }), {
    provider: 'kimi',
    model: 'k',
  })
  // The model picker appends `model/selection`; that event, not the proposal the
  // Host resolves, is what says a person chose a model.
  dispatchSessionEvent(context, session, {
    type: 'model/selection',
    seq: appended.length + 1,
    time: Date.now(),
    data: { provider: 'qwen', model: 'q' },
  })
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'qwen', model: 'q' }), {
    provider: 'qwen',
    model: 'q',
  }, 'a model the user picks is left alone even while this plugin still holds its own route')
  await context.dispose()
})

check('a starting session waits for its pool\'s balance scripts before it is routed', async () => {
  const scripts = createSubprocess(['{"remaining": 0}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: {
      medium: { routes: [{ provider: 'inside', model: 'i' }, { provider: 'spare', model: 's' }] },
      other: { routes: [{ provider: 'outside', model: 'o' }] },
    },
    balances: [
      { provider: 'inside', script: ['probe-script'], minimumRemaining: 1 },
      { provider: 'spare', script: ['probe-script'] },
      { provider: 'outside', script: ['probe-script'] },
    ],
  })
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'inside', model: 'i' }), {
    provider: 'spare',
    model: 's',
  }, 'a route the pool has just been told is spent is not the one the request starts on')
  assert.equal(scripts.spawned.length, 2, 'both of that pool\'s scripts ran, and the request waited for them')
  assert.equal(context.service.report().find(pool => pool.name === 'other').routes[0].reading, undefined,
    'and no provider outside that pool is probed')
  await context.dispose()
})

check('a cancelled turn stops waiting for a probe without cutting it off', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const spawned = []
  // A script whose run stays open until released, so the turn really is waiting
  // on it when the abort arrives.
  const scripts = {
    spawned,
    spawn(spec) {
      spawned.push(spec)
      return {
        done: gate.then(() => ({ exitCode: 0, signal: null })),
        collected: {
          stdout: { readFrom: () => ({ text: '{"remaining": 0}', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        terminate() {},
        waitForExit: () => Promise.resolve(true),
      }
    },
  }
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: { medium: { routes: [{ provider: 'inside', model: 'i' }] } },
    balances: [{ provider: 'inside', script: ['probe-script'], minimumRemaining: 1 }],
  })
  const controller = new AbortController()
  const pending = dispatchRequest(context, agent, { provider: 'inside', model: 'i' }, controller.signal)
  await settled()
  assert.equal(spawned.length, 1, 'the turn is waiting on the script')
  controller.abort()
  assert.deepEqual(await pending, { provider: 'inside', model: 'i' },
    'the cancelled turn stops waiting and answers on the readings it already had')
  assert.equal(context.service.report()[0].routes[0].reading, undefined,
    'the script it gave up on had reported nothing yet')
  release()
  await settled()
  assert.equal(context.service.report()[0].routes[0].reading.remaining, 0,
    'and the script it gave up on still ran to its end')
  await context.dispose()
})

check('a request proposal carrying no signal is still routed from a reading', async () => {
  const scripts = createSubprocess(['{"remaining": 0}'])
  const context = createContext({ subprocess: scripts })
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: { medium: { routes: [{ provider: 'inside', model: 'i' }, { provider: 'spare', model: 's' }] } },
    balances: [
      { provider: 'inside', script: ['probe-script'], minimumRemaining: 1 },
      { provider: 'spare', script: ['probe-script'] },
    ],
  })
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'inside', model: 'i' }), {
    provider: 'spare',
    model: 's',
  }, 'a payload with nothing to cancel it waits for the reading rather than throwing on its absence')
  assert.equal(scripts.spawned.length, 2, 'and it is routed from the script that reported')
  await context.dispose()
})

check('a pool that refuses mid-session switching still moves a session the user puts in it', async () => {
  const context = createContext()
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 5,
    pools: {
      held: {
        midSessionSwitch: false,
        routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }],
      },
    },
  })
  await dispatchRequest(context, agent, { provider: 'third', model: 'three' })
  const outcome = await context.commands.runNamed('quota-pool', 'held', agent)
  assert.equal(outcome.kind, 'success')
  assert.deepEqual(
    await dispatchRequest(context, agent, { provider: 'third', model: 'three' }),
    { provider: 'first', model: 'one' },
    'setting the pool is the user asking for its route, which the refusal does not cover',
  )
})

check('/quota-pool states a pool, and the next request moves into it', async () => {
  const context = createContext()
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] } },
  })
  // The session is on a model no pool holds, so nothing moves it until it is pooled.
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'other', model: 'elsewhere' }), {
    provider: 'other',
    model: 'elsewhere',
  })
  const before = appended.length
  const outcome = await context.commands.runNamed('quota-pool', 'medium', agent)
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /route pool "medium" governs this session/)
  assert.match(outcome.text, /its next request uses first\/one/)
  assert.equal(context.projections.view(session).pool, 'medium')
  assert.equal(context.projections.view(session).poolSource, 'session')
  // Choosing a pool is choosing to leave the model the session was on.
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'other', model: 'elsewhere' }), {
    provider: 'first',
    model: 'one',
  })
  assert.deepEqual(appended.slice(before), [{
    id: 'probe-session',
    type: 'model/selection',
    data: { provider: 'first', model: 'one' },
  }], 'the session records the route a pool chose, so the model picker follows')
  // The choice was spent: a later request is not re-chosen behind the user.
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'first', model: 'one' }), {
    provider: 'first',
    model: 'one',
  })
})

check('/quota-pool off stops route moves, and default clears the pool', async () => {
  const context = createContext()
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 5,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] } },
  })
  await context.commands.runNamed('quota-pool', 'medium', agent)
  assert.equal((await context.commands.runNamed('quota-pool', 'off', agent)).kind, 'success')
  assert.equal(context.projections.view(session).pool, null)
  assert.equal(context.projections.view(session).poolSource, 'off')
  // Even an exhausted route is left alone now: the opt-out is the whole response.
  await dispatchRequest(context, agent, { provider: 'first', model: 'one' })
  assert.deepEqual(await dispatchFailure(context, { ...request, provider: 'first' }), { kind: 'retry' })
  assert.equal(enteredOf(context).length, 1, 'the exhausted allowance is waited out instead')
  assert.equal(context.emitted.some(entry => entry.event === 'llm-quota-retry/failover'), false)
  assert.deepEqual(await dispatchRequest(context, agent, { provider: 'first', model: 'one' }), {
    provider: 'first',
    model: 'one',
  })

  const back = await context.commands.runNamed('quota-pool', 'default', agent)
  assert.equal(back.kind, 'success')
  assert.equal(context.projections.view(session).poolSource, 'default')
})

check('/quota-pool rejects an unknown pool and reports status', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true, pools: { medium: { routes: [{ provider: 'first', model: 'one' }] } } })
  const bad = await context.commands.runNamed('quota-pool', 'nope', agent)
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /expected one of medium, off, default, or status/)
  const status = await context.commands.runNamed('quota-pool', 'status', agent)
  assert.match(status.text, /route pool \(none\) — no pool governs this session/)
  assert.match(status.text, /configured pools: medium/)
  await dispatchRequest(context, agent, { provider: 'first', model: 'one' })
  const inferred = await context.commands.runNamed('quota-pool', 'status', agent)
  assert.match(inferred.text, /route pool "medium" — inferred from the route this session is on/)
  assert.match(inferred.text, /this session is on first\/one/)
})

check('a stated pool survives a host restart through the storage domain', async () => {
  const store = new Map()
  const parents = new Map()
  const pools = { medium: { routes: [{ provider: 'first', model: 'one' }] } }
  const first = createContext({ store, parents, withStorage: true })
  apply(first, { longTermDelayMs: 5, defaultEnabled: true, pools })
  await first.commands.runNamed('quota-pool', 'medium', agent)
  await settled()
  assert.equal(store.get('probe-session').pool, 'medium')

  const second = createContext({ store, parents, withStorage: true })
  apply(second, { longTermDelayMs: 5, defaultEnabled: true, pools })
  await settled()
  assert.equal(second.projections.view(session).pool, 'medium')
  assert.equal(second.projections.view(session).poolSource, 'session')
})

check('a forked session inherits the pool its nearest ancestor stated', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 5, defaultEnabled: true, pools: { medium: { routes: [{ provider: 'first', model: 'one' }] } } })
  const parent = fakeSession('parent-session', 'grandparent-session')
  context.parents.set('child-session', 'parent-session')
  await context.commands.runNamed('quota-pool', 'medium', { session: parent })
  const child = fakeSession('child-session', 'parent-session')
  assert.equal(context.projections.view(child).pool, 'medium')
  assert.equal(context.projections.view(child).poolSource, 'inherited')
})

check('a failover records the route it moves to on the session', async () => {
  const context = createContext()
  apply(context, {
    defaultEnabled: true,
    longTermDelayMs: 60_000,
    pools: { medium: { routes: [{ provider: 'first', model: 'one' }, { provider: 'second', model: 'two' }] } },
  })
  await dispatchRequest(context, agent, { provider: 'first', model: 'one' })
  const before = appended.length
  assert.deepEqual(await dispatchFailure(context, { ...request, provider: 'first' }), { kind: 'retry' })
  assert.deepEqual(appended.slice(before), [{
    id: 'probe-session',
    type: 'model/selection',
    data: { provider: 'second', model: 'two' },
  }], 'the model picker follows the retry')
})

/** A resolved normal-mode policy with the shortest waits these checks can time. */
function nativePolicy(maxRetries) {
  return {
    mode: 'normal',
    maxRetries,
    retryableCodes: ['EMPTY_RESPONSE', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 20,
    maxDelayMs: 40,
    jitterRatio: 0,
  }
}

/** One `llm/retry` event, as `@deepseek-ai/dsh-llm-retry` appends it. */
function nativeRetryEvent(overrides) {
  return {
    type: 'llm/retry',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, provider: 'probe-provider', ...overrides },
  }
}

check('a named provider runs its own native schedule, then hands over to the hourly wait', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true, nativeRetryFirstProviders: ['probe-provider'] })
  const policy = nativePolicy(2)

  const first = Date.now()
  assert.deepEqual(await dispatchFailure(context, { ...request, retryPolicy: policy }), { kind: 'retry' })
  const firstWait = Date.now() - first
  assert.ok(firstWait >= 20 && firstWait < 1_000, `the first attempt waits the policy's 20ms, waited ${firstWait}ms`)

  const second = Date.now()
  assert.deepEqual(await dispatchFailure(context, { ...request, retryPolicy: policy }), { kind: 'retry' })
  const secondWait = Date.now() - second
  assert.ok(secondWait >= 40 && secondWait < 1_000, `the second attempt doubles to 40ms, waited ${secondWait}ms`)

  assert.equal(context.service.isRetrying(session), false, 'a quick retry is not a long-term entry')
  assert.equal(enteredOf(context).length, 0)
  assert.equal(
    context.emitted.some(entry => entry.event === 'llm-quota-retry/failover'),
    false,
    'a throttled provider is not moved off',
  )

  const appendedBefore = appended.length
  const exhausted = dispatchFailure(context, { ...request, retryPolicy: policy })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(enteredOf(context).length, 1, 'a spent quick budget opens the long-term entry instead')
  assert.deepEqual(appended.slice(appendedBefore), [], 'nothing moved the session off its route')
  await context.dispose()
  assert.equal(await exhausted, undefined)
})

check('the quick budget is spent per step, not per session', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true, nativeRetryFirstProviders: ['probe-provider'] })
  const policy = nativePolicy(1)
  assert.deepEqual(await dispatchFailure(context, { ...request, retryPolicy: policy }), { kind: 'retry' })
  const nextStep = await dispatchFailure(context, { ...request, retryPolicy: policy, step: 2 })
  assert.deepEqual(nextStep, { kind: 'retry' }, 'the next step starts a fresh quick budget')
  await context.dispose()
})

check('a provider the row does not name keeps the interval it had', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true, nativeRetryFirstProviders: ['probe-provider'] })
  const started = Date.now()
  const pending = dispatchFailure(context, { ...request, provider: 'other-provider', retryPolicy: nativePolicy(5) })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(enteredOf(context).length, 1, 'an unnamed provider answers its exhausted allowance with the interval')
  assert.ok(Date.now() - started < 1_000, 'no quick wait stands in front of it')
  await context.dispose()
  assert.equal(await pending, undefined)
})

check('a provider with no bounded native schedule of its own answers with the interval', async () => {
  const schedules = [undefined, { mode: 'always', initialDelayMs: 20, maxDelayMs: 40, jitterRatio: 0 }]
  for (const retryPolicy of schedules) {
    const context = createContext()
    apply(context, { longTermDelayMs: 60_000, defaultEnabled: true, nativeRetryFirstProviders: ['probe-provider'] })
    const started = Date.now()
    const pending = dispatchFailure(context, { ...request, retryPolicy })
    await new Promise(resolve => setTimeout(resolve, 10))
    const label = JSON.stringify(retryPolicy) ?? 'absent'
    assert.equal(enteredOf(context).length, 1, `a schedule of ${label} has no budget to mirror`)
    assert.ok(Date.now() - started < 1_000, `a schedule of ${label} waits no quick retry`)
    await context.dispose()
    assert.equal(await pending, undefined)
  }
})

check('a provider-asked wait decides the quick retry, up to its own ceiling', async () => {
  const within = createContext()
  apply(within, { longTermDelayMs: 60_000, defaultEnabled: true, nativeRetryFirstProviders: ['probe-provider'] })
  const asked = { ...request, retryPolicy: nativePolicy(1), failure: { ...quotaFailure, providerRetryAfterMs: 30 } }
  const started = Date.now()
  assert.deepEqual(await dispatchFailure(within, asked), { kind: 'retry' })
  assert.ok(Date.now() - started >= 30, 'the wait the provider asked for is the wait used')
  await within.dispose()

  const beyond = createContext()
  apply(beyond, { longTermDelayMs: 60_000, defaultEnabled: true, nativeRetryFirstProviders: ['probe-provider'] })
  const tooLong = dispatchFailure(beyond, {
    ...request,
    retryPolicy: nativePolicy(5),
    failure: { ...quotaFailure, providerRetryAfterMs: 600_000 },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(enteredOf(beyond).length, 1, 'a wait past the policy ceiling is the long-term wait')
  await beyond.dispose()
  assert.equal(await tooLong, undefined)
})

check('a native policy that already spent this step leaves the step to it', async () => {
  const context = createContext()
  apply(context, { longTermDelayMs: 60_000, defaultEnabled: true, nativeRetryFirstProviders: ['probe-provider'] })
  dispatchSessionEvent(context, session, nativeRetryEvent({ retry: 7, maxRetries: 8, delayMs: 30_000 }))

  const budgetLeft = await dispatchFailure(context, { ...request, retryPolicy: nativePolicy(8) })
  assert.deepEqual(budgetLeft, { kind: 'retry' }, 'a native retry short of its budget has not spent one')

  dispatchSessionEvent(context, session, nativeRetryEvent({ retry: 8, maxRetries: 8, delayMs: 30_000 }))
  const pending = dispatchFailure(context, { ...request, retryPolicy: nativePolicy(8) })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(enteredOf(context).length, 1, 'the step the native policy spent is not retried again here')
  await context.dispose()
  assert.equal(await pending, undefined)
})

check('a pool named after a command word fails activation', () => {
  const context = createContext()
  assert.throws(
    () => apply(context, { longTermDelayMs: 5, pools: { off: { routes: [{ provider: 'p', model: 'm' }] } } }),
    /pool name "off" cannot be used/,
  )
  assert.throws(
    () => apply(context, {
      longTermDelayMs: 5,
      pools: {
        medium: { routes: [{ provider: 'p', model: 'm' }] },
        auto: { routes: [{ provider: 'p', model: 'm' }] },
      },
    }),
    /pool name "auto" cannot be used/,
  )
})

let failed = 0
for (const { name, run } of checks) {
  try {
    await run()
    console.log(`ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split('\n').join('\n     ')}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} probe checks passed`)
process.exitCode = failed === 0 ? 0 : 1
