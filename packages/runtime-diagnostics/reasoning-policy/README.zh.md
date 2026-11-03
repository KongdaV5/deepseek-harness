---
description: "面向 DS Harness 的能力感知推理策略：解析某个精确 provider/model 路由实际会被要求什么，保持'请求值'与'解析值'的区分，并对不支持的请求 fail-closed。"
kind: "package-library"
---

# @deepseek-ai/dsh-reasoning-policy

[English](README.md) | 中文

## 概述

在请求成形之前，回答某个精确 provider/model 路由实际会被要求什么推理设置。本包读取路由自己公布的推理能力，把*请求值*与*解析值*严格区分开，并在请求不被支持时直接拒绝，而不是静默丢弃、静默提升或猜测。解析是纯函数且全域的：任何输入都只给出两种结果之一——带着来源说明的受支持解析，或一个明确说明为何无法满足的原因。它是库，无插件入口、无 Session 事件、不持久化任何状态。

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

它的能力输入就是当前上游适配器已经为某个精确 provider/model 路由公布的 `LlmResolvedModelInfo.reasoning`。不存在第二份能力数据库，也不存在仓库自有的推理等级枚举，因为将要序列化该请求的适配器本就已是该路由接受什么的唯一权威。

```ts
import {
  resolveReasoning,
  requireResolvedReasoning,
  applyReasoningResolution,
  taskReasoningMetadata,
} from '@deepseek-ai/dsh-reasoning-policy'
import type { LlmCallConfig, LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

declare const modelInfo: LlmResolvedModelInfo
declare const requested: ReasoningEffortId | undefined
declare const baseCallConfig: LlmCallConfig

const resolution = resolveReasoning({
  provider: modelInfo.provider,
  model: modelInfo.id,
  requested,
  capability: modelInfo.reasoning,
})

// Fail closed before any request is proposed: an unsupported effort throws
// here, at the policy boundary, instead of depending on a backend rejection.
const config = applyReasoningResolution(baseCallConfig, requireResolvedReasoning(resolution))

taskReasoningMetadata(resolution)
// { requestedReasoning?: 'high', resolvedReasoning?: 'medium' }
```

### 请求值不是解析值

本包存在的全部理由就是这一个区分。*请求值*是任务、profile 或调用方提出的等级；*解析值*是该精确路由能够接受、且请求实际会携带的等级。解析绝不会仅因为某个等级被请求就把它报告为已解析，调用方也总能看出三者中的哪一个来源提供了它：

- `request` —— 请求提出的等级正是路由所公布的，原样使用；
- `provider-default` —— 请求未提出任何等级，因此使用路由声明的默认值；
- `omitted` —— 请求未提出任何等级，且路由未声明默认值，因此请求确实不携带任何推理偏好。

`omitted` 是一个真实答案，而不是缺失的答案。报告一个从未被发送的默认值，等于宣称 provider 从未收到过的设置。

### 不被支持的请求是终态，而非可恢复

路由无法满足的请求解析为 `kind: 'unsupported'`，其中保留所请求的值、路由*确实*公布的值集合，以及两个原因之一：`route-declares-no-reasoning` 或 `effort-not-offered`。既不降级、也不提升，更不会形成任何请求。`requireResolvedReasoning` 是 fail-closed 的桥：它抛出携带 `UNSUPPORTED_REASONING_EFFORT_CODE` 的 `ReasoningPolicyError`，让非法配置在策略边界暴露，而不是变成 provider 的意外。

### 能力是被校验的，而不是被信任的

公布推理能力的路由必须公布它自己声明的默认等级。若某个能力的 `defaultEffort` 不在其公布的 `efforts` 之内，那就是自相矛盾的配置，会抛出 `INVALID_CAPABILITY`，而不是被四舍五入成一个解析结果。能力读取一律经由 `reasoningCapabilityOf`、`advertisedReasoningEfforts` 与 `advertisesReasoningEffort`，使"是否属于公布集合"在任何地方都以同一方式回答。

-----

<a id="api"></a>
## API

