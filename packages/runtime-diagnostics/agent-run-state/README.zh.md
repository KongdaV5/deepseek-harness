---
description: "通过可替换的本地后端观察器接缝投影 Agent Run 身份、阶段、健康与错误诊断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-state

[English](README.md) | 中文

## 概述

`dsh-agent-run-state` 让 DeepSeek Harness 组合知道一次用户触发的 Run 正在做什么，同时不扩展粗粒度 `AgentStatus` 词表，也不让 agent loop 维护第二套可变状态机。它把现有低频 Session 事件折叠为客户端可见的 `agentRunState` projection，通过 `ctx.agentRunState` 叠加进程内 assistant stream 与 backend observation，并只进行健康和错误分类，不执行恢复动作。后端实现注册有限的 `LocalBackendObserver` 约定；本包不依赖 MLX、llama.cpp 或特定日志格式。

## 目录

- [使用本包](#use-this-package)
- [身份与状态约定](#identity-and-state-contract)
- [持久与瞬态边界](#durable-and-transient-boundary)
- [健康与错误不变量](#health-and-error-invariants)
- [实现地图](#implementation-map)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `dsh-session-projection` 旁挂载本服务，并提供由部署方管理的耗时阈值。服务把最新持久 Run 注册为 `sessionProjections.snapshot(session).values.agentRunState`；`ctx.agentRunState.diagnostics(session)` 返回已分离的只读快照，其中合并了瞬态 stream/backend/control activity。`subscribe()` 报告由 activity 驱动的变化；`probe()` 要求可替换 backend observer 刷新当前可获得的证据，同时不伪造 activity。轮询 `diagnostics()` 会重新计算只由时间经过引起的健康变化；本包不创建 stalled timer。

```yaml
- name: '@deepseek-ai/dsh-agent-run-state'
  config:
    slowAfterMs: 300000
    stalledAfterMs: 600000
```

| 字段 | 必填 | 含义 |
|---|---:|---|
| `slowAfterMs` | 是 | 活跃 Run 总耗时超过该值且仍在工作时分类为 `slow` |
| `stalledAfterMs` | 是 | 活跃 Run 距最近 meaningful activity 超过该值时分类为 `stalled`；必须大于 `slowAfterMs` |

后端插件通过 `ctx.agentRunState.registerObserver(observer)` 注册一个 observer。每条 observation 明确归属于 `run`、`attempt` 或 `unknown`。无法解析的 Run/Attempt 会保留在 `unattributedBackendObservations`；服务不会仅因为当前只有一个活跃 generation 就替它归属。Observer 可以实现 `probe()`，供决策时刷新证据。独立 `LocalRunControlObserver` 可以发布 transient retry budget/reason 与 cancellation acknowledgement 事实。`LocalRunDiagnosticsObserver` 可以发布有归属的只读 reasoning 与 Context Pressure 事实；两类 observer 都不能修改 durable projection、lifecycle、health、retry 或 cancellation 事实。

测试与 fixture 包可从 `@deepseek-ai/dsh-agent-run-state/testing` 导入 `FakeBackendObserver`、`FakeStream` 与 `FakeWorker`。这些 fixture 只生成公共 backend/stream 约定，不模拟 MLX。

可选的 `@deepseek-ai/dsh-agent-run-state/command` function plugin 注册 `/agent_run_state`。它返回调用 Session 的合并 diagnostics 只读 JSON view，包括 identity、route、phase、整体与组件 health、meaningful activity 与 stale threshold、prefill、retry current/max/reason、cancellation acknowledgement，以及 primary/secondary error。该 command 只产生 command registry 通常的低频 `command/run` 与 `command/done` 记录；backend progress 仍是 transient。使用 MLX 的部署可以挂载独立的 [`dsh-agent-run-state-mlx`](../agent-run-state-mlx/README.zh.md) provider 与可选 [`dsh-agent-run-policy`](../../guard/agent-run-policy/README.zh.md)。

-----

<a id="identity-and-state-contract"></a>
## 身份与状态约定

身份层级为 `session_id → run_id → attempt_id`。Session 是长期 conversation，Run 是一次完整的用户触发 turn，Attempt 是某一步骤中的一次实际模型请求。`runIdFor(sessionId, turn)` 可确定性重建；`attemptIdFor(runId, step, ordinal)` 在 retry 时变化。`llm/retry-started` 增加 attempt ordinal，同时保持 Run id 不变。`agent/assistant-stream` 中进程内的 `LlmAttemptId` 会映射到这套稳定层级，绝不会被当作持久的跨进程身份。

`RunPhase` 独立于 `AgentStatus`，覆盖 `unknown`、准备、prefill、reasoning、generation、工具等待、retry 等待、compaction 以及终态。`AgentRunState` 明确区分 requested/resolved/backend-default reasoning 字段，并且只在已观测到时暴露 context 事实。缺失的 progress、health、reasoning、activity 和 attribution 一律是 unknown，不会估算。

-----

<a id="durable-and-transient-boundary"></a>
## 持久与瞬态边界

持久 projection 消费现有 `turn/start`、`turn/end`、`step/start`、`request/header`、`request/context`、`assistant/attempt`、`assistant/message`、`tool/call`、`tool/result`、`llm/retry`、`llm/retry-started`、`compaction/start` 与 `compaction/end` 事件，不新增 Session 事件。Run 开始/结束、从 step/retry 事件推导的 Attempt 边界、retry 事实、已分类的持久失败、路由/reasoning 观测、context-window metadata、token usage 以及 tool/compaction 阶段边界，都能在 replay 和 projection cache 恢复后保留。

Assistant chunk activity、后端组件 health、prefill 计数/速度、后端 heartbeat 时间、generation presence、retry-policy display fact、cancellation acknowledgement、reasoning selection、Context Pressure 与实时错误信号保留在进程内。它们存放在 Session JSONL 之外，只由读取服务合并。因此重复 progress observation 不会扩大日志或模型 context。wire projection 有意只包含持久快照；可选 host command 会序列化合并后的服务快照，而不改变状态或 observer 约定。

-----

<a id="health-and-error-invariants"></a>
## 健康与错误不变量

`unknown`、`healthy`、`slow`、`stalled`、`degraded` 与 `fatal` 是不同结果。Stall 使用 `now - lastMeaningfulActivityAt` 判定，绝不使用 total request age。Assistant reasoning/text、tool lifecycle event 与有归属且持续推进的 backend progress 会刷新 meaningful activity；UI read 与 health polling 不会。因而即使首 token 等待很久，新鲜 progress 也能阻止纯时间型 stalled 分类，之后恢复的 progress 还能把非 fatal stalled view 恢复为 active/slow。进程 healthy 不代表 generation worker healthy；组件 fatal 证据优先于进程 health。Fatal 分类必须来自结构化的 process/worker/model-load 终止、结构化 fatal code，或来自 backend origin 的已识别 resource-limit/OOM 特征。HTTP health 成功、断连、BrokenPipe、取消或单纯长时间沉默都不能单独构成 fatal。

错误按首次观测顺序处理：`primaryError` 永不被替换，后续信号追加到 `secondaryErrors`。因此客户端取消后再出现 BrokenPipe 时，`CLIENT_CANCELLED` 仍是 primary，`STREAM_DISCONNECTED` 是 secondary。这些分类仅是诊断事实；本包不会 restart worker、retry request、resume run、cancel work，也不会改变 retry、reasoning、checkpoint 或 compaction policy。

-----

<a id="implementation-map"></a>
## 实现地图

| 文件 | 职责 |
|---|---|
| [`src/brand.ts`](src/brand.ts) | 不透明的 Run、Attempt 与 observer 身份，以及确定性派生 |
| [`src/types.ts`](src/types.ts) | Run State、backend/control/diagnostics observer、health、error、cancellation、reasoning、context 与 diagnostics 约定 |
| [`src/projection.ts`](src/projection.ts) | 纯持久 fold 与 `agentRunState` projection 注册 |
| [`src/health.ts`](src/health.ts) | 由调用方提供阈值的纯 health classifier |
| [`src/errors.ts`](src/errors.ts) | 感知来源的 fatal/error classifier 与 primary/secondary 累积 |
| [`src/index.ts`](src/index.ts) | `ctx.agentRunState` 服务、瞬态 overlay、observer registry、probe、activity event 与读取 API |
| [`src/testing.ts`](src/testing.ts) | 可控 fake observer、stream 与 worker fixture |
| [`src/view.ts`](src/view.ts) | 使用显式 unknown/null 值的稳定 JSON-compatible developer view |
| [`src/command.ts`](src/command.ts) | 可选只读 `/agent_run_state` diagnostics command |

本包不发布运行时 invariant companion。它的可观察关系正是 projection 与 classifier 行为，并已由穷尽单元测试和真实 Loader 组合测试覆盖；再添加一个运行时 listener 只会重复实现，无法独立发现损坏。

-----

<a id="model-experience"></a>
## 模型体验

无，因为服务只观察运行时活动并暴露 diagnostics，不会改变模型请求。

#### KV Cache 影响

无影响。本包不修改已组装请求或 Session surface event。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 客户端可见 projection 仅包含持久数据。实时合并 diagnostics 可通过 host 的 `ctx.agentRunState` 与可选 command 读取；Desktop 传输与展示被延后。
- MLX provider 的文本派生 progress 与 request attribution 是 provisional；共享或有歧义的 endpoint 保持 unattributed。
- 仅由时间经过造成的 health 变化会在读取 `diagnostics()` 时出现；没有后台 stalled timer。
- `stalledAfterMs` 与 adapter 的 stream idle timeout 是独立部署设置；Run State 报告前者，不会改写后者。
- Attempt 身份可以从持久 step/retry 顺序重建，但进程崩溃后从未 settle 的进程内 stream 没有持久 `LlmAttemptId` 映射。
- projection 只保留最新 Run。Session 日志仍是历史 Run 的来源。
- 本包只分类和记录 observation，不执行恢复或策略变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

架构决策记录在 [Agent Run State projection 与 backend observer seam](../../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.zh.md)与[进度感知 Run 控制](../../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.zh.md)。

</details>
