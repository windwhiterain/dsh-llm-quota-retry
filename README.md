# dsh-llm-quota-retry

A DeepSeek Harness host plugin that answers an exhausted account quota or
balance: it moves the session to another provider/model that still has allowance
when one is configured, and otherwise keeps the step alive by retrying inside the
same open turn.

When a model request fails because the account is out of allowance, the ordinary
recovery policy gives up once its retry budget is spent and the turn ends. This
plugin takes over at that point. If the session's **route pool** — a named,
ordered list of interchangeable provider/model pairs — has a route with
allowance, the retry goes there immediately, drawn in proportion to what each
route has left; if none has, the same request is
retried inside the same open turn once per configured interval — one hour by
default, with no attempt limit — until a request succeeds or the turn is
cancelled. It is **off** for a session that owns no setting, so this plugin never
takes over a conversation a person is having and never redraws the model their
picker chose: work the deployment declares to be delegated opts in on its own — see
[`delegatedChildren`](#the-per-session-switch). Which route has allowance comes
from [balance scripts](#route-pools-and-balance-sources) and from the providers
that report exhaustion themselves.

Any session can also be put in a pool by hand — the
[second composer chip or `/quota-pool`](#the-per-session-route-pool) — and a
session whose model happens to be pooled follows that pool without being told to.
A pool's `minimumRemaining` decides which routes a session *starts* on, and the
one it starts on is drawn from them in proportion to what each has left; once a
session is running, only a provider reporting its allowance spent moves it.

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

**Row order does not decide listener order.** A Cordis waterfall runs its
listeners in registration order, and a plugin registers when its services
appear rather than when its row is read; reloading a row moves that row's
listener to the end. So in a deployment where this plugin happened to activate
first, it gets the first word on a quota failure, and a failure the native
policy lists as eligible gets no native retry at all. A provider named in
[`nativeRetryFirstProviders`](#native-quick-retries-for-a-named-provider) is
answered the same way either way.

## Native quick retries for a named provider

Some providers report ordinary request throttling as a spent allowance — a
`QUOTA` body behind a 429 that clears in seconds. Waiting out an hour for that
is the failure this plugin exists to avoid, and on those providers a rate limit
must also not count as evidence that the account is out of allowance.

`nativeRetryFirstProviders` names them. For a named provider, an exhausted
allowance runs that provider's **own native retry schedule first** — the same
bounded exponential backoff and the same attempt budget `@deepseek-ai/dsh-llm-retry`
would have run, taken from the resolved `retryPolicy` the failed request carries
(`initialDelayMs`, `maxDelayMs`, `jitterRatio`, `maxRetries`, and a
`providerRetryAfterMs` the provider asked for while it fits under its own
ceiling). Only when that budget is spent does this plugin mark the provider out
of allowance, move the session to another route of its pool, and start the
hourly wait.

The quick retries run **before** the exhaustion mark and before any failover, so
a provider that was merely throttled keeps its allowance and the session stays
on it. They hold the open step for a few seconds, like the long-term wait does,
and they announce nothing: the entry, its events, and `ctx.llmQuotaRetry` state
describe the long-term wait, which has not started yet. Progress is in the log:

```
llm-quota-retry: provider "qwen" returned QUOTA; native quick retry 2 in 4000ms
```

Three rules decide whether a quick retry happens at all, and each is a case
where the native policy, not this plugin, owns the step:

- **The provider is named in the row.** Every other provider is unchanged.
- **The native policy holds a bounded schedule.** No `retryPolicy` at all, and
  `mode: always`, which has no budget to spend, leave the failure to the hourly
  wait. So does a `providerRetryAfterMs` beyond the policy's `maxDelayMs`, which
  the native policy answers by delegating rather than by retrying.
- **The native policy has not already spent this step's budget.** When this row
  really does run after `dsh-llm-retry` and the failure is one that policy
  retries, its own budget is spent first, and this plugin adds no wait of its
  own. The plugin reads that from the `llm/retry` events the Session already
  records — the one piece of cross-plugin state it depends on, and one it can
  simply lack: without `@deepseek-ai/dsh-llm-retry` the quick schedule runs, and
  with a native policy that never spent its budget, so does it.

**A balance reading is deliberately not a fourth rule.** qwen answers the same
`insufficient_quota` failure whether the plan is spent or the request was merely
throttled, so a reading showing nothing left cannot tell those two apart — and
the quick retry is the only thing that lets a throttled request recover in
seconds. Skipping the schedule for a low reading would turn one conflated error
into an immediate failover, which is the opposite of what this list is for. The
cost stays bounded and visible instead: a provider that really has nothing left
spends one step's schedule and the long-term wait follows. Shortening that
schedule is the provider's own `maxRetries` and `maxDelayMs`, not a rule here.

The quick budget is counted per step, like the native one: a step that runs out
of it enters the long-term wait, and the next step starts a fresh budget.

```yaml
- id: llm-quota-retry
  name: 'dsh-llm-quota-retry'
  config:
    # qwen reports a 429 rate limit as `insufficient_quota`, so its own bounded
    # backoff runs first: 2s, 4s, 8s … up to maxRetries, then the hourly wait.
    nativeRetryFirstProviders: [qwen]
```

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
  own retries, and this plugin wakes up only after they are spent. A provider
  named in `nativeRetryFirstProviders` runs that same schedule from here when
  the native policy did not, which is additive rather than a replacement: see
  [the named provider](#native-quick-retries-for-a-named-provider).
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

A session with no record of its own follows `defaultEnabled`, which is `false`
unless the row sets it to `true`, with one exception: a session that **is**
delegated work is on whatever the default says. A session is delegated work when
its own header says so — `delegationDepth` above zero, or `origin: 'subagent'` —
or when a delegator that keeps its children looking like full sessions publishes
it as one of the projections `delegatedChildren` names. The order is the session's
own record, then that, then the deployment default: a person who switched this off
for a session keeps it off whatever that session turns out to be.

A delegator that creates ordinary root sessions leaves no trace in a session
header — that header is what makes the Client keep showing the children as full
sessions, each with its own model picker, and it names no parent either. It
publishes the relation as a session projection, and this plugin collects it from
the registry's change feed, which means a view published before this row mounted
is not in the feed: such a delegation reads as absent until its delegator
publishes again.

A forked or delegated session takes its
nearest ancestor's explicit setting once, as a snapshot: the value applies to
that session from then on, and `default` clears it back to the deployment
default rather than re-inheriting.

Turning the switch **off** while a session is waiting ends the entry
immediately — the pending timer is aborted rather than left to wake an hour
later — and reports `left` with reason `disabled`.

## The per-session route pool

Which pool governs a session is a setting of its own, in the same durable record
as the switch and with the same inheritance rules. It is written the same two
ways:

- **Composer chip** — a second chip beside the switch. Its menu lists every
  configured pool by name, plus Default and Off.
- **`/quota-pool <pool|off|default|status>`** — the one write path that chip
  also uses. `status` reports the effective pool, where it came from, and the
  route the session is on.

Three states, deliberately distinct:

| Setting | What it means |
|---|---|
| a pool name | This session belongs to that pool: on an exhausted allowance it may move to another of its routes. |
| `default` | No pool is stated, so the plugin follows the route the session is on — **a route exactly one pool holds names that pool**. An ordinary session whose model is pooled therefore fails over without being told to; a route two pools share names neither. |
| `off` | This session never changes provider. An exhausted allowance is waited out where it is, however long that takes. |

**Choosing a pool chooses a route.** The moment a session is put in a pool — by
the command, by the chip, or by the delegation plugin that created it from a
pooled template — the plugin draws a route from it (each usable route in
proportion to what it has left, so the threshold applies) and the session's next
request uses it, even when the model it is on belongs to no pool. That choice is
recorded on the session itself, as the `model/selection` event the model picker
writes, so the Client's picker shows the route actually in use. After that the
session is only moved again when a provider reports its allowance spent, and a
model the user picks afterwards is left alone.

A quota failover never changes the **deployment default** for new sessions, even
though it moves a session the same way the picker would. The picker's own write
path saves the choice as the default as well; this plugin deliberately does not
use it.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `longTermDelayMs` | `3600000` | Interval between long-term attempts, in milliseconds. Must be a positive finite number no greater than `2147483647`. |
| `defaultEnabled` | `false` | The switch a session that owns no setting starts from. `true` opts every session in; `false` leaves the default to the delegation rule, which is what a deployment that composes subagents wants. |
| `delegatedChildren` | none | Session projections whose published children are delegated work, and so are switched on whatever `defaultEnabled` says. Each source is `projectionKey` plus, optionally, `rowsField` (default `children`) and `sessionIdField` (default `childSessionId`). |
| `nativeRetryFirstProviders` | none | Provider ids whose exhausted allowance runs the provider's own native retry schedule first. See [the named provider](#native-quick-retries-for-a-named-provider). |
| `pools` | none | Named, ordered route lists a session starts on and may be moved between. Each pool is `routes` plus, optionally, `midSessionSwitch: false` to refuse the moves this plugin makes on its own once a session is running. See below. |
| `balances` | none | One balance script per provider, reporting what it has left, plus the `apiKeyEnv` credential it runs with, the `coefficients` weighing each window it reports, the `capacities` a window the script leaves without one divides by, and the `capacity` a reading with no window divides by. See below. |
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
reports what one provider has left. The scripts this deployment runs live in
[dsh-balance](https://github.com/windwhiterain/dsh-balance) — one file per
provider, no dependencies, each printing one JSON reading on stdout.

```yaml
- id: llm-quota-retry
  name: 'dsh-llm-quota-retry'
  config:
    pools:
      medium:
        routes:
          - { provider: gateway-a, model: flash-1, reasoningEffort: high }
          - { provider: gateway-b, model: flash-1, reasoningEffort: high }
      advice:
        midSessionSwitch: false   # interchangeable to start on, never swapped under a live session
        routes:
          - { provider: gateway-a, model: model-max, reasoningEffort: high }
          - { provider: gateway-b, model: model-max, reasoningEffort: high }
    balances:
      - provider: gateway-a
        script: ['node', 'C:/resource/dsh-balance/gateway-a.mjs']
        apiKeyEnv: GATEWAY_A_API_KEY      # resolved through the credential service, then forwarded
        unit: percent             # what `remaining` counts, for a person reading it
        minimumRemaining: 5       # below this a route is not chosen, and never one already running
        refreshMs: 60000          # how long a reading answers a route draw without a new run
        timeoutMs: 5000           # and how long that draw waits for this script at most
        coefficients:             # how the windows this script reports are weighed
          five-hour: 1            # a window the map does not name weighs 1
          monthly: 0.25           # a month of credits matters a quarter as much
        capacities:               # what a window counts as full, for a script that
          monthly: 40             # reports an amount without the plan's cap
      - provider: gateway-b
        script: ['node', 'C:/resource/dsh-balance/gateway-b.mjs']
        apiKeyEnv: GATEWAY_B_API_KEY
        unit: usd-left
        minimumRemaining: 1
        capacity: 20              # this script reports no window: 20 usd counts as full
```

### A route's provider is the harness's provider id

`provider` is the route key the harness resolves a model request through — the id
itself passes to `ctx.llm`, not a provider's own marketing name and not the id some
SDK underneath happens to use internally. A provider plugin registers one such id,
and the name of its package, its row, or the vendor is not automatically that id.

This is the one mistake in this file that cannot be caught from here, so the
plugin checks it rather than trusting it: see
[the provider check](#the-provider-check).

### The provider check

A route's provider is written verbatim into the `model/selection` event this
plugin emits, so a name no adapter serves does not fail where it was written — it
fails later, on somebody's model request, as the harness's `NO_ADAPTER`. The plugin
therefore holds every provider name in `pools` and `balances` against the adapters
the composition registered, and reports a mismatch once rather than on every
announcement:

```
llm-quota-retry: no LLM adapter is registered for provider "opencode-go" (named by
pools.medium.routes[0], balances[0]); a model request on one of them fails with
NO_ADAPTER. Registered providers: command-code-goat, dsh-opencode-go, kimi-coding
```

**When it reports.** Composition order decides when each adapter registers, and a
provider plugin composed after this row registers its adapter after `apply()` has
returned — so a name missing at activation says nothing about whether it will ever
arrive. Nothing in the harness announces that a composition has finished, so the
check answers at the earliest point that can: it follows every
`llm/adapters-updated` announcement but reports from one only when **two
consecutive announcements agree on the missing set** — every announcement
registers at least one adapter, so an unchanged set means no configured provider
is still on its way. Failing that, the first request to route settles it, which is
also the moment the defect matters.

**What it does to routing.** A pool whose routes name a provider no adapter serves
is **refused**: `pickRoute` throws for it, naming the pool and the provider, and
the session that asked is not put in the pool. A *balance source* naming one is
not refused — a balance name is only a lookup key into this plugin's own readings,
so a mismatch there costs a reading rather than a request and a deployment whose
balance script is misnamed still delegates.

`/quota-routes` prints the same sentence above the pools, so the state a person
reads names the same defect the log does.

### The balance script contract

The script is **argv**, never a shell line: `script: ['node', 'x.mjs', '--json']`
runs exactly that executable with those arguments, through the harness's own
subprocess service, with the working directory the host was started in. It
should print **one JSON object on stdout**:

```json
{
  "remaining": 2.94,
  "windows": [
    { "name": "five-hour", "remaining": 14, "capacity": 14 },
    { "name": "weekly", "remaining": 2.94, "capacity": 35 },
    { "name": "monthly", "remaining": 37.94 }
  ],
  "resetsAt": "2026-10-01T00:00:00Z"
}
```

`remaining` is what the provider has left in whatever unit the row's `unit` field
names — a percent left, a currency amount, a credit count. A script for a
provider that reports *used* percentage converts it (`remaining = 100 - used`)
before printing. `resetsAt` is optional context for a person; a provider's own
refusal can be reported with `error` alongside a reading.

`windows` is optional, and it is what ranks one route against another: a plan
meters several windows (a five-hour cap, a week, a month), and the one that will
refuse the next request is the one to go by. Each entry names its own window
(`name`), reports what is left of it (`remaining`), and reports that window's
full allowance (`capacity`) when the provider publishes one. A window's
`remaining` is in that window's own unit; the plugin divides it by that same
window's `capacity`, so a percentage plan and a wallet in another currency
compare. A window without a `capacity` — a prepaid wallet, a monthly credit an
endpoint reports only as an amount — is kept for the person reading
`/quota-routes` and skipped by the ranking.

Everything else is a **missing reading**, not an error: a non-zero exit, a
timeout (`timeoutMs`), output that is not that JSON object, or no subprocess
service in the composition. A missing reading never stops a request — the route
that asked for it falls back to the pool's declared order under `failOpen`, and
the exhaustion mark is what keeps a provider the pool has already been told about
out of the way. A malformed `windows` entry is dropped rather than failing the
reading; the top level `remaining` is what the row's `minimumRemaining` still
measures.

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

**A choice and an interruption are two different rules.** A threshold
(`minimumRemaining`) decides which route a session *starts* on, and which route a
session moves to; it never interrupts a session that is already running on one.
That split is deliberate: another account can mean another model, another prompt
cache, and another price, so a live conversation is only moved when the route it
is on cannot answer at all.

**A session's first request is where the pool chooses, and it never chooses
without a balance to choose from.** A session that has not made a request through
this plugin yet has no conversation to protect, so its starting route is drawn from
its pool by the rule below, whatever `midSessionSwitch` says. That draw is made
from readings the pool owns: a source whose reading is missing or older than its
own `refreshMs` is asked again first and the draw waits for it, and a reading
inside that interval answers with no round trip. So the common case costs nothing,
the interval bounds how often the scripts start, and the draw is never made from
the *absence* of a reading — the one case that used to hand a session a route in
declared order. The wait is bounded by each source's own `timeoutMs`, so a script
that hangs costs its timeout and not the request.

**Choosing a route**, in this order:

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

**Among the usable routes, the one drawn is proportional to what it has left.**
A reading is scored as a fraction of the allowance that binds it — the **worst**
of its `windows`, each weighed by the row's own `coefficients` — and the draw
puts a route in the pool's range in proportion to that score. A route with twice
the headroom of another is drawn twice as often, so a pool is spent across its
routes instead of drained route by route, and the next request still goes to
whichever route the draw lands on rather than to the one with the most left.

| Case | What decides |
|---|---|
| The row names one or more scored windows | The lowest `remaining / capacity × coefficient` over the windows that carry a `capacity`, or a `capacities` entry for their name |
| The reading has no scorable window | The whole reading against the row's `capacity`, when the row declares one |
| Neither | The route is unscored, and undrawable while any scored route of the pool is usable |
| Nothing in the pool is scored | Declared order: the first usable route, exactly as before |

Declared order also breaks the tie between two equally scored routes, and a pool
whose routes are *all* unusable still answers with its first route: a request has
to run somewhere, and the long-term wait covers the case where every route
refuses it. Only a pool the configuration never declared is an error, and the
caller that named it reports it as one.

The coefficients are how a deployment says which window matters. `monthly: 0.25`
means a month of credits counts for a quarter of what the same fraction of a
five-hour cap counts for; `0` drops a window from the score entirely. A window
name the map does not mention weighs `1`, so a row that declares no
`coefficients` weighs every window equally.

`capacities` is the other half: a provider that reports **what is left of a
window without stating what full is** — an endpoint that answers a dollar amount
of remaining credits and no monthly cap — leaves that window unscored until the
row says what the window's full allowance is. The capacity the script reports
always wins; the row's entry only fills in a window the provider left without
one. `--raw` on the balance script, or `/quota-routes`, shows which windows came
back and which of them are being scored.

**Leaving a route** needs one thing: the provider itself reporting the allowance
spent. A reading below the threshold does not move a session that has already
started, and neither does a pool reordering. The move is then made by the same
rule — the draw over the routes that are not out of allowance and clear their own
threshold, or failing that the first route that is merely not out of allowance,
because a route with little left can still be the one that answers.

**A pool can refuse that move.** `midSessionSwitch: false` on a pool means its
routes are interchangeable for the session that *starts* on one, never for the
session already running on it: an exhausted provider is waited out where it is
instead of being swapped for a different model mid-conversation, and no
`llm-quota-retry/failover` is announced. It governs **only the moves this plugin
makes on its own after that start** — the failure-time failover and the
per-request replacement. A move the user asks for is not that decision and is
unaffected: the model picker, `/quota-pool <name>`, and the composer chip all still
move a session, and `pickRoute` still draws a starting route for every new session
and every delegated child. Use it for a pool whose routes are different *models*
rather than the same model behind several accounts, where the swap costs a prompt
cache and a change of behavior the conversation did not ask for — the sessions
still *start* on whichever of those models has the most left.

| Pool | `midSessionSwitch` | What a session already running on one of its routes does when that provider runs out |
|---|---|---|
| `medium` (default) | on | Moves to another route of the pool and retries at once. |
| `advice` | off | Keeps its route and waits out the interval; only the user moves it. |

### What happens to a session

- **At the end of a step**, before any waiting: a request that failed with an
  exhausted allowance marks its provider and looks for a usable route in the
  session's pool. One found means the retry goes there **at once**, announced as
  `llm-quota-retry/failover`; none found means the long-term wait, exactly as
  before. A pool that refuses mid-session switching is one of the ways none is
  found.
- **At every request**, the route the session would otherwise use is drawn from its
  pool in proportion to headroom while the session is still starting, and replaced
  once it has started when its provider has **reported the allowance spent** and the
  pool holds a route that has not. Drawing waits for whichever of the pool's
  balance scripts are due and only marks once they have answered; replacing waits
  for nothing at all, because that decision is made against the provider's own
  exhaustion mark rather than a reading, and a provider that just refused a
  request is the last thing worth waiting on. A reading below a route's threshold
  does not move a session that has already started (see "How a route is chosen"), a
  pool that refuses mid-session switching never moves it here either, and a route
  the user picked in the model picker is left alone as soon as it falls outside the
  session's pool.
- **A route the plugin chose governs the session until someone else chooses one.**
  The Host resolves each request from the model selection it captured at prompt
  assembly, and the `model/selection` event a move appends does not update that
  selection: it is cleared only when a request actually uses the cached route. So
  the chosen route is re-applied to every later request of that session, which is
  what makes a draw, a failover, or a pool choice outlast the one request it was
  made for. A `model/selection` event the plugin did not write — the model
  picker, the `/model` popup — releases it at once, and naming a pool with
  `/quota-pool` or the chip moves the session into that pool's next draw.
- **Which pool governs a session**: the one the session states (`/quota-pool`,
  the chip, or the delegation plugin that created it), or — when it states none —
  the single pool that holds the route the session is on. A route two pools share
  names neither, so a session is never moved between pools on a guess. A stated
  pool is what makes a pool name mean the same thing to a delegating session and
  to its child.
- **A new session** can ask for a route before it exists, through `pickRoute`,
  which reads **that pool's own providers** first — asking again for whichever of
  them are due — so a pool never probes a provider it cannot use and the wait is
  bounded by the slowest script that actually ran. This
  is the delegation-time half: `dsh-subagent-templates` templates name a pool and
  call it for every child they create — one route per child, drawn in proportion
  to headroom, so two subagents of one template start on different routes without
  anyone choosing between them.

`/quota-routes [pool]` prints the same state a person needs: each pool, each
route, its last reading, its score when it has one, and its exhaustion mark. A
pool that refuses mid-session switching is named as such in its header, so the
report also answers why a session did not move.

### Pool names

A pool is named by the deployment, with lowercase letters, digits, and hyphens.
Eight names are refused at activation because `/quota-pool` and the composer menu
answer them themselves: `status`, `off`, `none`, `disable`, `disabled`,
`default`, `reset`, `auto`, and `error`. A pool called `off` could never be
selected, so the row fails loudly instead of defining one nobody can reach.

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
// Choose the route a session that does not exist yet should start on: one draw
// over the pool's usable routes, each in proportion to what it has left, so two
// calls can answer differently by design. Asks again for the pool's sources whose
// reading is missing or past their own `refreshMs`, so it may wait up to the
// slowest of THOSE scripts' `timeoutMs`.
// `undefined` means no pool by that name exists — a config error at the caller.
// It rejects when a route of the pool names a provider no adapter serves, which
// is also a config error at the caller; see
// [the provider check](#the-provider-check).
const route = await ctx.llmQuotaRetry.pickRoute('medium')
// route.provider, route.model, route.reasoningEffort?

// Put a session under one pool's care, so a route several pools share is not
// left to inference. The session's next request moves into the pool. Pass `null`
// for the opt-out. Returns false when the pool does not exist.
ctx.llmQuotaRetry.setPool(childSession, 'medium')

// The pool governing a session right now: the one it states, or the one its
// route belongs to; undefined when none does.
const pool = ctx.llmQuotaRetry.poolOf(session)

// Every pool, route, reading, score, and mark — what `/quota-routes` prints.
const report = ctx.llmQuotaRetry.report()
```

`dsh-subagent-templates` is the reference caller: a template names a pool, its
child is created on the route `pickRoute` chose, and `setPool` records the pool on
the child so a failover later knows where it may move to.

**The per-session settings**, as the `quotaRetry` Session projection:

```js
const facts = ctx.sessionProjections.stateOf(session, 'quotaRetry')
// facts.enabled        — the effective switch
// facts.defaultEnabled — the row's configured default
// facts.source         — 'default' | 'session' | 'inherited'
// facts.pool           — the pool governing the session, or null
// facts.poolSource     — 'default' | 'session' | 'inherited' | 'off'
// facts.pools          — every configured pool name, in configured order
```

The projection is the client-visible path, so it is also what both composer chips
read.

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
- **A quick retry of a named provider is a billed request too**, and it is
  bounded exactly like the native one: at most `maxRetries` waits per step,
  none longer than the policy's `maxDelayMs`. It is what runs first for a
  provider in `nativeRetryFirstProviders`, and it is the reason such a provider
  is neither marked out of allowance nor moved off while its limit lasts.
- **Quick retries publish nothing.** They emit no plugin event and append no
  session event: `llm/retry` belongs to `@deepseek-ai/dsh-llm-retry` and
  counting these waits into its projection state would make *it* skip retries
  it still owes. The entry, `ctx.llmQuotaRetry`, and the three events describe
  the long-term wait, which starts after the quick budget is spent.
- **A failover is a billed request on the other route, and it happens at once.**
  The failed request itself already cost what it cost; the retry on the pool's
  next usable route is one more request, which is the point of configuring a
  pool. `llm-quota-retry/failover` announces every such move.
- **Two identical sessions can start on different routes.** The route a pool
  answers with is drawn in proportion to headroom rather than taken from the top
  of a ranking, so a deployment with several routes spreads its work instead of
  draining the richest one; only a pool with nothing scored falls back to the
  declared order. The draw is what the score shown by `/quota-routes` weighs.
- **The session stays busy.** A long-term wait holds the open step, so the turn
  does not reach quiescence and the session reports as running until a request
  succeeds or the turn is cancelled.
- **Each long-term attempt is a billed provider request.** The schedule is
  unbounded by design: nothing but a successful request, cancellation, the switch
  going off, or unloading the plugin stops it.
- **A route choice waits only for the balance scripts that are due.** Drawing a
  session's starting route asks again for the pool's sources whose reading is
  missing or past their own `refreshMs`, and waits for exactly those; a reading
  still inside its interval answers the draw with no round trip at all. The wait
  is bounded by each source's own `timeoutMs` and by nothing else: losing a
  script's output costs a reading and the timeout, never the request, and a route
  with no reading at all falls back to `failOpen`.
- **A provider's own failure outranks its script.** A reading taken right after
  an exhaustion mark cannot withdraw it (it must be at least one `refreshMs`
  later), so a script with its own cache cannot bounce a session straight back
  into the route that just refused it.
- **Route state is in-memory, the settings are not.** Readings, marks, and the
  route each session is on are lost when the host restarts or the row reloads, so
  the first request after one reads as that session's start and is drawn from its
  pool again — a pool that refuses mid-session switching included. The switch **and
  the route pool** are durable, in the same
  `llm_quota_retry` record with the same inheritance.
- **Cancelling a turn keeps the entry.** The pending wait aborts, `pending`
  becomes `false`, and no `left` is announced; the entry and its `enteredAt`
  survive, and the next quota failure in that session re-arms the schedule.
  Only success or turning the switch off ends an entry.
- **The composer chips show the settings, not live progress.** Session
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
  the one event the plugin appends is `model/selection` — the picker's own, so
  the Client shows the route a pool chose. It introduces no new session
  vocabulary a build would have to know, and it never touches the deployment's
  default model. A route it proposes is recorded the ordinary way, as
  the config of the request that used it.

## Hot reload

Listing `index.js`, `client.js`, `lib/policy.js`, `lib/routes.js`,
`lib/balance.js`, and `lib/providers.js` in the profile's `hmr` roots makes an
edit to any of them replace the module generation in a running host: the plugin is
disposed and re-imported, and `apply()` re-runs. A module missing from that list
silently never reloads, so keep the list in step with the files.
The in-memory retry state does not survive a reload — it drops a pending wait and
its entry, and with them every reading and exhaustion mark, exactly as a restart
does; the next requests re-derive them. The durable per-session switch and route
pool do survive, because they live in the storage domain. Editing
`client.js` of an already-registered client row is picked up as a new artifact
generation; only adding or changing the `dsh.client` manifest itself needs a
restart, because the client-module scan caches that verdict per package. The page
is already open, so refresh it to load the new chip.

## Client bundle scope

The shell concatenates every dynamic client bundle of a batch into **one
classic script**, so a top-level declaration in `client.js` joins the same
lexical scope as every other bundle's. A name two bundles both declare is a
`SyntaxError` that fails the whole batch, which takes down every composer
contribution in it — not just this one.

`client.js` therefore declares nothing at the top level: a single IIFE owns
every name and only the `window.__ModuleLoader__.load(...)` call inside it
reaches the shell. It registers two composer chips — the retry switch and the
route pool — into the same slot, each with its own registration and disposer.

## Probe

`probe/probe.mjs` drives `apply()` against a fake Cordis context and checks
every decision, event, state transition, command outcome, inherited setting, and
projection value without a Harness — including the route surface: the request
that is moved off an exhausted provider, the immediate retry a pool with
allowance produces, the long-term wait a pool without one still uses, the switch
that stops both, the pool setting (stated, inferred, opted out, inherited, and
restored from storage), the `model/selection` event a chosen route is recorded
as, the balance scripts seen through a fake subprocess service, the draw that
sends a session to a route in proportion to its headroom (driven through an
injected `random`, so the choice is exact), and the native-first provider list:
which providers qualify, the waits it schedules, and the long-term entry it hands
over to once that budget is spent.

```sh
node probe/probe.mjs
```

`probe/routes.probe.mjs` drives the route policy alone — config validation, the
balance-output contract (including the windows a reading carries and the
coefficients and capacity a row declares), the score a reading earns, fail-open
vs fail-closed, exhaustion marks and their cooldown, pool inference, and the
proportional draw itself — with no context, no subprocess, and no clock:

```sh
node probe/routes.probe.mjs
```

`probe/client-probe.mjs` loads the composer half through a stub module loader
and checks both chips: their slot registration, order, dictionary, menu contents,
selected option, and the exact `/quota-retry` or `/quota-pool` line each submits:

```sh
node probe/client-probe.mjs
```

No probe can produce a provider response that reports an exhausted quota, and
none runs a real balance script. Confirming the composed behavior against a real
provider requires either an account that actually runs out of balance or an
OpenAI-compatible endpoint that answers `402` with insufficient-balance wording;
the balance contract is confirmed by running a script by hand and comparing its
stdout with `{"remaining": …}` and its `windows`. What a real pool then does with
those readings — which route a draw lands on — is what `/quota-routes` shows.

## License

MIT
