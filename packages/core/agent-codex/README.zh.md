---
description: "在 DS Harness Custom 中通过官方 ChatGPT 订阅运行 Codex 模型。需要隔离的 App Server 会话，且不使用 API-key 路由或 provider 回退时，阅读此包说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

选择官方 ChatGPT 订阅中的模型，通过 Codex App Server 运行 DSH 轮次。“自动”模式会优先使用 `/Applications/ChatGPT.app` 内签名有效且通过所需能力验证的 Codex runtime；否则使用 bundled `@openai/codex`。每个 App Server 连接只绑定一个可执行文件，模型和推理档位目录只来自该 runtime 的 `model/list`。DSH 保留用户可见的 Session 和公开对话历史；Codex 保留自己的私有执行线程和订阅登录状态。此集成不接受 API key，也不会自动回退到其他 provider。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

DS Harness Custom 桌面组合会将此 provider 与 Local 模型路由并列挂载。

### 何时选择

需要通过官方 ChatGPT 订阅运行明确选定的 Codex 模型时，选择此路由。仅需本地运行时，选择已配置的 Local provider；此路由绝不会自动切换 provider。

### 最小配置

在 Cordis 组合中挂载此包；它不接受包专属配置字段。

```yaml
- id: agent-codex
  name: '@deepseek-ai/dsh-agent-codex'
```

生成的[配置目录](../../../docs/config-catalog.zh.md)记录服务要求，并确认此条目不含 config 区块。

| 字段 | 默认值 | 含义 |
|---|---|---|
| 无 | — | 此插件不接受包专属配置。 |

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

运行时通过 stdio 管理一个官方 App Server 进程，并将其私有线程与 DSH 公开 Session 分开。模型设置卡会持久化“自动 / System Codex / Bundled Codex”选择；切换只会在当前轮次结束并启动新连接后生效。模型不在当前目录时不会触发可执行文件切换。运行时同步有界的公开历史，在模型轮次前持久化 dispatch 意图，并拒绝无法验证的工作区或审批请求。它通过有界、进程本地的 Session live-follow 窗口发布经过净化的命令、文件变更、审批和终态活动，并将其与 Local 工具调用及持久 Session 事件分开。丢失 `turn/start` 响应后，运行时会依据远端 thread 和 turn 对账；已确认的终态会在不重放的情况下解除本地 dispatch barrier，仍无法确认的轮次则继续 fail-closed 或退役其映射。Session 投影会追踪最近一次已提交的助手结果，确保重启后不会重复投递已恢复的结果。

| 源码 | 职责 |
|---|---|
| `src/index.ts` | 组合入口和声明的服务依赖。 |
| `src/runtime.ts` | 账号状态、模型发现、历史同步、轮次和审批。 |
| `src/app-server.ts` | 系统 runtime 签名身份校验、bundled 可执行文件身份和 JSON-RPC stdio 生命周期。 |
| `src/projection.ts` | 用于映射私有 Codex 线程的可忽略 Session 状态。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Core 子系统](../../../docs/subsystems/core.zh.md)
- [Agent 运行时](../agent/README.zh.md)
- [Desktop Custom 组合](../../bundle/desktop-custom/README.zh.md)
- [官方 Codex App Server 协议](https://github.com/openai/codex/tree/main/codex-rs/app-server)

-----

<a id="model-experience"></a>
## 模型体验

### 同步的公开对话历史

#### 模型看到的内容

Codex 线程会收到 DSH Session 中近期的纯文本用户消息和最终 assistant 消息；当前轮次的文本会单独发送到 `turn/start`。历史最多包含 80 条消息和 48,000 个字符；丢弃较早内容时会加入省略标记。

#### Token 影响

DSH 将有界的公开历史和当前轮次文本作为请求内容发送；不会把 DSH 提示词区块或工具 schema 加入 Codex 请求。App Server 和模型自身的上下文可能增加其他 token，因此此包无法报告精确总量。

#### KV Cache 影响

私有 Codex 线程拥有自己的 provider 上下文和缓存。工作区身份及已确认的历史游标有效时，恢复线程可保留缓存复用；同步结果不确定或身份变化后重建线程会重新发送有界历史，可能降低复用率。此包不会改变 Local provider 的缓存。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

以下约束说明此路由何时不可用或需要用户操作。

- **需要官方订阅登录** — 用户须在官方浏览器流程中完成 ChatGPT 登录；不支持 API-key 认证。
- **需要已注册的本地工作区** — Codex 线程启动前，当前 Session 必须解析到唯一规范绝对路径工作区。
- **不自动重放结果不确定的轮次** — 运行时会保留结果供协调处理，并安全失败以避免重复副作用。
- **仅转发文本输入** — 此集成不会将图像或其他非文本内容传给 Codex 轮次。
- **System Codex 经过身份与能力门禁** — 只考虑 `/Applications/ChatGPT.app` 中官方签名的 runtime；DSH 不会执行 `PATH` 中发现的 `codex`。
- **Runtime 选择以连接为边界** — 必须在轮次空闲时切换，并从新 App Server 重新加载模型/推理档位目录；重连时会再次校验系统 runtime，bundled runtime 则固定到包版本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护上下文 — 点击展开</summary>

无。

</details>
