# dsh-llm-quota-retry

A DeepSeek Harness host plugin that keeps an agent step alive through an
exhausted account quota or balance.

When a model request fails with the canonical `QUOTA` code, the ordinary
recovery policy gives up once its retry budget is spent and the turn ends. For
a session that has opted in, this plugin takes over at that point and retries
the same request inside the same open turn once per configured interval — one
hour by default, with no attempt limit — until a request succeeds or the turn
is cancelled.

## Install

The package is a Cordis bundle with a Web composer half:

```sh
dsh plugin --profile web add C:/resource/dsh-llm-quota-retry
```

Installation links the package into the profile and records it in
`dsh.profile.bundles`, so the bundle layer is read on every later start. The
host row applies without a restart: the profile patch reloads live, the row
activates, and the bundle reports `enabled` with an active fiber.

**The composer chip needs one host restart the first time.** The `dsh.client`
manifest is read by the client-module scan, which caches its verdict per
package for the lifetime of the host — a package first scanned before it
declared `dsh.client` stays cached as "not a client package", and no later
rescan clears that entry. Restart `dsh web` once after installing, or after
adding `dsh.client` to an already-installed package, and the chip appears.

## Composition order

Compose the `llm-quota-retry` row **after** `@deepseek-ai/dsh-llm-retry`.

That order is the contract, not a preference. `dsh-llm-retry` runs earlier in
the `agent/request-error` waterfall, spends its own retry budget first, and
calls the next listener once that budget is exhausted. By the time a quota
failure reaches this plugin, every earlier recovery policy has already
declined it — which is exactly what "after the base quick retries" means. The
bundle's own `cordis.patch.yml` appends the row to the composition root, so a
bundle install lands in the right place automatically.

## What this plugin does not touch

The plugin is strictly additive for every failure code except `QUOTA`, and for
`QUOTA` too until a session opts in:

- **Non-quota failures always delegate unchanged** — rate limits, server
  errors, timeouts, transports, and context overflows keep their ordinary
  handling, including compaction's own recovery.
- **A session that has not opted in delegates its quota failures unchanged.**
  This is the default.
- **The native quick retry is never removed.** `dsh-llm-retry` still runs
  first and its configured `retryPolicy` still governs. Note that `QUOTA` is
  not in the default `retryableCodes`, so by default a quota failure triggers
  no native retry at all and this plugin is the only thing that answers it;
  a provider that lists `QUOTA` (or runs `mode: always`) keeps its own
  retries, and this plugin wakes up only after they are spent.
- **One configuration is superseded rather than merely left alone.**
  `retryPolicy.mode: always` has no eligible-code list and no budget, and it
  asks downstream first, so for `QUOTA` the hourly schedule replaces its own
  sub-minute backoff. Every other configuration is untouched.

## The per-session switch

Long-term retry is **off until a session turns it on**. Three paths move the
same switch:

- **Composer chip** — beside the model, permission, and compaction chips, with
  a menu offering On, Off, and Default.
- **`/quota-retry <on|off|default|status>`** — the one write path the chip
  also uses, so a typed line and a click can never disagree.
- The setting is per session and **durable** through the `llm_quota_retry`
  storage domain, so it survives a host restart. Without a usable storage
  domain it degrades to a process-local value instead of failing the switch.

A session with no record of its own follows `defaultEnabled`. A forked or
delegated session takes its nearest ancestor's explicit setting once, as a
snapshot: the value applies to that session from then on, and `default` clears
it back to the deployment default rather than re-inheriting.

Turning the switch **off** while a session is waiting ends the entry
immediately — the pending timer is aborted rather than left to wake an hour
later — and reports `left` with reason `disabled`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `longTermDelayMs` | `3600000` | Interval between long-term attempts, in milliseconds. Must be a positive finite number no greater than `2147483647`. |
| `defaultEnabled` | `false` | The switch a session starts from before it owns a setting of its own. |

Unknown keys and invalid values throw at activation, so a misconfigured row
fails loudly instead of silently retrying on a wrong schedule.

```yaml
- id: llm-quota-retry
  name: 'dsh-llm-quota-retry'
  config:
    longTermDelayMs: 1800000
    defaultEnabled: true
```

## Reading the state from another plugin

Two read paths are published.

**The live retry state**, as the service `ctx.llmQuotaRetry`:

```js
export const inject = ['llmQuotaRetry']

export function apply(ctx) {
  ctx.on('session/event', (session) => {
    if (!ctx.llmQuotaRetry.isRetrying(session)) return
    const state = ctx.llmQuotaRetry.stateOf(session)
    // state.pending       — an hourly wait is armed right now
    // state.attempts      — long-term attempts scheduled for this entry
    // state.enteredAt     — epoch ms the entry opened
    // state.nextAttemptAt — epoch ms of the armed attempt, while pending
    // state.provider, state.turn, state.step — the failing request
  })
}
```

