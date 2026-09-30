---
description: "读取和编辑 Codex 运行时偏好，不连接账户或启动 App Server。通过规范插件身份的 Session 事件恢复 thread mapping。未决 dispatch 与同步事实仍要求 reconciliation。"
kind: package-reference
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

读取和编辑 Codex 运行时偏好，不连接账户或启动 App Server。通过规范插件身份的 Session 事件恢复 thread mapping。未决 dispatch 与同步事实仍要求 reconciliation。

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

Config 以实时引用拥有 preference、authGeneration 和 authTransition。偏好修改使用 ConfigEditor，认证字段原样保留。投影验证完整 mapping 快照；codexMappingRecovery 只分类恢复义务，不授权 dispatch。本包不初始化运行时、auth-state epoch、CODEX_HOME、认证事务或账户绑定。

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

`plugin:codex/subscription-state` 元数据不进入对话历史。执行所有者决定如何同步公开消息。

#### Token 效应

零直接 token。

#### KV Cache 影响

无直接影响；此层不执行模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- App Server 执行、认证生命周期、external turn 和 catalog discovery 留给 M2。隐藏的非秘密 auth Config 字段仅供未来事务 owner 按约定写入；偏好 consumer 调用 savePreference。

-----

<a id="dev-note"></a>
### 开发备注

维护者通过所属隔离测试验证 Config、持久化和释放行为。
