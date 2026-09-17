# Task Checkpoint 与 Result Manifest

[English](task-checkpoint.md) | 中文

Task Checkpoint 描述结构化长任务中已经验证的进度。它既不同于回答某个 live Run 正在做什么的 Run State，也不同于在风险边界前确保已追加事件持久化的 session checkpoint policy。一个 Task 可以开始于一个 Run，并在以后选择另一个 Run 恢复时保持相同 `taskId`。

## 身份与事件流

持久层级为 Session → Task → Run references → checkpoint revision。`originRunId` 指向最初的用户触发工作单元；`latestRunId` 可以前进而不改变 Task。`attemptId` 仍属于 Run State，只在已知失败 attempt 时出现在 failure context 中。

该子系统拥有两个必需的完整值事件流：

- `task/checkpoint` 携带完整 Task progress revision。
- `task/result-manifest` 携带一个输出 revision 的完整状态。

对应的 `taskCheckpoint` 与 `taskResults` projection unit 折叠每个已提交 Session event。进程重启后，它们从 append-only 日志恢复；projection-cache row 只是经过验证的捷径。Task progress 与 result state 保持为独立对象，通过 `taskId`、`runId` 和 output id 关联。

## 安全进度边界

Runtime owner 主动把合适的长任务纳入此 capability，并在逻辑步骤成功、副作用已确认、输出已验证或其他明确安全边界后写入 Checkpoint。普通聊天以及 token/backend activity 不会创建 Task event。

Completed step 是结构化且只追加的。每一步都引用成功的持久 `tool/result`、通过验证的 Result Manifest revision，或明确的结构化 runtime validator。系统没有面向模型的 checkpoint tool，因此 assistant 文本本身不能推进进度。Current step 会保持 pending，直到有依据的完成证据被接受。Failure snapshot 保留早先 completed steps，让未完成步骤保持 pending，并保存 primary Run error 及已知 Attempt/step identity。

Task projection 的 host-only 部分维护成功工具结果 event sequence 与 call id 的紧凑索引。安全边界写入根据该 projection index 校验工具证据，不会同步扫描任意 Session history。该索引可从 event log 重建，且不会进入 client wire view。

## Result 与原子发布

Result Manifest 描述 output identity、Task/Run 关联、路径、状态、时间戳、字节大小、SHA-256 checksum、execution metadata 与结构化 validation。只有非空文件、checksum、completion time 和 passed validation 都存在时，才允许 `completed`；缺少所需结构时为 `partial`。Task 一旦引用 output，只有所有引用 manifest 都 completed 时才能 completed。

`resultPublisher(session).publish()` 把本地发布委托给 `dsh-atomic-write`，随后重新读取 final path、检查 size 与 SHA-256 checksum，并运行结构化 validator。只有非空、已重新读取、带 checksum 且 validation passed 的 result 才会成为 `completed`；任何失败检查都会保留明确的 `partial` manifest。直接 shell 写入仍可使用，且不会被静默声明为受治理结果。

## 明确 Resume 与诊断

Resume classification 只读。`SAFE_TO_RESUME` 只暴露 pending steps。`NEEDS_VALIDATION` 覆盖未 settle 的 output state 或 model changed。Session Repair 一旦报告 `TOOL_OUTCOME_UNKNOWN`，必须返回 `BLOCKED_UNKNOWN_SIDE_EFFECT`；用户不能覆盖它，orchestrator 必须检查外部状态。其他事实安全时，`TOOL_NOT_STARTED` 不会阻断。完成任务返回 `COMPLETED`；blocked task、没有 pending work 的 task，以及按自动路径检查的用户取消 task 返回 `NOT_RESUMABLE`。

`ctx.taskCheckpoints.resume(agent, { taskId, maxContextTokens })` 是用户授权的 host API。它重新读取 checkpoint、manifest、hazard、idle Agent boundary、execution metadata 与 inbox ordering，并在 persistence flush 后重复这些检查。已经准入的请求会在模型请求排队前，以单调递增的 Task revision reservation 一个新 Run。重启后如发现该 reservation 没有匹配的 `turn/start`，API 会复用它，而不会创建另一个 Run。

Resume Context 是 JSON，包含 objective、constraints、decisions、completed/current/pending steps、output reference、root failure 与 critical facts。token meter 提供其记录的 budget；历史 reasoning、完整 Session log 与 raw tool output 被明确省略。pre-step extension 只替换派生的、模型可见的非 system Session surface，而 append-origin JSONL event 仍是权威来源。已准入 Run 的 terminal error 或用户取消会追加 failure/cancellation Task revision，不会改变 completed work 或重试任何内容。

`ctx.taskCheckpoints.diagnostics(session)` 返回选定/最新 Task、checkpoint revision 与 step sets、resume decision、output manifests、repair hazards、reservation 是否 requested/started、其 Run id、model relation 与 context budget。提供拟议 execution metadata 时，决策会反映 model-change 风险。该 capability 从不重启 backend、重试 tool、自动 Resume、改变 reasoning 或改变 compaction policy。

完整 schema、lifecycle、fixture 与 deferred-work 约定见[包 README](../../packages/session/task-checkpoint/README.zh.md)和[架构决策](../../.agents/notes/implemented/architecture/2026-09-14-task-checkpoint-resume-safety.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/session/task-checkpoint/src/index.ts`](../../packages/session/task-checkpoint/src/index.ts)
<!-- END GENERATED cordis-surface -->
