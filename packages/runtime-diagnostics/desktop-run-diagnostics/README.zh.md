---
description: "开发态 Agent Run 诊断与显式 Task Resume 的版本化、终端安全 Remote 传输"
kind: "package-library"
---

# @deepseek-ai/dsh-desktop-run-diagnostics

[English](README.md) | 中文

此包是开发态 Run Details 界面的极薄 Host 到 Desktop 边界。
`DesktopRunDiagnosticsService` 读取既有 Agent Run State、Reasoning Policy 和
TaskCheckpoint diagnostics，发布版本化只读 snapshot stream。它不拥有 Run
生命周期，也不改变 retry、backend recovery、reasoning、compaction 或 Session
持久化。

Remote projection 有意只传递 `AgentRunState | null`，不传递完整 raw observer
diagnostics：未归属 backend evidence 可能包含任意错误对象。这样 UI 仍可获得
分类错误、health、identity、prefill、checkpoint 与 compaction facts，同时不会
把不安全对象带过 Desktop 边界。

`resume()` 是唯一写端点。仅由用户点击触发，并委托既有 TaskCheckpoint executor；
该 executor 在真正执行前重新验证 Resume eligibility。

## 开发态使用

本包只由
[`@deepseek-ai/dsh-desktop-dev-composition`](../../bundle/desktop-dev-composition)
挂载。配套浏览器包通过既有 Typert connection 挂载生成的 `./remote`
descriptor；不会新增 Electron IPC、renderer 文件访问或网络端口。

## Model Experience

### 终端安全 projection

#### What the model sees

`DesktopRunDiagnosticsService` 不发起 model request 或 prompt content；它只在 owner 已产生 Run、policy、checkpoint 与 compaction fact 后读取这些既有事实。

#### Token effect

versioned Remote snapshot 仅面向 browser，因此 snapshot coalescing 与 elapsed-health refresh 不添加 model-visible token 或 durable Session event。

#### KV Cache effect

transport 不改变也不估算 prompt-cache state；它只转发 upstream Run projection 已确认的 cache fact。

## Known Limitations and Deferred Work

- 这是 upstream-style projection adapter，而不是 released Desktop integration。
- 未来官方 Desktop 可采用 `DesktopRunDiagnosticsSnapshot`，而无需接手 development composition 或 UI package。
- raw unattributed backend evidence 仍按设计只留在 Host。
