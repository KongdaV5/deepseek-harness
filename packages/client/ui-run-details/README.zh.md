---
description: "Web GUI 的 Run Details 界面：只读的 composer 上下文条，显示当前 Run 的身份、阶段、健康度、步骤与重试次数、推理、压缩审计与任务连续性；面向 run 诊断体验的使用者与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-run-details

[English](README.md) | 中文

## 概述

Web GUI 的 Run Details 界面只读地显示当前 Run 的身份、阶段、健康度、步骤与重试次数、主 run 的推理、最近一次持久压缩审计，以及持久任务连续性。当没有 Run 时它不渲染任何内容，因此空闲会话不会出现"Run: None"占位符；未被观测的后端显示为 `Unknown`，而不会被升级为可达、空闲或健康。该条不携带任何控件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 `ui-conversation` 以及 Run Details 传输包一起挂载；此后只要会话存在 Run，该条就会出现在 composer 上下文栈中。它只在自定义桌面风味中随行——official 客户端不受影响。

### 它显示什么

- **Run** —— 派生出的 Run id（会话与轮次），并附阶段与健康度徽标。
- **步骤 / 重试** —— 持久计数，以及仍处于打开状态的步骤。
- **后端** —— 可达性与活跃度合并为一个 `Unknown` 读数，因为这条路径没有注册观测器。
- **Run 推理** —— 持久请求头所证明的推理强度，并在适配器自行补全时加以标注。
- **压缩** —— 最近一次提交的策略审计，其辅助推理单独成行，绝不会被误认为主 run 的推理。
- **压缩进行态** —— 正在进行的压缩此刻发布的状态，来自瞬态传输；传输失败时显示分类代码和原因，而不是它最后送出的取值。
- **任务** —— 持久任务检查点的身份与状态，以及任何崩溃修复隐患。

### 它绝不会做什么

它不提供重试、恢复、取消或压缩操作。每个取值都来自宿主计算好的投影，因此该条不可能与折叠结果不一致，也不可能回写它所描述的 Run。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

Run 切面通过 `useProjection('runDetails')` 到达，任务连续性通过 `useProjection('taskCheckpoint')` 到达，进行中的压缩状态则通过对会话派生的地址调用 `useResource` 到达。两个投影都是宿主计算好的整值，资源则是宿主拥有的流，因此本包不做任何领域折叠。该 dock 条目完全不提供注入面，这正是该界面结构上只读的原因：没有可调用的动词，也没有可点击的处理器。

组件是这些读数的纯函数。当投影尚未提供值，或切面报告 `hasRun: false` 时，它返回 `null`，因此 dock 行不占空间，也不会产生占位文本。文案来自 `runDetails` locale 命名空间；除为显示而缩短 Run id 之外，每个标签与取值都只是字典查询，没有任何客户端侧的领域取值格式化。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当本条不够用时，请阅读这些页面。它们从浏览器条延伸到传输层与它所填充的插槽。

- [dsh-run-details](../../runtime-diagnostics/run-details/README.zh.md) —— 计算本条所渲染切面的宿主传输投影。
- [ui-conversation](../ui-conversation/README.zh.md) —— 声明 `conversation.input.dock` 插槽并拥有 composer。
- [Client package map](../README.zh.md) —— 相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无——该条是浏览器侧对已计算 run 诊断的只读投影，不注册提示词、schema、工具或结果文本。

#### KV Cache 影响

无；它从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前的 Run Details 界面。它们是本包的当前约束，而非 run 领域对比或任务待办。

- **后端始终显示 `Unknown`** —— 传输层不安装观测器，因此无法从该界面推断可达性与活跃度。
- **压缩进行态只与传输一样新** —— 该行渲染通用诊断传输此刻发布的内容；未挂载提供方时该行直接缺席，宿主重启后在拥有者重新发布之前读作未知，而不是显示过期状态。
- **已结束的 Run 作为历史继续显示** —— 该条描述活跃的 Run，或在没有活跃 Run 时描述最近一次关闭的 Run，因此已完成工作的会话仍会显示上一次 Run 的结局。
- **仅自定义风味** —— official 客户端不挂载本包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>

**运行时不变量：** 未发布伴随物。只有一处 Run Details dock 注册，其销毁随插件 fiber —— 每个持久取值都通过投影位到达，该条目自身不持有任何订阅。
