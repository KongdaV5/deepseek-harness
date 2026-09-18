---
description: "从已提交 Session v3 事件归一出的、仅面向持久层的 Agent 生命周期事实，供必须在不去解读上游原始载荷的前提下推理轮次与步骤边界、崩溃修复与重试链的消费方使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-agent-lifecycle-facts

[English](README.md) | 中文

## 概述

查询某个会话持久记录了哪些轮次与步骤、每一轮如何结束、某条重试链共尝试了几次，且不必依赖每个上游事件的确切载荷形状。本适配器是对已提交 Session 事件的纯折叠：传入一份日志或一段回放范围，即可读取轮次边界、终止原因、事后崩溃修复，以及重试链。它不报告 run 身份，也不报告持久的模型尝试身份，因为上游两者都不持久化；对日志中保持未关闭的轮次或步骤，它也不合成任何关闭。

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

Agent 的生命周期分散在若干由不同包写入的 Session 事件里：`turn/start` 与 `turn/end` 承载边界与终止原因，`step/start` 与 `step/end` 界定轮次内的工作，`llm/retry` 与 `llm/retry-started` 记录由 provider 路由的重试恢复。本适配器把它们归一为一份仅面向持久层的事实集，并由两处"缺席"刻意定义：不提供 run 身份，因为上游没有可供读取的权威主 Agent `RunId`；不提供持久的模型尝试身份，因为上游不把尝试 id 持久化进任何 Session 事件。

以递增序号顺序把一个 Session 日志或一段回放范围传给 `lifecycleFactsFrom(events)`，然后读取返回的事实。调用之间不缓存任何东西，因此同一段范围永远给出相等的结果。

```ts
import { lifecycleFactsFrom } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare const events: readonly SessionEvent[]

const facts = lifecycleFactsFrom(events)

facts.turns       // boundaries, terminal reason, and the steps of each turn
facts.retryChains // attempts grouped by their durable RetryId
facts.seedBoundary
```

### 折叠不合成任何东西

没有持久关闭事件的轮次或步骤保持 `open`。关闭一个因崩溃而遗留的轮次是真实的修复工作，它会向日志追加真实事件；若适配器自行推断该关闭，就会报出一份持久记录中并不存在的生命周期。因此步骤上的 `open: true` 与轮次上缺失的 `terminal` 是答案，不是空缺。

出于同样的理由，折叠对顺序敏感而对内容不敏感：按日志顺序传入事件，它不会对自己不识别的事件妄加猜测。

### 崩溃修复 vs 实时决策

上游从不实时发出 `interrupted` 终止原因。agent-loop 的 resume 与冷读都会在事后追加它，以关闭一个进程已死的轮次。`TurnLifecycleFact.repairClosure` 恰好对这种关闭事件为 `true`，这正是"用户取消了"与"我们正在读一份戛然而止的日志"之间的区别。`isRepairClosure(reason)` 对已是类型的 `TurnEndReason` 暴露同一判断。

### 重试链

共享同一个持久 `RetryId` 的每次尝试都属于同一条链，因此这条链就是"该重试延续了同一逻辑工作"的持久证据。每次尝试记录策略的从 1 开始的序号、其建模延迟，以及触发它的 provider 中立 `LlmFailure.code`；当等待结束、下一次尝试开始时出现 `startedSeq`——这正是"已执行的重试"与"在等待中被中断的重试"之间的区别。

`maxRetries` 只存在于有界的 `normal` 模式记录上——`always` 策略不设上限，报出一个上限即为凭空捏造。

### 持久尝试身份刻意恒为 null

`LlmAttemptId` 由 agent loop 内部的内存计数器生成，resume 时不恢复，因此同一值可能在一个 Session 的多个生命周期中重复出现，且永不进入已提交事件。把它作为可选字段发布，会诱使消费方把"缺失"当成"数据丢失"；因此 `durableAttemptIdentity` 就是字面量 `null`。需要持久尝试关联的消费方，必须改为从重试链归属加上轮次与步骤位置推导。

-----

<a id="api"></a>
## API

```ts
import { lifecycleFactsFrom, isRepairClosure } from '@deepseek-ai/dsh-agent-lifecycle-facts'

import type { LifecycleFacts, TurnLifecycleFact } from '@deepseek-ai/dsh-agent-lifecycle-facts/types'
```

| 导出 | 职责 |
|---|---|
| `lifecycleFactsFrom(events)` | 按递增序号顺序折叠一段事件范围，得到全部归一后的事实。 |
| `isRepairClosure(reason)` | 判断某终止原因是否为事后崩溃修复（`kind: 'interrupted'`）。 |
| `LifecycleFacts` | `seedBoundary`、`turns`、`retryChains`，以及恒为 `null` 的 `durableAttemptIdentity`。 |
| `TurnLifecycleFact` | `turn`、`startSeq`、可选的 `endSeq` 与 `terminal`、`repairClosure`、`steps`。 |
| `StepLifecycleFact` | `step`、`startSeq`、可选的 `endSeq`，以及 `open`。 |
| `RetryChainFact` / `RetryAttemptFact` | 持久 `RetryId` 链及其中的每次已安排尝试。 |
| `SeedBoundaryFact` | 最后一个 `session/end-seed` 标记，以及它是否为 fork 切口。 |
| `DurableTerminalReason` | 上游可合并扩展的 `TurnEndReason['kind']` 的别名；请按开放联合处理。 |
| `DurableRetryMode` | `'normal'` 或 `'always'`，与持久重试事件记录的一致。 |

`/types` 出口承载上述契约，不含运行时导入。

<a id="model-experience"></a>
## 模型体验

无——本适配器只读取已提交事件，不注册任何提示词、schema、工具或结果文本。

#### KV Cache 影响

无；它从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **刻意不提供 run 身份**——上游没有权威的主 Agent `RunId`；本包拒绝从轮次号、步骤号、重试计数、`LlmAttemptId` 或猜测的生命周期跨度中推断一个。
- **不提供持久尝试身份**——因没有任何 Session 事件持久化尝试 id，`durableAttemptIdentity` 恒为 `null`；请改用重试链归属与轮次/步骤位置做关联。
- **步骤按编号匹配，而非按身份**——重复的 `step/end` 关闭该编号下最新的仍打开的起点，这与持久事件标识步骤的方式一致；没有匹配起点的步骤会被忽略，而非被合成。
- **事实按调用重算**——不做缓存；想要在持续增长的日志上做增量读取的调用方，需重新折叠它所传入的范围。
- **不发布运行时不变量伴生入口，因为对事件数据的纯函数不持有可变运行时状态**——其契约由包内测试证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

折叠过程通过私有的可变视图累积，并返回与这些视图相分离的公开契约，因此调用方既无法观察到、也无法干扰上一次调用的工作状态。

本包仅用于诊断且不持久化任何内容，因此不参与持久化目录，也不需要 `docs/persistence-changes` 记录。

</details>
