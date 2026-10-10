/**
 * Route pools, balance sources, and the allowance policy that decides which
 * route a Session may use next.
 *
 * A *route* is one provider/model pair (with the reasoning effort it starts at).
 * A *pool* is a named, ordered list of interchangeable routes. A *balance
 * source* is a script that reports what a provider has left. This module owns
 * the shape and the decisions and nothing else: it performs no I/O, so the probe
 * drives every rule without a Harness, a subprocess, or a clock.
 *
 * Two rules make the decisions fail safe rather than fail closed. A route
 * *nothing reported on* counts as usable, because most providers document no
 * balance endpoint and a deployment that cannot read one must still delegate.
 * And a pool whose routes are all unusable still answers with its first route,
 * because refusing to run the request would be a worse outage than running it on
 * the least-bad route. Only a pool the configuration never declared is an error,
 * and the caller reports that as one.
 *
 * @module dsh-llm-quota-retry/routes
 */

import { MAX_TIMER_DELAY_MS } from './policy.js'

/** Row-config keys this module owns, for the policy validator's allowlist. */
export const ROUTE_CONFIG_KEYS = Object.freeze(['balances', 'pools', 'failOpen', 'exhaustedCooldownMs'])

/** How long a balance script may run before its readings are discarded. */
export const DEFAULT_BALANCE_TIMEOUT_MS = 5_000

/** How long one provider's reading stays current. */
export const DEFAULT_BALANCE_REFRESH_MS = 60_000

/**
 * How long one provider stays marked as out of allowance after a request failed
 * for that reason. A fresh reading that shows allowance clears the mark sooner;
 * this bound is what clears it for a provider no script reports on.
 */
export const DEFAULT_EXHAUSTED_COOLDOWN_MS = 3_600_000

/** Pool name grammar: the value a template or a caller passes as `pool`. */
const POOL_NAME = /^[a-z0-9][a-z0-9-]*$/

/** Whether a value is a non-empty string. */
function filledString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * What is left of one allowance, as a fraction of its own capacity.
 * @param remaining - what the provider has left.
 * @param capacity - the allowance's full amount.
 * @returns the fraction, clamped to the zero-to-one range.
 */
function fractionOf(remaining, capacity) {
  return Math.min(1, Math.max(0, remaining / capacity))
}

/**
 * Choose one candidate with a probability proportional to its weight.
 *
 * Proportional rather than "the largest wins": headroom is a share of what is
 * left, and spending a pool in proportion to it is what keeps every route of
 * that pool in use instead of draining the richest one first and paying a
 * failover for it. A zero total — every candidate scored zero — falls back to an
 * equal chance, because the caller has already decided these are the candidates
 * worth using and refusing to choose would strand the request.
 *
 * @param candidates - the candidates, each carrying a non-negative `weight`.
 * @param random - sample in the zero-to-one range.
 * @returns the chosen candidate, or undefined when there is none.
 */
function chooseWeighted(candidates, random) {
  if (candidates.length === 0) return undefined
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
  if (!(total > 0)) return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]
  let point = random() * total
  for (const candidate of candidates) {
    point -= candidate.weight
    if (point < 0) return candidate
  }
  return candidates[candidates.length - 1]
}

/**
 * Validate one `balances` entry, the description of how to read one provider's
 * remaining allowance.
 * @param raw - the declared entry.
 * @param index - its position, for issue messages.
 * @returns the normalized entry.
 * @throws when a field is missing, unknown, or out of range.
 */