```ts
import {
  advertisedReasoningEfforts,
  advertisesReasoningEffort,
  applyReasoningResolution,
  reasoningCapabilityOf,
  reasoningMetadataFromHeader,
  requireResolvedReasoning,
  resolveReasoning,
  ReasoningPolicyError,
  taskReasoningMetadata,
  UNSUPPORTED_REASONING_EFFORT_CODE,
} from '@deepseek-ai/dsh-reasoning-policy'

import type { ReasoningCapability, ReasoningPolicyInput, ReasoningResolution } from '@deepseek-ai/dsh-reasoning-policy/types'
```

| 导出 | 作用 |
|---|---|
| `resolveReasoning(input)` | 把一个精确路由与一个可选请求解析为受支持或不受支持的结论；对不受支持的等级绝不抛出。 |
| `requireResolvedReasoning(resolution)` | 返回受支持的解析，否则在策略边界抛出 `ReasoningPolicyError`。 |
| `applyReasoningResolution(config, resolved)` | 把解析出的等级写入调用配置，并先清除任何继承来的等级，使未被请求的值无法泄漏。 |
| `reasoningCapabilityOf(model)` | 从已解析的 model info 读取上游能力，或返回 `undefined`。 |
| `advertisedReasoningEfforts(capability)` / `advertisesReasoningEffort(capability, effort)` | 读取公布集合，或判定某个等级是否在集合内。 |
| `taskReasoningMetadata(resolution)` | 产出持久任务执行记录可以如实携带的两个字段（`requestedReasoning`、`resolvedReasoning`）。 |
| `reasoningMetadataFromHeader(header)` | 读取 `adapterDefaults.reasoningEffort` 把 epoch header 拆成请求值与解析值，避免把适配器物化的值报告为调用方请求。 |
| `ReasoningPolicyError` / `UNSUPPORTED_REASONING_EFFORT_CODE` | fail-closed 错误及其携带的代码。 |
| `ReasoningCapability` / `ReasoningPolicyInput` / `ReasoningResolution` | 能力契约、一次解析输入，以及解析联合类型。 |

`/types` 出口只承载契约，不产生任何运行时导入。

<a id="model-experience"></a>
## 模型体验

间接地，通过它校验进 `dsh-llm` 请求的逐次调用推理字段。

#### KV Cache 影响

推理等级作为请求参数传输，而不属于被缓存的提示词前缀，因此保留、清除或替换它只改变 provider 被要求做什么，不会使可复用的前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **解析的如实程度取决于适配器提供的能力** —— 公布不完整 `reasoning` 块的路由会被原样反映，因此错误的能力应在适配器修正，而不是在此处补偿。
- **不引入仓库自有的推理等级** —— 等级依旧是上游的 `ReasoningEffortId` 品牌，因此本包无法表达 provider 未曾声明的等级。
- **本包不把策略接入请求组装** —— 组合必须在自己的接缝处调用 `resolveReasoning` 与 `applyReasoningResolution`，因为本库不挂载插件入口、不安装监听器。
- **不做任何能力缓存或发现** —— 每次调用都读取调用方提供的能力，因此不存在需要与适配器同步、需要失效的第二份存储。
- **适配器物化的默认值只报告为解析值，绝不报告为请求值** —— `reasoningMetadataFromHeader` 读取 `adapterDefaults.reasoningEffort` 来完成该拆分，因此丢失该事实的 header 事后无法再被分离。
- **不发布运行时不变量伴生入口，因为解析是其输入的纯全域函数、且本包不持有任何可变运行时状态** —— 其契约由包内测试证明，而不是由运行时观测器证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 —— 点击展开</summary>

解析是 `(provider, model, requested, capability)` 的纯函数，这正是它可以在请求存在之前安全调用、且可廉价重新推导的原因：相同的输入给出相同的解析。

本包不新增任何持久词汇，因此不参与持久化目录，也不需要 `docs/persistence-changes` 记录。它的 `TaskReasoningMetadata` 字段名与已恢复的 v1 `TaskExecutionMetadata` 契约完全一致，因此生产者可直接展开，无需翻译。

</details>
