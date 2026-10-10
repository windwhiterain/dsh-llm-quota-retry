#!/usr/bin/env node
/**
 * Offline probe for the route policy of dsh-llm-quota-retry: drives
 * `resolveRoutes`, `parseBalanceOutput`, and `RouteState` — the whole decision
 * surface — without a Harness, a subprocess, or a clock.
 *
 * Run with `node probe/routes.probe.mjs` from the package directory. Exits
 * non-zero on the first failed check.
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_BALANCE_REFRESH_MS,
  DEFAULT_BALANCE_TIMEOUT_MS,
  DEFAULT_EXHAUSTED_COOLDOWN_MS,
  RouteState,
  parseBalanceOutput,
  resolveRoutes,
} from '../lib/routes.js'

const checks = []
function check(name, run) {
  checks.push({ name, run })
}

/** One resolved policy with two pools, for the state checks. */
const POLICY = resolveRoutes({
  pools: {
    medium: {
      routes: [
        { provider: 'first', model: 'one', reasoningEffort: 'high' },
        { provider: 'second', model: 'two' },
        { provider: 'third', model: 'three' },
      ],
    },
    shared: { routes: [{ provider: 'both', model: 'either' }] },
    other: { routes: [{ provider: 'both', model: 'either' }] },
  },
  balances: [
    { provider: 'second', script: ['probe-script', '--json'], minimumRemaining: 5, refreshMs: 1000 },
    { provider: 'third', script: ['probe-script'], minimumRemaining: 0 },
  ],
})

/** One resolved policy whose three routes carry readings that can be weighed. */
const SCORED = resolveRoutes({
  pools: {
    medium: {
      routes: [
        { provider: 'rich', model: 'r' },
        { provider: 'poor', model: 'p' },
        { provider: 'unread', model: 'u' },
      ],
    },
  },
  balances: [
    { provider: 'rich', script: ['s'], coefficients: { monthly: 0.5 } },
    { provider: 'poor', script: ['s'], capacity: 10 },
  ],
})

/**
 * A random source a check drives: `box.value` answers the next draw.
 * @param value - the first sample.
 * @returns the source and the box a check writes the next sample into.
 */
function fixedRandom(value) {
  const box = { value }
  return { box, random: () => box.value }
}

check('config: pools and balance sources resolve, with their defaults', () => {
  const routes = resolveRoutes({
    pools: { medium: { routes: [{ provider: 'p', model: 'm' }] } },
    balances: [{ provider: 'p', script: ['s'], minimumRemaining: 2 }],
  })
  assert.deepEqual(routes.pools.medium.routes, [{ provider: 'p', model: 'm' }])
  assert.equal(routes.failOpen, true)
  assert.equal(routes.exhaustedCooldownMs, DEFAULT_EXHAUSTED_COOLDOWN_MS)
  assert.equal(routes.balances[0].timeoutMs, DEFAULT_BALANCE_TIMEOUT_MS)
  assert.equal(routes.balances[0].refreshMs, DEFAULT_BALANCE_REFRESH_MS)
  assert.deepEqual(routes.balances[0].env, {})
  assert.deepEqual(routes.balances[0].coefficients, {}, 'a row without coefficients weighs every window equally')
  assert.deepEqual(resolveRoutes({}), {
    balances: [],
    pools: {},
    failOpen: true,
    exhaustedCooldownMs: DEFAULT_EXHAUSTED_COOLDOWN_MS,
    minimumOf: {},
    refreshOf: {},
    coefficientOf: {},
    windowCapacityOf: {},
    capacityOf: {},
  })
})

