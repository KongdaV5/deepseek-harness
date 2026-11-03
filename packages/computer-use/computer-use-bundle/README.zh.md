---
description: "通过现有 profile bundle 列表选择启用前台电脑操作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-computer-use-bundle

[English](README.md) | 中文

## 概述

通过现有插件界面添加此可选 bundle。它可供选择，但不包含在 Custom profile 默认启用列表中。启用后组合官方注册服务、MCP provider、Custom 安全层及最小客户端控件。停用时停止并排空所属操作，但不会清除不确定结果。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过现有插件界面添加此可选 bundle。它可供选择，但不包含在 Custom profile 默认启用列表中。启用后组合官方注册服务、MCP provider、Custom 安全层及最小客户端控件。停用时停止并排空所属操作，但不会清除不确定结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

provider 仅在明确启用 bundle 后启动 `cua-driver mcp`。子进程环境 `CUA_DRIVER_RS_PERMISSIONS_GATE=0` 只关闭自动权限引导，不跳过 macOS 授权或运行时审批。failOnStartupError:false 复用官方 MCP 重连策略，使缺失可执行文件不会阻断 Desktop 启动。profile 中是否存在 bundle 是唯一启用状态来源，没有第二个布尔开关。本 bundle 不增加持久化框架。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Custom 基础台账](../../../docs/custom-foundation.zh.md)记录产品所有权。

-----

<a id="model-experience"></a>
## 模型体验

### 运行时集成

#### 模型看到什么

可选组合通过安全包提供 `computer-use:custom-safety` 前台准入、审批和用户接管提示词；官方 provider 提供工具 schema 与结果。

#### Token 影响

启用组合会增加安全提示词与驱动工具 schema；观察结果使用上游内容及图像准入。

#### KV Cache 影响

本包不管理模型 KV cache；选定 provider 决定缓存行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 电脑操作 V1 仅支持前台 Local 轮次。Schedule 和 Codex 不受支持，也没有模型替换或桥接。默认代理模式下 macOS 权限归属 CuaDriver，用户触发的权限控件展示明确授权状态。原生资格验证及正式晋升与源码测试分开。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
