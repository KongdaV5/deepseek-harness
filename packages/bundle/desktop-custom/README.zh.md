---
description: "在 RC.2 base 和 Web bundles 上组合 Custom 配置、runtime 与持久化插件，显式默认 Local Huihui，并启用官方 Schedule bundle。Custom composition 不包含 hosted defaults 或 Computer Use。"
kind: package-bundle
---

# @deepseek-ai/dsh-desktop-custom

[English](README.md) | 中文

## 概述

在 RC.2 base 和 Web bundles 上组合 Custom 配置、runtime 与持久化插件。新 Session 默认使用 Local Huihui。Custom Desktop profile 包含官方 Schedule，可在原 Session 中创建持久提醒；hosted defaults 与 Computer Use 不进入该组合。

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

Custom Desktop profile 已包含 `@deepseek-ai/dsh-experimental-schedule-bundle`。标准 Web profile 仍需选择启用：从插件页启用该 bundle，或将它写入 `dsh.profile.bundles`。Schedule 把任务保存在 Host 数据根目录，并将到期事项投递到绑定的 Session。Host 必须运行；退出后定时器停止，下次启动时会检查错过的 occurrence。Computer Use 仍保持关闭。

-----

<a id="understand-the-implementation"></a>
## 理解实现

此层挂载 Local/Codex runtime owner、task/checkpoint 与 compaction policy、diagnostic transport、Models 控件及 Run Details。Custom composition 加入官方 Schedule bundle，同时禁用 DeepSeek account/controller/UI onboarding、hosted DeepSeek/search、不相关的 timer bundle、HMR 和模型生成标题；通过既有 Config seam 禁用 native credential onboarding。Bootstrap 在官方 profile patch 中设置 provider 配置，并将 Local Huihui 设为默认；未初始化的组合保留未注册 sentinel，拒绝隐式执行。Development/Script 预设使用共享 Standard composition：compaction 预留 8,192 token headroom、摘要最多输出 2,048 token、保留最近 10% 上下文，从而让随附的 65,536-token Local 模型在 completion reserve 被耗尽前触发压缩。自动续跑最多额外执行 5 轮。Schedule 使用 Host 所有的任务存储、Session Controller 与官方 Schedule runtime。Computer Use 不在组合中。

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

组合中的 `agent-default-model` 选择 Local Huihui。启用自动续跑后，task-checkpoint 会增加一段简短指引，要求维护并在续跑前读取 `.dsh-task-progress.md`；上下文达到压缩阈值时，会用摘要替换较早的对话范围。

#### Token 效应

一段简短的续跑指引；compaction 摘要最多输出 2,048 token。

#### KV Cache 影响

Compaction 会替换部分旧消息，因此后续请求只能在保留的前缀仍匹配时复用 KV cache。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Schedule 工具在 DSH 根 Agent 中可用，包括选择 Local 的 Session。当前官方集成没有向 Codex external turn 提供 DSH 工具的接缝，因此 Codex 自身无法创建或管理 Schedule 任务。
- Schedule 持久化并投递提醒；它不保证模型恰好执行一次或外部副作用恰好发生一次。Host 必须运行才会执行 occurrence；重启时按官方 Schedule 规则处理最近错过的 occurrence。
- 最终 release qualification 是独立步骤。Computer Use 有意保持关闭。

-----

<a id="dev-note"></a>
### 开发备注

维护者通过所属隔离测试验证 Config、持久化、Schedule 投递/恢复和释放行为。
