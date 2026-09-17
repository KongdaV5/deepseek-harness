---
description: "Durable task checkpoints, separate result manifests, and conservative resume-safety diagnostics for structured long-running work."
kind: "package-reference"
---

# @deepseek-ai/dsh-task-checkpoint

English | [中文](README.zh.md)

## Summary

`dsh-task-checkpoint` records verified progress for structured long tasks and lets a user explicitly continue safe pending work. It keeps one Task stable across Runs, persists whole checkpoint and result-manifest revisions in the Session log, and rebuilds both through projections after restart. A resume Run receives a budgeted structured context instead of the old conversation surface. Unknown tool outcomes block, a changed model requires validation, and user cancellation never arms automatic continuation.

## Table of Contents

- [Use this package](#use-this-package)
- [Identity and durable contracts](#identity-and-durable-contracts)
- [Resume safety](#resume-safety)
- [Implementation map](#implementation-map)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service beside the Session projection registry. A runtime owner writes verified Task boundaries and may call `ctx.taskCheckpoints.resume(agent, { taskId, maxContextTokens })` only after a user explicitly asks to continue.

### When to choose it

Choose this capability for multi-step coding, batch processing, long analysis, workflows, multi-question tests, or work with governed deliverables. Do not create a Task for ordinary chat, a short answer, a single read-only tool, or a simple shell action. The plugin adds no model tool; only an admitted explicit resume replaces the model-visible Session surface.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-task-checkpoint'
```

The plugin has no configuration fields. `ctx.taskCheckpoints.diagnostics(session)` is the read-only developer transport for the latest task. `resume()` is a host API, not an automatic policy: it reads fresh projections, validates the live idle Agent and outputs, persists a new Run reservation, then queues one model request.

-----

<a id="identity-and-durable-contracts"></a>
## Identity and durable contracts

The hierarchy is `Session → Task → Run references → checkpoint revision`. `taskId` is stable when a failed task later continues in a new Run. `originRunId` never changes; `latestRunId` records the most recent selected Run. Every checkpoint keeps task type/status, original and latest provider/model/backend/reasoning metadata, evidence-backed completed steps, current and pending steps, structured resume context, output references, timestamps, and optional root failure context.

`task/checkpoint` and `task/result-manifest` are separate required Session events carrying whole post-change values. Their `taskCheckpoint` and `taskResults` projections rebuild from the authoritative log after restart; projection-cache rows remain accelerators only. Checkpoint revisions use compare-and-set ordering, completed steps and output references are append-only, and a completed Task cannot retain pending work. A tool result, passed result-manifest revision, or explicit runtime validator must support every completed step; model prose alone has no write path. `latestResume` records the admitted Run, its pending-only plan, and its context budget; existing turn events prove whether that reservation started.

The host-only part of `taskCheckpoint` also retains a compact index of successful `tool/result` event-sequence/call-id pairs. Evidence checks therefore read projected state rather than synchronously scanning arbitrary Session history. That index is omitted from the client diagnostics wire view.

A Result Manifest records one output's Task/Run link, path, lifecycle, timestamps, size, SHA-256 checksum, execution metadata, and structured validation. `completed` requires a non-zero size, checksum, completion time, and passed validation. The Task may become completed only when every referenced output is completed. `resultPublisher(session).publish()` uses the shared `dsh-atomic-write` primitive, re-reads and hashes the final path, runs validators, and writes `completed` only after every check passes.

-----

<a id="resume-safety"></a>
## Resume safety

`classifyResumeEligibility()` returns `SAFE_TO_RESUME`, `NEEDS_VALIDATION`, `BLOCKED_UNKNOWN_SIDE_EFFECT`, `COMPLETED`, or `NOT_RESUMABLE`; it starts no work. Session Repair's `TOOL_OUTCOME_UNKNOWN` is projected against the active Task and always produces the dedicated blocking result. `TOOL_NOT_STARTED` does not block when every other condition is safe. Unsettled result state or a changed model requires validation. A blocked Task is not resumable, and an explicit user cancellation is not resumable automatically; a later user-triggered check may admit its still-pending steps.

The diagnostic decision returns only the checkpoint's pending steps, so completed work is not part of a future execution plan. `resume()` repeats the classification, output verification, idle/boundary/inbox checks, and an acknowledgement that Session persistence participates immediately before enqueue. It writes a new `latestRunId` before the request; a persisted reservation that never reached `turn/start` is reused instead of minting another Run. A failed or user-cancelled resume appends a new checkpoint revision with the classified primary error while retaining completed and pending steps.

The model receives a JSON minimal Resume Context containing task objective/constraints/decisions, completed/current/pending steps, completed or explicitly partial outputs, root failure, and critical context. The token meter records `estimatedTokens`, selected sections, and deliberate omissions. Historical reasoning, the full Session log, and raw tool output are never replayed. Over-budget context, changed outputs, a changed model, unresolved live execution, or an ordering change returns `NEEDS_VALIDATION`; `TOOL_OUTCOME_UNKNOWN` remains a non-overridable block.

-----

<a id="implementation-map"></a>
## Implementation map

| File | Responsibility |
|---|---|
| [`src/types.ts`](src/types.ts) | Client-safe Task, Checkpoint, Result Manifest, repair-hazard, resume, and diagnostics contracts |
| [`src/identity.ts`](src/identity.ts) | Validated branded Task/Step/Output constructors and generated Task/Output ids |
| [`src/schema.ts`](src/schema.ts) | Strict durable-value and projection-cache schemas |
| [`src/domain.ts`](src/domain.ts) | Required `task/checkpoint` and `task/result-manifest` Session event ownership |
| [`src/projection.ts`](src/projection.ts) | Pure strict folds, revision/immutability rules, and two projection definitions |
| [`src/resume.ts`](src/resume.ts) | Pure, non-executing resume eligibility classifier |
| [`src/resume-execution.ts`](src/resume-execution.ts) | Explicit revalidation, reservation, minimal-context construction, and model queueing |
| [`src/result-publisher.ts`](src/result-publisher.ts) | Atomic local result publication, reread/checksum verification, and validation ordering |
| [`src/index.ts`](src/index.ts) | `ctx.taskCheckpoints`, evidence-gated writes, terminal resume snapshots, and diagnostics |
| [`src/testing.ts`](src/testing.ts) | `FakeTask`, `FakeTaskStep`, and deterministic result-publishing fixtures |

No runtime invariant companion is published. Strict schemas, transition guards, replay-failure retention, evidence checks, and real Loader composition tests directly cover the package's observable relationships.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session projections](../../../docs/subsystems/session-projection.md) — authoritative-log fold and cache semantics.
- [Session persistence](../../../docs/subsystems/persistence.md) — durability and crash repair boundaries.
- [Agent Run State](../../../docs/subsystems/agent-run-state.md) — Run/Attempt identity and classified failure inputs.
- [Task checkpoints and results](../../../docs/subsystems/task-checkpoint.md) — subsystem contract and generated service API.

-----

<a id="model-experience"></a>
## Model Experience

### Explicit Resume Context

#### What the model sees

An admitted `resume()` request supplies one JSON Resume Context with the Task objective, constraints, decisions, completed/current/pending steps, governed output references, primary failure, and critical facts; it replaces the derived non-system Session surface for that request series.

#### Token effect

The token meter estimates this JSON before admission and records `estimatedTokens`, the maximum, included sections, and omitted sections. Historical reasoning, full Session logs, and raw tool output contribute no resumed prompt tokens.

#### KV Cache effect

Resume starts a new request series and therefore does not claim reuse of the prior conversation's KV Cache. Checkpoint and manifest revisions otherwise stay in runtime-owned projections.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A user or future authorized orchestrator must call `resume()`; observing `SAFE_TO_RESUME` never starts model work.
- A runtime owner must explicitly create Tasks and call safe-boundary writes. The service mirrors only terminal error/cancellation facts for an admitted resume Run; it never marks model prose as a completed step.
- Result governance covers outputs published through the service boundary. Direct shell writes are not blocked or automatically discovered.
- Result governance covers `resultPublisher()` outputs; direct shell writes remain unmanaged until a runtime explicitly validates and publishes them.
- Model changes require validation but no compatibility policy is selected here.
- One unfinished Task is admitted per Session by this first service API; Task identity itself is not coupled to backend concurrency.
- The shared generic atomic writer guarantees complete same-directory rename publication but does not claim crash-durable `fsync`; backends with stronger durability retain responsibility for it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The ownership and safety decisions are recorded in [Task checkpoints, result manifests, and resume safety](../../../.agents/notes/implemented/architecture/2026-09-14-task-checkpoint-resume-safety.md).

</details>
