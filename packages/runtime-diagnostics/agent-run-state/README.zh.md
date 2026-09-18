---
description: "从已提交 Session 轮次推导出的持久 Run 身份、run 状态投影与结构化 run 诊断；后端观测作为独立的诊断维度，永远不能成为 run 权威。"
kind: "package-library"
---

# @deepseek-ai/dsh-agent-run-state

[English](README.md) | 中文

## 概述

查询主 Agent 当前在做什么、上一次 run 如何结束、以及为什么失败，且只以持久 Session 日志为权威。本包由单个轮次推导出确定性的 Run 身份，把 Stage 6 生命周期事实折叠为"活跃或已终止"的 run 状态，并以固定优先级从结构化证据中分类失败。后端健康度是并列报告、而非定义 run 的独立维度。它不新增任何 Session 事件，也不持久化任何东西。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有状态。

一个 run 就是一个持久的上游轮次，因为 `turn/start` 与 `turn/end` 是上游就 Agent 工作所提交的唯一边界。本包的一切都由这一个选择推得：身份是轮次的纯函数；重试延续它所属的 run，而不是新开一个；已关闭的轮次根本没有"活跃 run"这种表示。

```ts
import { lifecycleFactsFrom } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import {
  activeRun,
  backendObserverId,
  projectRuns,
  runDiagnostics,
  unknownBackendObservation,
} from '@deepseek-ai/dsh-agent-run-state'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'

declare const events: readonly SessionEvent[]
declare const sessionId: SessionId

const state = projectRuns(sessionId, lifecycleFactsFrom(events))

activeRun(state)   // the open turn, or null when no durable turn is open
state.terminal     // the most recent closed run, retained as history

runDiagnostics({
  projection: state,
  observation: unknownBackendObservation(backendObserverId('local-gguf'), 0),
  now: 0,
  slowAfterMs: 30_000,
  stalledAfterMs: 120_000,
})
```

### Run 身份是推导出来的，而不是凭空铸造的

`runIdFor(sessionId, turn)` 以长度前缀编码这两个坐标，因此结果是单射的，并且跨进程、跨重启、跨回放保持一致。这里没有 `RunId(value)` 构造函数，因为接受调用方传入的字符串与接受一个随机值无法区分。此处不读取 `LlmAttemptId`、不读取重试计数、也不读取进程内局部值；也没有为了承载那个上游本已记录为轮次边界的身份而新增任何 Session 事件。

### 不存在空闲 run

当日志没有留下任何未关闭的轮次时，`activeRun` 返回 `null`，这就是全部答案：轮次之间的会话没有活跃 run，而不是被合成出一个空闲 run。已消费的 run 也不会被丢弃 —— 最近一个已关闭的轮次仍可经 `terminalRun` 读取，它是历史，不暗示当前有任何工作。

投影在每次调用时都从事实集重新计算，因此终止单调性是结构性的：一旦 `turn/end` 进入日志，任何后续折叠都不可能把那一轮报告为活跃。

### 重试延续一个 run，绝不新开一个

重试保持同一个 `RunId`、同一个轮次、同一个步骤。等待期间它表现为 `phase: 'waiting_retry'`，并在 run 上表现为 `retryCount`、`maxRetryCount` 与 `retryReason` —— 有界的 `normal` 策略会报告它的上限，`always` 策略则不报告上限，而不是编造一个。

### 终止原因在投影后依然保留

`completed`、`aborted`、`blocked`、`error`、`max-tokens` 与 `interrupted` 各自把持久原因保留在 run 上。`interrupted` 以 `repairClosure: true` 报告：上游只在事后写入它，用于关闭一个进程已死掉的轮次，所以它是对日志的读取，而不是实时故障。循环在运行时从不发出它。

### 后端健康度只被观测，从不具有权威

后端观测回答的是另一个问题 —— 本地推理后端是否可达、是否繁忙 —— 它永远不能创建、推进或终止一个 run。`BackendObservation` 自带 `source`、`directness`、`reachability` 与 `activity`；`runDiagnostics` 中的合并是把观测者诊断追加在 run 自身错误之后，而不是与它竞争。

`unknown` 在每一层都是真实答案：无法连接后端的观测者报告 `unreachable`，无从判断的报告 `unknown`，两者都不会被四舍五入成一个猜测。若观测的 `observerId` 与产出它的观测者不匹配，那是显式报错，而不是静默填一个字段。

本包**不附带任何后端适配器**。一个诚实的适配器需要当前源码中存在以诊断节奏报告后端活动的接缝，而当前源码没有：唯一的本地模型路径是用户触发的模型列表发现，它不是健康信号。

### 错误按结构分类，而不是按文字

