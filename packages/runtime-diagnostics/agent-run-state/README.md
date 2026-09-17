---
description: "Projected agent run identity, phase, health, and error diagnostics with a replaceable local-backend observer seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-state

English | [中文](README.zh.md)

## Summary

`dsh-agent-run-state` tells a DeepSeek Harness composition what one user-triggered run is doing without expanding the coarse `AgentStatus` vocabulary or making the agent loop own a second mutable state machine. It folds existing low-frequency Session events into the client-visible `agentRunState` projection, overlays process-local assistant stream and backend observations through `ctx.agentRunState`, and classifies health and errors without taking recovery action. Backend implementations register the finite `LocalBackendObserver` contract; the package does not depend on MLX, llama.cpp, or a log format.

## Table of Contents

- [Use this package](#use-this-package)
- [Identity and state contract](#identity-and-state-contract)
- [Durable and transient boundary](#durable-and-transient-boundary)
- [Health and error invariants](#health-and-error-invariants)
- [Implementation map](#implementation-map)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service beside `dsh-session-projection` and supply deployment-owned elapsed-time thresholds. The service registers the latest durable run as `sessionProjections.snapshot(session).values.agentRunState`; `ctx.agentRunState.diagnostics(session)` returns a detached read-only cut with transient stream/backend/control activity merged in. `subscribe()` reports activity-driven changes, while `probe()` asks replaceable backend observers to refresh immediately available evidence without fabricating activity. Polling `diagnostics()` recomputes elapsed-only health transitions; the package does not create a stalled timer.

```yaml
- name: '@deepseek-ai/dsh-agent-run-state'
  config:
    slowAfterMs: 300000
    stalledAfterMs: 600000
```

| Field | Required | Meaning |
|---|---:|---|
| `slowAfterMs` | yes | Total active run age after which continuing work is `slow` |
| `stalledAfterMs` | yes | Time since the latest meaningful activity after which active work is `stalled`; must exceed `slowAfterMs` |

A backend plugin registers one observer with `ctx.agentRunState.registerObserver(observer)`. Each observation names a `run`, an `attempt`, or explicit `unknown` attribution. An unresolvable run/attempt remains in `unattributedBackendObservations`; the service never assigns it merely because one generation is active. Observers can implement `probe()` for decision-time refresh. A separate `LocalRunControlObserver` may publish transient retry-budget/reason and cancellation-acknowledgement facts. `LocalRunDiagnosticsObserver` may publish correlated read-only reasoning and Context Pressure facts. Neither observer can mutate the durable projection, lifecycle, health, retry, or cancellation facts.

Tests and fixture packages can import `FakeBackendObserver`, `FakeStream`, and `FakeWorker` from `@deepseek-ai/dsh-agent-run-state/testing`. These fixtures produce only the public backend/stream contracts and do not emulate MLX.

The optional `@deepseek-ai/dsh-agent-run-state/command` function plugin registers `/agent_run_state`. It returns a read-only JSON view of merged diagnostics for the invoking Session, including identities, route, phase, overall and component health, meaningful activity and stale threshold, prefill, retry current/max/reason, cancellation acknowledgement, and primary/secondary errors. The command creates only the command registry's ordinary low-frequency `command/run` and `command/done` records; backend progress stays transient. Deployments using MLX can mount the separate [`dsh-agent-run-state-mlx`](../agent-run-state-mlx/README.md) provider and optional [`dsh-agent-run-policy`](../../guard/agent-run-policy/README.md).

-----

<a id="identity-and-state-contract"></a>
## Identity and state contract

The hierarchy is `session_id → run_id → attempt_id`. A Session is the long-lived conversation, a Run is one complete user-triggered turn, and an Attempt is one actual model request inside one step. `runIdFor(sessionId, turn)` is deterministic; `attemptIdFor(runId, step, ordinal)` changes on retry. `llm/retry-started` increments the attempt ordinal while preserving the Run id. The process-local `LlmAttemptId` from `agent/assistant-stream` is mapped onto this stable hierarchy and is never treated as the durable cross-process identity.

`RunPhase` is independent of `AgentStatus` and includes `unknown`, preparation, prefill, reasoning, generation, tool wait, retry wait, compaction, and terminal phases. `AgentRunState` keeps requested/resolved/backend-default reasoning fields distinct and exposes context facts only when observed. Missing progress, health, reasoning, activity, and attribution are unknown rather than estimated.

-----

<a id="durable-and-transient-boundary"></a>
## Durable and transient boundary

The durable projection consumes existing `turn/start`, `turn/end`, `step/start`, `request/header`, `request/context`, `assistant/attempt`, `assistant/message`, `tool/call`, `tool/result`, `llm/retry`, `llm/retry-started`, `compaction/start`, and `compaction/end` events. No new Session event is introduced. Run start/end, attempt boundaries derived from step/retry events, retry facts, classified durable failures, route/reasoning observations, context-window metadata, token usage, and tool/compaction phase boundaries survive replay and projection-cache restoration.

Assistant chunk activity, backend component health, prefill counters/speed, backend heartbeat time, generation presence, retry-policy display facts, cancellation acknowledgement, reasoning selection, Context Pressure, and live error signals remain process-local. They are stored outside the Session JSONL and merged only by the read service. Repeated progress observations therefore do not grow the log or model context. The wire projection intentionally contains only the durable cut; the optional host command serializes the merged service snapshot without changing the state or observer contracts.

-----

<a id="health-and-error-invariants"></a>
## Health and error invariants

`unknown`, `healthy`, `slow`, `stalled`, `degraded`, and `fatal` are distinct outcomes. Stall is determined by `now - lastMeaningfulActivityAt`, never by total request age. Assistant reasoning/text, tool lifecycle events, and attributed advancing backend progress refresh meaningful activity; UI reads and health polling do not. Fresh progress therefore prevents a time-only stalled classification even when first-token latency is long, and later progress can recover a non-fatal stalled view to active/slow. A healthy process does not imply a healthy generation worker; component fatal evidence dominates process health. Fatal classification requires a structured process/worker/model-load termination, a structured fatal code, or a recognized resource-limit/OOM signature from the backend origin. HTTP health success, disconnection, BrokenPipe, cancellation, or elapsed silence alone is not fatal.

Errors use first-observed ordering: `primaryError` is never replaced and later signals append to `secondaryErrors`. A client cancellation followed by BrokenPipe therefore remains `CLIENT_CANCELLED` primary with `STREAM_DISCONNECTED` secondary. These classifications are diagnostic facts only; this package never restarts a worker, retries a request, resumes a run, cancels work, or changes retry, reasoning, checkpoint, or compaction policy.

-----

<a id="implementation-map"></a>
## Implementation map

| File | Role |
|---|---|
| [`src/brand.ts`](src/brand.ts) | Opaque Run, Attempt, and observer identities plus deterministic derivation |
| [`src/types.ts`](src/types.ts) | Run State, backend/control/diagnostics observers, health, error, cancellation, reasoning, context, and diagnostics contracts |
| [`src/projection.ts`](src/projection.ts) | Pure durable fold and `agentRunState` projection registration |
| [`src/health.ts`](src/health.ts) | Pure threshold-parameterized health classifier |
| [`src/errors.ts`](src/errors.ts) | Source-aware fatal/error classifier and primary/secondary accumulation |
| [`src/index.ts`](src/index.ts) | `ctx.agentRunState` service, transient overlays, observer registries, probe, activity event, and read API |
| [`src/testing.ts`](src/testing.ts) | Controllable fake observer, stream, and worker fixtures |
| [`src/view.ts`](src/view.ts) | Stable JSON-compatible developer view with explicit unknown/null values |
| [`src/command.ts`](src/command.ts) | Optional read-only `/agent_run_state` diagnostics command |

No runtime invariant companion is published. The package's observable relationships are exactly the projection and classifier behavior covered by exhaustive unit and real-Loader composition tests; a second runtime listener would duplicate the implementation rather than independently detect corruption.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service observes runtime activity and exposes diagnostics without changing model requests.

#### KV Cache effect

No effect. The package does not mutate assembled requests or Session surface events.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The client-visible projection is durable-only. Live merged diagnostics are host-readable through `ctx.agentRunState` and the optional command; Desktop transport and presentation are deferred.
- The MLX provider's text-derived progress and request attribution are provisional; shared or ambiguous endpoints remain unattributed.
- Health changes caused only by elapsed time appear when `diagnostics()` is read; there is no background stalled timer.
- `stalledAfterMs` and an adapter's stream idle timeout are separate deployment settings; Run State reports the former and does not rewrite the latter.
- Attempt identity can be reconstructed from durable step/retry ordering, but an in-flight process-local stream that never settles after a crash has no durable `LlmAttemptId` mapping.
- Only the latest Run is projected. The Session log remains the source for historical runs.
- The package classifies and records observations but performs no recovery or policy changes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The architecture decisions are recorded in [Agent Run State projection and backend observer seam](../../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.md) and [Progress-aware Run control](../../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.md).

</details>
