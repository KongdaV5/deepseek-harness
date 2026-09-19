---
description: "面向 DS Harness 的有界轮内重试策略：在既有按 provider 路由的重试执行器之前架设 fail-closed 闸门，初始尝试之后最多两次自动重试，取消与致命类别永不重试。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-policy

[English](README.md) | 中文

## 概述

约束 harness 已经具备的重试机制，而不替换它。本插件在 agent loop 的 `agent/request-error` waterfall 上安装一个最外层监听器，只决定既有执行器是否可继续：初始尝试之后最多两次自动重试；取消或致命类别不重试；当没有任何现行契约把某个失败命名为可重试时，给出拒绝而非猜测。被允许的重试停留在同一个 Session、轮次、`RunId` 与步骤内。它不新增 Session 事件，也从不调用受保护恢复（guarded resume）。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**插件**，但不拥有任何执行。当前源码已经拥有轮内重试：`dsh-llm-retry` 在 waterfall 上恢复失败，provider 适配器拥有 `retryPolicy`，每次被安排的重试在等待之前就已持久。本包不替换其中任何一行。

```ts
import { Context } from '@deepseek-ai/cordis'
import * as agentRunPolicy from '@deepseek-ai/dsh-agent-run-policy'

declare const ctx: Context

// Installs the decision listener; omission of the config allows the product maximum.
ctx.plugin(agentRunPolicy)
// or: ctx.plugin(agentRunPolicy, { maxRetryCount: 1 })
```

当策略放行时，执行器仍会应用它自己的代码资格判定、自己的预算、自己的退避、自己的重试身份，以及自己持久化的 `llm/retry` 事件。当策略拒绝时，它从 waterfall 返回 `undefined`，因此不会安排任何尝试，也不会写入任何重试事件。

### 上限是产品不变量，不是可调参数

`MAX_AUTOMATIC_RETRIES` 为 `2`，`MAX_AUTOMATIC_ATTEMPTS` 为 `3`：最长自动链是 `初始尝试 + 重试 1 + 重试 2`。该上限计的是*重试次数*，绝不是尝试次数，所以两次重试等于三次尝试。部署方 `Config.maxRetryCount` 可以下调上限——最低到 `0`，即完全关闭自动轮内重试——但永远不能上调；越界值会在任何监听器安装之前 fail-closed。该上限同样叠加在 `always` provider 策略之上，因此即便某个适配器自己未声明任何限制，也无法产生更长的自动链。

### 取消与致命类别永不重试

判定顺序是固定的，且每一步都基于结构化证据而非文字：

- 被中止的信号即 `CANCELLED` —— 用户结束一个 run 是结果，不是故障；
- 致命失败，包括已经附着到 run 上的致命主错误，即 `FATAL_FAILURE`；
- 已关闭或轮次不匹配即 `RUN_NOT_RETRYABLE`，因为轮内重试需要一个打开的轮次作为运行空间；
- 本策略永不自动重试的类别即 `NO_RETRY_CATEGORY`；
- 没有任何现行契约命名为可重试的失败即 `NO_STRUCTURED_RETRYABILITY`，直接拒绝，而不是假定其为瞬时故障；
- 预算耗尽即 `RETRY_BUDGET_EXHAUSTED`。

### 可重试性是读取的，不是推断的

可重试性来自捕获到的 provider 策略加上 Stage 7 类别。在 `normal` 模式下，失败必须携带该策略自身可重试集合中列出的代码；在 `always` 模式下，一个非 `UNKNOWN` 的结构化类别，或一个默认瞬时代码，即已足够。从不读取消息文本，因此从句子推断出的类别永远不会被误认为被观测到的类别。

### 预算是持久的，监听器是可处置的

某个精确轮次与步骤已记录的自动重试次数，是由已提交的 `llm/retry` 事件折叠成的 Session 投影，因此该计数能跨越重启存活，而不是停留在进程内的计数器里。卸载插件会移除投影单元并处置监听器；仍持有它的 waterfall 回调会解析为 `undefined`，而不是基于已拆除的上下文继续判定。

-----

<a id="api"></a>
## API

