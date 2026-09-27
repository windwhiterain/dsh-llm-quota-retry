# dsh-llm-quota-retry

A DeepSeek Harness host plugin that keeps an agent step alive through an
exhausted account quota or balance.

When a model request fails with the canonical `QUOTA` code, the ordinary
recovery policy gives up once its retry budget is spent and the turn ends. This
plugin takes over at that point and retries the same request inside the same
open turn once per configured interval — one hour by default, with no attempt
limit — until a request succeeds or the turn is cancelled.

## Install

The package is a Cordis bundle. Install it into a profile and the row appears
in that profile's composition:

```sh
dsh plugin --profile web add C:/resource/dsh-llm-quota-retry
```

A freshly linked package needs one host restart before the Loader can resolve
its row; after that, both the row and the source files hot-reload.

## Composition order

Compose the `llm-quota-retry` row **after** `@deepseek-ai/dsh-llm-retry`.

That order is the contract, not a preference. `dsh-llm-retry` runs earlier in
the `agent/request-error` waterfall, spends its own retry budget first, and
calls the next listener once that budget is exhausted. By the time a quota
failure reaches this plugin, every earlier recovery policy has already
declined it — which is exactly what "after the base quick retries" means.

The bundle's own `cordis.patch.yml` appends the row to the composition root,
so a bundle install lands in the right place automatically.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `longTermDelayMs` | `3600000` | Interval between long-term attempts, in milliseconds. Must be a positive finite number no greater than `2147483647`. |

Unknown keys and out-of-range intervals throw at activation, so a
misconfigured row fails loudly instead of silently retrying on a wrong
schedule.

```yaml
- id: llm-quota-retry
  name: 'dsh-llm-quota-retry'
  config:
    longTermDelayMs: 1800000
```

## Reading the state from another plugin

The plugin publishes the service `ctx.llmQuotaRetry`:

```js
export const inject = ['llmQuotaRetry']

export function apply(ctx) {
  ctx.on('session/event', (session) => {
    if (!ctx.llmQuotaRetry.isRetrying(session)) return
    const state = ctx.llmQuotaRetry.stateOf(session)
    // state.pending      — an hourly wait is armed right now
    // state.attempts     — long-term attempts scheduled for this entry
    // state.enteredAt    — epoch ms the entry opened
    // state.nextAttemptAt— epoch ms of the armed attempt, while pending
    // state.provider, state.turn, state.step — the failing request
  })
}
```

`isRetrying(session)` answers whether the session is in long-term retry.
`stateOf(session)` returns a frozen snapshot, or `undefined` when the session
is not in long-term retry. Both accept the Harness `Session`.

## Subscribing to the transitions

Two Cordis events carry the timing of every transition:

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

Emitted when a model request in the session succeeds, which is the only
transition that ends an entry.

| Field | Meaning |
|---|---|
| `session` | The session that recovered. |
| `provider`, `turn`, `step` | Location of the last failed request. |
| `enteredAt` | Epoch ms the entry opened. |
| `leftAt` | Epoch ms the entry closed. |
| `durationMs` | `leftAt - enteredAt`. |
| `attempts` | Long-term attempts scheduled during the entry. |

```js
export function apply(ctx) {
  ctx.on('llm-quota-retry/entered', ({ session, nextAttemptAt }) => {
    // ...
  })
  ctx.on('llm-quota-retry/left', ({ session, durationMs, attempts }) => {
    // ...
  })
}
```

## Behavior and limits

- **Only the canonical `QUOTA` code triggers long-term retry.** Every other
  failure delegates to the next listener unchanged, so rate limits, server
  errors, and context overflows keep their ordinary handling.
- **The session stays busy.** A long-term wait holds the open step, so the turn
  does not reach quiescence and the session reports as running until a request
  succeeds or the turn is cancelled.
- **Each attempt is a billed provider request.** The schedule is unbounded by
  design: nothing but success, cancellation, or unloading the plugin stops it.
- **Cancelling a turn keeps the state.** The pending wait aborts, `pending`
  becomes `false`, and no `left` is announced; the entry and its `enteredAt`
  survive, and the next quota failure in that session re-arms the schedule.
  Only a successful request ends the state.
- **The state is in-memory.** Reloading or restarting the host drops a pending
  wait together with its entry, because the wait lived in the process that
  carried the open turn.
- **It consumes no model-visible context.** Nothing here reaches the model,
  and the plugin writes no session events, so it adds no log vocabulary that
  another build would have to know.

## Probe

`probe/probe.mjs` drives `apply()` against a fake Cordis context and checks
every decision, event, and state transition without a Harness:

```sh
node probe/probe.mjs
```
