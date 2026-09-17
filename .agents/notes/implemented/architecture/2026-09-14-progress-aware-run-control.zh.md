# Agent Note：进度感知 Run 控制保持为 observation 与 retry execution 之上的外层策略

Status: implemented

[English](2026-09-14-progress-aware-run-control.md) | 中文

## 问题

Agent Run State 已让 MLX prefill、backend activity、组件 health 与 fatal error 可见，但现有 request recovery path 仍基于更窄的证据做出两个决定。pi-ai adapter 的 idle watchdog 只能看到 provider response-stream demand，因此 backend prefill 持续推进十分钟却没有 assistant token 时仍可能被误判 idle。`dsh-llm-retry` executor 能正确持久化并调度 provider 配置的 retry，但本地 route 可能继承过大的 retry budget，并在 backend observation 已确认 Metal resource exhaustion 或 worker failure 后，仍对普通 `SERVER` 结果重试。

Cancellation 存在相同的证据缺口。Agent request 被 abort 只能证明 DSH 要求 transport 停止；不能证明 MLX generation 已释放 worker。把 AbortSignal 完成当作 backend acknowledgement，会在本地 worker 可能仍消耗资源时产生过度乐观的 diagnostics。

Response-stream waterfall 不能通过改写请求解决 prefill 缺口：`llm.prepareCall()` 有意冻结 immutable call snapshot，而 backend log 既不是 model output，也不是 request configuration。Request-error waterfall 可以承载 retry governance，但普通 listener 注册顺序不是稳定的安全边界：真实 Loader 组合证明，现有 retry executor 可能包在新 policy 外层，在 policy 执行前耗尽 provider 的五次 retry。

## 决策

Run control 是独立 Cordis plugin `@deepseek-ai/dsh-agent-run-policy`，叠加在 `ctx.agentRunState` 与现有 retry executor 之上。Agent loop、Session controller、client runtime、Desktop、retry event format、reasoning policy 与 compaction policy 均保持不变。

### 一个 provider-neutral activity hook

`dsh-llm` 声明 additive `llm/request-activity` event。它只携带 Session identity、observation time、source 与 confidence。Agent Run State 仅在有归属的 backend observation 携带严格递增、且等于该 observation 自身 timestamp 的 `lastActivityAt` 时发出该事件。Health-only poll 因而不能 pulse request activity，而 MLX prefill progress 可以。

`dsh-llm-pi-ai` 按 Session identity 为单个 in-flight request 可选订阅该事件，并为匹配活动调用现有 `idleWatchdog.pulse()`。Hook 不改变 request、stream chunk、retry action 或 Session record。它是 provider-neutral 的，未来 backend observer 无需暴露 MLX log syntax 即可复用。之所以需要这一最小 core hook，是因为之前没有事件能在 provider iterator 存在 outstanding demand 时到达 adapter。

### 有界的外层 retry guard

Policy 注册 prepended `agent/request-error` listener，使安全决策无论 Loader 顺序如何都处于 waterfall 最外层。对于列出的 provider route，它 probe 所有 backend observer、读取当前 Run diagnostics，并只在 `retryCount < maxRetryCount` 时把瞬态 transport／provider failure 委派给 `dsh-llm-retry`。配置把本地上限限制为零至二。`dsh-llm-retry` 仍是唯一 executor，继续负责 provider policy、durable `llm/retry`／`llm/retry-started` event、delay、jitter 与可取消等待。

Overall 或任一组件 health 为 fatal 时，即使当前 failure 是普通错误，也会阻断委派。`RESOURCE_LIMIT`、`WORKER_CRASH`、`MODEL_LOAD_FAILED`、`INVALID_MODEL_CONFIG`、`INVALID_REASONING_PARAMETER`、`CLIENT_CANCELLED`、`CONTEXT_OVERFLOW` 与 `GENERATION_STALLED` 同样拒绝原样 retry。因此 Retry 只通过现有 durable event path 推进 Attempt identity，绝不会创建 Run。

`GENERATION_STALLED` 会先 probe 再拒绝。Run State 不会因为 elapsed diagnostics 变为 stalled 就主动 abort live request，因此仍存活的请求继续接受观察。如果请求已经失败，policy 没有“继续同一 transport”的动作，所以不会把 stalled evidence 转化为新的完整请求。

### 瞬态 cancellation acknowledgement