check('config: window coefficients and capacities resolve, or fail the row', () => {
  const routes = resolveRoutes({
    balances: [{
      provider: 'p',
      script: ['s'],
      coefficients: { 'five-hour': 2, monthly: 0 },
      capacities: { monthly: 40 },
      capacity: 10,
    }],
  })
  assert.deepEqual(routes.coefficientOf.p, { 'five-hour': 2, monthly: 0 })
  assert.deepEqual(routes.windowCapacityOf.p, { monthly: 40 })
  assert.equal(routes.capacityOf.p, 10)
  assert.equal(routes.capacityOf.q, undefined, 'a provider without a capacity has none to divide by')
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], coefficients: 1 }] }), /coefficients must be an object/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], coefficients: { a: -1 } }] }), /coefficients\.a must be a non-negative/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], coefficients: { '': 1 } }] }), /must not name an empty window/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], capacity: 0 }] }), /capacity must be a positive finite number/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], capacity: '10' }] }), /capacity must be a positive finite number/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], capacities: [] }] }), /capacities must be an object/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], capacities: { monthly: 0 } }] }), /capacities\.monthly must be a positive finite number/)
})

check('config: a malformed pool, route, or balance source fails the row', () => {
  assert.throws(() => resolveRoutes({ pools: { Bad: { routes: [] } } }), /pool name "Bad"/)
  assert.throws(() => resolveRoutes({ pools: { ok: {} } }), /routes must be a non-empty array/)
  assert.throws(() => resolveRoutes({ pools: { ok: { routes: [{ provider: 'p' }] } } }), /model must be a non-empty string/)
  assert.throws(() => resolveRoutes({ pools: { ok: { routes: [{ provider: 'p', model: 'm', extra: 1 }] } } }), /unknown field "extra"/)
  assert.throws(() => resolveRoutes({ balances: {} }), /balances must be an array/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: [] }] }), /script must be a non-empty array/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], env: { A: 1 } }] }), /env.A must be a string/)
  assert.equal(
    resolveRoutes({ balances: [{ provider: 'p', script: ['s'], apiKeyEnv: 'P_API_KEY' }] }).balances[0].apiKeyEnv,
    'P_API_KEY',
  )
  assert.throws(
    () => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], apiKeyEnv: ' ' }] }),
    /apiKeyEnv must be a non-empty credential reference/,
  )
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], timeoutMs: 0 }] }), /timeoutMs must be greater than 0/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'], minimumRemaining: 'x' }] }), /minimumRemaining must be a finite number/)
  assert.throws(() => resolveRoutes({ balances: [{ provider: 'p', script: ['s'] }, { provider: 'p', script: ['s'] }] }), /duplicate balance source/)
  assert.throws(() => resolveRoutes({ failOpen: 'yes' }), /failOpen must be a boolean/)
  assert.throws(() => resolveRoutes({ exhaustedCooldownMs: 0 }), /exhaustedCooldownMs must be greater than 0/)
})

check('a balance script\'s output is read strictly', () => {
  assert.deepEqual(parseBalanceOutput('{"remaining": 12.5}'), { kind: 'reading', reading: { remaining: 12.5 } })
  assert.deepEqual(parseBalanceOutput('  {"remaining": 0, "resetsAt": "2026-01-01T00:00:00Z"}  '), {
    kind: 'reading',
    reading: { remaining: 0, resetsAt: '2026-01-01T00:00:00Z' },
  })
  assert.deepEqual(parseBalanceOutput('{"remaining": 3, "error": "stale window"}').reading, {
    remaining: 3,
    error: 'stale window',
  })
  assert.equal(parseBalanceOutput('').kind, 'invalid')
  assert.equal(parseBalanceOutput('not json').kind, 'invalid')
  assert.equal(parseBalanceOutput('[1]').kind, 'invalid')
  assert.equal(parseBalanceOutput('{"remaining": "12"}').kind, 'invalid')
  assert.equal(parseBalanceOutput('{"balance": 12}').kind, 'invalid')
  assert.equal(parseBalanceOutput('{"remaining": null}').kind, 'invalid')
})

