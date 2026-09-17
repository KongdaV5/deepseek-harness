# Agent Note: Task Checkpoint、Result Manifest 与 Resume 安全

Status: implemented

[English](2026-09-14-task-checkpoint-resume-safety.md) | 中文

## Problem

Run State 可以描述 live 或 failed Run，却不能说明长任务的哪些部分已经安全完成，也不能判断重放被中断副作用是否安全。通过重放完整 conversation 再说“继续”，会丢失 Task identity、重复昂贵工作，并可能重复执行 outcome 未被记录的工具或外部修改。Session checkpoint policy 保护事件持久化，但刻意不建模 task progress 或 deliverable validity。

## Decision

`@deepseek-ai/dsh-task-checkpoint` 是外置 Session capability，拥有稳定 Task identity、完整快照 Task Checkpoint event、独立完整快照 Result Manifest event、对应 projection、Resume classification 与明确 Resume execution。它使用已有 Session event、Session Repair、Session Projection、`agent/pre-step` 与 `llm/stream` extension point；不增加 Agent loop、Session core、Projection core、Goal、filesystem core、client runtime 或 Desktop hook。

Task 不等于 Run。`taskId` 在 origin Run 与以后选定的 Run 之间保持稳定。`originRunId` 不可变，`latestRunId` 可以前进，每个 Checkpoint revision 严格递增。本批 contract 在每个 Session 中只接纳一个未完成 Task；这是 task service 约束，不是 backend concurrency 或 identity 假设。

### Durable ownership

`task/checkpoint` 携带一份完整 `TaskCheckpoint`；`task/result-manifest` 携带一份完整 `ResultManifest`。两种事件都是 required 而非 ignorable，因为静默跳过会抹掉 recovery truth。普通 Session event vocabulary 增长不会改变 Session format version，但不认识 required task event 的 runtime 必须拒绝日志，不能假装 recovery state 不存在。

`taskCheckpoint` 与 `taskResults` projection 保持独立。它们的 state 是 plain JSON，严格 fold 会保留第一次 replay failure。Crash/restart 后，append-only Session log 仍是权威来源；projection cache 只是捷径。Checkpoint revision 保持不可变 task/origin metadata，completed step 与 output reference 只允许追加，completed Task/Result state 是 terminal。

### Evidence and result rules

模型不会获得 Checkpoint mutation tool。Completed step 必须引用匹配且成功的持久 `tool/result`、passed Result Manifest revision，或明确的 structured runtime validator。Current step 在证据被接受前始终留在 pending steps 内。Fatal failure 记录 root classified error 以及已知 Attempt/current-step identity，同时保留早先 completion，并让未完成工作保持 pending。

Task projection 的 host-only 部分保留成功工具结果的紧凑 event-sequence/call-id 索引。Service 从这份可重建 state 校验工具证据，不会新增同步任意 history 读取；该索引不属于 client diagnostics view。

Task Checkpoint 与 Result Manifest 始终是不同对象。Manifest 拥有 output path、lifecycle、size、SHA-256 checksum、execution metadata 与 validation。Completed manifest 要求 size 大于零，并具备 checksum、completion timestamp 与 passed validation。包含 output reference 的 Task 必须在每个引用都 completed 后才能 complete。生产 publisher 使用已有 atomic-write primitive，重新读取并哈希 final path，运行 validator，并只在所有检查通过后写入 `completed`。直接 shell governed-path discovery 不属于此 capability。

### 明确 Resume execution

Classifier 返回 `SAFE_TO_RESUME`、`NEEDS_VALIDATION`、`BLOCKED_UNKNOWN_SIDE_EFFECT`、`COMPLETED` 或 `NOT_RESUMABLE`，并且 prospective plan 只包含 pending steps。Classification 本身不执行工作。用户授权的 host call `ctx.taskCheckpoints.resume(agent, { taskId, maxContextTokens })` 会重新读取当前 checkpoint、manifest、repair hazard、live Agent provider/model、idle turn boundary 与 inbox，并在 Session flush 后重复这些检查。

Session Repair 的 `TOOL_OUTCOME_UNKNOWN` 始终产生 `BLOCKED_UNKNOWN_SIDE_EFFECT`；在外部状态验证前不会允许 tool retry，也没有 force override。其他检查通过时，`TOOL_NOT_STARTED` 可以重新进入计划。未 settle 的 result 和 model changed 要求 validation。Blocked Task 不可恢复。用户取消的 Task 保留 Checkpoint，但自动检查拒绝 Resume；只有以后由用户明确发起，才可能让其 pending steps 变为 eligible。

已经准入的 call 会在模型请求排队前，于 Checkpoint revision 中 reservation 一个不同的新 Run。`latestResume` 保留仅含 pending 的 plan、其 estimated token budget 与 selected/omitted context sections。已持久化但未到达 `turn/start` 的 reservation 会在重启后复用，而不会产生另一个 Run。terminal error 或用户取消会追加 failure/cancellation Checkpoint revision，写入 classified primary error，同时保留先前 completed steps 与 pending work。

模型接收受限 JSON Resume Context：task objective、constraints、decisions、completed/current/pending steps、completed/partial outputs、root failure 与 critical facts。历史 reasoning、完整 Session log 与 raw tool output 保持排除。pre-step extension 为新 request series 替换派生的模型可见 non-system surface；原始 append-origin JSONL event 仍是权威来源。Original/latest provider、model、backend、requested reasoning 与 resolved reasoning 都只作为事实 metadata。服务记录 same-model 或 model-changed 关系，但不引入 reasoning、retry、restart、compaction、Profile 或 Benchmark policy。

## Alternatives considered

- **把一个 Run 当成一个 Task。** 拒绝，因为可恢复长任务必须在以后由用户触发的新 Run 继续时保留 identity。
- **用 Session checkpoint policy 表示 task progress。** 拒绝，因为日志持久性与语义 task completion 拥有不同 owner 和 evidence。
- **把 Checkpoint prose 存进模型 prompt。** 拒绝，因为这会让模型成为 authority、扩大 context，也无法安全分类 unknown side effect。
- **把 progress 与 deliverable 合并成一个巨大 record。** 拒绝，因为 step recovery 与 output validity 独立变化，并需要不同 lifecycle invariant。
- **Result 缺失时盲目重放当前 tool。** 拒绝，因为已经 started 的副作用操作可能已在外部提交。
- **立刻修改 Agent loop 或 Desktop。** 拒绝，因为 Session event/projection 与已有 pre-step/stream seam 已能承担 durable ownership 与 model-context replacement，无需 core fork。

## Consequences

- 长任务可以在 Session replay 后保留有证据的 completed/pending work，且不改变 Run/Attempt identity。
- Unknown external side effect 会 fail closed，而已证明未开始的 tool 可以保持 resumable。
- Result completion 不能仅从文件存在推断；0-byte 与结构不完整输出保持 partial。
- Checkpoint 频率绑定明确 safe boundary，而不是 token、stream delta 或 backend heartbeat。
- Diagnostics 暴露 Task、Checkpoint、Resume decision、outputs、repair hazards、request/start attribution、model relation 与 context budget，不引入正式 UI。
- 明确 Resume 会创建一个新 Run，在模型请求前持久化 reservation，并记录 terminal error 或 cancellation，不会重复 completed work。
- 单独的 `SAFE_TO_RESUME` 没有副作用。Capability 不执行自动 Resume、backend restart、worker restart、tool retry、reasoning change、compaction change、Profile change、Benchmark change 或正式 UI 工作。
- 直接 shell-path governance 与明确跨 model approval policy 仍不属于此 capability。
