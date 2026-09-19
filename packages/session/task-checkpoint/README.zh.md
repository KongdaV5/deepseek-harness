---
description: "Session 的持久任务权威：Final Product v1 任务事件的读取兼容、其严格 schema 与纯投影、checkpoint 与 result-manifest 生产者，以及只在 Run 已真正提交后才采纳它的受保护续跑。"
kind: "package-reference"
---

# @deepseek-ai/dsh-task-checkpoint

[English](README.md) | 中文

## 概述

掌管 Session 的持久任务权威。本包把 Final Product 的两个任务事件恢复到 Session v3 词汇表中，使旧版日志可以重新载入，并用严格 schema 与纯投影折叠它们；新增版本一律经由 ignorable 追加接缝写入。它还判断未完成任务是否可以继续，并且只采纳真正已经开始的那一轮的 Run，因此任何续跑都不会预测 turn。任务状态与 Stage 7 的 run 状态彼此独立。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 Session 需要记录任务进度、发布结果清单、并在崩溃后继续未完成任务时，挂载该服务。若客户端只需*读取*这些状态，则只导入投影。

Final Product 把持久的任务进度记录为两个 Session 事件。上游移除产出它们的 run-state 子系统时，一并删除了这两个 `SessionEventMap` 声明，于是持久化读取路径不再识别它们，携带 checkpoint 的旧版 Session 完全无法读取——日志本身完好无损，读取方却以"未知的必需事件"为由拒绝它。本包先恢复该词汇，再补上这份已恢复契约所等待的写入方：单一生产者 API、resume 策略，以及把被继续的任务归属到真实 Run 的接缝。

**导入本包这一动作本身即恢复了可读性。** 两个事件通过模块合并声明进 `@deepseek-ai/dsh-session/types`，目录生成器据此收录它们，读取路径据此接纳它们。由 Final Product 写出的旧版日志可如常载入；由于读取绝不改写字节，接缝之前的版本会原样保留。

### 本包拥有什么

| 拥有 | 不拥有 |
|---|---|
| 两个 `SessionEventMap` 成员及其载荷类型 | 分配 run 身份的 run-state 子系统 |
| 能原样接纳旧版载荷的严格 zod schema | Run 本身——一个 Run 就是已提交的一轮，由 run-state 包拥有 |
| 纯折叠函数与可注册的投影定义 | Session 日志、其信封及其 v3 格式版本 |
| checkpoint 与 result-manifest 生产者，这两个事件的唯一写入方 | 后端健康、模型选择与压缩 |
| 受保护的 resume 决策与仅含待办步骤的续跑计划 | 续跑是否真的执行——由调用方依据决策行事 |

### 读取旧版日志

按常规持久化路径读取日志，事件即带类型抵达。用导出的投影折叠它们——把 `taskCheckpointProjectionDefinition` 与 `resultManifestProjectionDefinition` 注册到 `dsh-session-projection`，任务进度与结果清单由此保持为两个相互独立的权威：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-session-projection'
import {
  resultManifestProjectionDefinition,
  taskCheckpointProjectionDefinition,
} from '@deepseek-ai/dsh-task-checkpoint'

declare const ctx: Context

ctx.sessionProjections.register(taskCheckpointProjectionDefinition)
ctx.sessionProjections.register(resultManifestProjectionDefinition)
```

两个折叠都是严格的回放校验器。checkpoint 必须恰好递增一个版本，且绝不可改写其不可变身份（`sessionId`、`taskType`、`originRunId`、`createdAt`、`originalExecution`）、已完成步骤或输出引用；manifest 必须恰好递增一个版本，且不可改写其 `outputId` 身份元数据。首个违规会作为 `failure` 字符串保留在折叠状态中而非抛出，因此受损日志得到的是可诊断状态，而不是让读取中断。

在编写生产者之前，用 `assertTaskCheckpointTransition` 或 `assertResultManifestTransition` 校验候选版本：它们对候选应用同一套规则，且不改动折叠。

### 写入一个版本

所有新版本都经由该服务写入——它是这两个事件的唯一写入方，也是唯一设置 ignorable 标记的地方：

```ts
import { Context } from '@deepseek-ai/cordis'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import TaskCheckpoint from '@deepseek-ai/dsh-task-checkpoint'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TaskId, TaskResumeContext, TaskStepId } from '@deepseek-ai/dsh-task-checkpoint/types'

const ctx = new Context()
await ctx.plugin(SessionProjection)
await ctx.plugin(TaskCheckpoint)

declare const session: Session
declare const taskId: TaskId
declare const step: TaskStepId
declare const resumeContext: TaskResumeContext