check('a reading carries the windows a script reported, and keeps the ones it can use', () => {
  assert.deepEqual(parseBalanceOutput(JSON.stringify({
    remaining: 2.94,
    windows: [
      { name: 'five-hour', remaining: 14, capacity: 14 },
      { name: 'weekly', remaining: 2.94, capacity: 35 },
      { name: 'monthly', remaining: 37.94 },
    ],
  })).reading, {
    remaining: 2.94,
    windows: [
      { name: 'five-hour', remaining: 14, capacity: 14 },
      { name: 'weekly', remaining: 2.94, capacity: 35 },
      { name: 'monthly', remaining: 37.94 },
    ],
  })

  const dropped = parseBalanceOutput(JSON.stringify({
    remaining: 1,
    windows: [
      { name: '', remaining: 1, capacity: 1 },
      { name: 'no-remaining', capacity: 1 },
      { name: 'not-a-number', remaining: '5', capacity: 1 },
      { name: 'zero-capacity', remaining: 1, capacity: 0 },
      { name: 'kept', remaining: 1, capacity: 2 },
      'not an object',
    ],
  })).reading
  assert.deepEqual(dropped.windows, [
    { name: 'zero-capacity', remaining: 1 },
    { name: 'kept', remaining: 1, capacity: 2 },
  ], 'a window nothing can be made of is dropped, and an unusable capacity is dropped with it')

  assert.deepEqual(parseBalanceOutput('{"remaining": 5, "windows": "none"}').reading, { remaining: 5 })
  assert.deepEqual(parseBalanceOutput('{"remaining": 5, "windows": []}').reading, { remaining: 5 })
})

check('a route is scored by its weighted worst window, or by its whole reading', () => {
  const state = new RouteState(SCORED, () => 0)
  state.noteReading('rich', {
    remaining: 40,
    windows: [
      { name: 'five-hour', remaining: 8, capacity: 10 },
      { name: 'monthly', remaining: 100, capacity: 100 },
    ],
  }, 0)
  assert.equal(state.scoreOf('rich'), 0.5, 'the monthly window weighs half, so 1.0 × 0.5 is the worst')
  state.noteReading('poor', { remaining: 3 }, 0)
  assert.equal(state.scoreOf('poor'), 0.3, 'a reading with no window divides by the row capacity')
  assert.equal(state.scoreOf('unread'), undefined, 'a provider nothing reported on has no score')
  state.noteReading('rich', { remaining: 40, windows: [{ name: 'monthly', remaining: 100 }] }, 0)
  assert.equal(state.scoreOf('rich'), undefined, 'a window without a capacity cannot be divided by')
  state.noteReading('rich', { remaining: 40, windows: [{ name: 'five-hour', remaining: 40, capacity: 10 }] }, 0)
  assert.equal(state.scoreOf('rich'), 1, 'more than a window\'s capacity is still full headroom')
})

check('a window the provider states no capacity for divides by the row\'s own', () => {
  const state = new RouteState(resolveRoutes({
    pools: { medium: { routes: [{ provider: 'goat', model: 'g' }] } },
    balances: [{ provider: 'goat', script: ['s'], capacities: { monthly: 40 } }],
  }), () => 0)
  state.noteReading('goat', {
    remaining: 0.91,
    windows: [
      { name: 'monthly', remaining: 0.91 },
      { name: 'weekly', remaining: 35, capacity: 35 },
    ],
  }, 0)
  assert.equal(state.scoreOf('goat'), 0.02275,
    'a reported capacity wins, and the row fills in the window the endpoint states none for')
})

check('the choice is proportional to headroom, and a scored route outranks an unread one', () => {
  const { box, random } = fixedRandom(0)
  const state = new RouteState(SCORED, random)
  state.noteReading('rich', { remaining: 75, windows: [{ name: 'five-hour', remaining: 75, capacity: 100 }] }, 0)
  state.noteReading('poor', { remaining: 2.5 }, 0)
  assert.equal(state.scoreOf('rich'), 0.75)
  assert.equal(state.scoreOf('poor'), 0.25)

  box.value = 0
  assert.equal(state.pick('medium', 0).provider, 'rich')
  box.value = 0.74
  assert.equal(state.pick('medium', 0).provider, 'rich', 'three quarters of the range is the richer route')
  box.value = 0.75
  assert.equal(state.pick('medium', 0).provider, 'poor', 'the rest of the range is the poorer one')
  box.value = 0.999
  assert.equal(state.pick('medium', 0).provider, 'poor', 'an unread route is never drawn while a scored one is usable')
})

