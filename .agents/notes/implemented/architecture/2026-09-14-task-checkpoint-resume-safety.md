# Agent Note: Task checkpoints, result manifests, and resume safety

Status: implemented

English | [中文](2026-09-14-task-checkpoint-resume-safety.zh.md)

## Problem

Run State can describe a live or failed Run, but it cannot say which parts of a long task were safely completed or whether replaying an interrupted side effect is safe. Replaying the full conversation with “continue” loses task identity, repeats expensive work, and can duplicate a tool or external mutation whose outcome was never recorded. Session checkpoint policy protects event durability but intentionally does not model task progress or deliverable validity.

## Decision

`@deepseek-ai/dsh-task-checkpoint` is an external Session capability that owns stable Task identity, whole-snapshot Task Checkpoint events, separate whole-snapshot Result Manifest events, their projections, resume classification, and explicit resume execution. It uses existing Session events, Session Repair, Session Projection, `agent/pre-step`, and `llm/stream` extension points; no Agent loop, Session core, Projection core, Goal, filesystem core, client runtime, or Desktop hook is added.

A Task is not a Run. `taskId` remains stable across an origin Run and any later selected Run. `originRunId` is immutable, `latestRunId` may advance, and each checkpoint has a strictly increasing revision. The service admits a single unfinished Task per Session in this first contract. This is a task-service constraint, not a backend-concurrency or identity assumption.

### Durable ownership

`task/checkpoint` carries one complete `TaskCheckpoint`; `task/result-manifest` carries one complete `ResultManifest`. Both events are required rather than ignorable because silently skipping them would erase recovery truth. Ordinary Session event-vocabulary growth does not change the Session format version, while a runtime that does not recognize required task events must refuse that log rather than pretend recovery state is absent.

The `taskCheckpoint` and `taskResults` projections are separate. Their states are plain JSON and strict folds retain the first replay failure. The append-only Session log remains authoritative after crash/restart; a projection cache remains only a shortcut. Checkpoint revisions preserve immutable task/origin metadata, completed steps and output references are append-only, and completed Task/Result states are terminal.

### Evidence and result rules

Models do not receive a checkpoint mutation tool. A completed step must cite a matching successful durable `tool/result`, a passed Result Manifest revision, or an explicit structured runtime validator. The current step remains within pending steps until that evidence is accepted. Fatal failure records the root classified error and known Attempt/current-step identity while preserving earlier completions and leaving incomplete work pending.

The host-only Task projection retains a compact event-sequence/call-id index for successful tool results. The service validates tool evidence from that rebuildable state instead of adding a synchronous arbitrary-history read; the index is not part of the client diagnostics view.

Task Checkpoint and Result Manifest remain different objects. A manifest owns output path, lifecycle, size, SHA-256 checksum, execution metadata, and validation. A completed manifest requires size greater than zero, checksum, completion timestamp, and passed validation. A task with referenced outputs cannot complete until every reference is completed. The production publisher uses the existing atomic-write primitive, rereads and hashes the final path, runs validators, and writes `completed` only after all checks pass. Direct-shell governed-path discovery remains outside this capability.

### Explicit resume execution

The classifier returns `SAFE_TO_RESUME`, `NEEDS_VALIDATION`, `BLOCKED_UNKNOWN_SIDE_EFFECT`, `COMPLETED`, or `NOT_RESUMABLE` and includes only pending steps in the prospective plan. Classification itself does not execute work. A user-authorized host call to `ctx.taskCheckpoints.resume(agent, { taskId, maxContextTokens })` re-reads the current checkpoint, manifests, repair hazards, live Agent provider/model, idle turn boundary, and inbox; it repeats those checks after a Session flush.

Session Repair's `TOOL_OUTCOME_UNKNOWN` always yields `BLOCKED_UNKNOWN_SIDE_EFFECT`; no tool retry is admitted until external state is validated and no force override exists. `TOOL_NOT_STARTED` is safe to plan again when other checks pass. Unsettled results and model changes require validation. A blocked task is not resumable. A user-cancelled task keeps its checkpoint but automatic checks refuse resume; only an explicit later user trigger may make its pending steps eligible.

An admitted call reserves a distinct new Run in a checkpoint revision before queueing a model request. `latestResume` retains the pending-only plan plus its estimated token budget and selected/omitted context sections. A reservation that survived persistence but never reached `turn/start` is reused after restart instead of minting another Run. A terminal error or user cancellation appends a failure/cancellation checkpoint revision with the classified primary error while preserving prior completed steps and pending work.

The model receives a bounded JSON Resume Context: task objective, constraints, decisions, completed/current/pending steps, completed/partial outputs, root failure, and critical facts. Historical reasoning, complete Session logs, and raw tool output remain excluded. The pre-step extension replaces the derived model-visible non-system surface for the new request series; raw append-origin JSONL events remain authoritative. Original/latest provider, model, backend, requested reasoning, and resolved reasoning remain factual metadata. The service records a same-model or model-changed relation but introduces no reasoning, retry, restart, compaction, Profile, or Benchmark policy.

## Alternatives considered

- **Treat one Run as one Task.** Rejected because a recoverable long task must preserve identity when a later user-triggered Run continues it.
- **Use Session checkpoint policy as task progress.** Rejected because log durability and semantic task completion have different owners and evidence.
- **Store checkpoint prose in the model prompt.** Rejected because it makes the model the authority, expands context, and cannot safely classify unknown side effects.
- **Combine progress and deliverables into one large record.** Rejected because step recovery and output validity change independently and require different lifecycle invariants.
- **Blindly replay the current tool when the result is missing.** Rejected because a started side-effecting operation may already have committed externally.
- **Patch Agent loop or Desktop immediately.** Rejected because the Session event/projection and existing pre-step/stream seams provide durable ownership and model-context replacement without a core fork.

## Consequences

- Long tasks can preserve evidence-backed completed and pending work across Session replay without changing Run/Attempt identity.
- Unknown external side effects fail closed, while a tool proved not started can remain resumable.
- Result completion cannot be inferred from file existence alone; zero-byte and structurally incomplete outputs remain partial.
- Checkpoint frequency is tied to explicit safe boundaries rather than tokens, stream deltas, or backend heartbeats.
- Diagnostics expose task, checkpoint, resume decision, outputs, repair hazards, request/start attribution, model relation, and context budget without formal UI.
- An explicit resume creates one new Run, persists its reservation before the model request, and records a terminal error or cancellation without repeating completed work.
- `SAFE_TO_RESUME` alone has no side effect. The capability performs no automatic resume, backend restart, worker restart, tool retry, reasoning change, compaction change, Profile change, Benchmark change, or formal UI work.
- Direct shell-path governance and an explicit cross-model approval policy remain outside the capability.