Agent Run State 除 backend observer 外还接受可替换 `LocalRunControlObserver`。其 overlay 携带 policy 的 retry budget／reason 与 cancellation acknowledgement，不把高频或进程内事实写入 Session JSONL。`/agent_run_state` view 会报告 `lastMeaningfulActivityAt`、`staleThresholdMs`、retry current／max／reason，以及 requested／confirmed／unconfirmed cancellation timestamp。

Request abort 时，policy 发布 `requested`、probe observer，并启动有限 confirmation window。只有 `generationActivity = { state: 'inactive', confidence: 'confirmed' }` 能确认 backend disappearance。到期后产生 `unconfirmed`，并把 overall health 降为 degraded，除非 fatal evidence 已经优先。稍后到达的 confirmed inactive observation 仍可确认取消。Durable `turn/end` 继续负责 terminal cancellation 与 `CLIENT_CANCELLED`；overlay 不改写 terminal state。

## 考虑过的替代方案

**再次增加 adapter timeout。** 拒绝，因为 total elapsed time 不是 inactivity，更大的常量只会移动误判边界。Watchdog 现在根据真实 attributed progress 重新计时。

**把 MLX log parsing 或 retry decision 放入 adapter。** 拒绝，因为这会把 request policy 绑定到一个 provisional log format，也会阻止 llama.cpp 或未来结构化 MLX observer 复用相同 contract。

**替换 `dsh-llm-retry`。** 拒绝，因为现有 executor 已正确负责 durable retry identity、persistence、backoff、cancellation 与 provider policy。缺少的是有证据的外层上限，而不是另一个 executor。

**依靠 plugin load order 实现上限。** 真实 Loader 测试否决了这一方案：普通顺序允许五次 retry 的 provider policy 在 guard 前执行。Prepend guard 让安全边界成为显式 event contract。

**把 abort 当作 confirmed cancellation。** 拒绝，因为 transport acknowledgement 与 backend generation disappearance 是不同事实。Unknown 保持显式。

**Fatal 后 restart 或 resume。** 本阶段拒绝。Restart、checkpoint 与 resume 需要后续 recovery ownership，不能只凭 observation 安全回放完整请求。

## 结果

- Stalled classification 使用 `now - lastMeaningfulActivityAt`；Run age 只把持续工作的状态区分为 slow。Assistant reasoning／text、tool event 与有归属 backend progress 更新 meaningful activity；UI read 与 health poll 不更新。
- 长 MLX prefill 可以在不产生 assistant token 或 Session event 的情况下，让 diagnostics 与 pi-ai 的 outstanding provider demand 都保持活跃。
- Metal resource exhaustion 可以与 process health `healthy` 并存；fatal generation evidence 仍阻止 retry，并保留首个 fatal error 为 primary、之后 stream failure 为 secondary。
- Retry diagnostics 显示 durable current count 与 policy 的进程内 maximum／reason。真实 Loader fixture 证明 provider 最大五次会被限制为两次 retry、三次 total attempt、一个 Run。
- 当前 MLX deployment 如果日志或结构化 endpoint 都不能证明 generation disappearance，cancellation 会诚实地保持 unconfirmed。HTTP health success 不足以确认。
- Upstream compatibility surface 很小但不为零：一个 additive LLM event、一个可选 pi-ai adapter subscription、可选 backend `probe()` 与可替换 Run-control observation contract。Upstream 若改变 LLM event、pi-ai watchdog ownership、Agent request-error waterfall semantics 或 Session retry event shape，需要复核。没有修改 Desktop bundle 或签名应用。

## 验证

确定性 fixture 覆盖：模拟长时间内持续推进的 prefill、无进展 stall、从 stall 恢复、Metal fatal evidence、有界瞬态 retry、invalid reasoning、caller cancellation、confirmed／unconfirmed cancellation，以及 healthy-process／fatal-generation 优先级。MLX replay fixture 保留 provisional backend-log progress 与 root-cause ordering。真实 Cordis Loader 组合覆盖 Agent loop 与 retry executor，并证明 policy cap。新增 policy 以及变更 Run State／MLX path 的每文件 statement、branch、function 与 line coverage 均为 100%。

本决策扩展 [Agent Run State 投影与后端观察器接缝](2026-09-13-agent-run-state-projection.zh.md)及[有界 LLM 请求恢复](2026-06-21-bounded-llm-request-recovery.zh.md)，不取代其中任一决策。
