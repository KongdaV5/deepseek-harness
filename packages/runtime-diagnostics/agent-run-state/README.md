---
description: "Durable Run identity, run-state projection, and structured run diagnostics derived from committed Session turns, with backend observation as a separate diagnostic dimension that can never become run authority."
kind: "package-library"
---

# @deepseek-ai/dsh-agent-run-state

English | [中文](README.zh.md)

## Summary

Ask what the main Agent is doing right now, how its last run ended, and why it failed, using the durable Session log as the only authority. The package derives a deterministic Run identity from one turn, folds Stage 6 lifecycle facts into an active-or-terminal run state, and classifies failures from structured evidence with a fixed precedence. Backend health is a separate dimension that is reported beside the run and never defines it. It adds no Session event and persists nothing.

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

A run is one durable upstream turn, because `turn/start` and `turn/end` are the only boundaries upstream commits about Agent work. Everything here follows from that single choice: the identity is a pure function of the turn, a retry continues the run it belongs to rather than starting a new one, and a closed turn has no representation as a live run at all.

```ts
import { lifecycleFactsFrom } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import {
  activeRun,
  backendObserverId,
  projectRuns,
  runDiagnostics,
  unknownBackendObservation,
} from '@deepseek-ai/dsh-agent-run-state'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'

declare const events: readonly SessionEvent[]
declare const sessionId: SessionId

const state = projectRuns(sessionId, lifecycleFactsFrom(events))

activeRun(state)   // the open turn, or null when no durable turn is open
state.terminal     // the most recent closed run, retained as history

runDiagnostics({
  projection: state,
  observation: unknownBackendObservation(backendObserverId('local-gguf'), 0),
  now: 0,
  slowAfterMs: 30_000,
  stalledAfterMs: 120_000,
})
```

### Run identity is derived, never minted

`runIdFor(sessionId, turn)` encodes both coordinates with length prefixes, so the result is injective and stable across processes, restarts, and replays. There is no `RunId(value)` constructor, because accepting a caller-supplied string would be indistinguishable from accepting a random one. Nothing here reads an `LlmAttemptId`, a retry counter, or a process-local value, and no Session event was added to carry an identity that upstream already records as a turn boundary.

### There is no idle run

`activeRun` returns `null` when the log leaves no turn open, and that is the whole answer: a session between turns has no active run rather than a synthesized idle one. A consumed run is not discarded either — the last closed turn stays readable through `terminalRun`, which is history and implies no current work.

The projection is recomputed from the fact set on every call, so terminal monotonicity is structural: once `turn/end` is in the log, no later fold can report that turn as active.

### Retries continue a run; they never open one

A retry keeps the same `RunId`, the same turn, and the same step. It surfaces as `phase: 'waiting_retry'` while the wait is pending and as `retryCount`, `maxRetryCount`, and `retryReason` on the run — a bounded `normal` policy reports its cap, and an `always` policy reports none rather than an invented one.

### Terminal reasons survive the projection

`completed`, `aborted`, `blocked`, `error`, `max-tokens`, and `interrupted` each keep their durable reason on the run. `interrupted` is reported as `repairClosure: true`: upstream writes it only after the fact to close a turn whose process died, so it is a reading of the log, not a live failure. The loop never emits it while running.

### Backend health is observed, never authoritative

A backend observation answers a different question — is the local inference backend reachable, and is it busy — and it can never create, advance, or terminate a run. `BackendObservation` carries its own `source`, `directness`, `reachability`, and `activity`, and the merge in `runDiagnostics` appends observer diagnostics after the run's own error instead of competing with it.

`unknown` is a real answer at every level: an observer that cannot reach a backend reports `unreachable`, one that has no way to tell reports `unknown`, and neither is rounded to a guess. An observation whose `observerId` does not match the observer that produced it is a loud error rather than a quiet field.

This package ships **no backend adapter**. A truthful adapter needs a seam in the current source that reports backend activity on a diagnostics cadence, and the current source has none: the only local-model path is a user-triggered model-list discovery, which is not a health signal.

### Errors are classified from structure, not prose