分类读取结构化的 provider 码或强后端失败种类。消息文本只为人类携带，不用于任何其他用途，因为从句子里推断出的类别与真正观测到的类别无法区分。没有结构化码的信号是 `UNKNOWN`。

`fatal` 仅保留给"执行无法安全继续"的证据 —— 资源上限、worker 崩溃或模型加载失败。超时、传输错误、生成停滞或取消都是 `degraded`；即使承载取消的信号本可证明更强的状况，取消也保持 `degraded`，因为用户结束一次 run 是一种结果，而不是故障。

优先级是全序的，且与到达顺序无关：证据更强者在先（持久终止、结构化执行、客户端、观测者），然后时间更早者在先。因此迟到的观测者更新无法让 run 的结果来回摆动。

-----

<a id="api"></a>
## API

```ts
import {
  activeRun,
  backendObservation,
  backendObserverId,
  classifyRunError,
  classifyRunHealth,
  clientCancelledError,
  observeBackend,
  projectRuns,
  providerErrorCode,
  reachabilityObservation,
  runDiagnostics,
  runIdFor,
  terminalRun,
  unknownBackendObservation,
} from '@deepseek-ai/dsh-agent-run-state'

import type { RunState, RunProjectionState, BackendObservation } from '@deepseek-ai/dsh-agent-run-state/types'
```

| 导出 | 作用 |
|---|---|
| `runIdFor(sessionId, turn)` | 把一个持久轮次编码为其确定性的 `RunId`；轮次非整数或从 0 起算时抛出。 |
| `projectRuns(sessionId, facts)` | 把 Stage 6 生命周期事实折叠为 `{ active, terminal }`。 |
| `activeRun(state)` / `terminalRun(state)` | 读取未关闭的 run，或最近一个已关闭的 run，二者都不合成。 |
| `runDiagnostics(input)` | 把 run 自身的诊断与后端观测合并，同时保持两个维度彼此分离。 |
| `backendObserverId(id)` | 为后端观测者的身份打上品牌标记；另一个身份构造函数，且同样校验输入。 |
| `backendObservation(input)` | 构造一个经过校验的观测；拒绝"不可用却仍带值"的来源。 |
| `unknownBackendObservation(id, at)` / `reachabilityObservation(id, at, reachability)` | 诚实的兜底：什么都没观测到，或只报告可达性而把活动留为 `unknown`。 |
| `observeBackend(observer, at)` | 执行一次拉取式 `observe()`，把抛出映射为 `unavailable` 证据，而不是 run 状态。 |
| `classifyRunError(evidence)` | 把一个失败信号分类进持久 v1 错误契约。 |
| `providerErrorCode(code)` | 把持久重试码映射为 run 错误类别，或 `UNKNOWN`。 |
| `clientCancelledError(time)` | 规范的取消错误。 |
| `classifyRunHealth(input)` | 把 run 的阶段、活动时间与主错误归纳为一个健康度判定。 |
| `RunState` / `RunProjectionState` | run 的身份、阶段、步骤、重试摘要、终止原因与错误。 |
| `BackendObservation` | `observerId`、`observedAt`、`source`、`directness`、`reachability`、`activity`。 |

`/types` 出口仅携带契约，没有运行时导入。

<a id="model-experience"></a>
## 模型体验

无，因为本包读取已提交的 Session 事实，且不注册任何提示词、schema、工具或结果文本。

#### KV Cache 影响

无；它从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **本构建中的后端观测没有适配器** —— 契约可实现且已校验，但当前源码中没有任何接缝以诊断节奏报告后端活动，因此 GGUF 后端合理地保持 `unknown`，而不是被轮询成一个编造的状态。
- **Run 身份止于轮次** —— 一个 run 就是一个轮次，所以多轮次会话有多个 run，不存在"会话级 run"的持久概念。
- **不引入持久的尝试身份** —— `LlmAttemptId` 依旧是瞬时的、非持久的，此处没有任何东西从它推导。
- **`slow` 与 `stalled` 由墙钟阈值判定** —— 分类器取用调用方的时钟，所以两个使用不同时钟的调用方可能对同一个活跃 run 的健康度产生分歧；已终止的 run 则仅凭其事实分类。
- **不新增任何 Session 事件类型** —— 此处一切都是推导出来的；需要新持久字段的消费方必须先把它加入持久日志。
- **不发布运行时不变量伴生入口，因为对持久事实的纯折叠不持有可变运行时状态**——其契约由包内测试证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 —— 点击展开</summary>

投影是不携带状态的纯折叠，这正是它可安全地每次调用重新计算、且易于推理的原因：相同的事实给出相同的结果。

本包仅用于诊断且不持久化任何东西，因此不参与持久化目录，也不需要 `docs/persistence-changes` 记录。

</details>
