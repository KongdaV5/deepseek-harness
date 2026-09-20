---
description: "Durable-only Agent lifecycle facts normalized from committed Session v3 events, for consumers that must reason about turn and step boundaries, crash repair, and retry chains without reading raw upstream payloads."
kind: "package-library"
---

# @deepseek-ai/dsh-agent-lifecycle-facts

English | [中文](README.zh.md)

## Summary

Ask which turns and steps a session durably recorded, how each turn ended, and how many attempts a retry chain took, without depending on the payload shape of every upstream event. The adapter is a pure fold over committed Session events: pass a log or a replay range and read turn boundaries, terminal reasons, after-the-fact crash repair, and retry chains. It reports no run identity and no durable model-attempt identity, because upstream persists neither, and it invents no closure for a turn or step the log left open.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

An Agent's lifecycle is spread across Session events written by different packages: `turn/start` and `turn/end` carry boundaries and a terminal reason, `step/start` and `step/end` bracket the work inside a turn, and `llm/retry` with `llm/retry-started` record provider-routed recovery. This adapter normalizes them into one durable-only fact set. It is deliberately defined by two absences: no run identity, because upstream has no authoritative main-Agent `RunId` to read, and no durable model-attempt identity, because upstream persists no attempt id in any Session event.

Call `lifecycleFactsFrom(events)` with a Session log or a replay range in ascending sequence order and read the returned facts. Nothing is cached between calls, so the same range always yields an equal result.

```ts
import { lifecycleFactsFrom } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare const events: readonly SessionEvent[]

const facts = lifecycleFactsFrom(events)

facts.turns       // boundaries, terminal reason, and the steps of each turn
facts.retryChains // attempts grouped by their durable RetryId
facts.seedBoundary
```

### The fold synthesizes nothing

A turn or step with no durable closer stays `open`. Closing a crash-orphaned turn is real repair work that appends actual events to the log; an adapter that inferred the closure would report a lifecycle the durable record does not contain. So `open: true` on a step and an absent `terminal` on a turn are answers, not gaps.

For the same reason the fold is order-sensitive but content-blind: pass the events in log order, and it will not guess at an event it does not recognize.

### Crash repair versus a live decision

Upstream never emits the `interrupted` terminal reason live. Both agent-loop resume and a cold read append it after the fact to close a turn whose process died. `TurnLifecycleFact.repairClosure` is `true` exactly for that closer, which is the difference between "the user cancelled" and "we are reading a log that ended abruptly". `isRepairClosure(reason)` exposes the same test for an already-typed `TurnEndReason`.

### Retry chains

Every attempt that shares one durable `RetryId` belongs to one chain, so the chain is the durable evidence that a retry continued the same logical work. Each attempt records the policy's one-based ordinal, its modelled delay, and the provider-neutral `LlmFailure.code` that triggered it; `startedSeq` appears once the wait completed and the next attempt began, which is what distinguishes a scheduled retry that ran from one that was interrupted mid-wait.

`maxRetries` is present only on the bounded `normal` mode record — an `always` policy caps nothing, so reporting a cap would be an invention.

### Durable attempt identity is null, on purpose

`LlmAttemptId` is minted from an in-memory counter inside the agent loop and is not restored on resume, so the same value can recur across lifecycles within one Session and it never reaches a committed event. Publishing it as an optional field would invite a consumer to treat "absent" as "missing data"; `durableAttemptIdentity` is therefore the literal `null`. A consumer that needs durable attempt correlation must derive it from retry-chain membership plus the turn and step position instead.

-----

<a id="api"></a>
## API

```ts
import {
  applyLifecycleFacts,
  emptyLifecycleFacts,
  isRepairClosure,
  lifecycleFactsFrom,
} from '@deepseek-ai/dsh-agent-lifecycle-facts'

import type { LifecycleFacts, TurnLifecycleFact } from '@deepseek-ai/dsh-agent-lifecycle-facts/types'
```

| Export | Role |
|---|---|
| `lifecycleFactsFrom(events)` | Fold one event range, in ascending sequence order, into every normalized lifecycle fact. |
| `applyLifecycleFacts(state, event)` | Advance one fact set by one committed event, for a consumer that accumulates state the way a Session projection does; returns the same fact set when the event contributes nothing. |
| `emptyLifecycleFacts()` | The fact set of an empty range — the starting point of the stepwise fold. |
| `isRepairClosure(reason)` | Whether a terminal reason is an after-the-fact crash repair (`kind: 'interrupted'`). |
| `LifecycleFacts` | `seedBoundary`, `turns`, `retryChains`, and the always-`null` `durableAttemptIdentity`. |
| `TurnLifecycleFact` | `turn`, `startSeq`, optional `endSeq` and `terminal`, `repairClosure`, `steps`. |
| `StepLifecycleFact` | `step`, `startSeq`, optional `endSeq`, and `open`. |
| `RetryChainFact` / `RetryAttemptFact` | The durable `RetryId` chain and each scheduled attempt within it. |
| `SeedBoundaryFact` | The last `session/end-seed` marker and whether it is a fork cut. |
| `DurableTerminalReason` | Alias of the upstream merge-extensible `TurnEndReason['kind']`; treat it as an open union. |
| `DurableRetryMode` | `'normal'` or `'always'`, as the durable retry events record them. |

The `/types` outlet carries the contracts with no runtime import.

`lifecycleFactsFrom` is exactly `applyLifecycleFacts` repeated over the range, so the whole-range and stepwise shapes can never disagree. A projection that needs these facts one event at a time therefore consumes this adapter instead of normalizing raw payloads beside it.

<a id="model-experience"></a>
## Model Experience

None, as the adapter reads already-committed events and registers no prompt, schema, tool, or result text.

#### KV Cache effect

None; it never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No run identity, by design** — upstream has no authoritative main-Agent `RunId`, and this package refuses to infer one from a turn number, a step number, a retry counter, an `LlmAttemptId`, or a guessed lifecycle span.
- **No durable attempt identity** — `durableAttemptIdentity` is always `null` because no Session event persists an attempt id; correlate through retry-chain membership and turn/step position instead.
- **Steps are matched by number, not by identity** — a repeated `step/end` closes the newest still-open start with that number, which mirrors how the durable events identify steps; a step with no matching start is ignored rather than synthesized.
- **Facts are recomputed per call** — no caching, so a caller wanting incremental reads over a growing log re-folds the range it passes.
- **No runtime invariant companion is published because a pure function over event data holds no mutable runtime state** — its contracts are proven by the package spec.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fold accumulates through private mutable views and returns the public contracts detached from them, so a caller can neither observe nor disturb the working state of an earlier call.

This package is diagnostics-only and persists nothing, so it does not participate in the persistence catalog and needs no `docs/persistence-changes` record.

</details>
