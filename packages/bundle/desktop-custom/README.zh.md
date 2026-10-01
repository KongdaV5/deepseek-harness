---
description: "在 RC.2 base 和 Web bundles 上组合 Custom 配置与持久化插件。新 profile 使用 bootstrap 提供的显式 Local Huihui 默认选择。隐式组合不包含 hosted defaults、Schedule 或 Computer Use。"
kind: package-bundle
---

# @deepseek-ai/dsh-desktop-custom

[English](README.md) | 中文

## 概述

在 RC.2 base 和 Web bundles 上组合 Custom 配置与持久化插件。新 profile 使用 bootstrap 提供的显式 Local Huihui 默认选择。隐式组合不包含 hosted defaults、Schedule 或 Computer Use。

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

-----

<a id="understand-the-implementation"></a>
## 理解实现

此层挂载 Local/Codex runtime owner、task/checkpoint 与 compaction policy、diagnostic transport、Models 控件及 Run Details。它禁用 DeepSeek account/controller/UI onboarding、hosted DeepSeek/search、timer、HMR 和模型生成标题；通过既有 Config seam 禁用 native credential onboarding。Bootstrap 在官方 profile patch 中设置 provider 配置与默认模型；未初始化的组合保留未注册 sentinel，拒绝隐式执行。此层不安装可选 Schedule 或 Computer Use bundles。

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

此层不产生提示词字节。组合中的 `agent-default-model` 选择 Local Huihui；既有 Web 与 Agent 插件管理模型上下文。

#### Token 效应

零直接 token。

#### KV Cache 影响

无直接影响；此层不执行模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- M1 profile 是持久化基础。Codex 和 Local 执行、集成 Desktop 行为及最终 UI 留给 M2。

-----

<a id="dev-note"></a>
### 开发备注

维护者通过所属隔离测试验证 Config、持久化和释放行为。