```ts
import {
  AGENT_RUN_RETRY_BUDGET_KEY,
  MAX_AUTOMATIC_ATTEMPTS,
  MAX_AUTOMATIC_RETRIES,
  boundedRetryProjectionDefinition,
  decideBoundedRetry,
  retryCountFor,
} from '@deepseek-ai/dsh-agent-run-policy'

import type { BoundedRetryProjectionState } from '@deepseek-ai/dsh-agent-run-policy'
import type {
  RetryDecision,
  RetryDecisionInput,
  RetryDenyReason,
  RetryPermitReason,
} from '@deepseek-ai/dsh-agent-run-policy/types'
```

| 导出 | 作用 |
|---|---|
| `apply(ctx, config)` | 安装有界重试监听器并注册持久预算单元；`maxRetryCount` 越界时抛出。 |
| `name` / `inject` / `Config` | 插件身份、`sessionProjections` 注入，以及校验过的部署上限 schema。 |
| `decideBoundedRetry(input)` | 纯决策函数：一个结构化失败进，一个 `delegate` 或 `deny` 结论出。 |
| `MAX_AUTOMATIC_RETRIES` / `MAX_AUTOMATIC_ATTEMPTS` | `2` 次重试的上限，以及它蕴含的 `3` 次尝试链。 |
| `boundedRetryProjectionDefinition` / `AGENT_RUN_RETRY_BUDGET_KEY` | 折叠已提交 `llm/retry` 事件的投影单元，以及读取其状态的键。 |
| `BoundedRetryProjectionState` | 该预算所描述的步骤的 `{ turn, step, retries, turnOpen }`。 |
| `retryCountFor(state, turn, step)` | 已记录的重试次数；当预算描述的是另一个步骤时返回 `0`。 |
| `RetryDecision` / `RetryDecisionInput` | 决策联合类型及其结构化输入；输入没有消息文本字段，也没有后端字段。 |
| `RetryDenyReason` / `RetryPermitReason` | 六个拒绝原因与唯一一个放行原因。 |

`/types` 出口只承载契约，不产生任何运行时导入。

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-llm-retry` 所拥有的重新投递请求。

#### KV Cache 影响

拒绝重试不写入任何事件、也不重新发送任何内容；放行则重新发送由执行器从持久历史重建的同一个显式 provider/model 请求，因此可复用的提示词前缀在两种情况下都不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **可重试性的强度取决于捕获到的 provider 策略** —— 适配器从未分类的失败会携带 `NO_STRUCTURED_RETRYABILITY` 并被拒绝，所以一个确实瞬时、但没有任何契约命名的失败，在它自己的契约出现之前不会被自动重试。
- **上限计的是重试次数，不是尝试次数** —— 上限是初始尝试之后两次重试，即共三次尝试；命名是有意为之，以免该数字被误读为两次。
- **压缩与上下文溢出归 Stage 10 所有** —— 上下文溢出失败在此被拒绝而非恢复，因为恢复它是后续阶段的决定，本策略绝不自行扩展该职责。
- **不引入任何后端健康度依赖** —— 无法被观测的本地后端无法改变重试是否被允许，输入上也不存在可达性字段。
- **本策略只管自动轮内重试** —— 跨 run 的延续是受保护恢复，本插件从不调用、也从不记录它。
- **不新增任何 Session 事件类型** —— 它读取的重试事实都是上游已经写入的，持久预算是它们的投影而非一条新记录。
- **不发布运行时不变量伴生入口，因为决策是一个结构化失败加上已折叠投影状态的纯函数，且插件不持有任何可变策略状态** —— 其契约由策略与插件测试证明，而不是由运行时观测器证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 —— 点击展开</summary>

决策是一个结构化失败加上已折叠预算的纯函数，这正是它可以在执行器被要求行动之前在 waterfall 内同步运行的原因。

本包不新增任何自有持久词汇——预算由既有 `llm/retry` 事件推导而来——因此不参与持久化目录，也不需要 `docs/persistence-changes` 记录。唯一允许直接读取已提交事件的地方是插件测试，它承担集成证明。

</details>
