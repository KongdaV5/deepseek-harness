---
description: "通过规范 Session writer 持久化 task checkpoint 与 result manifest。重启后恢复受控续接 authority。在允许续接前拒绝过期 revision、缺失的完成证据与未解决的工具结果。"
kind: package-reference
---

# @deepseek-ai/dsh-task-checkpoint

[English](README.md) | 中文

## 概述

通过规范 Session writer 持久化 task checkpoint 与 result manifest。重启后恢复受控续接 authority。在允许续接前拒绝过期 revision、缺失的完成证据与未解决的工具结果。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 Custom profile 的 bundle 组合使用；本包不拥有另一套应用启动入口。

要在输出上限结束后启用有界的进程内续跑，可将插件的 `maxAutoContinuations` 设为 `0` 到 `5`。默认值为 `0`；Custom 桌面 profile 设为 `5`。只有 `max-tokens` 结束原因会触发 follow-up，等待中的用户输入优先。每次 follow-up 都会作为单独的 user message 记录，其 chain 和 attempt 次数由 Session 投影校验。

启用后，系统提示会要求模型在大范围查看代码前创建或复用一份简洁的 Markdown 检查点，在每个阶段完成后以及预计上下文压缩或输出达到上限前更新，并在出现压缩摘要或自动续跑后读取和核对该文件。对于代码任务，检查点记录已查看文件的准确路径和行区间，并区分只读检查与实际修改，让下一阶段从未完成处继续，避免重复查看未变化的代码。提示会优先复用已有进度文件；否则仅当 `.tmp/` 已存在时才使用 `.tmp/dsh-task-progress.md`，其他情况使用工作区根目录下的 `.dsh-task-progress.md`。这是由有界轮次支持的模型指引，不保证模型一定能成功写入文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

原生事件使用 plugin:task/checkpoint 和 plugin:task/result-manifest；载荷 kind 与 version 保留领域身份。工具结果证据采用 V4 SessionSeq 坐标与原生 tool-role isError。Task 和 output revision、Session identity 及按 turn 派生的 Run identity 保持不变。注册投影拥有状态，Session 拥有持久化。进程内 admission 不恢复或回放；checkpoint revision 变化或 service 销毁使延迟 adoption 失效。

未发布 runtime invariant companion，因为所有持久写入经过既有 Session 或 ConfigEditor 校验，且本包没有可独立分歧的状态副本。

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Custom foundation ledger](../../../docs/custom-foundation.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 持久化基础

#### 模型可见内容

`buildResumeContext` 构建器为执行所有者呈现有界任务事实。它不发起模型请求；调用方在准入 token 预算内核算呈现的上下文。

#### Token 效应

不发起模型请求；呈现的继续执行上下文消耗由调用方管理的有界预算。

#### KV Cache 影响

无直接影响；此层不执行模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 传输、UI 与 task-aware compaction 执行留给 M2。旧 compaction audit 的捕获引用明确限定在保留的 V3 generation；不能授权 V4 continuation。

-----

<a id="dev-note"></a>
### 开发备注

维护者通过所属隔离测试验证 Config、持久化和释放行为。
