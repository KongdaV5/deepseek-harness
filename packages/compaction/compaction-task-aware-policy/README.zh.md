---
description: "DS Harness 的任务感知压缩策略：在不变的 BasicCompactionEngine 之上叠加一个可选候选策略 —— 让持久任务权威在压缩中存活、以同步权威复检为发布闸门，并在确定性校验失败时最多只再索取一个候选。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-task-aware-policy

[English](README.md) | 中文

## 概述

在不接管压缩的前提下，让持久任务权威穿越压缩。执行器已有所属：`dsh-compaction-basic` 决定何时压缩、选取区间、计价、调用模型、校验稳定性并发布替换内容。本包不替换其中任何一行。它只挂载一个执行器可查询的可选候选策略，而它的贡献有三：最新检查点的权威被捕获为一份经规范化哈希的保护根，并以代码渲染的块原样重新发布；发布以对权威的同步复检为闸门；以及一个未通过确定性校验的候选只会被再索取一次，随后压缩即被拒绝。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是一个**插件**，且不拥有任何执行权。是否挂载是部署决策：官方 profile 不挂载任何东西，因此它的压缩行为与当前上游完全一致。

```ts
import { Context } from '@deepseek-ai/cordis'
import TaskAwareCompactionPolicy from '@deepseek-ai/dsh-compaction-task-aware-policy'

declare const ctx: Context

// Installs the optional policy that `dsh-compaction-basic` resolves.
ctx.plugin(TaskAwareCompactionPolicy)
```

一旦挂载，执行器就会解析 `ctx.compactionCandidatePolicy` 并在两处查询它：`assess` 位于任何破坏性模型上下文操作之前；`begin` 位于执行器自己的持久压缩括号已经存在之后。当执行器找不到策略时，本包不会运行任何代码，也不会新增挂起点；当它找到策略时，选取、计价、摘要、稳定性校验与发布仍然全部归执行器所有。

### Session 未跟踪 Task 时保持 fail-open

未跟踪 Task 的 Session 没有权威需要保护，因此策略会放行每一次入口、开启一个不做任何修饰且接受执行器产出结果的惰性事务，并报告一份不含保护摘要的审计。此时发布出来的替换内容与完全没有策略时执行器会发布的内容逐字节相同，而审计会如实记录这一点，而不是暗示一次并不存在的保护。

### 权威被捕获、哈希，并原样重新发布

`protectTaskAuthority` 读取一份一致的权威切面，捕获任务身份、修订号、状态、Run 身份、执行元数据、步骤划分、恢复上下文、失败与恢复记录、每一条证据身份、每一份被精确引用的结果修订，以及每一个修复隐患。该根以键排序的规范化形式序列化并哈希。由于发布的替换内容必须恰好携带该值，校验会重新解析替换内容、重新规范化载荷并比较摘要与规范化形式 —— 因此重排列表、重复块或篡改过的事实都会失败，而不会被放过。

该块是**代码渲染**的，从不由模型撰写。`decorateRequest` 以 `replacementContent` 返回它，执行器会将它原样追加在同一条替换消息里模型叙述之后。模型会通过 `supplementalMessages` 以背景信息的形式看到同样的事实，但模型必须伪造的那个块根本不在模型的输出路径上。

### 发布以实时权威为闸门，且为同步

`assertPublishable` 按契约就是同步的。它在提交替换内容的同一个不可中断块中重新读取投影、重建保护根并比较摘要，因此没有任何 `await` 会把证明与它所授权的写入分开。摘要期间发生移动的检查点修订号、被引用的结果修订、证据身份、隐患集合或主 Run 的推理事实，都会中止发布，而不是被散文掩盖过去。

### 辅助阶梯有界且诚实

辅助摘要请求在第一个候选上要求 `low` 推理、在后续候选上要求 `medium`，而从不要求主 Run 的 effort。该阶梯是恰好两级的产物不变量。在任何辅助模型调用之前，`begin` 会证明执行器声明的路由确实能够满足第一级；不能满足的路由会被拒绝，而不是被发送一个不受支持的线上取值。针对非本事务所计价路由的 `decorateRequest` 会 fail closed。

### 此处不会成为权威

策略不追加任何 Session 事件、不写任何投影、不创建任何锁、不重试任何东西、也不删除任何东西。受保护的块派生自只追加日志，而日志保留每一个原始事件，包括派生它的检查点与结果清单。它的审计作为可选字段记录在执行器既有的 `compaction/summary` 事件上，这正是让该事件对早于本包的读取方保持向后兼容的原因。

