---
description: "以前台 Local 模式启用电脑操作，并提供唯一桌面所有者、审批和 Host 停止。"
kind: "package-reference"
---

# @deepseek-ai/dsh-custom-computer-use-safety

[English](README.md) | 中文

## 概述

在可选电脑操作 bundle 中，将本包与官方注册服务及 MCP provider 一起使用。观察工具采用经过核实的精确只读目录，未知工具视为动作。每次变更均通过既有审批，因为输入工具名称不能可靠判定高风险意图。Schedule 和 Codex 路由被拒绝。

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

在可选电脑操作 bundle 中，将本包与官方注册服务及 MCP provider 一起使用。观察工具采用经过核实的精确只读目录，未知工具视为动作。每次变更均通过既有审批，因为输入工具名称不能可靠判定高风险意图。Schedule 和 Codex 路由被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

唯一的 Host 根内存租约跨 bundle 重载保留。根 Session 与轮次标识所有者，经过核实的子 Agent 共享此所有者。停止会拒绝新调用、取消进行中的操作，并在排空后释放。排空超时或已派发动作失败／被取消会污染租约；恢复不能清除污染。重启 Host 和驱动前必须确认旧操作已终止并检查桌面。本包不持久化租约、待执行物理动作、权限或截图。

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

- Host 控制接口提供脱敏状态、显式权限查询／请求、停止及仅在空闲时恢复。弹窗权限绑定单次用户请求的调用 ID，不使用会话标记。启动时不查询权限。查询失败保持未授权，目录不可用时报告驱动不可用。凭据必须由用户接管。剪贴板、录制、配置、安装和轨迹重放调用被排除。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
