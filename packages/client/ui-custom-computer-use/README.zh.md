---
description: "通过 Host 所有的控件查看电脑操作状态并停止桌面操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-custom-computer-use

[English](README.md) | 中文

## 概述

可选 bundle 在插件设置中挂载电脑操作标签页，并在每个可见会话输入框上方提供全局停止栏。控件使用既有 Remote 操作。启用状态仍由标准插件 bundle 列表管理。渲染进程没有独立租约或运行时管理器。

输入区状态行会明确标注“电脑操作”，并分别显示租约与全局停止状态：租约空闲不是本地运行时状态；全局停止状态则根据 Host snapshot 显示为未触发、正在停止或已触发。

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

可选 bundle 在插件设置中挂载电脑操作标签页，并在每个可见会话输入框上方提供全局停止栏。控件使用既有 Remote 操作。启用状态仍由标准插件 bundle 列表管理。渲染进程没有独立租约或运行时管理器。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

可选 UI 先通过 Gateway 挂载生成的 Computer Use Remote contribution，再向控件注入该命名空间。移除 UI 时同时释放命名空间和控件。生成的 Remote 通过包的条件导出解析：值导入使用运行时 JavaScript，类型检查使用声明文件。控件挂载期间，可释放的观察对象轮询脱敏 Host 状态。权限检查和弹窗仅由明确点击按钮触发。其他异步操作期间全局停止仍可使用。过期响应不能覆盖较新的停止结果，Host 不可用时清除过期的健康状态。

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

`computerUse.status` 控件不提供提示词、工具 schema 或会话内容；安全包和官方 provider 决定模型可见内容。

#### Token 影响

本 UI 不增加直接提示词 token。

#### KV Cache 影响

本包不管理模型 KV cache；选定 provider 决定缓存行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 现有审批界面负责动作确认，敏感输入必须手动接管。排空或污染期间恢复不可用。界面不推断权限、不读取凭据、不截屏，也不决定执行权限。移除可选 bundle 时终止轮询与尚未完成的状态发布。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
