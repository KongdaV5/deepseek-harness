---
description: "Development-only Desktop layer that composes the local-run diagnostics, policy, checkpoint, and compaction capabilities with an isolated IQ3_S provider."
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-dev-composition

English | [中文](README.zh.md)

## Summary

This private layer lets the source Desktop compose the Phase 2–6 local-runtime capabilities without changing a released Desktop installation or a user's normal Harness home. The trusted Desktop development launcher selects it only when `DSH_DESKTOP_DEV_COMPOSITION=phase2-6`, creates an isolated `DSH_HOME`, and routes its `local-qwen-dev` provider to the temporary IQ3_S service on port 8081. It is not an installable daily profile, and it never changes the official launcher, provider, presets, or Desktop artifact.

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

Set the exact allowlisted value before starting the source Desktop development script. The launcher creates its project, home, and Electron user-data below `apps/desktop/.desktop-build/development`; those paths are disposable and separate from the released Desktop and `$HOME/.dsh`.

```sh
DSH_DESKTOP_DEV_COMPOSITION=phase2-6 pnpm --filter @deepseek-ai/dsh-desktop run start
```

The layer selects `local-qwen-dev`, the IQ3_S GGUF model, a 65,536-token context window, and a 24,576-token output limit. A separate test process owns port 8081. This package has no supported `dsh plugin` installation path and must not be added to a daily profile.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`cordis.patch.yml` inserts the existing Run State, run policy, task checkpoint, MLX observer, reasoning policy, compaction configuration, and on-demand `/agent_run_state` command. It only supplies deployment values; the owned packages keep their state machines, classifications, projections, and waterfall listeners. The reasoning declaration names the dev provider exactly and fixes the hidden `benchmark` fixture to `xhigh` with raw-context preservation.

The Desktop launcher creates the Dev settings and two local preset fixtures. `lite-general` is visible for ordinary work; `benchmark` is resolvable but hidden from the roster. Metadata beside the settings records the source revision and route for diagnostics.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Development-only capability rows and fixed provider policy |
| [`package.json`](package.json) | Private bundle declaration and capability dependencies |
| [`../../../apps/desktop/scripts/development-fixtures.ts`](../../../apps/desktop/scripts/development-fixtures.ts) | Isolated settings, preset, and metadata writer |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop development project preparation](../../../apps/desktop/scripts/development-project.ts) — the trusted bundle-selection path.
- [Agent Run State](../../runtime-diagnostics/agent-run-state/README.md) — event-projected Run diagnostics.
- [Reasoning policy](../../runtime-diagnostics/reasoning-policy/README.md) — IQ3_S reasoning normalization and Context Pressure observation.
- [Task checkpoint](../../session/task-checkpoint/README.md) — durable task state and resume safety.

-----

<a id="model-experience"></a>
## Model Experience

### Development route and auxiliary context

#### What the model sees

The bundle itself contributes no prompt text; its `local-qwen-dev` route selects the existing IQ3_S policy and compaction components that own any model-visible context.

#### Token effect

The deployment preserves the existing 65,536-token route and xhigh-first main-work policy; only the already-owned compaction auxiliary path may use its separate low/medium request.

#### KV Cache effect

The bundle does not clear, preserve, or estimate cache state; changing reasoning effort can affect template/cache shape only through the existing backend-specific policy.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The layer is source-Desktop only** — the released Desktop does not load workspace links or this package.
- **The temporary backend is external** — the launcher does not start, stop, update, or restart it.
- **GGUF prefill is Unknown** — the composed MLX log observer has no GGUF progress source, so it does not infer prefill activity.
- **The layer is not a recovery controller** — it observes retries, cancellation, health, checkpoints, and compaction policy but does not add automatic restart or resume behavior.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The development launcher is the only supported entry point. Do not turn this private bundle into a released profile without a separate compatibility decision and artifact verification.

</details>
