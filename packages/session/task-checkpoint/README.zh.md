---
description: "Final Product v1 任务权威的读取兼容层：恢复的两个持久 Session 事件、其严格 schema 与纯投影，面向读取旧版 Session 的维护者，以及将来折叠它们的消费方。"
kind: "package-library"
---

# @deepseek-ai/dsh-task-checkpoint

[English](README.md) | 中文

## 概述

读取 Final Product 会话记录的 task 进度与结果清单，并将它们折叠为当前状态。导入本包即把两个持久任务事件恢复到 Session v3 词汇表中，因此携带它们的旧版日志可以重新载入，而不再被拒；随后由严格 schema 原样校验每个版本。当客户端需要看到任务状态时，注册导出的两个投影定义。本包不持有服务、不提供生产者、不授予任何 run 权威，因此当前构建不会写入这两个事件。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有实时状态。

Final Product 把持久的任务进度记录为两个 Session 事件。上游移除产出它们的 run-state 子系统时，一并删除了这两个 `SessionEventMap` 声明，于是持久化读取路径不再识别它们，携带 checkpoint 的旧版 Session 完全无法读取——日志本身完好无损，读取方却以"未知的必需事件"为由拒绝它。本包只恢复该词汇：不恢复 run 权威、不提供生产者、不含 resume 策略。

**导入本包这一动作本身即恢复了可读性。** 两个事件通过模块合并声明进 `@deepseek-ai/dsh-session/types`，目录生成器据此收录它们，读取路径据此接纳它们；不涉及挂载步骤、配置项或组合变更。随后由 Final Product 写出的日志可如常载入；由于本包不提供生产者，当前任何构建都不会写入这两个事件。

### 恢复了什么，没恢复什么

| 已恢复 | 未恢复 |
|---|---|
| 两个 `SessionEventMap` 成员及其载荷类型 | 分配 `RunId` 与 `AttemptId` 的 run-state 子系统 |
| 能原样接纳旧版载荷的严格 zod schema | 任何写入方：本包中 `Session.append('task/checkpoint', …)` 没有生产者 |
| 纯折叠函数与可注册的投影定义 | 任何 resume 策略——这里既不授权也不阻止 resume |
| `TaskId`、`TaskStepId`、`TaskOutputId` 构造器 | 逻辑上的 harness `RunId`（属于后续架构决策） |

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

### 旧版关联身份

`RunId` 与 `AttemptId` 只为让旧版载荷通过校验而存在。它们是**不含当前 run 权威的不透明值**：本包不分配、不派生、不解释它们，也不导出它们的构造器。它们既不是进程内的 `LlmAttemptId`，也不是逻辑上的 harness run 身份。

-----

<a id="api"></a>
## API

```ts
import {
  taskCheckpointSchema,
  taskCheckpointProjectionDefinition,
  applyTaskCheckpointProjection,
  emptyTaskCheckpointProjection,
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

### 身份

| 导出 | 职责 |
|---|---|
| `taskIdFromString` / `taskStepIdFromString` / `taskOutputIdFromString` | 为一个已校验的规范外部身份打上品牌标记。 |
| `createTaskId()` / `createTaskOutputId()` | 生成抗碰撞的任务或输出身份。 |

本包的 `/types` 出口承载持久值契约——`TaskCheckpoint`、`ResultManifest`、`TaskStatus`、`RunErrorCode`、步骤证据联合，以及 `RunId` / `AttemptId`——不含任何运行时导入，因此只需要这些形状的聚合体不会把 schema 一并引入。

<a id="model-experience"></a>
## 模型体验

无——恢复的两个事件都是 log-only，本包不注册任何提示词、schema、工具或结果文本。

#### KV Cache 影响

无；这里不组装也不发送任何 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅做读取兼容**——事件被恢复为已知词汇与可折叠状态；没有任何组件写入它们，在 run-state 架构决策落地前也没有此计划。
- **`RunId` / `AttemptId` 不含权威**——它们只校验并往返一个旧版值，无法关联两个版本；需要持久 run 关联的消费方必须从 checkpoint 自身的 `taskId` 与版本推导。
- **两个折叠不在此处注册**——本包只导出定义；想要客户端可见任务状态的组合必须挂载 `dsh-session-projection` 并注册它们。
- **不发布运行时不变量伴生入口，因为折叠不持有可变运行时状态**——它是对事件数据的纯函数，其契约由包内测试证明。
- **不修复旧版载荷**——违反规则的版本只会被报告为折叠 `failure`，绝不落盘改写，日志因此保持逐字节一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包从 Final Product v1 的序列化 schema 恢复而来，因此 schema、跨字段规则与步骤证据联合都保留原始语义，而非近似模拟。唯一刻意的偏离是 `RunId` / `AttemptId` 的拆分：原实现从已不存在的 `@deepseek-ai/dsh-agent-run-state` 导入它们，因此 `src/legacy-identity.ts` 只重新实现序列化表示与品牌标记的应用。

把这两个事件加入已知词汇是一项持久化变更，已在 `docs/persistence-changes/2026-09-18-restore-task-checkpoint-events.md` 中确认为 `same-version`：没有任何既有类型改变，`SESSION_FORMAT_VERSION` 仍为 3。

</details>
