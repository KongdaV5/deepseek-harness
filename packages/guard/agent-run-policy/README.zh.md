---
description: "基于 Agent Run State 的进度感知模型请求有限重试与取消确认，供本地后端部署者及组合恢复策略的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-policy

[English](README.md) | 中文

## 概述

`dsh-agent-run-policy` 使用只读 Agent Run State diagnostics，阻止盲目模型请求重试，并区分“已请求取消”与“后端已确认终止”。它把瞬态请求恢复限制为零至两次，在每次受管重试决策前探测 backend observer，拒绝对 fatal 与永久失败原样重试，并通过 diagnostics service 发布瞬态 retry／cancellation 事实。它不会重启后端、恢复 Run、改变 reasoning 或 compaction 策略，也不会把高频控制状态写入 Session 日志。

## 目录

- [使用本包](#use-this-package)
- [重试策略](#retry-policy)
- [取消确认](#cancellation-acknowledgement)
- [组合与诊断](#composition-and-diagnostics)
- [实现地图](#implementation-map)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先挂载 Agent Run State，再挂载本策略与现有 retry executor。只列出需要本地策略治理的 provider route。策略把自身的 request-error listener 注册为最外层 waterfall guard，因此上限不依赖 Loader 顺序，也不会被 provider 更大的 retry budget 绕过。

```yaml
- name: '@deepseek-ai/dsh-agent-run-state'
  config:
    slowAfterMs: 300000
    stalledAfterMs: 600000

- name: '@deepseek-ai/dsh-agent-run-policy'
  config:
    observerId: local-run-policy
    providers:
      - local-qwen
    maxRetryCount: 2
    cancellationConfirmationMs: 5000

- name: '@deepseek-ai/dsh-llm-retry'
```

| 字段 | 必填 | 含义 |
|---|---:|---|
| `observerId` | 是 | 瞬态 Run control observation source 的唯一标识 |
| `providers` | 是 | 本策略治理的精确 LLM provider route |
| `maxRetryCount` | 是 | 每个 Run 的硬性 retry 上限，取值 0 至 2 |
| `cancellationConfirmationMs` | 是 | 等待后端 generation 消失强确认的有限窗口 |

本包要求 `ctx.agentRunState`。Backend observer 可以实现 `probe()`，在决策前刷新当前可获得的日志或进程证据。Probe 失败会被隔离，绝不会被伪造成 health 或 activity。

-----

<a id="retry-policy"></a>
## 重试策略

每次 retry 都是同一 Run 内的新 Attempt。策略读取 durable `retryCount`，应用自身 `maxRetryCount`，并只把 `TRANSPORT`、`TIMEOUT`、`SERVER`、`RATE_LIMIT` 或 `PROVIDER_UNAVAILABLE` 委派给现有 `dsh-llm-retry` executor。Executor 继续负责 provider policy、durable `llm/retry`／`llm/retry-started` event、backoff 与可取消等待。

策略拒绝对 `RESOURCE_LIMIT`、`WORKER_CRASH`、`MODEL_LOAD_FAILED`、`INVALID_MODEL_CONFIG`、`INVALID_REASONING_PARAMETER`、`CLIENT_CANCELLED`、`CONTEXT_OVERFLOW` 与 `GENERATION_STALLED` 原样重试。只要 overall、process、model 或 generation health 任一为 fatal，即使当前 provider failure 看起来只是普通 `SERVER` 或 transport 错误，也会拒绝。Metal resource limit 因而保持为根因，不会触发另一轮完整 prefill。

`GENERATION_STALLED` 会先 probe 再拒绝。Agent Run State 不会仅因 diagnostics 变为 stalled 就中止仍在运行的请求；若请求仍存活，观察会继续。请求一旦已经失败，本包没有不安全的“恢复旧 stream”动作，因此不会把该状态变成新的模型请求。

错误保持观察顺序。首个 classified failure 永远是 `primaryError`；BrokenPipe、stream disconnect 与后续 attempt failure 保持为 secondary。Retry 评估与之后的 health 结果都不会覆盖根因。

-----

<a id="cancellation-acknowledgement"></a>
## 取消确认

Agent request 被 abort 后首先发布 cancellation status `requested`；AbortSignal 只能证明 DSH 请求了 transport cancellation。策略立即要求 backend observer probe，并监视 diagnostics 中 `generationActivity.state = inactive` 且 `confidence = confirmed` 的证据。只有这种证据会把状态改为 `confirmed`。

如果在 `cancellationConfirmationMs` 内没有收到 generation 消失的强确认，状态变为 `unconfirmed`，overall health 至少为 `degraded`。稍后到达的 confirmed inactive observation 仍可把 `unconfirmed` 改为 `confirmed`。Process `/health = 200`、沉默、UI 断连与 provisional inactive 推测都不能确认取消。

所有 acknowledgement 数据都是瞬态。Durable `turn/end` event 仍负责 Run 的 terminal `cancelled` phase 与 `CLIENT_CANCELLED` primary error；策略不会发明或改写 terminal Session event。

-----

<a id="composition-and-diagnostics"></a>
## 组合与诊断

`ctx.agentRunState.diagnostics(session)` 暴露：

- 用于 no-progress 分类的 `lastMeaningfulActivityAt` 与 `staleThresholdMs`；
- `retryCount`、策略 `maxRetryCount` 与最新 classified retry reason；
- 带时间戳的 cancellation `requested`、`confirmed` 或 `unconfirmed`；
- 相互独立的 process、model、generation health；
- 稳定 primary error 与按序 secondary error。

有归属且持续推进的 backend activity 还会发出 provider-neutral `llm/request-activity` event。`dsh-llm-pi-ai` 只用它 pulse 同一 Session 当前未完成的 idle-watchdog demand。Health polling 无法发出该事件，因为 observation 必须携带严格递增且等于 observation time 的 `lastActivityAt`。该事件不改变请求 payload，也不写 Session record。

-----

<a id="implementation-map"></a>
## 实现地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 最外层 retry guard、backend probe、cancellation monitor 与 diagnostics observation |
| [`src/types.ts`](src/types.ts) | 配置、纯 retry decision、clock 与测试注入契约 |
| [`src/testing.ts`](src/testing.ts) | 无需墙钟等待即可测试长窗口的确定性 `FakeClock` |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | Retry matrix、fatal 优先级、取消确认与 timer case |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 真实 Loader 组合，证明 provider budget 为五时仍被限制为同一 Run 内两次 retry |

不发布 runtime invariant 伴生入口。策略的可观察关系已在 Agent event waterfall、Session projection、backend observer 与真实 Loader 边界直接覆盖。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为本包不增加 prompt、tool、model message 或 request field，只限制已有失败模型请求能否再次尝试。

#### KV Cache 影响

无直接影响：本包不改变 request content 或 compaction policy，而阻止 blind retry 可以避免重复完整 prefill。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Cancellation confirmation 的强度取决于 backend observer。当前 MLX 日志接入在 client abort 后若没有结构化消失信号，可能保持 `unconfirmed`。
- 策略不会重启 worker、重启 local-model service、恢复 Run、创建 checkpoint 或修改 terminal state。
- `stalledAfterMs` 与 adapter 的 stream idle timeout 是两个独立部署设置，应保持一致；本包不会静默改写任一设置。
- 只有列出的 provider route 受治理。未列出的 provider 保持其既有 recovery chain。
- Run-control overlay 是进程内 diagnostics。Durable retry attempt 仍来自现有 Session retry event。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

已实现的拆分与最小 core hook 记录在[进度感知 Run 控制](../../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.zh.md)。底层 projection 与 observer seam 记录在 [Agent Run State 投影与后端观察器接缝](../../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.zh.md)。

</details>