Classification reads a structured provider code or a strong backend failure kind. Message text is carried for humans and used for nothing else, because a category inferred from a sentence is indistinguishable from one that was observed. A signal with no structured code is `UNKNOWN`.

Fatal is reserved for evidence that execution cannot safely continue — a resource limit, a worker crash, or a model load failure. A timeout, a transport error, a stalled generation, or a cancellation is `degraded`, and a cancellation stays `degraded` even when the signal carrying it would otherwise prove something stronger, because a user ending a run is an outcome rather than a fault.

Precedence is total and independent of arrival order: strongest evidence first (durable terminal, then structured execution, then client, then observer), then earliest time. A late observer update therefore cannot oscillate a run's outcome.

-----

<a id="api"></a>
## API

```ts
import {
  activeRun,
  backendObservation,
  backendObserverId,
  classifyRunError,
  classifyRunHealth,
  clientCancelledError,
  observeBackend,
  projectRuns,
  providerErrorCode,
  reachabilityObservation,
  runDiagnostics,
  runIdFor,
  terminalRun,
  unknownBackendObservation,
} from '@deepseek-ai/dsh-agent-run-state'

import type { RunState, RunProjectionState, BackendObservation } from '@deepseek-ai/dsh-agent-run-state/types'
```

| Export | Role |
|---|---|
| `runIdFor(sessionId, turn)` | Encode a durable turn as its deterministic `RunId`; throws on a non-integer or zero-based turn. |
| `projectRuns(sessionId, facts)` | Fold Stage 6 lifecycle facts into `{ active, terminal }`. |
| `activeRun(state)` / `terminalRun(state)` | Read the open run, or the last closed run, without inventing either. |
| `runDiagnostics(input)` | Merge the run's own diagnostics with a backend observation, keeping the dimensions apart. |
| `backendObserverId(id)` | Brand a backend observer's identity; the only other identity constructor, and it validates its input. |
| `backendObservation(input)` | Build a validated observation; rejects an unavailable source that still carries values. |
| `unknownBackendObservation(id, at)` / `reachabilityObservation(id, at, reachability)` | The truthful fallbacks: nothing observed, or reachability alone with activity left `unknown`. |
| `observeBackend(observer, at)` | Run one pull-based `observe()`, mapping a throw to `unavailable` evidence rather than to a run state. |
| `classifyRunError(evidence)` | Classify one failure signal into the durable v1 error contract. |
| `providerErrorCode(code)` | Map a durable retry code onto a run error category, or `UNKNOWN`. |
| `clientCancelledError(time)` | The canonical cancellation error. |
| `classifyRunHealth(input)` | Turn a run's phase, activity age, and primary error into one health verdict. |
| `RunState` / `RunProjectionState` | The run's identity, phase, steps, retry summary, terminal reason, and errors. |
| `BackendObservation` | `observerId`, `observedAt`, `source`, `directness`, `reachability`, `activity`. |

The `/types` outlet carries the contracts with no runtime import.

<a id="model-experience"></a>
## Model Experience

None, as the package reads already-committed Session facts and registers no prompt, schema, tool, or result text.

#### KV Cache effect

None; it never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Backend observation has no adapter in this build** — the contract is implementable and validated, but no seam in the current source reports backend activity on a diagnostics cadence, so a GGUF backend legitimately stays `unknown` rather than being polled into a fabricated state.
- **Run identity stops at the turn** — a run is one turn, so a session with several turns has several runs and no durable notion of one "session run".
- **No durable attempt identity is introduced** — `LlmAttemptId` remains transient and non-durable, and nothing here derives from it.
- **Wall-clock thresholds decide `slow` and `stalled`** — the classifier takes the caller's clock, so two callers with different clocks can disagree about a live run's health; a terminal run is classified from its facts alone.
- **No new Session event type is introduced** — everything here is derived, and a consumer that needs a new durable field has to add it to the durable log first.
- **No runtime invariant companion is published because a pure fold over durable facts holds no mutable runtime state** — its contracts are proven by the package spec.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The projection is a pure fold with no carry-forward state, which is what makes it safe to recompute per call and cheap to reason about: equal facts give an equal result.

This package is diagnostics-only and persists nothing, so it does not participate in the persistence catalog and needs no `docs/persistence-changes` record.

</details>