const created = ctx.taskCheckpoints.createCheckpoint(session, {
  taskId,
  taskType: 'report',
  originTurn: 4,
  execution: { provider: 'deepseek', model: 'chat' },
  pendingSteps: [{ id: step, title: 'Draft the report' }],
  resumeContext,
})

created.revision   // 1 — the first durable revision of this task
```

`createCheckpoint`、`advanceCheckpoint`、`publishResultManifest` 与 `recordAcceptedResume` 是四个持久动词。它们各自先对着自己读取到的投影状态校验，再经 `Session.appendIgnorable` 追加，并返回已存储的版本。`advanceCheckpoint` 要求调用方给出它认为当前的版本，版本过期即 fail closed，因此同一版本的两个后继不可能都成为权威。`publishResultManifest` 生成单调递增的结果版本，而引用它的 checkpoint 只有在该版本已经持久之后才会被接受——不存在前向引用。

任务的步骤始终是一个自洽划分：已完成、当前与待办三者互斥，已完成的步骤绝不会被重新规划。

### 继续一个任务

`armResume` 只回答一件事：这个未完成任务能否继续，若可以，从何处继续。它返回结构化决策，类别为 `allowed`、`requires_confirmation`、`blocked` 或 `not_applicable`，并携带原因码、checkpoint 版本、它读取到的 run、步骤 id 与隐患证据。已完成、已取消、被阻塞或致命失败的任务永不被放行；工具结果未知一律需要确认；记录中的 run 与 Session 当前持久 run 不再一致时 fail closed，而不是重新解释日志。

预备（arm）本身不写入任何东西。只有当调用方真正开启新的一轮后，该决策才落为持久：服务观察已提交的 `turn/start`，从该轮派生 Run，并用那一轮真正拥有的 RunId 记录被接受的续跑。`buildResumeContext` 组装计划所携带的有界上下文，并逐项说明它省略了哪些部分，而不是静默裁剪。

### 旧版关联身份

`RunId` 与 `AttemptId` 之所以存在于持久载荷中，是因为旧版 checkpoint 携带了它们。`AttemptId` 是**不含当前权威的不透明值**：本包不生成也不解释它。`RunId` 则不再不透明——生产者通过 run-state 包自己的 `runIdFor` 从已提交的那一轮派生它，绝不自行生成、猜测或预分配。因此载荷中的 RunId 指向一个真实的轮次，且使用 run-state 包所拥有的同一套编码。

-----

<a id="api"></a>
## API

```ts
import {
  createTaskCheckpoint,
  appendTaskCheckpointUpdate,
  publishResultManifest,
  recordAcceptedResume,
  decideGuardedResume,
  buildResumeContext,
  taskCheckpointProjectionDefinition,
} from '@deepseek-ai/dsh-task-checkpoint'