check('with nothing scored the declared order decides, and every candidate carries equal weight', () => {
  const state = new RouteState(SCORED, () => 0.99)
  assert.deepEqual(state.pick('medium', 0), { provider: 'rich', model: 'r' },
    'no reading in the pool: the declared order stands')
  for (const provider of ['rich', 'poor']) {
    state.noteReading(provider, { remaining: 0, windows: [{ name: 'monthly', remaining: 0, capacity: 100 }] }, 0)
  }
  assert.equal(state.scoreOf('rich'), 0)
  assert.equal(state.pick('medium', 0).provider, 'poor',
    'a zero total weight falls back to an equal chance over the scored routes')
})

check('fail-open: a route nothing reported on is usable, and declared order decides', () => {
  const state = new RouteState(POLICY)
  const now = 1_000
  assert.deepEqual(state.pick('medium', now), { provider: 'first', model: 'one', reasoningEffort: 'high' })
  assert.equal(state.isUsable('second', now), true, 'no reading yet, and the policy is fail-open')
  assert.deepEqual(state.pick('unknown-pool', now), undefined)
})

check('a fresh reading below its own minimum skips the route', () => {
  const state = new RouteState(POLICY)
  state.noteReading('second', { remaining: 1 }, 2_000)
  assert.equal(state.isUsable('second', 2_000), false)
  assert.deepEqual(state.pick('medium', 2_000), { provider: 'first', model: 'one', reasoningEffort: 'high' })
  // One route below its minimum does not hide the rest of the pool.
  state.noteReading('first', { remaining: -1 }, 2_000)
  state.noteReading('second', { remaining: 99 }, 2_000)
  assert.equal(state.isUsable('first', 2_000), false)
  assert.deepEqual(state.pick('medium', 2_000), { provider: 'second', model: 'two' })
})

check('fail-closed: a route with no balance source is then unusable', () => {
  const state = new RouteState(resolveRoutes({
    failOpen: false,
    pools: { medium: { routes: [{ provider: 'unreported', model: 'u' }, { provider: 'reported', model: 'r' }] } },
    balances: [{ provider: 'reported', script: ['s'] }],
  }))
  assert.equal(state.isUsable('unreported', 0), false)
  state.noteReading('reported', { remaining: 0 }, 0)
  assert.equal(state.isUsable('reported', 0), true)
})

check('an exhausted provider is unusable until a later reading disproves it', () => {
  const state = new RouteState(POLICY)
  const now = 10_000
  state.noteReading('second', { remaining: 100 }, now)
  state.noteExhausted('second', now)
  assert.equal(state.isUsable('second', now), false, 'the provider itself reported exhaustion')
  assert.deepEqual(state.pick('medium', now), { provider: 'first', model: 'one', reasoningEffort: 'high' })
  state.noteReading('second', { remaining: 0 }, now + 1)
  assert.equal(state.isUsable('second', now + 1), false, 'a reading that still shows no allowance keeps the mark')
  // The refresh the failure itself triggers must not withdraw the mark it just
  // set: that would propose the failing route again and retry into a loop.
  state.noteReading('second', { remaining: 100 }, now + 2)
  assert.equal(state.isUsable('second', now + 2), false)
  // One refresh interval later, allowance is recovery evidence.
  state.noteReading('second', { remaining: 100 }, now + 1_000)
  assert.equal(state.isUsable('second', now + 1_000), true)
})

check('a provider no script covers recovers when the cooldown lapses', () => {
  const routes = resolveRoutes({
    exhaustedCooldownMs: 5_000,
    pools: { medium: { routes: [{ provider: 'unreported', model: 'u' }] } },
  })
  const state = new RouteState(routes)
  state.noteExhausted('unreported', 0)
  assert.equal(state.isUsable('unreported', 4_999), false)
  assert.equal(state.isUsable('unreported', 5_000), true)
  assert.equal(state.exhaustedAt('unreported', 5_000), undefined, 'the lapsed mark is dropped, not just ignored')
})