-----

<a id="api"></a>
## API

```ts
import TaskAwareCompactionPolicy, {
  AUXILIARY_REASONING_LADDER,
  TASK_AWARE_POLICY_ID,
  TASK_AWARE_POLICY_VERSION,
  TaskAwarePolicyError,
  admitTaskAware,
  canonicalJson,
  parseTaskProtectionBlocks,
  protectTaskAuthority,
  protectionDigest,
  renderTaskProtectionBlock,
  resolveAuxiliaryReasoning,
  taskProtectionContent,
  taskProtectionSupplement,
  taskRepairHazards,
  textOfContent,
  unknownOutcomeHazard,
  usableInputTokens,
  validateTaskAwareCandidate,
} from '@deepseek-ai/dsh-compaction-task-aware-policy'

import type {
  TaskAwareCompactionDiagnostics,
  TaskProtection,
  TaskProtectionSnapshot,
  TaskCandidateValidationContext,
} from '@deepseek-ai/dsh-compaction-task-aware-policy'
```

| 导出 | 作用 |
|---|---|
| `apply(ctx, config)`（默认导出） | 注册执行器所解析的 `compactionCandidatePolicy` 服务。 |
| `name` / `inject` / `Config` | 插件身份、`sessionProjections`/`taskCheckpoints`/`llm`/`tokenMeter` 注入，以及空配置 schema。 |
| `TASK_AWARE_POLICY_ID` / `TASK_AWARE_POLICY_VERSION` | 记录在每份审计中的稳定策略身份与契约版本。 |
| `protectTaskAuthority(snapshot)` | 从一份权威切面构建规范化保护根及其摘要；当切面没有 Task 或某个受保护事实无法解析时抛出 `TaskAwarePolicyError`。 |
| `protectionDigest(protection)` / `canonicalJson(value)` | 针对受保护取值的确定性摘要，以及它使用的顺序无关规范化序列化器。 |
| `renderTaskProtectionBlock(protection)` | 渲染执行器会原样发布的带分隔符的代码撰写块。 |
| `parseTaskProtectionBlocks(content)` | 把发布的替换内容重新解析为块，校验正是拿它来比较。 |
| `taskProtectionContent` / `taskProtectionSupplement` | 发布出去的替换块，以及展示给辅助模型的背景消息。 |
| `validateTaskAwareCandidate(candidate, context)` | 确定性裁决：`accept`、一次被允许的 `retry`，或携带其精确规则码的 `reject`。 |
| `admitTaskAware(input)` | 纯放行决策：障碍顺序、手动豁免，以及无 Task 时的 fail-open。 |
| `resolveAuxiliaryReasoning(provider, model, capability, attempt)` | 针对该精确路由已公布的能力解析一级阶梯。 |
| `AUXILIARY_REASONING_LADDER` | `['low', 'medium']` 这一产物不变量。 |
| `taskRepairHazards(snapshot, taskId)` / `unknownOutcomeHazard(hazards)` | 被寻址 Task 的隐患，以及其中的未知结果障碍。 |
| `usableInputTokens(contextWindow, maxTokens)` | 容量算术，下界为零。 |
| `textOfContent(content)` | 校验与计价所用的文本投影。 |
| `TaskAwarePolicyError` | 结构化拒绝，携带一个 `TaskAwareBlockCode`。 |
| `TaskAwareCompactionDiagnostics` | 瞬态的按 Session 观测，通过服务的 `diagnostics(sessionId)` 读取。 |
| `TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC` / `TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA`（[`./diagnostics-transport`](../../../packages/compaction/compaction-task-aware-policy/src/diagnostics-transport.ts)） | 本策略发布的 topic，以及该 topic 上每一帧必须重复的 schema 身份。 |
| `createTaskAwareCompactionDiagnosticsProvider(source)` / `isTaskAwareDiagnosticsSource(value)`（[`./diagnostics-transport`](../../../packages/compaction/compaction-task-aware-policy/src/diagnostics-transport.ts)） | 传输适配器：通用 runtime-diagnostics 控制器注册的 read/subscribe 面，以及判断已挂载策略能否提供该面的结构检查。 |

<a id="model-experience"></a>
## 模型体验

### 辅助压缩请求

#### 模型看到什么

摘要模型收到的是执行器逐字重放的会话前缀，外加本策略提供的一条补充用户消息 —— 对持久任务事实的散文式复述 —— 插入在执行器固定压缩指令的正前方。会话模型从不会看到这个请求，而可校验的 `task_compaction_context` 块被刻意排除在它之外：模型以背景形式看到这些事实，而不是看到那个它必须复现的块。

