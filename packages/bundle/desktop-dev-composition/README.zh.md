---
description: "仅供开发版 Desktop 使用的本地运行时层：在隔离 IQ3_S provider 中组装 Run 诊断、策略、Checkpoint 与 Compaction 能力。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-dev-composition

[English](README.md) | 中文

## Summary

该私有层让源码 Desktop 在不修改已发布 Desktop 或用户日常 Harness home 的情况下组装 Phase 2–6 本地运行时能力。仅当受信任的 Desktop 开发启动器收到 `DSH_DESKTOP_DEV_COMPOSITION=phase2-6` 时才选择它，并创建隔离的 `DSH_HOME`，把 `local-qwen-dev` provider 路由到 8081 上的临时 IQ3_S 服务。它不是可安装的日常 profile，绝不修改正式 launcher、provider、preset 或 Desktop artifact。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在启动源码 Desktop 开发脚本前设置精确的 allowlist 值。启动器会在 `apps/desktop/.desktop-build/development` 下创建 project、home 与 Electron user-data；这些路径可丢弃，并且与已发布 Desktop 和 `$HOME/.dsh` 隔离。

```sh
DSH_DESKTOP_DEV_COMPOSITION=phase2-6 pnpm --filter @deepseek-ai/dsh-desktop run start
```

该层选择 `local-qwen-dev`、IQ3_S GGUF 模型、65,536 token context window 与 24,576 token output limit。独立的测试进程拥有 8081 端口。本包没有受支持的 `dsh plugin` 安装路径，也不得加入日常 profile。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`cordis.patch.yml` 插入既有 Run State、run policy、task checkpoint、MLX observer、reasoning policy、compaction 配置以及按需 `/agent_run_state` command。它只提供部署值；各能力包仍拥有自己的状态机、分类、projection 与 waterfall listener。reasoning declaration 精确命名开发 provider，并把隐藏 `benchmark` fixture 固定为 `xhigh` 且保留原始 context。

Desktop 启动器创建 Dev settings 和两个本地 preset fixture。`lite-general` 对日常工作可见；`benchmark` 可显式解析但不出现在 roster。settings 旁的 metadata 会记录 diagnostics 所需的源码 revision 与 route。

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 仅开发环境使用的 capability rows 与固定 provider policy |
| [`package.json`](package.json) | 私有 bundle declaration 与 capability dependencies |
| [`../../../apps/desktop/scripts/development-fixtures.ts`](../../../apps/desktop/scripts/development-fixtures.ts) | 隔离 settings、preset 与 metadata writer |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop development project preparation](../../../apps/desktop/scripts/development-project.ts) — 受信任的 bundle-selection 路径。
- [Agent Run State](../../runtime-diagnostics/agent-run-state/README.zh.md) — event-projected Run diagnostics。
- [Reasoning policy](../../runtime-diagnostics/reasoning-policy/README.zh.md) — IQ3_S reasoning normalization 与 Context Pressure observation。
- [Task checkpoint](../../session/task-checkpoint/README.zh.md) — durable task state 与 resume safety。

-----

<a id="model-experience"></a>
## Model Experience

### 开发 route 与辅助 context

#### What the model sees

bundle 本身不贡献 prompt text；其 `local-qwen-dev` route 选择既有 IQ3_S policy 与 compaction component，由它们拥有任何 model-visible context。

#### Token effect

部署保持既有 65,536-token route 与 xhigh-first main-work policy；只有已经归属 compaction 的 auxiliary path 可以使用独立 low/medium request。

#### KV Cache effect

bundle 不会清除、保留或估算 cache state；reasoning effort 对 template/cache shape 的影响仍只通过既有 backend-specific policy 发生。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The layer is source-Desktop only** — 已发布 Desktop 不加载 workspace link 或本包。
- **The temporary backend is external** — 启动器不会启动、停止、更新或重启它。
- **GGUF prefill is Unknown** — 已组装的 MLX log observer 没有 GGUF progress source，因此不会推断 prefill activity。
- **The layer is not a recovery controller** — 它观察 retry、cancellation、health、checkpoint 与 compaction policy，但不添加 automatic restart 或 resume 行为。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

开发启动器是唯一受支持的入口。除非另行完成兼容性决策和 artifact 验证，否则不要把这个 private bundle 变为已发布 profile。

</details>