function normalizeBalance(raw, index) {
  const path = `balances[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`llm-quota-retry: ${path} must be an object`)
  }
  for (const key of Object.keys(raw)) {
    if (![
      'provider', 'script', 'apiKeyEnv', 'env', 'timeoutMs', 'refreshMs', 'minimumRemaining', 'unit',
      'coefficients', 'capacity',
    ].includes(key)) {
      throw new Error(`llm-quota-retry: ${path} has unknown field "${key}"`)
    }
  }
  if (!filledString(raw.provider)) throw new Error(`llm-quota-retry: ${path}.provider must be a non-empty string`)
  if (!Array.isArray(raw.script) || raw.script.length === 0 || raw.script.some(part => !filledString(part))) {
    throw new Error(`llm-quota-retry: ${path}.script must be a non-empty array of non-empty strings (argv)`)
  }
  if (raw.apiKeyEnv !== undefined && !filledString(raw.apiKeyEnv)) {
    throw new Error(`llm-quota-retry: ${path}.apiKeyEnv must be a non-empty credential reference when declared`)
  }
  const env = {}
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
      throw new Error(`llm-quota-retry: ${path}.env must be an object of string values`)
    }
    for (const [name, value] of Object.entries(raw.env)) {
      if (typeof value !== 'string') throw new Error(`llm-quota-retry: ${path}.env.${name} must be a string`)
      env[name] = value
    }
  }
  const timeoutMs = raw.timeoutMs ?? DEFAULT_BALANCE_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-quota-retry: ${path}.timeoutMs must be greater than 0 and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const refreshMs = raw.refreshMs ?? DEFAULT_BALANCE_REFRESH_MS
  if (!Number.isFinite(refreshMs) || refreshMs <= 0 || refreshMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-quota-retry: ${path}.refreshMs must be greater than 0 and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const minimumRemaining = raw.minimumRemaining ?? 0
  if (!Number.isFinite(minimumRemaining)) {
    throw new Error(`llm-quota-retry: ${path}.minimumRemaining must be a finite number`)
  }
  if (raw.unit !== undefined && !filledString(raw.unit)) {
    throw new Error(`llm-quota-retry: ${path}.unit must be a non-empty string when declared`)
  }
  const coefficients = {}
  if (raw.coefficients !== undefined) {
    if (raw.coefficients === null || typeof raw.coefficients !== 'object' || Array.isArray(raw.coefficients)) {
      throw new Error(`llm-quota-retry: ${path}.coefficients must be an object of window names`)
    }
    for (const [name, value] of Object.entries(raw.coefficients)) {
      if (name === '') throw new Error(`llm-quota-retry: ${path}.coefficients must not name an empty window`)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`llm-quota-retry: ${path}.coefficients.${name} must be a non-negative finite number`)
      }
      coefficients[name] = value
    }
  }
  const capacity = raw.capacity
  if (capacity !== undefined && (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0)) {
    throw new Error(`llm-quota-retry: ${path}.capacity must be a positive finite number when declared`)
  }
  return Object.freeze({
    provider: raw.provider,
    script: Object.freeze([...raw.script]),
    env: Object.freeze(env),
    timeoutMs,
    refreshMs,
    minimumRemaining,
    coefficients: Object.freeze(coefficients),
    ...raw.apiKeyEnv === undefined ? {} : { apiKeyEnv: raw.apiKeyEnv },
    ...raw.unit === undefined ? {} : { unit: raw.unit },
    ...capacity === undefined ? {} : { capacity },
  })
}

/**
 * Validate one route inside a pool.
 * @param raw - the declared route.
 * @param path - issue path prefix.
 * @returns the normalized route.
 * @throws when a field is missing, unknown, or unusable.
 */
function normalizeRoute(raw, path) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`llm-quota-retry: ${path} must be an object`)
  }
  for (const key of Object.keys(raw)) {
    if (!['provider', 'model', 'reasoningEffort'].includes(key)) {
      throw new Error(`llm-quota-retry: ${path} has unknown field "${key}"`)
    }
  }
  for (const key of ['provider', 'model']) {
    if (!filledString(raw[key])) throw new Error(`llm-quota-retry: ${path}.${key} must be a non-empty string`)
  }
  if (raw.reasoningEffort !== undefined && !filledString(raw.reasoningEffort)) {
    throw new Error(`llm-quota-retry: ${path}.reasoningEffort must be a non-empty string when declared`)
  }
  return Object.freeze({
    provider: raw.provider,
    model: raw.model,
    ...raw.reasoningEffort === undefined ? {} : { reasoningEffort: raw.reasoningEffort },
  })
}

/**
 * Validate the route-related row config and freeze the resolved route policy.
 * @param config - raw Loader row config; omission selects the defaults.
 * @returns the frozen pools, balance sources, and the two policy switches.
 * @throws when a pool name, a route, a balance source, or a switch is unusable.
 */
export function resolveRoutes(config = {}) {
  const source = config === null || typeof config !== 'object' || Array.isArray(config) ? {} : config
  const balances = []
  if (source.balances !== undefined) {
    if (!Array.isArray(source.balances)) throw new Error('llm-quota-retry: balances must be an array')
    const seen = new Set()
    for (const [index, raw] of source.balances.entries()) {
      const balance = normalizeBalance(raw, index)
      if (seen.has(balance.provider)) {
        throw new Error(`llm-quota-retry: duplicate balance source for provider "${balance.provider}"`)
      }
      seen.add(balance.provider)
      balances.push(balance)
    }
  }
  const pools = {}
  if (source.pools !== undefined) {
    if (source.pools === null || typeof source.pools !== 'object' || Array.isArray(source.pools)) {
      throw new Error('llm-quota-retry: pools must be an object of named pools')
    }
    for (const [name, raw] of Object.entries(source.pools)) {
      if (!POOL_NAME.test(name)) {
        throw new Error(`llm-quota-retry: pool name "${name}" must be lowercase letters, digits, and hyphens`)
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`llm-quota-retry: pool "${name}" must be an object`)
      }
      for (const key of Object.keys(raw)) {
        if (key !== 'routes') throw new Error(`llm-quota-retry: pool "${name}" has unknown field "${key}"`)
      }
      if (!Array.isArray(raw.routes) || raw.routes.length === 0) {
        throw new Error(`llm-quota-retry: pool "${name}".routes must be a non-empty array`)
      }
      pools[name] = Object.freeze({
        name,
        routes: Object.freeze(raw.routes.map((route, index) => normalizeRoute(route, `pools.${name}.routes[${index}]`))),
      })
    }
  }
  const failOpen = source.failOpen ?? true
  if (typeof failOpen !== 'boolean') throw new Error('llm-quota-retry: failOpen must be a boolean')
  const exhaustedCooldownMs = source.exhaustedCooldownMs ?? DEFAULT_EXHAUSTED_COOLDOWN_MS
  if (!Number.isFinite(exhaustedCooldownMs) || exhaustedCooldownMs <= 0 || exhaustedCooldownMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-quota-retry: exhaustedCooldownMs must be greater than 0 and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return Object.freeze({
    balances: Object.freeze(balances),
    pools: Object.freeze(pools),
    failOpen,
    exhaustedCooldownMs,
    minimumOf: Object.freeze(Object.fromEntries(balances.map(balance => [balance.provider, balance.minimumRemaining]))),
    refreshOf: Object.freeze(Object.fromEntries(balances.map(balance => [balance.provider, balance.refreshMs]))),
    coefficientOf: Object.freeze(Object.fromEntries(balances.map(balance => [balance.provider, balance.coefficients]))),
    capacityOf: Object.freeze(Object.fromEntries(
      balances.flatMap(balance => balance.capacity === undefined ? [] : [[balance.provider, balance.capacity]]),
    )),
  })
}

/**
 * Read one balance script's output.
 *
 * The contract is one JSON object on stdout: `remaining` is what the provider has
 * left, in whatever unit the script and its `unit` field agree on, and `resetsAt`
 * is optional context for a person. Anything else — another shape, a non-number,
 * text around the JSON — is reported as unusable rather than guessed at.
 *
 * @param text - the script's captured stdout.
 * @returns the reading, or the reason the output is not one.
 */
export function parseBalanceOutput(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { kind: 'invalid', reason: 'the script printed nothing' }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { kind: 'invalid', reason: 'stdout is not JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'stdout is not a JSON object' }
  }
  const remaining = parsed.remaining
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
    return { kind: 'invalid', reason: 'the JSON object carries no finite numeric "remaining"' }
  }
  const windows = parseWindows(parsed.windows)
  return {
    kind: 'reading',
    reading: {
      remaining,
      ...windows.length === 0 ? {} : { windows },
      ...typeof parsed.resetsAt === 'string' && parsed.resetsAt !== '' ? { resetsAt: parsed.resetsAt } : {},
      ...typeof parsed.error === 'string' && parsed.error !== '' ? { error: parsed.error } : {},
    },
  }
}

/**
 * Read the per-window readings one script reported.
 *
 * A window is where a plan's real limit lives — a month of credits can outlast a
 * five-hour cap — so it is what ranks one route against another. It is optional
 * context rather than part of the reading: an entry nothing can be made of is
 * dropped, and a window without a capacity is kept for a person reading the
 * report and skipped by the score, because a route that publishes no window
 * limit must still be usable.
 *
 * @param raw - the parsed `windows` value.
 * @returns the usable windows, in reported order.
 */
function parseWindows(raw) {
  if (!Array.isArray(raw)) return []
  const windows = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.name !== 'string' || entry.name === '') continue
    if (typeof entry.remaining !== 'number' || !Number.isFinite(entry.remaining)) continue
    const capacity = entry.capacity
    const scalable = typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0
    windows.push({
      name: entry.name,
      remaining: entry.remaining,
      ...scalable ? { capacity } : {},
    })
  }
  return windows
}

/**
 * One route's reading: what the last script run reported, and when it ran.
 * @typedef {object} RouteReading
 * @property {number} remaining What the provider has left.
 * @property {RouteWindow[]} [windows] One entry per usage window the provider meters.
 * @property {string} [resetsAt] When the provider says its window resets.
 * @property {string} [error] The provider's own message, when its script reported one.
 * @property {number} at Epoch milliseconds this reading was taken at.
 */

/**
 * One usage window of a reading.
 * @typedef {object} RouteWindow
 * @property {string} name The window's own label, which a row's `coefficients` names.
 * @property {number} remaining What is left of that window.
 * @property {number} [capacity] That window's full allowance, absent when the
 *   provider reports none; a window without one is not scored.
 */

/**
 * The route decision state: the readings scripts reported, the providers known
 * to be out of allowance, and the two rules that turn them into a route.
 *
 * It performs no I/O and starts no work, so every decision here is synchronous
 * and can be taken inside a model request's proposal without adding latency.
 */
export class RouteState {
  #readings = new Map()
  #exhausted = new Map()
  #routes
  #random

  /**
   * @param routes - the resolved route policy from {@link resolveRoutes}.
   * @param random - sample in the zero-to-one range, for the proportional
   *   choice; a deployment uses the default, a probe passes its own.
   */
  constructor(routes, random = Math.random) {
    this.#routes = routes
    this.#random = random
  }

  /** @returns the resolved route policy, for callers that report it. */
  get routes() {
    return this.#routes
  }

  /**
   * Record one provider's fresh reading.
   *
   * A reading showing allowance is recovery evidence for a provider that failed
   * earlier — but only once it is a *later* reading rather than the refresh the
   * failure itself triggered. Without that grace the very first probe would
   * withdraw the mark the failure just set, the next request would be proposed
   * on the same failing route, and an immediate retry would loop there. The
   * grace is the provider's own refresh interval, so recovery is picked up at
   * the cadence its script is meant to be read at.
   *
   * @param provider - the provider the reading belongs to.
   * @param reading - what the script reported, without its timestamp.
   * @param now - epoch milliseconds of the run.
   */
  noteReading(provider, reading, now) {
    this.#readings.set(provider, { ...reading, at: now })
    const markedAt = this.#exhausted.get(provider)
    if (markedAt === undefined) return
    const grace = this.#routes.refreshOf[provider] ?? DEFAULT_BALANCE_REFRESH_MS
    if (now - markedAt < grace) return
    if (reading.remaining >= (this.#routes.minimumOf[provider] ?? 0)) this.#exhausted.delete(provider)
  }

  /**
   * Record that one provider answered a request with an exhausted allowance.
   * @param provider - the provider that failed.
   * @param now - epoch milliseconds of the failure.
   */
  noteExhausted(provider, now) {
    this.#exhausted.set(provider, now)
  }

  /**
   * @param provider - the provider to read.
   * @returns the last reading taken for it, or undefined when none was.
   */
  readingOf(provider) {
    return this.#readings.get(provider)
  }

  /**
   * @param provider - the provider to read.
   * @param now - epoch milliseconds of the question.
   * @returns when that provider was marked out of allowance and the mark still
   *   stands, or undefined.
   */
  exhaustedAt(provider, now) {
    const at = this.#exhausted.get(provider)
    if (at === undefined) return undefined
    if (now - at >= this.#routes.exhaustedCooldownMs) {
      this.#exhausted.delete(provider)
      return undefined
    }
    return at
  }

  /**
   * One provider's headroom, as a fraction of the allowance that binds it.
   *
   * A window is scored as what is left of it out of its own capacity, so a
   * percentage plan and a wallet in another currency compare, and the row's own
   * coefficient for that window multiplies the fraction — which is how a
   * deployment says a five-hour cap matters more than a monthly one, or that a
   * window counts for nothing at all. The route's score is its **worst** window,
   * because the worst one is what refuses the next request; a reading that
   * carries no window to score falls back to the whole reading against the row's
   * `capacity`, and one with neither is simply unscored.
   *
   * @param provider - the provider to score.
   * @returns a number, or undefined when this provider has no reading or nothing
   *   in it can be divided by.
   */
  scoreOf(provider) {
    const reading = this.#readings.get(provider)
    if (reading === undefined) return undefined
    const scores = (reading.windows ?? []).flatMap((window) => {
      if (window.capacity === undefined) return []
      const coefficient = this.#routes.coefficientOf[provider]?.[window.name] ?? 1
      return [fractionOf(window.remaining, window.capacity) * coefficient]
    })
    if (scores.length > 0) return Math.min(...scores)
    const capacity = this.#routes.capacityOf[provider]
    return capacity === undefined ? undefined : fractionOf(reading.remaining, capacity)
  }

  /**
   * Whether one route may be used now.
   *
   * An out-of-allowance mark decides first, because it is a fact the provider
   * itself reported. A reading is next, against the provider's own minimum —
   * zero when its balance source declares none. A route nothing reported on is
   * usable when the policy is fail-open (the default) and unusable when it is
   * fail-closed.
   *
   * @param provider - the route's provider.
   * @param now - epoch milliseconds of the question.
   * @returns whether the route is usable now.
   */
  isUsable(provider, now) {
    if (this.exhaustedAt(provider, now) !== undefined) return false
    const reading = this.#readings.get(provider)
    if (reading === undefined) return this.#routes.failOpen
    return reading.remaining >= (this.#routes.minimumOf[provider] ?? 0)
  }

  /**
   * Choose one route out of the usable ones.
   *
   * A route a reading scores is preferred to one nothing reported on — an unread
   * provider is unknown rather than plentiful — so the choice is made over the
   * scored routes alone, each with a probability proportional to its headroom.
   * With no scored route at all there is nothing to weigh, and the caller's
   * declared order decides instead.
   *
   * @param usable - the routes usable right now, in declared order.
   * @returns the chosen route.
   */
  #chooseUsable(usable) {
    const scored = usable.flatMap((route) => {
      const score = this.scoreOf(route.provider)
      return score === undefined ? [] : [{ route, weight: score }]
    })
    return scored.length === 0 ? usable[0] : chooseWeighted(scored, this.#random).route
  }

  /**
   * The route a pool should use next.
   *
   * The choice is proportional to what each usable route has left, so a pool is
   * spent in proportion to its allowance rather than drained route by route.
   * When none is usable the pool's first route is still the answer: a request has
   * to run somewhere, and the long-term retry covers the case where every route
   * refuses it.
   *
   * @param poolName - the pool to choose from.
   * @param now - epoch milliseconds of the choice.
   * @returns the chosen route, or undefined when no pool by that name exists.
   */
  pick(poolName, now) {
    const pool = this.#routes.pools[poolName]
    if (pool === undefined) return undefined
    const usable = pool.routes.filter(route => this.isUsable(route.provider, now))
    return usable.length === 0 ? pool.routes[0] : this.#chooseUsable(usable)
  }

  /**
   * Which pool one route belongs to, for a caller that did not name one.
   *
   * A route several pools share names no pool: guessing there would move a
   * Session between pools on a coin toss.
   *
   * @param provider - the route's provider.
   * @param model - the route's model.
   * @returns the pool that holds the route exactly once, or undefined.
   */
  poolOfRoute(provider, model) {
    const found = Object.values(this.#routes.pools).filter(pool =>
      pool.routes.some(route => route.provider === provider && route.model === model))
    return found.length === 1 ? found[0] : undefined
  }

  /**
   * The route one Session should use for its next request.
   *
   * A threshold is the *choice* rule, not a mid-conversation one. A Session that
   * has already started keeps the route the user and this plugin last agreed on
   * until the provider itself reports the allowance spent: moving a live
   * conversation to another account — and so to another model, prompt cache, and
   * price — is worth doing only when the current route cannot answer at all.
   *
   * The replacement is then chosen the way a new Session's is — {@link pick}'s
   * own rule — falling back to the first route that is merely not out of
   * allowance, because a route with little left can still be the one that
   * answers.
   *
   * @param poolName - the pool that governs this Session.
   * @param current - the route the request would otherwise use.
   * @param now - epoch milliseconds of the question.
   * @returns the replacement route, or undefined when the current one stands.
   */
  replacementFor(poolName, current, now) {
    const pool = this.#routes.pools[poolName]
    if (pool === undefined) return undefined
    if (current !== undefined && this.exhaustedAt(current.provider, now) === undefined) return undefined
    const candidates = pool.routes.filter(route => this.exhaustedAt(route.provider, now) === undefined)
    const usable = candidates.filter(route => this.isUsable(route.provider, now))
    const chosen = usable.length === 0 ? candidates[0] : this.#chooseUsable(usable)
    if (chosen === undefined) return undefined
    if (chosen.provider === current?.provider && chosen.model === current?.model) return undefined
    return chosen
  }

  /**
   * Every pool, route, and reading, for the status command and the logs.
   * @param now - epoch milliseconds of the report.
   * @returns one row per route, in pool then declared order.
   */
  report(now) {
    return Object.values(this.#routes.pools).map(pool => ({
      name: pool.name,
      routes: pool.routes.map(route => ({
        provider: route.provider,
        model: route.model,
        usable: this.isUsable(route.provider, now),
        exhaustedAt: this.exhaustedAt(route.provider, now),
        score: this.scoreOf(route.provider),
        reading: this.#readings.get(route.provider),
      })),
    }))
  }
}
