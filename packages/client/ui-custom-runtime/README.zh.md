---
description: "在 Models 设置中查看 Local 模型健康状态与 Codex 订阅状态。启动或切换已安装的 Local text profile，并停止其 owned serving resource。选择已验证的 Codex runtime，或显式开始登录操作。不可用 observation 替换旧状态，永不触发 cloud fallback。"
kind: package-reference
---

# @deepseek-ai/dsh-client-ui-custom-runtime

[English](README.md) | 中文

## 概述

在 Models 设置中查看 Local 模型健康状态与 Codex 订阅状态。启动或切换已安装的 Local text profile，并停止其 owned serving resource。选择已验证的 Codex runtime，或显式开始登录操作。不可用 observation 替换旧状态，永不触发 cloud fallback。

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

使用 Custom composition，将本 Client contribution 挂载到官方 Models footer。选择可用的确切 text profile；不可用 profile 与未验证 System runtime 选项保持禁用。改变 runtime preference 不改变 account ownership。认证控件始终要求显式用户操作。 Local card 标识 Host 提供的当前 profile 与 modality。启动／切换、停止与显式重启均调用已有 Host controller；只有 Host 确认可安全停止时才提供该 profile 的重启入口。

本地运行时状态行复用同一份 Host snapshot，分别显示已禁用、不可用、已停止、启动中、就绪、停止中和错误；运行时也会显示当前 profile。电脑操作在单独的状态行中明确标注租约与全局停止；租约空闲不代表本地运行时已停止。此卡片不增加轮询定时器。

Codex card 展示 Host 提供的 runtime 与 account state、所选 runtime source/version、runtime selection note 和动态 model count。两个可用的 usage window 均包含已用百分比、时长与重置时间。缺少 quota information 时保持不可用；不会改变 routing 或推断连接健康状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

Object layer RuntimeSettingsModel 读取两个脱敏 Remote status owner，发布完整 observation。Generation retirement 拒绝延迟 read，单个 operation gate 串行化用户 interaction。Renderer 绑定的 observable hook 将 Host Context、runtime state machine 与命令式 subscription 留在组件外。Local 与 Codex controller 保留唯一 mutation ownership。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Models 设置](../ui-settings-models/README.zh.md)
- [Local runtime owner](../../boot/custom-foundation/README.zh.md)
- [Codex runtime owner](../../core/agent-codex/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### Runtime 集成

#### 模型看到什么

控件不注册 prompt、tool schema 或 conversation text。`session.selectModel` selection 与 provider owner 决定模型请求。

#### Token 影响

本包不直接添加 prompt token；选定 execution 与 request assembly owner 决定 token 用量。

#### KV Cache 影响

本包不保存模型 KV cache；选定 provider 拥有 cache 行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Native window layout 与 installed runtime 行为需要 M3 qualification。
- Read join 没有自动 polling timer；connection reset、adapter invalidation、action 完成与显式 refresh 获取新状态。
- Original Qwen 是 text profile；image inventory 在此不作为 inference route。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

源码测试使用隔离 runtime owner 和显式 Remote operation。迁移 ledger 将真实 smoke 限制与 fixture 证据分别记录。

</details>
