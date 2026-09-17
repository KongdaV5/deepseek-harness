# Agent Note: 在后端中立 observer seam 后通过现有事件投影 Run State

Status: implemented

[English](2026-09-13-agent-run-state-projection.md) | 中文

## 问题

Agent 的公共 `idle | running` 状态能够回答 driver 是否活跃，却无法区分 context 准备、后端 prefill、reasoning、generation、工具等待，或被健康进程端点掩盖的 generation worker 故障。Session 日志已经记录 turn、step、request、assistant attempt、tool、retry 和 compaction 边界，assistant stream frame 则携带高频进程内 activity。本地后端还可以暴露 process、model、generation、heartbeat 和 prefill observation，但这些事实缺少共享约定与 correlation identity。

把每个阶段都放进 `AgentStatus` 会混合生命周期与单次请求进度。让 loop 维护一个大型可变 diagnostics 对象会重复仓库的 event-sourced projection 风格。持久化 progress counter 或 heartbeat 会让 Session JSONL 增长，却不提供 replay 或模型 context 价值。把 backend-specific MLX 日志 parser 嵌入 Run State，也会让实验性文本格式成为架构依赖。

Correlation hierarchy 必须区分长期 conversation、一次用户触发的工作单元以及每次实际模型请求。Retry 是同一工作单元内的另一次 attempt；把它视为新 Run 会破坏因果诊断与未来恢复策略。后端 activity 无法可靠归属时，单并发部署本身不足以作为绑定证据。

## 决策

### 身份依次为 Session、Run、Attempt

Diagnostics domain 自有不透明的 `RunId` 与 `AttemptId` brand。Run id 由 Session id 与正整数 turn number 确定性派生。Attempt id 由 Run id、step number 与正整数 ordinal 派生。`step/start` 建立 ordinal one；`llm/retry-started` 建立下一个 ordinal，但不改变 Run id。Loop 的进程内 `LlmAttemptId` 在进程存活期间映射到这套层级，但不会提升为持久跨进程身份。Provider request id 保持为可选叶节点 diagnostics。

Backend attribution 是封闭 union：精确 Attempt、精确 Run 或 `unknown`。无法解析的 identity 保留在未归属 diagnostics collection 中。当前 prompt/decode concurrency 可以改善某个 observer 的归属证据，但不是 Run State invariant。

### Durable state 是 Session projection

`@deepseek-ai/dsh-agent-run-state` 服务通过现有 Session projection registry 注册一个客户端可见的 `agentRunState` projection。其纯 fold 消费现有 `turn/start`、`turn/end`、`step/start`、`request/header`、`request/context`、`assistant/attempt`、`assistant/message`、`tool/call`、`tool/result`、`llm/retry`、`llm/retry-started`、`compaction/start` 与 `compaction/end` 事件。它不引入 Session 事件，也不需要修改 agent-loop、LLM、session-controller、client-runtime 或 Desktop。

Projection 保存最新 Run 的生命周期、确定性 identity、attempt/retry 位置、request route、requested 与 resolved reasoning observation、context metadata 与已报告 usage、tool/compaction 边界，以及 durable terminal/classified error。后续 turn 开始时替换最新 Run view；append-only Session log 仍是历史 authority。

Assistant stream delta、后端 heartbeat/activity 时间、组件 health、prefill counter/speed 和实时 backend error 是服务自有的 transient overlay，绝不会追加到 Session JSONL。只读 `diagnostics(session)` 方法返回已分离的合并快照；通用 wire projection 有意只暴露 durable cut。可选 host command 为开发 diagnostics 序列化合并快照，但不改变 projection。Activity subscription 在观测变化时通知，而只由时间经过产生的 health 变化会在读取 diagnostics 时重新计算，不安装定时器。

### Backend observation 可替换

`LocalBackendObserver` 发布有限且 backend-neutral 的 `BackendObservation`：process/model/generation health、observation 与最近 activity 时间、可选 activity kind 和 prefill 事实、可选结构化 failure evidence，以及显式 attribution。Run State 包不导入 MLX 或 llama.cpp 实现。`FakeBackendObserver`、`FakeStream` 与 `FakeWorker` 通过 testing subpath 提供可控 fixture。

