# Agent Note: Project run state from existing events behind a backend-neutral observer seam

Status: implemented

English | [中文](2026-09-13-agent-run-state-projection.zh.md)

## Problem

The agent's public `idle | running` status answers whether its driver is active but cannot distinguish context preparation, backend prefill, reasoning, generation, tool waits, or a generation-worker failure hidden behind a healthy process endpoint. The Session log already records turn, step, request, assistant attempt, tool, retry, and compaction boundaries, while assistant stream frames carry high-frequency process-local activity. Local backends can additionally expose process, model, generation, heartbeat, and prefill observations, but those facts have no shared contract or correlation identity.

Putting every phase into `AgentStatus` would mix lifecycle and per-request progress. Making the loop maintain a large mutable diagnostics object would duplicate the repository's event-sourced projection style. Persisting progress counters or heartbeats would grow Session JSONL with data that has no replay or model-context value. A backend-specific MLX log parser embedded in Run State would also make an experimental text format an architectural dependency.

The correlation hierarchy must distinguish a long-lived conversation, one user-triggered work unit, and each actual model request. A retry is another attempt inside the same work unit; treating it as a new Run would break causal diagnostics and future recovery policy. When backend activity cannot be reliably attributed, a single-concurrency deployment is insufficient evidence for assigning it.

## Decision

### Identity is Session, Run, then Attempt

The diagnostics domain owns opaque `RunId` and `AttemptId` brands. A Run id is deterministically derived from Session id and positive turn number. An Attempt id is derived from Run id, step number, and a positive ordinal. `step/start` establishes ordinal one; `llm/retry-started` establishes the next ordinal without changing Run id. The loop's process-local `LlmAttemptId` is mapped to this hierarchy while the process is alive but is not promoted to a durable cross-process identity. Provider request ids remain optional leaf diagnostics.

Backend attribution is a closed union: exact Attempt, exact Run, or `unknown`. An unresolvable identity stays in an unattributed diagnostics collection. Current prompt/decode concurrency may improve attribution evidence for a particular observer, but it is not a Run State invariant.

### Durable state is a Session projection

The `@deepseek-ai/dsh-agent-run-state` service registers one client-visible `agentRunState` projection through the existing Session projection registry. Its pure fold consumes existing `turn/start`, `turn/end`, `step/start`, `request/header`, `request/context`, `assistant/attempt`, `assistant/message`, `tool/call`, `tool/result`, `llm/retry`, `llm/retry-started`, `compaction/start`, and `compaction/end` events. It introduces no Session event and requires no agent-loop, LLM, session-controller, client-runtime, or Desktop patch.

The projection stores the latest Run's lifecycle, deterministic identity, attempt/retry position, request route, requested versus resolved reasoning observation, context metadata and reported usage, tool/compaction boundaries, and durable terminal/classified errors. Starting a later turn replaces the latest Run view; the append-only Session log remains the historical authority.

Assistant stream deltas, backend heartbeat/activity time, component health, prefill counters/speed, and live backend errors are transient overlays owned by the service. They never append to Session JSONL. The read-only `diagnostics(session)` method returns a detached merged cut; the generic wire projection intentionally exposes only the durable cut. An optional host command serializes the merged cut for development diagnostics without changing the projection. Activity subscriptions notify on observed changes, while elapsed-only health changes are recomputed when diagnostics is read instead of installing a timer.

### Backend observation is replaceable

`LocalBackendObserver` publishes a finite backend-neutral `BackendObservation`: process/model/generation health, observation and latest-activity times, optional activity kind and prefill facts, optional structured failure evidence, and explicit attribution. The Run State package imports no MLX or llama.cpp implementation. `FakeBackendObserver`, `FakeStream`, and `FakeWorker` provide controlled fixtures through a testing subpath.

The separate `@deepseek-ai/dsh-agent-run-state-mlx` provider encapsulates MLX log parsing, file following, HTTP process health, and request-lifecycle correlation. It marks log-derived prefill as `source: "backend-log"` and `confidence: "provisional"`. Exact Attempt attribution also remains provisional and requires an operator-declared exclusive single-flight endpoint plus exactly one eligible active DSH attempt at an MLX request marker; ambiguity stays unknown. A callback, structured event, metrics endpoint, request id, or another backend can replace that provider without changing the Run State contract.

### Unknown, health, and error rules are explicit

Unknown is a formal state for missing progress, attribution, component health, and effective reasoning. The state never estimates prefill percentage, reasoning percentage, ETA, worker liveness, or cancellation success from insufficient evidence.

Overall health is `unknown | healthy | slow | stalled | degraded | fatal`. Deployment configuration supplies the slow and stalled durations. Recent meaningful activity prevents a time-only stalled result even after long time-to-first-token. Fatal component evidence dominates a healthy process. Fatal error classification requires structured process exit, uncaught worker exception, generation-worker termination, model-load failure, a structured fatal code, or a recognized backend-origin resource-limit/OOM signature. HTTP health success, UI or stream disconnect, BrokenPipe, cancellation, and elapsed silence are not fatal alone.

The earliest classified failure is `primaryError`; later failures append to `secondaryErrors` and never replace it. This preserves client cancellation as primary when a backend later reports BrokenPipe, and preserves a resource limit as primary when disconnection follows. Classification produces diagnostics only: it does not restart, retry, resume, checkpoint, cancel, or alter reasoning, retry, compaction, Profile, or Benchmark policy.

## Alternatives considered

- **Expand `AgentStatus` with every phase.** Rejected because driver lifecycle and request/backend progress have different identity, frequency, and durability.
- **Keep Run State as mutable loop-owned state.** Rejected because it duplicates durable event truth and requires invasive loop changes.
- **Add durable events for every stream delta or prefill increment.** Rejected because high-frequency observability would pollute Session storage and downstream context processing.
- **Build Run State around an MLX log parser.** Rejected because an experimental log format must remain inside a replaceable provider.
- **Attribute unknown backend activity to the only active generation.** Rejected because current concurrency is a backend capability, not architectural proof of identity.
- **Couple the projection to session-controller and Desktop transport.** Rejected because host diagnostics can consume the detached service view while transport and presentation remain independent consumers.

## Consequences

- The implementation is plugin-first and adds no core hook; official upstream changes in loop, LLM, session-controller, client runtime, and Desktop remain easy to follow.
- Existing durable events are sufficient for lifecycle identity and replay, while the observer seam supplies backend-only facts without backend coupling.
- Session JSONL growth is independent of token streaming, prefill progress frequency, and heartbeat frequency.
- UI and diagnostics consumers can distinguish unknown from slow, stalled, degraded, and fatal, and can inspect process and generation health separately.
- Retry remains inside one Run and creates a new Attempt, establishing the correlation contract required by later recovery work.
- A replaceable MLX provider supplies real-log observation and a host command supplies a merged diagnostics view without changing core runtime modules.
- Live Desktop transport/presentation, automatic recovery, dynamic reasoning, checkpoint policy, retry policy, compaction policy, Profile changes, and Benchmark changes remain deferred.
