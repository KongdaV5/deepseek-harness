---
description: "通过官方 App Server 订阅路径运行显式选定的 Codex 模型。从活动 runtime 发现可用模型，并保持 DSH conversation history 的 canonical 地位。恢复私有 thread mapping，不重复 uncertain dispatch。Runtime preference 变化保留 authentication generation，并拒绝替换活动 turn。"
kind: package-reference
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

通过官方 App Server 订阅路径运行显式选定的 Codex 模型。从活动 runtime 发现可用模型，并保持 DSH conversation history 的 canonical 地位。恢复私有 thread mapping，不重复 uncertain dispatch。Runtime preference 变化保留 authentication generation，并拒绝替换活动 turn。

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

使用 Custom profile composition 与 Models 订阅控件。Verified System discovery 和固定 Bundled runtime 提供显式 auto/system/bundled 选项。不接纳 API key 替代或 hosted fallback。Account 或选定 model 不可用时明确失败；reconnect 不代表 login，也不授权 replay。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

Codex Config 拥有 runtime preference、authGeneration 和 pending auth transition marker。只有 transaction owner 通过 ConfigEditor 更新 lifecycle 字段；generic Settings 只暴露 preference。CodexSubscriptionRuntime 拥有 child、process local epoch、lease、account transaction 与私有 thread protocol。Canonical plugin qualified Session snapshot 保存 thread binding 与 reconciliation obligation；原生 assistant settlement 证明 answer delivery。External AgentLoop seam 将 DSH turn/cancellation/history ownership 留给 native driver。State leaf face 为 format catalog 提供纯 projection type，不把 Host Context 引入 Client contract。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Custom foundation ledger](../../../docs/custom-foundation.zh.md)
- [AgentLoop](../agent-loop/README.zh.md)
- [Session foundation](../session/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### Runtime 集成

#### 模型看到什么

External runtime 接收当前用户请求，并在私有 thread 需要 bootstrap 时接收有界 canonical public history。`plugin:codex/subscription-state` mapping metadata 与脱敏 activity 不属于 conversation message。接纳 external route 后跳过 Local prompt 与工具组装。

#### Token 影响

创建私有 thread 时，有界 public history bootstrap 消耗 context token。App Server 报告实际 turn 用量；mapping 与 diagnostic metadata 不增加 token。

#### KV Cache 影响

本包不保存模型 KV cache；选定 provider 拥有 cache 行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 未决 remote outcome 在 authoritative thread/turn reconciliation 成功前阻止 replay。
- 真实 inference 需要已经认证的 dedicated Codex home；源码 fixture 从不检查或复制凭据。
- Native packaged discovery、persistence restart 与 installed lifecycle 仍是 M3 evidence obligation。
- 不发布 runtime invariant companion；canonical Session validation 与 transaction owner test 检查 lifecycle，不引入第二份可变 observer。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

源码测试使用隔离 runtime owner 和显式 Remote operation。迁移 ledger 将真实 smoke 限制与 fixture 证据分别记录。

</details>
