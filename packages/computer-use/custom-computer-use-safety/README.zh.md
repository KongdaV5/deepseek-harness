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


V1 工具呈现由 [presentation.ts](src/presentation.ts) 唯一拥有，复用官方逐 Agent 的 ToolRuntime restriction seam。CuaDriver 0.22.0 在全局发现 56 项工具；模型只接收八项：`get_accessibility_tree`、`list_windows`、`get_window_state`、`click`、`type_text`、`press_key`、`scroll` 和 `bring_to_front`。text-only Local 路由使用 `include_screenshot:false` 的结构化窗口状态与 element token。高级 browser／视觉／session 控制，以及敏感剪贴板／录制／配置／安装／重放操作均在 V1 范围外。未来未知工具默认不呈现。Host 权限控件保留完整注册表；非 CU schema 和每次 ACT 安全检查保持原样。五类已核实目录在同一 policy 源码中，不另建工具目录或 UI allowlist。

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

冻结请求保持相同 transcript 与非 CU 工具。选择八项 CU 定义后，CU schema token 从 24,018 降到 6,664，总输入从 34,157 降到 16,803（减少 50.8%）。计数使用部署中的 server template/tokenizer；cache-read token 是输入子集。观察结果仍走上游内容与图像准入。

#### KV Cache 影响

本包不管理模型 KV cache；选定 provider 决定缓存行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Host 控制接口提供脱敏状态、显式权限查询／请求、停止及仅在空闲时恢复。权限状态必须来自 canonical MCP 结果 structuredContent 中的布尔字段，可读文本不能授予访问权限。弹窗权限绑定单次用户请求的调用 ID，不使用会话标记。启动时不查询权限。查询失败保持未授权，目录不可用时报告驱动不可用。凭据必须由用户接管。剪贴板、录制、配置、安装和轨迹重放调用被排除。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
