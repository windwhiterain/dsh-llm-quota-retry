# dsh-llm-quota-retry

A DeepSeek Harness host plugin that answers an exhausted account quota or
balance: it moves the session to another provider/model that still has allowance
when one is configured, and otherwise keeps the step alive by retrying inside the
same open turn.

When a model request fails because the account is out of allowance, the ordinary
recovery policy gives up once its retry budget is spent and the turn ends. This
plugin takes over at that point. If the session's **route pool** — a named,
ordered list of interchangeable provider/model pairs — has a route with
allowance, the retry goes there immediately; if none has, the same request is
retried inside the same open turn once per configured interval — one hour by
default, with no attempt limit — until a request succeeds or the turn is
cancelled. It is on by default for every session: turn it off per session through
the [composer chip or `/quota-retry`](#the-per-session-switch), or for the whole
deployment with `defaultEnabled: false`. Which route has allowance comes from
[balance scripts](#route-pools-and-balance-sources) and from the providers that
report exhaustion themselves.

That covers three shapes of the same condition: the canonical `QUOTA` code, and
an `AUTH` or `RATE_LIMIT` failure whose text names a spent usage limit. The
other two are how metered providers answer — a 403 permission error from one
that meters a rolling window, a 429 rate limit from one that meters a Token
Plan (`已达到 Token Plan 用量上限：…`, in Chinese) — and a plugin that keyed on
`QUOTA` alone would miss exactly the cases it exists for.

## Install

The package is a Cordis bundle with a Web composer half:

From the directory that contains your checkout of this repository:

```sh
dsh plugin --profile web add ./dsh-llm-quota-retry
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

The plugin is strictly additive for every failure except an exhausted
allowance, and for that too in every session whose switch is off:

- **Every other failure delegates unchanged** — rate limits, server errors,
  timeouts, transports, and context overflows keep their ordinary handling,
  including compaction's own recovery. So does a credential the provider will
  keep rejecting, and so does ordinary throttling: an `AUTH` or `RATE_LIMIT`
  failure is read as a spent allowance only when its text names one, so a wrong
  or revoked API key still fails fast and a burst of concurrent requests still
  keeps its sub-minute retries, instead of either waiting an hour between
  attempts that cannot succeed.
- **A session whose switch is off delegates an exhausted allowance
  unchanged.** Turning the switch off is the opt-out; every session starts on,
  and it covers the route move as much as the wait.
- **A pooled session's request can be moved before it is sent.** That is what a
  pool is for, and it happens only when the route the request resolves to is
  unusable — an exhausted mark, or a reading below that provider's minimum — and
  another route of the session's pool is usable. A session with no pool and no
  assigned pool is never touched, and a model the user picked in the model picker
  is left alone as soon as it falls outside the session's pool.
- **The native quick retry is never removed.** `dsh-llm-retry` still runs
  first and its configured `retryPolicy` still governs. Note that `QUOTA` is
  not in the default `retryableCodes`, so by default an exhausted allowance
  triggers no native retry at all and this plugin is the only thing that
  answers it; a provider that lists `QUOTA` (or runs `mode: always`) keeps its
  own retries, and this plugin wakes up only after they are spent.
- **One configuration is superseded rather than merely left alone.**
  `retryPolicy.mode: always` has no eligible-code list and no budget, and it
  asks downstream first, so for an exhausted allowance the hourly schedule
  replaces its own sub-minute backoff. Every other configuration is untouched.

## The per-session switch

The response to an exhausted allowance is **on until the switch is turned off**,
and the switch covers the whole response: the move to another route of the
session's pool, and the wait-and-retry when no route has allowance. Three paths
move the same switch:

- **Composer chip** — beside the model, permission, and compaction chips, with
  a menu offering On, Off, and Default.
- **`/quota-retry <on|off|default|status>`** — the one write path the chip
  also uses, so a typed line and a click can never disagree.
- The setting is per session and **durable** through the `llm_quota_retry`
  storage domain, so it survives a host restart. Without a usable storage
  domain it degrades to a process-local value instead of failing the switch.

A session with no record of its own follows `defaultEnabled`, which is `true`
unless the row sets it to `false`. A forked or delegated session takes its
nearest ancestor's explicit setting once, as a snapshot: the value applies to
that session from then on, and `default` clears it back to the deployment
default rather than re-inheriting.

Turning the switch **off** while a session is waiting ends the entry
immediately — the pending timer is aborted rather than left to wake an hour
later — and reports `left` with reason `disabled`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `longTermDelayMs` | `3600000` | Interval between long-term attempts, in milliseconds. Must be a positive finite number no greater than `2147483647`. |
| `defaultEnabled` | `true` | The switch a session starts from before it owns a setting of its own. `false` makes the whole allowance response opt-in. |
| `pools` | none | Named, ordered route lists a session may be moved between. See below. |
| `balances` | none | One balance script per provider, reporting what it has left, plus the `apiKeyEnv` credential it runs with. See below. |
| `failOpen` | `true` | Whether a route nothing reported on counts as usable. `false` makes an unread provider unusable, so only a route a script vouches for is ever chosen. |
| `exhaustedCooldownMs` | `3600000` | How long a provider stays marked after a request failed with an exhausted allowance. Must be a positive finite number no greater than `2147483647`. |

Unknown keys and invalid values throw at activation, so a misconfigured row
fails loudly instead of silently retrying on a wrong schedule.

A row that turns the default off makes the allowance response opt-in for the
whole deployment; the row below also shortens the interval.

```yaml
- id: llm-quota-retry
  name: 'dsh-llm-quota-retry'
  config:
    longTermDelayMs: 1800000
    defaultEnabled: false
```

## Route pools and balance sources

A **route** is one provider/model pair. A **pool** is a named, ordered list of
routes that can stand in for each other. A **balance source** is a script that
reports what one provider has left.

```yaml
- id: llm-quota-retry
  name: 'dsh-llm-quota-retry'
  config:
    pools:
      medium:
        routes:
          - { provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: high }
          - { provider: qwen, model: qwen3.8-max, reasoningEffort: high }
    balances:
      - provider: opencode-go
        script: ['node', 'C:/resource/dsh-balance/opencode-go.mjs']
        apiKeyEnv: OPENCODE_API_KEY   # resolved through the credential service, then forwarded
        unit: percent             # what `remaining` counts, for a person reading it
        minimumRemaining: 5       # below this the route is not usable
        refreshMs: 60000
        timeoutMs: 5000
      - provider: qwen
        script: ['node', 'C:/resource/dsh-balance/qwen.mjs']
        minimumRemaining: 0
```

### The balance script contract

The script is **argv**, never a shell line: `script: ['node', 'x.mjs', '--json']`
runs exactly that executable with those arguments, through the harness's own
subprocess service, with the working directory the host was started in. It
should print **one JSON object on stdout**:

```json
{ "remaining": 42.5, "resetsAt": "2026-10-01T00:00:00Z" }
```

`remaining` is what the provider has left in whatever unit the row's `unit` field
names — a percent left, a currency amount, a credit count. A script for a
provider that reports *used* percentage converts it (`remaining = 100 - used`)
before printing. `resetsAt` is optional context for a person; a provider's own
refusal can be reported with `error` alongside a reading.

Everything else is a **missing reading**, not an error: a non-zero exit, a
timeout (`timeoutMs`), output that is not that JSON object, or no subprocess
service in the composition. A missing reading never stops a request — it is the
exhaustion mark, not a probe, that keeps a spent provider out of the way.

The script owns its requests, and this plugin forwards it only what the row names.
`apiKeyEnv` is the credential it should use: the plugin resolves that reference
through the harness's **credential service** at every run — so a key stored as an
environment variable, in a `.env`, or in the credential store all work the same
way, and a rotated key reaches the next run — and passes it to the script under
the same name (`OPENCODE_API_KEY=…`). A reference nothing is configured for adds
no entry and logs a warning; the script still runs, so it may read a key from
somewhere this plugin does not know about, and its own message is the better
diagnostic. `env` adds any other literal entries the script needs (a base URL, a
region, a proxy) and is never used for secrets.

The plugin never writes a script's stdout into a log.

### How a route is chosen

1. **An exhaustion mark decides first.** A provider that answered a request with
   an exhausted allowance is unusable until its mark lapses
   (`exhaustedCooldownMs`), or until a reading *taken after* the mark — at least
   one `refreshMs` later, so the very probe the failure triggered cannot undo it —
   shows allowance again. This is what makes failover work for the providers that
   publish no balance endpoint at all.
2. **Then a reading decides it**, against that provider's own
   `minimumRemaining` (zero when it declares none).
3. **A route nothing reported on** is usable when `failOpen` is on (the default),
   and unusable when it is off.

Declared order breaks ties, and a pool whose routes are *all* unusable still
answers with its first route: a request has to run somewhere, and the long-term
wait covers the case where every route refuses it. Only a pool the configuration
never declared is an error, and the caller that named it reports it as one.

### What happens to a session

- **At the end of a step**, before any waiting: a request that failed with an
  exhausted allowance marks its provider and looks for a usable route in the
  session's pool. One found means the retry goes there **at once**, announced as
  `llm-quota-retry/failover`; none found means the long-term wait, exactly as
  before.
- **At every request**, the route the session would otherwise use is replaced
  when it is not usable and a pool route is. This decision reads cached readings
  and marks only — it starts no script and waits for nothing, because a model
  request must never be held behind a balance probe. A route the user picked in
  the model picker is left alone as soon as it falls outside the session's pool.
- **Which pool governs a session**: the one a caller assigned it to
  (`assignPool`), or — when nobody did — the single pool that holds the route the
  session is on. A route two pools share names neither, so a session is never
  moved between pools on a guess. A delegation plugin assigns its children's
  pool at creation, which is what makes a pool name mean the same thing to the
  delegating session and to its child.
- **A new session** can ask for a route before it exists, through `pickRoute`,
  which refreshes the stale readings of **that pool's own providers** first, so a
  pool never probes a provider it cannot use and the wait is bounded by the
  slowest script in that pool. This
  is the delegation-time half: `dsh-subagent-templates` templates name a pool and
  call it for every child they create.

`/quota-routes [pool]` prints the same state a person needs: each pool, each
route, its last reading, and its exhaustion mark.

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

**The route surface**, on the same service:

```js
// Choose the route a session that does not exist yet should start on. Refreshes
// that pool's stale readings first, so it may wait up to the slowest of THEIR
// scripts' `timeoutMs`. `undefined` means no pool by that name exists — a config
// error at the caller.
const route = await ctx.llmQuotaRetry.pickRoute('medium')
// route.provider, route.model, route.reasoningEffort?

// Put a session under one pool's care, so a route several pools share is not
// left to inference. Returns false when the pool does not exist.
ctx.llmQuotaRetry.assignPool(childSession, 'medium')

// Every pool, route, reading, and mark — what `/quota-routes` prints.
const report = ctx.llmQuotaRetry.report()
```

`dsh-subagent-templates` is the reference caller: a template names a pool, and
every child it creates is assigned that pool and starts on the route `pickRoute`
chose.

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

Three Cordis events carry the timing of every transition.

### `llm-quota-retry/entered`

Emitted once per entry, when the first quota failure takes the session over and
its first long-term wait is armed. A failure that finds a route with allowance is
never an entry, so it is announced as `failover` instead.

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

### `llm-quota-retry/failover`

Emitted when a failed request is retried at once on another route of the
session's pool, instead of waiting out an interval.

| Field | Meaning |
|---|---|
| `session`, `agent` | The session and agent whose request failed. |
| `failure` | The `LlmFailure` that triggered the move. |
| `from` | The route that failed: `{ provider, model }`. |
| `to` | The route the retry goes to: `{ provider, model }`. |
| `pool` | The pool that supplied it. |
| `at` | Epoch ms of the decision. |

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
  ctx.on('llm-quota-retry/failover', ({ session, from, to, pool }) => {
    // ...
  })
  ctx.on('llm-quota-retry/left', ({ session, reason, durationMs }) => {
    // ...
  })
}
```

## Behavior and limits

- **The trigger is an exhausted allowance.** The canonical `QUOTA` code always
  counts; an `AUTH` or `RATE_LIMIT` failure counts only when its text names a
  spent usage limit, quota, balance, or credits, in English or Chinese.
  Everything else reaches the next listener untouched.
- **A failover is a billed request on the other route, and it happens at once.**
  The failed request itself already cost what it cost; the retry on the pool's
  next usable route is one more request, which is the point of configuring a
  pool. `llm-quota-retry/failover` announces every such move.
- **The session stays busy.** A long-term wait holds the open step, so the turn
  does not reach quiescence and the session reports as running until a request
  succeeds or the turn is cancelled.
- **Each long-term attempt is a billed provider request.** The schedule is
  unbounded by design: nothing but a successful request, cancellation, the switch
  going off, or unloading the plugin stops it.
- **Readings are cached, and only a delegation ever waits for one.** A model
  request's route decision uses what the last script run reported; a route with
  no reading falls back to `failOpen`. Losing a script's output therefore costs a
  reading, never a request.
- **A provider's own failure outranks its script.** A reading taken right after
  an exhaustion mark cannot withdraw it (it must be at least one `refreshMs`
  later), so a script with its own cache cannot bounce a session straight back
  into the route that just refused it.
- **Route state is in-memory.** Readings, marks, and pool assignments are lost
  when the host restarts or the row reloads; the next requests re-derive them
  from the providers' own answers and the next script runs. Only the per-session
  switch is durable.
- **Cancelling a turn keeps the entry.** The pending wait aborts, `pending`
  becomes `false`, and no `left` is announced; the entry and its `enteredAt`
  survive, and the next quota failure in that session re-arms the schedule.
  Only success or turning the switch off ends an entry.
- **The composer chip shows the switch, not live progress.** Session
  projections recompute on session events, and the retry state changes between
  them, so a live "retrying now" badge would be up to an hour stale. Use the
  service, `/quota-routes`, or the three events for live progress.
- **The wording checks compensate for the harness.** A Harness release that
  classifies a spent allowance as `QUOTA` — which `@deepseek-ai/dsh-llm` does
  as of the `fix(llm): classify a spent usage allowance as quota, not auth`
  change, for a rolling window a provider reports as a 403 — needs no wording
  check at all. A Token Plan provider still arrives as `RATE_LIMIT`: that
  harness classifier reads English wording only, so a Chinese body keeps its
  429 code and would take its turn down here. The checks keep this plugin
  correct against both hosts.
- **It consumes no model-visible context.** Nothing here reaches the model, and
  the plugin appends no session events, so it adds no log vocabulary that another
  build would have to know. A route it proposes is recorded the ordinary way, as
  the config of the request that used it.

## Hot reload

Listing `index.js`, `client.js`, `lib/policy.js`, `lib/routes.js`, and
`lib/balance.js` in the profile's `hmr` roots makes an edit to any of them
replace the module generation in a running host: the plugin is disposed and
re-imported, and `apply()` re-runs. A module missing from that list silently
never reloads, so keep the list in step with the files.
The in-memory retry state does not survive a reload — it drops a pending wait and
its entry, and with them every reading, exhaustion mark, and pool assignment,
exactly as a restart does; the next requests re-derive them. The durable
per-session switch does survive, because it lives in the storage domain. Editing
`client.js` of an already-registered client row is picked up as a new artifact
generation; only adding or changing the `dsh.client` manifest itself needs a
restart, because the client-module scan caches that verdict per package.

## Client bundle scope

The shell concatenates every dynamic client bundle of a batch into **one
classic script**, so a top-level declaration in `client.js` joins the same
lexical scope as every other bundle's. A name two bundles both declare is a
`SyntaxError` that fails the whole batch, which takes down every composer
contribution in it — not just this one.

`client.js` therefore declares nothing at the top level: a single IIFE owns
every name and only the `window.__ModuleLoader__.load(...)` call inside it
reaches the shell. `probe/client-probe.mjs` enforces this by evaluating the
bundle twice into one scope, which is exactly what a batch does.

## Probe

`probe/probe.mjs` drives `apply()` against a fake Cordis context and checks
every decision, event, state transition, command outcome, inherited setting, and
projection value without a Harness — including the route surface: the request
that is moved off an exhausted provider, the immediate retry a pool with
allowance produces, the long-term wait a pool without one still uses, the switch
that stops both, and the balance scripts, seen through a fake subprocess service:

```sh
node probe/probe.mjs
```

`probe/routes.probe.mjs` drives the route policy alone — config validation, the
balance-output contract, fail-open vs fail-closed, exhaustion marks and their
cooldown, pool inference, and the choice itself — with no context, no subprocess,
and no clock:

```sh
node probe/routes.probe.mjs
```

`probe/client-probe.mjs` loads the composer half through a stub module loader
and checks its slot registration, dictionary, menu contents, selected option,
and the exact `/quota-retry` line it submits:

```sh
node probe/client-probe.mjs
```

No probe can produce a provider response that reports an exhausted quota, and
none runs a real balance script. Confirming the composed behavior against a real
provider requires either an account that actually runs out of balance or an
OpenAI-compatible endpoint that answers `402` with insufficient-balance wording;
the balance contract is confirmed by running a script by hand and comparing its
stdout with `{"remaining": …}`.

## License

MIT
