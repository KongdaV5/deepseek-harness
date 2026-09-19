---
description: "Bounded in-run retry policy for DS Harness: a fail-closed gate in front of the existing provider-routed retry executor, capped at two automatic retries after the initial attempt, with cancellation and fatal categories never retried."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-policy

English | [中文](README.zh.md)

## Summary

Constrain the retry mechanism the harness already has, without replacing it. The plugin installs one outermost listener on the agent loop's `agent/request-error` waterfall and decides only whether the existing executor may proceed: at most two automatic retries after the initial attempt, no retry for cancellation or a fatal class, and a denial — not a guess — when no current contract names a failure retryable. A permitted retry stays inside the same Session, turn, `RunId`, and step. It adds no Session event and never invokes guarded resume.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **plugin**, but it owns no execution. The current source already owns in-run retry: `dsh-llm-retry` recovers failures on the waterfall, the provider adapter owns the `retryPolicy`, and every scheduled retry is durable before its wait. This package replaces none of that.

```ts
import { Context } from '@deepseek-ai/cordis'
import * as agentRunPolicy from '@deepseek-ai/dsh-agent-run-policy'

declare const ctx: Context

// Installs the decision listener; omission of the config allows the product maximum.
ctx.plugin(agentRunPolicy)
// or: ctx.plugin(agentRunPolicy, { maxRetryCount: 1 })
```

When the policy delegates, the executor still applies its own code eligibility, its own budget, its own backoff, its own retry identity, and its own durable `llm/retry` events. When the policy denies, it returns `undefined` from the waterfall, so no attempt is scheduled and no retry event is written.

### The ceiling is a product invariant, not a tunable

`MAX_AUTOMATIC_RETRIES` is `2` and `MAX_AUTOMATIC_ATTEMPTS` is `3`: the largest automatic chain is `initial attempt + retry 1 + retry 2`. The cap counts *retries*, never attempts, so two retries is three attempts. The deployment `Config.maxRetryCount` may lower the ceiling — down to `0`, which disables automatic in-run retry entirely — but can never raise it, and an out-of-range value fails closed before any listener is installed. The ceiling composes over an `always` provider policy too, so even an adapter that declares no limit of its own cannot produce a longer automatic chain.

### Cancellation and fatal classes never retry

The decision order is fixed, and every step is structured evidence rather than prose:

- an aborted signal is `CANCELLED` — a user ending a run is an outcome, not a fault;
- a fatal failure, including a fatal primary error already attached to the run, is `FATAL_FAILURE`;
- a closed or mismatched turn is `RUN_NOT_RETRYABLE`, because an in-run retry needs an open turn to run inside;
- a class this policy never retries automatically is `NO_RETRY_CATEGORY`;
- a failure no current contract names retryable is `NO_STRUCTURED_RETRYABILITY`, denied rather than assumed transient;
- an exhausted budget is `RETRY_BUDGET_EXHAUSTED`.

### Retryability is read, never inferred

Retryability comes from the captured provider policy plus the Stage 7 category. In `normal` mode a failure must carry a code the policy's own retryable set lists; in `always` mode a structured category other than `UNKNOWN` is enough, or a default transient code. Message text is never read, so a category inferred from a sentence can never be mistaken for one that was observed.

### The budget is durable, and the listener is disposable

The automatic retries already recorded for one exact turn and step are folded from committed `llm/retry` events into a Session projection, so the count survives a restart instead of living in a process-local counter. Unloading the plugin removes the projection unit and disposes the listener; a waterfall callback still holding it resolves to `undefined` rather than deciding from a torn-down context.

-----

<a id="api"></a>
## API

```ts
import {
  AGENT_RUN_RETRY_BUDGET_KEY,
  MAX_AUTOMATIC_ATTEMPTS,
  MAX_AUTOMATIC_RETRIES,
  boundedRetryProjectionDefinition,
  decideBoundedRetry,
  retryCountFor,
} from '@deepseek-ai/dsh-agent-run-policy'

import type { BoundedRetryProjectionState } from '@deepseek-ai/dsh-agent-run-policy'
import type {
  RetryDecision,
  RetryDecisionInput,
  RetryDenyReason,
  RetryPermitReason,
} from '@deepseek-ai/dsh-agent-run-policy/types'
```

| Export | Role |
|---|---|
| `apply(ctx, config)` | Install the bounded-retry listener and register the durable budget unit; throws on an out-of-range `maxRetryCount`. |
| `name` / `inject` / `Config` | Plugin identity, the `sessionProjections` injection, and the validated deployment ceiling schema. |
| `decideBoundedRetry(input)` | The pure decision: one structured failure in, one `delegate` or `deny` decision out. |
| `MAX_AUTOMATIC_RETRIES` / `MAX_AUTOMATIC_ATTEMPTS` | The `2`-retry ceiling and the `3`-attempt chain it implies. |
| `boundedRetryProjectionDefinition` / `AGENT_RUN_RETRY_BUDGET_KEY` | The projection unit that folds committed `llm/retry` events, and the key its state is read by. |
| `BoundedRetryProjectionState` | `{ turn, step, retries, turnOpen }` for the step the budget describes. |
| `retryCountFor(state, turn, step)` | The recorded retry count, or `0` when the budget names another step. |
| `RetryDecision` / `RetryDecisionInput` | The decision union and its structured input, which has no message-text and no backend field. |
| `RetryDenyReason` / `RetryPermitReason` | The six denial reasons and the single delegation reason. |

The `/types` outlet carries the contracts with no runtime import.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the redelivered request that `dsh-llm-retry` owns.

#### KV Cache effect

Denying a retry writes no event and re-sends nothing, while permitting one re-sends the same explicit provider/model request the executor reconstructs from durable history, so the reusable prompt prefix is unchanged either way.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Retryability is only as strong as the captured provider policy** — a failure the adapter never classified carries `NO_STRUCTURED_RETRYABILITY` and is denied, so a genuinely transient failure that no contract names will not be retried automatically until its contract exists.
- **The cap counts retries, not attempts** — the ceiling is two retries after the initial attempt, which is three total attempts, and the naming is deliberate so the number is never read as two.
- **Stage 10 owns compaction and context overflow** — a context-overflow failure is denied here rather than recovered, because recovering it is a later stage's decision and this policy never grows its own.
- **No backend-health dependency is introduced** — a local backend that cannot be observed cannot change whether a retry is permitted, and no reachability field exists on the input.
- **The policy gates automatic in-run retry only** — a cross-run continuation is guarded resume, which this plugin never invokes and never records.
- **No new Session event type is introduced** — the retry facts it reads are the ones upstream already writes, and the durable budget is a projection over them rather than a new record.
- **No runtime invariant companion is published because the decision is a pure function of one structured failure plus the already-folded projection state and the plugin holds no mutable policy state** — its contracts are proven by the policy and plugin specs rather than by a runtime observer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The decision is a pure function of one structured failure plus the already-folded budget, which is why it can run synchronously inside the waterfall before the executor is asked to act.

This package adds no durable vocabulary of its own — the budget is derived from existing `llm/retry` events — so it does not participate in the persistence catalog and needs no `docs/persistence-changes` record. The one place a test may read committed events directly is the plugin spec, which owns the integration proof.

</details>