check('a pool whose routes are all unusable still answers with its first route', () => {
  const state = new RouteState(POLICY)
  for (const provider of ['first', 'second', 'third']) state.noteExhausted(provider, 0)
  assert.deepEqual(state.pick('medium', 0), { provider: 'first', model: 'one', reasoningEffort: 'high' })
  assert.equal(state.replacementFor('medium', { provider: 'first', model: 'one' }, 0), undefined)
})

check('a route exactly one pool holds names that pool, a shared one names none', () => {
  const state = new RouteState(POLICY)
  assert.equal(state.poolOfRoute('first', 'one').name, 'medium')
  assert.equal(state.poolOfRoute('both', 'either'), undefined)
  assert.equal(state.poolOfRoute('nowhere', 'nothing'), undefined)
})

check('a below-threshold reading does not move a session that has already started', () => {
  const state = new RouteState(POLICY)
  const now = 5_000
  state.noteReading('second', { remaining: 1 }, now)
  assert.equal(state.isUsable('second', now), false, 'a new session would not start here')
  assert.equal(
    state.replacementFor('medium', { provider: 'second', model: 'two' }, now),
    undefined,
    'a live conversation is not interrupted for a threshold',
  )
  state.noteExhausted('second', now)
  assert.deepEqual(
    state.replacementFor('medium', { provider: 'second', model: 'two' }, now),
    { provider: 'first', model: 'one', reasoningEffort: 'high' },
    'the provider reporting the allowance spent does move it',
  )
})

check('replacement keeps a live route and leaves an exhausted one in declared order', () => {
  const state = new RouteState(POLICY)
  const now = 5_000
  assert.equal(state.replacementFor('medium', { provider: 'third', model: 'three' }, now), undefined)
  state.noteExhausted('third', now)
  assert.deepEqual(state.replacementFor('medium', { provider: 'third', model: 'three' }, now), {
    provider: 'first',
    model: 'one',
    reasoningEffort: 'high',
  })
  state.noteExhausted('first', now)
  state.noteReading('second', { remaining: 0 }, now)
  assert.deepEqual(
    state.replacementFor('medium', { provider: 'third', model: 'three' }, now),
    { provider: 'second', model: 'two' },
    'a route below its threshold is still better than one the provider already refused',
  )
})

check('an exhausted pool with no candidate leaves the session where it is', () => {
  const state = new RouteState(POLICY)
  const now = 5_000
  for (const provider of ['first', 'second', 'third']) state.noteExhausted(provider, now)
  assert.equal(state.replacementFor('medium', { provider: 'third', model: 'three' }, now), undefined)
})

check('the report carries each route\'s reading, score, and mark', () => {
  const state = new RouteState(POLICY)
  state.noteReading('second', { remaining: 7, resetsAt: 'later' }, 1_000)
  state.noteReading('third', { remaining: 7, windows: [{ name: 'weekly', remaining: 7, capacity: 70 }] }, 1_000)
  state.noteExhausted('third', 1_000)
  const report = state.report(1_000)
  assert.deepEqual(report.map(pool => pool.name), ['medium', 'shared', 'other'])
  const medium = report[0]
  assert.deepEqual(medium.routes.map(route => route.provider), ['first', 'second', 'third'])
  assert.deepEqual(medium.routes[1].reading, { remaining: 7, resetsAt: 'later', at: 1_000 })
  assert.equal(medium.routes[1].score, undefined, 'a reading with nothing to divide by has no score')
  assert.equal(medium.routes[2].score, 0.1, 'a route out of allowance still reports what it has left')
  assert.equal(medium.routes[2].exhaustedAt, 1_000)
  assert.equal(medium.routes[2].usable, false)
})

for (const { name, run } of checks) {
  await run()
  console.log(`ok  ${name}`)
}
console.log(`\n${checks.length} route probe checks passed`)
