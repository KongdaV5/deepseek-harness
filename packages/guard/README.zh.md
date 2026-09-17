---
description: "循环与请求安全 guard 的包映射：重复工具引导、工具调用限时，以及进度感知的本地模型恢复治理。"
kind: "package-group"
---

# guard/：循环与请求安全 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组让 agent loop 与模型请求恢复保持有界。`repeat-tool-reminder` 检测重复的相同工具调用，`timeout-policy` 执行工具声明的协作式限时，`agent-run-policy` 则利用 Agent Run State 限制本地 provider 的瞬态 retry，并在不把 AbortSignal 误当成后端终止的前提下确认 cancellation。前两个随 `dsh` 基础组合包启用；Run policy 是供已挂载 Run State 与 backend observer 的部署选择启用的组合能力。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

三个聚焦插件分别覆盖这些模式；各 README 说明其组合边界。

| 包 | 提供什么 |
|---|---|
| [`agent-run-policy/`](agent-run-policy/README.zh.md) | Probe Run State、限制瞬态模型 retry、阻止 fatal blind retry，并区分 requested 与 confirmed cancellation |
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |

-----

<a id="related-documentation"></a>
## 相关文档

先阅读相关请求或工具子系统，再进入各包的决策记录。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——两个 guard 都依赖的工具调用流水线与决策。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
- [Agent Run State 子系统](../../docs/subsystems/agent-run-state.zh.md)——`agent-run-policy` 消费的 identity、meaningful activity、backend evidence 与 diagnostics。
- [进度感知 Run 控制 Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.zh.md)——retry／cancellation policy 边界与最小 activity hook。