`isRetrying(session)` answers whether the session is in long-term retry.
`stateOf(session)` returns a frozen snapshot, or `undefined` when the session
is not in long-term retry. Both accept the Harness `Session`. This state is
in-memory: it exists only while a wait is live.

**The per-session switch**, as the `quotaRetry` Session projection:

```js
const facts = ctx.sessionProjections.stateOf(session, 'quotaRetry')
// facts.enabled        — the effective switch
// facts.defaultEnabled — the row's configured default
// facts.source         — 'default' | 'session' | 'inherited'
```

The projection is the client-visible path, so it is also what the composer chip
reads.

## Subscribing to the transitions

Two Cordis events carry the timing of every transition.

### `llm-quota-retry/entered`

Emitted once per entry, when the first quota failure takes the session over and
its first hourly wait is armed.

| Field | Meaning |
|---|---|
| `session`, `agent` | The session and agent whose request failed. |
| `failure` | The `LlmFailure` that opened the entry. |
| `provider`, `turn`, `step` | Location of the failing request. |
| `enteredAt` | Epoch ms the entry opened. |
| `nextAttemptAt` | Epoch ms of the first long-term attempt. |
| `attempts` | `1` on entry. |
| `pending` | `true` — the wait is armed. |
| `retrying` | `true`. |

### `llm-quota-retry/left`

Emitted when an entry ends: a model request in the session succeeded, or the
switch was turned off.

| Field | Meaning |
|---|---|
| `session` | The session whose entry ended. |
| `reason` | `recovered` or `disabled`. |
| `provider`, `turn`, `step` | Location of the last failed request. |
| `enteredAt` | Epoch ms the entry opened. |
| `leftAt` | Epoch ms the entry ended. |
| `durationMs` | `leftAt - enteredAt`. |
| `attempts` | Long-term attempts scheduled during the entry. |

```js
export function apply(ctx) {
  ctx.on('llm-quota-retry/entered', ({ session, nextAttemptAt }) => {
    // ...
  })
  ctx.on('llm-quota-retry/left', ({ session, reason, durationMs }) => {
    // ...
  })
}
```

## Behavior and limits

- **Only the canonical `QUOTA` code is observed.** Every other failure
  delegates to the next listener unchanged.
- **The session stays busy.** A long-term wait holds the open step, so the turn
  does not reach quiescence and the session reports as running until a request
  succeeds or the turn is cancelled.
- **Each attempt is a billed provider request.** The schedule is unbounded by
  design: nothing but a successful request, cancellation, the switch going
  off, or unloading the plugin stops it.
- **Cancelling a turn keeps the entry.** The pending wait aborts, `pending`
  becomes `false`, and no `left` is announced; the entry and its `enteredAt`
  survive, and the next quota failure in that session re-arms the schedule.
  Only success or turning the switch off ends an entry.
- **The composer chip shows the switch, not live progress.** Session
  projections recompute on session events, and the retry state changes between
  them, so a live "retrying now" badge would be up to an hour stale. Use the
  service or the two events for live progress.
- **It consumes no model-visible context.** Nothing here reaches the model, and
  the plugin writes no session events, so it adds no log vocabulary that
  another build would have to know.

## Hot reload

`index.js`, `client.js`, and `lib/policy.js` are listed in the profile's `hmr`
roots, so an edit to either host file replaces the module generation in a
running host: the plugin is disposed and re-imported, and `apply()` re-runs.
The in-memory retry state does not survive that — a reload drops a pending wait
and its entry, exactly as a restart does. The durable per-session switch does
survive, because it lives in the storage domain. Editing `client.js` of an
already-registered client row is picked up as a new artifact generation; only
adding or changing the `dsh.client` manifest itself needs a restart, because
the client-module scan caches that verdict per package.

## Probe

`probe/probe.mjs` drives `apply()` against a fake Cordis context and checks
every decision, event, state transition, command outcome, inherited setting,
and projection value without a Harness:

```sh
node probe/probe.mjs
```

`probe/client-probe.mjs` loads the composer half through a stub module loader
and checks its slot registration, dictionary, menu contents, selected option,
and the exact `/quota-retry` line it submits:

```sh
node probe/client-probe.mjs
```

Neither probe can produce a provider response that reports an exhausted quota.
Confirming the composed behavior against a real provider requires either an
account that actually runs out of balance or an OpenAI-compatible endpoint that
answers `402` with insufficient-balance wording.