import type { TaskCheckpoint, RunId, AttemptId } from '@deepseek-ai/dsh-task-checkpoint/types'
```

### 持久载荷 schema

| 导出 | 职责 |
|---|---|
| `taskCheckpointSchema` | 单个完整 checkpoint 版本的严格 schema，含 Final Product 当时执行的每一条跨字段规则。 |
| `resultManifestSchema` | 单个完整 result-manifest 版本的严格 schema。 |
| `taskCheckpointEventDataSchema` | 严格的 `{ kind: 'task/checkpoint', version: 1, checkpoint }` 信封。 |
| `resultManifestEventDataSchema` | 严格的 `{ kind: 'task/result-manifest', version: 1, manifest }` 信封。 |

### 投影

| 导出 | 职责 |
|---|---|
| `taskCheckpointProjectionDefinition` | `taskCheckpoint` 单元（`stateVersion` 为 1）：任务进度与崩溃修复隐患。 |
| `resultManifestProjectionDefinition` | `taskResults` 单元（`stateVersion` 为 1）：结果清单集合，与任务进度分离。 |
| `applyTaskCheckpointProjection(state, event)` | 把单个事件折叠进任务状态；对不属于它的事件返回同一引用。 |
| `applyResultManifestProjection(state, event)` | 把单个事件折叠进结果清单状态。 |
| `assertTaskCheckpointTransition(state, checkpoint)` | 当候选不是已知任务的下一个合法版本时抛出。 |
| `assertResultManifestTransition(state, manifest)` | 当候选不是已知输出的下一个合法版本时抛出。 |
| `emptyTaskCheckpointProjection()` / `emptyResultManifestProjection()` | 不可变的空折叠状态。 |
| `taskCheckpointProjectionSchema` / `taskCheckpointProjectionStateSchema` / `resultManifestProjectionStateSchema` / `resultManifestCollectionSchema` | 两个单元的 wire 与缓存 schema。 |

### 生产者

| 导出 | 职责 |
|---|---|
| `createTaskCheckpoint(authority, input)` | 追加新任务的版本 1，归属到某一已提交轮次的 Run。 |
| `appendTaskCheckpointUpdate(authority, update)` | 在期望版本与 Run 的 compare-and-set 下追加下一个版本。 |
| `publishResultManifest(authority, manifest)` | 追加下一个结果清单版本；引用它的 checkpoint 必须在其之后。 |
| `recordAcceptedResume(authority, input)` | 用真正开始的那一轮的 RunId 记录被接受的续跑。 |
| `TaskCheckpoint`（默认导出） | `ctx.taskCheckpoints` 服务：四个生产者的单写入方门面。 |

### Resume 策略

| 导出 | 职责 |
|---|---|
| `decideGuardedResume(input)` | 返回结构化决策而非布尔值：类别、原因码、版本、run、步骤与隐患。 |
| `buildResumeContext(checkpoint, results, options)` | 组装有界的续跑上下文，并说明每个被省略的部分。 |
| `GuardedResumeReason` | 调用方据以分支的原因词汇，从 `PENDING_ONLY` 到 `SESSION_DIVERGED`。 |

### 身份

| 导出 | 职责 |
|---|---|
| `taskIdFromString` / `taskStepIdFromString` / `taskOutputIdFromString` | 为一个已校验的规范外部身份打上品牌标记。 |
| `createTaskId()` / `createTaskOutputId()` | 生成抗碰撞的任务或输出身份。 |

本包的 `/types` 出口承载持久值契约——`TaskCheckpoint`、`ResultManifest`、`TaskStatus`、`RunErrorCode`、步骤证据联合，以及 `RunId` / `AttemptId`——不含任何运行时导入，因此只需要这些形状的聚合体不会把 schema 一并引入。

<a id="model-experience"></a>
## 模型体验

无——持久任务事件不进入模型上下文，该服务也不注册任何提示词、schema、工具或结果文本。

#### KV Cache 影响

无；这里不组装也不发送任何 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **生产者只写入策略已经放行的事实**——checkpoint 记录的是进度与继续的决定；它绝不开启、引导或取消一轮。
- **续跑只被预备，不被执行**——`armResume` 是进程内状态，在调用方开启新的一轮之前一直是惰性的，因此"预备后、开始前"崩溃不会留下需要清理的持久痕迹。
- **Run 桥需要真实提交**——服务从已提交的 `turn/start` 派生 Run，因此当生产者被要求一个从未提交的轮次时会 fail closed，而不是凭空造一个。
- **`AttemptId` 不含权威**——它只校验并往返一个旧版值，无法关联两个版本；需要持久关联的消费方应读取 checkpoint 的 `runId`。
- **服务不注册那两个折叠**——服务读取它们，但想要客户端可见任务状态的客户端必须挂载 `dsh-session-projection` 并注册两个定义。
- **不发布运行时不变量伴生入口，因为折叠不持有可变运行时状态**——它是对事件数据的纯函数，其契约由包内测试证明。
- **不修复旧版载荷**——违反规则的版本只会被报告为折叠 `failure`，绝不落盘改写，日志因此保持逐字节一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包从 Final Product v1 的序列化 schema 恢复而来，因此 schema、跨字段规则与步骤证据联合都保留原始语义，而非近似模拟。唯一刻意的偏离是 `RunId` / `AttemptId` 的拆分：原实现从如今由 run-state 包拥有的模块导入它们，因此 `src/legacy-identity.ts` 只重新实现序列化表示与品牌标记的应用。

Stage 8 补上了写入方。`src/producer.ts` 拥有四个持久动词，并用从投影读取到的显式权威来校验每一个版本——从不使用已弃用的同步读取器——因此生产者无法对着它没有观察到的状态追加。`src/resume.ts` 拥有决策与有界上下文。`src/service.ts` 是 Cordis 服务：它注册投影、暴露诊断读取，并把对已开始 Run 的采纳推迟到一个微任务，因为在发布闩锁持有期间，Session 观察者不得重入 `append`。

新版本经由 `Session.appendIgnorable`——带类型的 ignorable 追加接缝——写入。接缝之前的版本不带标记，读取时仍为必需；只有本包写入的内容才被标记为可选，因此不认识这些事件的旧读取器不会拒绝任何它以前接受的内容。

把这两个事件加入已知词汇是一项持久化变更，已在 `docs/persistence-changes/2026-09-18-restore-task-checkpoint-events.md` 中确认为 `same-version`：没有任何既有类型改变，`SESSION_FORMAT_VERSION` 仍为 3。

</details>