独立的 `@deepseek-ai/dsh-agent-run-state-mlx` provider 封装 MLX 日志解析、文件跟随、HTTP process health 与 request-lifecycle correlation。它把日志派生 prefill 标为 `source: "backend-log"` 和 `confidence: "provisional"`。精确 Attempt attribution 同样保持 provisional，并要求 operator 声明 exclusive single-flight endpoint，且 MLX request marker 出现时恰好只有一个合格的活跃 DSH Attempt；所有歧义都保持 unknown。Callback、structured event、metrics endpoint、request id 或其他 backend 可以替换该 provider，而不改变 Run State contract。

### Unknown、health 与 error 规则明确

Unknown 是缺失 progress、attribution、component health 与 effective reasoning 时的正式状态。状态不会在证据不足时估算 prefill 百分比、reasoning 百分比、ETA、worker liveness 或 cancellation success。

总体 health 为 `unknown | healthy | slow | stalled | degraded | fatal`。部署配置提供 slow 与 stalled duration。只要 meaningful activity 仍然新鲜，即使 time-to-first-token 很长，也不会仅凭时间得到 stalled。Fatal component evidence 优先于 healthy process。Fatal error classification 必须来自结构化 process exit、uncaught worker exception、generation-worker termination、model-load failure、结构化 fatal code，或已识别的 backend-origin resource-limit/OOM signature。HTTP health success、UI 或 stream disconnect、BrokenPipe、cancellation 与 elapsed silence 都不能单独构成 fatal。

最早分类的 failure 是 `primaryError`；后续 failure 追加到 `secondaryErrors`，永不替换主因。这样，后端稍后报告 BrokenPipe 时仍保留 client cancellation 为 primary；断连跟随 resource limit 时也仍保留 resource limit 为 primary。Classification 只产生 diagnostics：不会 restart、retry、resume、checkpoint、cancel，也不会改变 reasoning、retry、compaction、Profile 或 Benchmark policy。

## 考虑过的替代方案

- **用每个阶段扩展 `AgentStatus`。** 拒绝，因为 driver lifecycle 与 request/backend progress 具有不同 identity、frequency 和 durability。
- **把 Run State 保持为 loop-owned mutable state。** 拒绝，因为这会重复 durable event truth，并要求侵入式 loop 修改。
- **为每个 stream delta 或 prefill increment 新增 durable event。** 拒绝，因为高频 observability 会污染 Session storage 与下游 context processing。
- **围绕 MLX 日志 parser 构建 Run State。** 拒绝，因为实验性日志格式必须留在可替换 provider 内。
- **把 unknown backend activity 归给唯一活跃 generation。** 拒绝，因为当前 concurrency 是 backend capability，不是 identity 的架构证明。
- **把 projection 与 session-controller 和 Desktop transport 耦合。** 拒绝，因为 host diagnostics 可以消费分离的 service view，而 transport 与 presentation 保持独立 consumer。

## 后果

- 实现保持 plugin-first，不新增 core hook；能够继续轻量跟随官方 loop、LLM、session-controller、client runtime 与 Desktop 变更。
- 现有 durable event 足以提供 lifecycle identity 与 replay，observer seam 则在不耦合后端的前提下补充 backend-only fact。
- Session JSONL 增长与 token streaming、prefill progress frequency、heartbeat frequency 无关。
- UI 与 diagnostics consumer 能区分 unknown、slow、stalled、degraded 与 fatal，并分别检查 process 和 generation health。
- Retry 保持在同一 Run 内并创建新 Attempt，为后续 recovery 工作建立 correlation contract。
- 可替换 MLX provider 提供真实日志 observation，host command 提供合并 diagnostics view，两者都不修改 core runtime module。
- Live Desktop transport/presentation、automatic recovery、dynamic reasoning、checkpoint policy、retry policy、compaction policy、Profile change 与 Benchmark change 继续延后。
