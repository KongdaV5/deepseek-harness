---
description: "只读的 Run Details 传输层：一个对客户端可见的 Session 投影，组合 Stage 6 生命周期、Stage 7 run 状态、Stage 9 推理与 Stage 10 压缩的持久事实，且不臆造其中任何一项。"
kind: "package-reference"
---

# @deepseek-ai/dsh-run-details

[English](README.md) | 中文

## 概述

通过 session-projection 缝为当前客户端提供一份只读的 Run 切面，使 Run Details 面板能够呈现实时 run 状态，而不必成为第二个权威。折叠过程逐事件累积 Stage 6 生命周期事实，捕获持久的 `request/header` 与 `compaction/summary` 策略审计，并用 Stage 7 的投影、健康度分类器与 run 身份推导切面。凡是没有任何来源能够证明的取值，对应字段就缺席而非取默认值：未被观测的后端保持 `unknown`，没有任何 Run 的会话干脆报告"没有 Run"，而不是给出占位符。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是一个 **Cordis 插件，其全部内容就是一次投影注册**：不持有订阅、折叠之外不拥有状态、不发出 Session 事件，也不携带任何控制动词。注册它会向投影表加入 `runDetails` 键；投递则由该缝负责。

```ts
import { Context } from '@deepseek-ai/cordis'
import { runDetailsProjectionDefinition } from '@deepseek-ai/dsh-run-details'
// Pulls the `sessionProjections` service merge into `Context`.
import type {} from '@deepseek-ai/dsh-session-projection'

declare const ctx: Context

// In a host plugin with `inject = ['sessionProjections']`:
ctx.sessionProjections.register(runDetailsProjectionDefinition)
```

在客户端，取值通过标准投影位到达。切面是判别联合，因此空闲会话根本没有可渲染的 run 字段：

```ts
import type { RunDetailsView } from '@deepseek-ai/dsh-run-details/client'

// Supplied by the Session client's projection seat.
declare function useProjection(key: 'runDetails'): RunDetailsView | undefined

export function readRunDetails(): RunDetailsView | null {
  const details = useProjection('runDetails')
  if (details === undefined || !details.hasRun) return null   // hide, never placeholder
  // details.runId, details.phase, details.health, details.reasoning, details.compaction
  return details
}
```

### 每个字段都另有来源

本包不自行计算任何领域事实。Run 身份来自 Stage 7 的 `runIdFor(sessionId, turn)`；阶段、步骤、重试摘要与错误来自 Stage 7 对 Stage 6 事实的投影；健康度是把 Stage 7 的分类器应用于一个恒定的 `unknown` 观测；推理来自 Stage 9 的 header 读取；压缩则是 Stage 10 在 `compaction/summary` 中提交的审计。因此读者可以把任何显示值追溯回一个已提交的事件。

### 空闲是缺席，而不是一个空的 Run

在从未开启过持久轮次时返回 `hasRun: false`。已经结束的 Run 仍然是 Run，因此最近一次关闭的 Run 会以 `active: false` 作为历史提供——历史不会被误认为当前工作，两种情况都不会产出合成的 Run 对象。

### 主 run 推理与辅助推理彼此分离

主 run 的推理来自持久的 `request/header`。压缩的辅助摘要请求带有自己的推理强度，它落在 `compaction` 之下，绝不会进入 `reasoning`：把两者放进同一个字段会让读者误以为该值描述的是用户的 run。

<a id="api"></a>
## API

| 导出 | 作用 |
|---|---|
| `runDetailsProjectionDefinition` | 带默认健康度阈值的 `runDetails` 单元；注册到 `ctx.sessionProjections`。 |
| `createRunDetailsProjection(thresholds?)` | 用部署自有的 `slowAfterMs` / `stalledAfterMs` 构造该单元。 |
| `emptyRunDetailsState(sessionId)` | 供测试与诊断使用的空折叠状态。 |
| `runDetailsViewSchema` | 在离开宿主之前校验 wire 切面。 |
| `runDetailsStateSchema` | 在播种折叠之前校验持久化的折叠状态。 |
| `RUN_DETAILS_HEALTH_THRESHOLDS` | 默认阈值（30 秒 slow、120 秒 stalled）。 |
| `RunDetailsView` | `RunDetailsIdleView`（`hasRun: false`）或 `RunDetailsRunView`。 |
| `RunDetailsRunView` | `runId`、`turn`、`active`、`phase`、`health`、时间、`stepCount`、`openStep`、重试摘要、`primaryError`、`secondaryErrors`、`backend`、`reasoning`、`compaction`。 |
| `RunReasoningFacts` | 主 run 的 `requested` / `resolved`，加上 `adapterMaterialized` 与来源事件的 seq 和时间。 |
| `RunCompactionFacts` | 持久审计：策略身份、触发原因、尝试次数、受保护的切面，以及辅助推理。 |

`/types` 与 `/client` 出口只承载契约，不引入宿主侧运行时导入。

<a id="model-experience"></a>
## 模型体验

无——本单元把已提交的 Session 事件折叠为客户端只读读模型，不注册任何提示词、schema、工具或结果文本。

#### KV Cache 影响

无；它从不构建或发送请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **后端观测始终是恒定的 `unknown` 事实** —— 这条只读路径不注册任何观测器，因此可达性与活跃度保持 `unknown`，而不是从端口、进程或缺失的进度指标推断出来。若部署环境安装真实观测器，需要一条本包刻意不添加的活体读取路径。
- **进行中的压缩诊断不被传输** —— 它们按设计存放在进程内存储中，而本 wire 取值是持久化的折叠状态，因此从未持久的状态在结构上是缺席的，而不会被快照下来、日后当作持久事显示。
- **健康度由已折叠事件自身的时间戳推导经过时间** —— 切面在每个事件上重算，因此变安静的 Run 会在下一个事件上被重新分类，而不是靠定时器；若没有新事件，则保留上一次判定。
- **终止的 Run 作为历史保留** —— 切面描述活跃的 Run，或在没有活跃 Run 时描述最近一次关闭的 Run，因此已经完成工作的会话仍会提供一个 Run，而非什么都不提供。
- **不引入任何新的 Session 事件类型** —— 这里的一切都由其他阶段已有的事件推导而来。
- **未发布运行时不变量伴随物，因为该单元是对持久事实的纯折叠** —— 其契约由包内 spec 证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

折叠以投影驱动所依赖的方式保持引用稳定：一个没有改变面板所报告内容的事件会返回同一个状态，且已存储的切面保持其身份，因此变更流在真实变化之间保持安静。

持久化的折叠状态只是捷径，绝不是权威。`stateVersion` 递增或 schema 拒绝会让注册表丢弃该行并重放日志，因此这里的严格 schema 最多只会带来一次重折叠。

</details>
