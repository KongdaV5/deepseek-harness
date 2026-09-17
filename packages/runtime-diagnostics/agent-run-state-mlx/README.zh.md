---
description: "可替换的 MLX 日志与健康观察器：输出 backend-neutral Agent Run State observation，不拥有分类或恢复逻辑。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-state-mlx

[English](README.md) | 中文

## 概述

`dsh-agent-run-state-mlx` 从 MLX server 日志的当前末尾开始跟随，可选探测其 HTTP health endpoint，并把已识别事实规范化为 `LocalBackendObserver` 约定。MLX 文本解析、文件跟随和 request lifecycle 关联都封装在此 provider 内。`dsh-agent-run-state` 保持 backend-neutral，继续负责 projection、health classification、error classification 与 primary/secondary 顺序。本包只观察；绝不 retry、restart、resume、cancel、checkpoint，也不改变 reasoning 或 compaction policy。

## 目录

- [使用本包](#use-this-package)
- [观察约定](#observation-contract)
- [归属](#attribution)
- [失败证据](#failure-evidence)
- [实现地图](#implementation-map)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先挂载 backend-neutral Run State 服务，再在已知 MLX process 与 log path 的部署中显式启用此 provider。Observer 从日志当前 byte end 开始，因此历史 failure 不会污染新启动的 DSH 进程。日志暂不存在时可以稍后出现；文件被截断或 rotation 到更短文件时，follower 会安全重置。

```yaml
- name: '@deepseek-ai/dsh-agent-run-state-mlx'
  config:
    observerId: local-mlx
    logPath: /absolute/path/to/local-model.error.log
    logPollIntervalMs: 500
    healthUrl: http://127.0.0.1:8080/health
    healthPollIntervalMs: 5000
    healthTimeoutMs: 1000
    requestAttribution: unknown
    provider: local
    models:
      - /absolute/path/to/model
```

| 字段 | 必填 | 含义 |
|---|---:|---|
| `observerId` | 是 | `ctx.agentRunState` 内唯一的 observer id |
| `logPath` | 是 | MLX stdout/stderr 日志绝对路径 |
| `logPollIntervalMs` | 是 | 读取追加记录的文件 stat 间隔 |
| `healthUrl` | 否 | HTTP(S) process-health endpoint |
| `healthPollIntervalMs` | 是 | 存在 `healthUrl` 时的探测间隔 |
| `healthTimeoutMs` | 是 | 单次探测超时；失败只表示 process degraded，绝不单独表示 fatal |
| `requestAttribution` | 是 | `unknown` 或显式声明的 `exclusive-single-flight` lifecycle correlation |
| `provider` | 是 | 有资格参与关联的精确 DSH provider |
| `models` | 是 | 有资格参与关联的精确 DSH model id |

-----

<a id="observation-contract"></a>
## 观察约定

Parser 识别 MLX request access line、server/model health access line、server startup、prompt-processing progress 以及强 worker/process/model failure evidence。`Prompt processing progress: 512/15572` 这类 progress line 会产生 `prefill.current`、`prefill.total`；只有相同 total 的两个递增 sample 同时具有递增 timestamp 时才产生 speed。所有日志派生 prefill 都标记为 `source: "backend-log"`、`confidence: "provisional"`。Provider 不输出百分比或 ETA。

Progress 和已识别 failure 会推进 `lastActivityAt`；health probe 不会冒充 generation activity。`probe()` 强制执行一次即时 log-file read，使 retry 或 cancellation policy 能在决策前刷新已经写入的 evidence。Prefill 把 generation presence 标为 active/provisional；直接完成且有归属的 request 或强 fatal termination 把它标为 inactive/confirmed。Process、model、generation 组件 health 始终相互独立。成功的 `/health` response 可以把 process health 设为 healthy，但不能清除 generation fatal。Observation 保持进程内瞬态，不追加高频 Session event。

-----

<a id="attribution"></a>
## 归属

`unknown` 是安全默认值。`exclusive-single-flight` 是部署 capability 声明，不是 Run State 约束。在该模式下，provider 使用现有 `llm/stream` lifecycle 收集精确的活跃 DSH Attempt，并且只在恰好存在一个合格 Attempt 时绑定日志 request marker。所得 Attempt attribution 标记为 `source: "request-and-backend-lifecycle"`、`confidence: "provisional"`；零个、多个、provider/model 不符、auxiliary purpose、无 Run 或 Session 缺失的候选都保持 `unknown`，进入 `unattributedBackendObservations`。

绑定会为 BrokenPipe 等延迟 request-side 日志保留，并由下一条 request marker 或 backend startup 重置。未来 structured request id 可以只替换 provider 内的关联方式，不改变 `BackendObservation` 或 Run State。

-----

<a id="failure-evidence"></a>
## 失败证据

Observer 为直接观测的 process exit、worker uncaught exception、generation-thread termination、model-load failure 和 MLX Metal resource-limit 等 backend-origin terminal exception 输出结构化证据。BrokenPipe 作为非结构化 stream failure 输出。共享 classifier 因此可以保留因果顺序：cancellation 或 resource limit 保持 primary，后到的 BrokenPipe 成为 `STREAM_DISCONNECTED` secondary。

HTTP failure 只使 process health degraded。沉默、client/UI disconnect、BrokenPipe 和 healthy process endpoint 都不会变成 fatal evidence。`observeProcessExit()` 刻意独立，因为只有直接观测到 child settlement 的 process owner 才能调用它。

-----

<a id="implementation-map"></a>
## 实现地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis provider、MLX parser、lifecycle correlation、组件 observation 与可选 health probe |
| [`src/log-file.ts`](src/log-file.ts) | 从当前 EOF 开始、处理 missing/truncated file 的 append-only UTF-8 follower |
| [`src/types.ts`](src/types.ts) | 部署配置与 process-owner 输入类型 |
| [`tests/fixtures`](tests/fixtures) | 经过清理的真实机器 MLX 长 prefill、Metal resource-limit 与 BrokenPipe 回放记录 |

本包不发布运行时 invariant companion。Observer 是 source adapter，没有可供独立检查的持久关系；单元覆盖与真实 Loader 组合测试会验证 provider lifecycle 和它输出的公共约定。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 observer 只读取 backend activity，不改变模型请求。

#### KV Cache 影响

无影响。本包不修改 prompt、token、cache control 或 Session surface event。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- MLX 日志解析是实验性的。在 MLX 提供 structured callback、event、metrics 或 request id 前，文本派生 progress 和 lifecycle attribution 都保持 provisional。
- Parser 支持本文记录的已观测 `mlx-lm` 日志族；上游文本格式变化可能使 observation 退化为 unknown，但不会破坏 Run State。
- 在共享或并发 endpoint 上，日志 request marker 不能证明因果关系。除非有更强的 provider 实现，这类部署必须保持 `requestAttribution: unknown`。
- HTTP health 只覆盖 process endpoint。Generation-worker health 需要独立日志或 process-owner evidence。
- Client abort 本身不能证明 generation 已停止。没有 structured 或 log-derived disappearance signal 时，cancellation acknowledgement 保持 unconfirmed。
- 文件跟随从当前 EOF 开始，不重建历史 backend state；回放只属于测试或显式 diagnostic tool。
- 本包不分类 error，也不执行 recovery；这些职责保留在 provider 之外。

### 开发备注

<a id="dev-note"></a>

<details>
<summary>维护者工作上下文——点击展开</summary>

Identity、durability、observer、health 与 error 决策记录在 [Agent Run State projection 与 backend observer seam](../../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.zh.md)。

</details>