#### Token 影响

该补充消息为辅助请求增加一个固定、有界的块，而策略在做出任何容量声明之前会通过执行器自己的计量器为它计价：它把这笔开销从可用输入预算中预留出来，并拒绝那些受保护上下文无法容纳的放行。它从不提高执行器已解析的生成上限。

#### KV Cache 影响

重放前缀未被触碰，因此 provider 的热前缀缓存仍可复用到补充消息为止；该消息与尾部的压缩指令是仅有的未缓存输入。若策略改变了 provider、模型、工具或重放消息，它就无法作出这一断言 —— 这也正是修饰类型里没有任何字段可以表达它们的原因。

### 发布的替换内容

#### 模型看到什么

执行器发布的替换内容携带模型的叙述，并在同一条消息内追加代码渲染的 `task_compaction_context` 块，原样附在其后。该块声明它是为哪个保护哈希渲染的，并在 `[[dsh-task-authority]]` 与 `[[/dsh-task-authority]]` 哨兵之间携带受保护取值的规范化 JSON，因此理解这些分隔符的读取方无需策略的进程内状态即可重建受保护的切面。

#### Token 影响

对于给定的权威切面，该块大小固定，而执行器会拒绝任何不比它所遮蔽区间更小的替换内容，因此发布出来的候选总是相对于被替换的内容减少未来的输入历史。补充消息只计入辅助调用，从不计入会话。

#### KV Cache 影响

与任何其他压缩检查点一样，是替换而非追加：在替换区间之前未改变的请求前缀其复用得以保留，从第一个被替换的 token 起失效。受保护的块是替换内容中的最后一段内容，因此它不会新增任何自己的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **校验失败只会再索取一次，随后即拒绝** —— Custom policy 在 native transaction 内最多接纳两个 candidate；不存在第三次尝试，而耗尽预算是拒绝，而不是降级发布。
- **保护根的强度上限取决于它所读取的投影** —— Task 投影未暴露的受保护事实无法被捕获，因此捕获会以 `TASK_AUTHORITY_UNAVAILABLE` fail closed，而不是发布一个更弱的块。
- **只有在路由声明了窗口时才查询容量** —— 未计价的路由意味着策略完全不作出容量声明，该失败模式仍归执行器自己的容量错误所有。
- **辅助阶梯恰好两级** —— `low` 然后 `medium`；无法公布 `low` 的路由会在任何辅助调用之前拒绝压缩，而不是替换成一个它从未计价过的 effort。
- **策略保护的是 Session 当前跟踪的那个 Task** —— 它从不寻址其他 Task，也从不决定某个 Task 应被丢弃，因此无 Task 的 Session 是 fail-open 而非受保护的空情形。
- **不引入新的 Session 事件类型** —— 策略唯一的持久痕迹是执行器既有 `compaction/summary` 事件上的可选 `plugin:task-compaction-audit` 字段。
- **不发布运行时不变式伴随物，因为该策略只是对已折叠投影状态的读取者与闸门，它不追加任何自己的持久事实，而它做出的每个决策都是「一份权威切面加一个候选」的纯函数** —— 它的契约由纯决策矩阵以及插件与执行器规格来证明，而不是由运行时观察者证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

执行器在两处查询策略，而这两处刻意并不对称。`assess` 足够同步，因而不会在无策略路径上新增挂起点，且它运行在无模型参与的工具结果剪枝之前，因此拒绝绝不会留下一个已被收窄的表层。`begin` 返回一个活事务，其 `assertPublishable` 在类型上就是同步的 —— 这是权威复检能与替换内容追加共享同一个不可中断块的唯一办法。

`rebaseAfterOwnedRecovery` 之所以存在，是因为执行器自己的摘要错误恢复会改动源表层；策略跟随该改动，但会先复检摘要，因此一次同时移动了权威的恢复会拒绝，而不是静默地变基到已移动的事实上。

本包不新增自己的持久词汇，因此不参与持久化目录。`src/` 下的纯模块（`protection`、`validation`、`eligibility`、`reasoning`、`context`）承载决策矩阵，无需挂载任何东西即可调用；`tests/plugin.spec.ts` 拥有针对真实投影的集成证明，而 `dsh-compaction-basic` 的规格拥有「该 seam 被执行器遵守」的执行器级证明。

</details>
