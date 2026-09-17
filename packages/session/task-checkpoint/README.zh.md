---
description: "为结构化长任务提供持久 Task Checkpoint、独立 Result Manifest 与保守 Resume 安全诊断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-task-checkpoint

[English](README.md) | 中文

## 概述

`dsh-task-checkpoint` 为结构化长任务记录已验证进度，并允许用户明确继续安全的 pending work。它让同一 Task 跨越多个 Run，把完整 Checkpoint 与 Result Manifest revision 写入 Session 日志，并在重启后通过 projection 重建二者。Resume Run 接收带预算的结构化上下文，而不是旧 conversation surface。未知 Tool outcome 会阻断；model changed 需要 validation；用户取消绝不会启用自动继续。

## 目录

- [使用本包](#use-this-package)
- [身份与持久约定](#identity-and-durable-contracts)
- [Resume 安全](#resume-safety)
- [实现地图](#implementation-map)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Session projection registry 旁挂载服务。Runtime owner 在经过验证的 Task 边界写入状态，并且只能在用户明确要求继续后调用 `ctx.taskCheckpoints.resume(agent, { taskId, maxContextTokens })`。

### 何时选择

多步骤 Coding、批处理、长分析、Workflow、多题测试或包含受治理 deliverable 的工作适合启用此 capability。普通聊天、短回答、单次只读工具或简单 shell 不应创建 Task。插件不增加模型工具；只有已经准入的明确 Resume 才会替换模型可见的 Session surface。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-task-checkpoint'
```

插件没有配置字段。`ctx.taskCheckpoints.diagnostics(session)` 是读取最新 Task 的只读开发诊断入口。`resume()` 是 host API 而不是自动策略：它读取最新 projection、验证 live idle Agent 与 output、持久化新 Run reservation，然后排入一次模型请求。

-----

<a id="identity-and-durable-contracts"></a>
## 身份与持久约定

层级为 `Session → Task → Run references → checkpoint revision`。失败任务以后在新 Run 中继续时，`taskId` 保持稳定；`originRunId` 永不变化，`latestRunId` 记录最近选择的 Run。每份 Checkpoint 保存 task type/status、原始和最新的 provider/model/backend/reasoning metadata、有证据的 completed steps、current/pending steps、结构化 resume context、output references、时间戳与可选根因 failure context。

`task/checkpoint` 与 `task/result-manifest` 是两个独立且必需的 Session event，均携带完整变更后值。对应的 `taskCheckpoint` 与 `taskResults` projection 在重启后从权威日志重建；projection cache row 仍只是加速器。Checkpoint revision 使用 compare-and-set 顺序，completed steps 与 output references 只允许追加，completed Task 不能保留 pending work。每个 completed step 必须由 tool result、通过验证的 Result Manifest revision 或明确 runtime validator 支持；模型文本本身没有写入路径。`latestResume` 记录已准入的 Run、仅含 pending 的计划与 context budget；已有 turn event 用于证明该 reservation 是否已经启动。

`taskCheckpoint` 的 host-only 部分还保留成功 `tool/result` 的 event-sequence/call-id 紧凑索引。因此证据检查读取 projection state，不会同步扫描任意 Session history；该索引不会进入 client diagnostics wire view。

Result Manifest 记录一个输出的 Task/Run 关联、路径、生命周期、时间戳、大小、SHA-256 checksum、execution metadata 与结构化 validation。只有 size 非零、存在 checksum/completion time 且 validation passed 时才允许 `completed`。只有所有被引用输出都 completed，Task 才能 completed。`resultPublisher(session).publish()` 复用共享 `dsh-atomic-write` primitive，重新读取并哈希 final path，运行 validator，并只在每项检查通过后写入 `completed`。

-----

<a id="resume-safety"></a>
## Resume 安全

`classifyResumeEligibility()` 返回 `SAFE_TO_RESUME`、`NEEDS_VALIDATION`、`BLOCKED_UNKNOWN_SIDE_EFFECT`、`COMPLETED` 或 `NOT_RESUMABLE`，但不启动任何工作。Session Repair 的 `TOOL_OUTCOME_UNKNOWN` 会投影到 active Task，并始终产生专用阻断结果。只要其他条件安全，`TOOL_NOT_STARTED` 不阻断。未 settle 的 result state 或 model changed 要求 validation。blocked Task 不可恢复；明确由用户取消的 Task 不能自动恢复，但以后由用户主动发起的检查可以允许其仍 pending 的步骤。

诊断决策只返回 Checkpoint 的 pending steps，所以 completed work 不会进入未来执行计划。`resume()` 会在排入前重复 classification、output verification、idle/boundary/inbox 检查，并确认 Session persistence 参与。它在请求前写入新的 `latestRunId`；已持久化但未达到 `turn/start` 的 reservation 会被复用，不会产生另一个 Run。失败或用户取消的 Resume 会追加新 Checkpoint revision，写入 classified primary error，同时保留 completed 与 pending steps。

模型接收 JSON 最小 Resume Context，其中包含 task objective/constraints/decisions、completed/current/pending steps、completed 或明确 partial 的 outputs、root failure 与 critical context。token meter 记录 `estimatedTokens`、已选 sections 与明确 omissions。历史 reasoning、完整 Session log 与 raw tool output 从不重放。context 超预算、output 已变、model changed、live execution 未解析或顺序变化都会返回 `NEEDS_VALIDATION`；`TOOL_OUTCOME_UNKNOWN` 仍是不可覆盖的阻断。

-----

<a id="implementation-map"></a>
## 实现地图

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | Client-safe Task、Checkpoint、Result Manifest、repair hazard、resume 与 diagnostics 约定 |
| [`src/identity.ts`](src/identity.ts) | 经验证的 Task/Step/Output 品牌构造器与自动生成的 Task/Output id |
| [`src/schema.ts`](src/schema.ts) | 严格持久值与 projection-cache schema |
| [`src/domain.ts`](src/domain.ts) | 必需的 `task/checkpoint` 和 `task/result-manifest` Session event ownership |
| [`src/projection.ts`](src/projection.ts) | 纯严格 fold、revision/immutability 规则与两个 projection definition |
| [`src/resume.ts`](src/resume.ts) | 纯且不执行工作的 Resume eligibility classifier |
| [`src/resume-execution.ts`](src/resume-execution.ts) | 明确 revalidation、reservation、最小 context 构造与模型排队 |
| [`src/result-publisher.ts`](src/result-publisher.ts) | 原子本地 result 发布、重新读取/checksum 验证与 validation 顺序 |
| [`src/index.ts`](src/index.ts) | `ctx.taskCheckpoints`、证据门控写入、terminal Resume snapshot 与 diagnostics |
| [`src/testing.ts`](src/testing.ts) | `FakeTask`、`FakeTaskStep` 与确定性 result-publishing fixture |

本包不发布 runtime invariant companion。严格 schema、transition guard、replay failure 保留、evidence check 与真实 Loader composition test 直接覆盖了本包可观察关系。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session projection](../../../docs/subsystems/session-projection.zh.md)——权威日志 fold 与 cache 语义。
- [Session persistence](../../../docs/subsystems/persistence.zh.md)——持久化与 crash repair 边界。
- [Agent Run State](../../../docs/subsystems/agent-run-state.zh.md)——Run/Attempt identity 与 classified failure 输入。
- [Task checkpoint 与 result](../../../docs/subsystems/task-checkpoint.zh.md)——子系统约定与自动生成的 service API。

-----

<a id="model-experience"></a>
## 模型体验

### 明确 Resume Context

#### 模型看到的内容

已经准入的 `resume()` request 提供一份 JSON Resume Context，其中包括 Task objective、constraints、decisions、completed/current/pending steps、受治理 output reference、primary failure 与 critical facts；它会为该 request series 替换派生的 non-system Session surface。

#### Token 影响

token meter 会在准入前估算这份 JSON，并记录 `estimatedTokens`、maximum、included sections 与 omitted sections。历史 reasoning、完整 Session log 与 raw tool output 不会贡献 resumed prompt token。

#### KV Cache 影响

Resume 开启新的 request series，因此不宣称复用先前 conversation 的 KV Cache。其余 Checkpoint 与 manifest revision 继续保留在 Runtime 管理的 projection 中。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 用户或未来已授权 orchestrator 必须调用 `resume()`；观察到 `SAFE_TO_RESUME` 绝不会启动模型工作。
- Runtime owner 必须明确创建 Task 并在安全边界写入。服务只为已准入 Resume Run 镜像 terminal error/cancellation 事实，绝不会把模型文本标为 completed step。
- Result governance 只覆盖通过该服务边界发布的输出；直接 shell 写入不会被阻止或自动发现。
- Result governance 覆盖 `resultPublisher()` 输出；直接 shell 写入保持 unmanaged，直到 Runtime 明确验证并发布它们。
- Model changed 会要求 validation，但本批不选择兼容策略。
- 第一版 service API 每个 Session 只接纳一个未完成 Task；Task identity 本身不与 backend concurrency 耦合。
- 共享通用 atomic writer 保证通过同目录 rename 发布完整内容，但不宣称 crash-durable `fsync`；需要更强持久性的 backend 仍负责提供该保证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者展开的工作上下文</summary>

所有权与安全决策记录在 [Task checkpoint、Result Manifest 与 Resume 安全](../../../.agents/notes/implemented/architecture/2026-09-14-task-checkpoint-resume-safety.zh.md)。

</details>
