# Task checkpoints and result manifests

English | [中文](task-checkpoint.zh.md)

Task checkpoints describe verified progress in structured long-running work. They are independent from Run State—which answers what one live Run is doing—and from session checkpoint policy—which makes already-appended events durable before risky boundaries. A Task may begin in one Run and retain the same `taskId` when a later Run is selected for recovery.

## Identity and event streams

The durable hierarchy is Session → Task → Run references → checkpoint revision. `originRunId` identifies the first user-triggered work unit; `latestRunId` can advance without changing the Task. `attemptId` remains a Run State identity and appears only in failure context when a failed attempt is known.

The subsystem owns two required, whole-value event streams:

- `task/checkpoint` carries the complete Task progress revision.
- `task/result-manifest` carries the complete state of one output revision.

The corresponding `taskCheckpoint` and `taskResults` projection units fold every committed Session event. They restore from the append-only log after process restart; a projection-cache row is only a validated shortcut. Task progress and result state remain separate objects linked by `taskId`, `runId`, and output ids.

## Safe progress boundaries

A runtime owner opts a suitable long task into this capability and writes a checkpoint after a logical step succeeds, a side effect is confirmed, an output is validated, or another explicit safe boundary is reached. Ordinary chat and token/backend activity create no Task events.

Completed steps are structured and append-only. Each one cites a successful durable `tool/result`, a passed Result Manifest revision, or an explicit structured runtime validator. There is no model-facing checkpoint tool, so assistant prose cannot advance progress by itself. The current step remains pending until supported completion evidence is accepted. A failure snapshot preserves earlier completed steps, keeps the incomplete step pending, and stores the primary Run error and known Attempt/step identity.

The host-only Task projection maintains a compact index of successful tool-result event sequences and call ids. Safe-boundary writes validate tool evidence against that projected index instead of synchronously scanning arbitrary Session history. The index is rebuildable from the event log and omitted from the client wire view.

## Results and atomic publication

A Result Manifest describes output identity, Task/Run linkage, path, state, timestamps, byte size, SHA-256 checksum, execution metadata, and structured validation. `completed` requires a non-empty file, checksum, completion time, and passed validation; missing required structure is `partial`. A Task that references outputs cannot become completed until every referenced manifest is completed.

`resultPublisher(session).publish()` delegates local publication to `dsh-atomic-write`, then rereads the final path, checks its size and SHA-256 checksum, and runs structured validators. Only a non-empty, reread, checksum-bearing, passed result becomes `completed`; any failed check leaves an explicit `partial` manifest. Direct shell writes remain available and are not silently declared governed results.

## Explicit resume and diagnostics

Resume classification is read-only. `SAFE_TO_RESUME` exposes only pending steps. `NEEDS_VALIDATION` covers unsettled output state or a changed model. `BLOCKED_UNKNOWN_SIDE_EFFECT` is mandatory when Session Repair reports `TOOL_OUTCOME_UNKNOWN`; a user cannot override it and an orchestrator must inspect external state. `TOOL_NOT_STARTED` is not a blocker when the remaining facts are safe. Completed tasks return `COMPLETED`; blocked tasks, tasks with no pending work, and automatically considered user-cancelled tasks return `NOT_RESUMABLE`.

`ctx.taskCheckpoints.resume(agent, { taskId, maxContextTokens })` is a user-authorized host API. It re-reads checkpoints, manifests, hazards, the idle Agent boundary, execution metadata, and inbox ordering; it repeats those checks after a persistence flush. An admitted request reserves a new Run in a monotone Task revision before queueing the model request. If a restart finds that reservation without a matching `turn/start`, the API reuses it rather than creating another Run.

The Resume Context is JSON with objective, constraints, decisions, completed/current/pending steps, output references, root failure, and critical facts. The token meter supplies its recorded budget; historical reasoning, full Session logs, and raw tool output are deliberately omitted. The pre-step extension replaces only the derived model-visible non-system Session surface, while append-origin JSONL events remain authoritative. A terminal error or user cancellation for the admitted Run appends a failure/cancellation Task revision without changing completed work or retrying anything.

`ctx.taskCheckpoints.diagnostics(session)` returns the selected/latest Task, checkpoint revision and step sets, resume decision, output manifests, repair hazards, whether a reservation was requested or started, its Run id, model relation, and context budget. Supplying proposed execution metadata records model-change risk in the decision. The capability never restarts a backend, retries a tool, auto-resumes, changes reasoning, or changes compaction policy.

The full schema, lifecycle, fixture, and deferred-work contract is in the [package README](../../packages/session/task-checkpoint/README.md) and the [architecture decision](../../.agents/notes/implemented/architecture/2026-09-14-task-checkpoint-resume-safety.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskcheckpoints--taskcheckpointservice"></a>

### `ctx.taskCheckpoints` — `TaskCheckpointService`

Cordis service for explicit safe-boundary writes and read-only task diagnostics.

```ts cordis-catalog
/**
 * Commit one whole checkpoint at a runtime-confirmed safe boundary.
 * Completion evidence is resolved against durable Session/result facts.
 * @param session - Session that owns the durable Task.
 * @param candidate - complete next checkpoint revision.
 * @returns validated checkpoint after its event commits.
 */
saveCheckpoint(session: Session, candidate: TaskCheckpoint): TaskCheckpoint

/**
 * Commit one whole, separately versioned result manifest.
 * @param session - Session that owns the Task and result.
 * @param candidate - complete next result-manifest revision.
 * @returns validated manifest after its event commits.
 */
saveResultManifest(session: Session, candidate: ResultManifest): ResultManifest

/**
 * Read one task checkpoint by stable task identity.
 * @param session - Session whose projection is read.
 * @param taskId - stable Task identity to select.
 * @returns latest checkpoint or `undefined` when the Task is absent.
 */
get(session: Session, taskId: TaskId): TaskCheckpoint | undefined

/**
 * Read the latest durable manifest for one governed output identity.
 * @param session - Session whose durable result projection is read.
 * @param outputId - stable output identity to select.
 * @returns latest manifest or `undefined` when the output is absent.
 */
getResult(session: Session, outputId: TaskOutputId): ResultManifest | undefined

/**
 * Create a local Result Publisher bound to one Session.
 * @param session - Session that receives published result-manifest revisions.
 * @returns publisher that uses atomic write, reread, checksum, and validation ordering.
 */
resultPublisher(session: Session): TaskResultPublisher

/**
 * Explicitly validate and queue one safe resume Run in a live idle Agent.
 * @param agent - live Agent whose current provider/model and ordering are revalidated.
 * @param request - user-authorized Task identity and maximum Resume Context budget.
 * @returns started Run/reservation details or a no-side-effect refusal decision.
 */
resume(agent: Agent, request: TaskResumeRequest): Promise<TaskResumeExecutionResult>

/**
 * Return the diagnostics/read transport for the latest or selected task.
 * This method classifies only; it never schedules resume execution.
 * @param session - Session whose durable Task state is read.
 * @param options - optional Task selection, proposed execution, and trigger authority.
 * @returns detached Task, checkpoint, resume, output, and repair-hazard view.
 */
diagnostics( session: Session, options: { readonly taskId?: TaskId readonly requestedExecution?: TaskExecutionMetadata readonly trigger?: 'automatic' | 'user' } = {}, ): TaskDiagnostics
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/session/task-checkpoint/src/index.ts`](../../packages/session/task-checkpoint/src/index.ts)
<!-- END GENERATED cordis-surface -->
