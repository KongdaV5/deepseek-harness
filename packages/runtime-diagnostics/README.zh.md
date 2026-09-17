---
description: "runtime-diagnostics 组地图：针对运行中组合的包自有运行时不变式检查，供浏览本组的用户与维护者参考。"
kind: "package-group"
---

# packages/runtime-diagnostics

[English](README.md) | 中文

## 概述

runtime-diagnostics 组为 DeepSeek Harness 组合提供实时可观察性与自检。`agent-run-state` 通过现有事件和可替换 observation 投影一次用户触发 Run 的 identity、phase、health、error 与只读策略事实；`agent-run-state-mlx` 提供实验性的 MLX log 与 health observation；`reasoning-policy` 选择已审计 backend 的 reasoning 值并报告 Context Pressure，而不改变 compaction；`invariants` 对持久 event/data relationship 运行包自有检查。当组合需要解释当前工作或验证自身运行时约定，同时又不把 diagnostics 移入 agent loop 时，请使用这些包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`agent-run-state`](agent-run-state/README.zh.md) | 投影 Run/Attempt identity、activity、health 与 primary/secondary error | 注册到 `ctx.agentRunState` 与 projection key `agentRunState` |
| [`agent-run-state-mlx`](agent-run-state-mlx/README.zh.md) | 把 MLX log 与 HTTP health 事实转换为 backend-neutral transient observation | 注册到 `ctx.mlxBackendObserver`；向 `ctx.agentRunState` 提供 observation |
| [`reasoning-policy`](reasoning-policy/README.zh.md) | 选择已审计 backend 的 reasoning 值并报告只读 Context Pressure | 注册到 `ctx.reasoningPolicy`；向 `ctx.agentRunState` 提供 transient diagnostics |
| [`invariants`](invariants/README.zh.md) | 运行包自有运行时检查，并按所属包报告每次失败 | 注册到 `ctx.invariants` |

-----

<a id="related-documentation"></a>
## 相关文档

- [运行时不变式子系统](../../docs/subsystems/invariants.zh.md)——生成的服务参考：选择、installer 与配套入口约定。
- [不变式运行时约定 Agent Note](../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.zh.md)——运行时不变式可以断言什么，以及强制配套入口接线的机械门禁。
- [包约定](../AGENTS.md)——每个包都必须遵循的 `./invariant` 配套入口规则。
- [Agent Run State projection 决策](../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.zh.md)——identity、durability、observer、health 与 error 边界。
- [后端能力 reasoning 策略](../../.agents/notes/implemented/architecture/2026-09-14-backend-capability-reasoning-policy.zh.md)——IQ3_S reasoning normalization 与 Context Pressure observation。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
