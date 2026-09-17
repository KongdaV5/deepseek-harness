---
description: "The runtime-diagnostics group map: package-owned runtime invariant checks for live compositions, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/runtime-diagnostics

English | [中文](README.zh.md)

## Summary

The runtime-diagnostics group provides live observability and self-checking for DeepSeek Harness compositions. `agent-run-state` projects one user-triggered run's identity, phase, health, errors, and read-only policy facts from existing events plus replaceable observations; `agent-run-state-mlx` supplies experimental MLX log and health observations; `reasoning-policy` selects an audited backend reasoning value and reports Context Pressure without changing compaction; `invariants` runs package-owned checks over durable event and data relationships. Use these packages when a composition should explain its current work or verify its own runtime contracts without moving diagnostics into the agent loop.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`agent-run-state`](agent-run-state/README.md) | Projects Run/Attempt identity, activity, health, and primary/secondary errors | registers on `ctx.agentRunState` and projection key `agentRunState` |
| [`agent-run-state-mlx`](agent-run-state-mlx/README.md) | Converts MLX log and HTTP health facts into backend-neutral transient observations | registers on `ctx.mlxBackendObserver`; contributes to `ctx.agentRunState` |
| [`reasoning-policy`](reasoning-policy/README.md) | Selects an audited backend reasoning value and reports read-only Context Pressure | registers on `ctx.reasoningPolicy`; contributes transient diagnostics to `ctx.agentRunState` |
| [`invariants`](invariants/README.md) | Runs package-owned runtime checks and reports each failure by owning package | registers on `ctx.invariants` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Runtime invariants subsystem](../../docs/subsystems/invariants.md) — the generated service reference: selection, installer, and companion contract.
- [Invariant runtime contracts Agent Note](../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.md) — what a runtime invariant may assert and the mechanical gate enforcing companion wiring.
- [Package conventions](../AGENTS.md) — the `./invariant` companion rule every package follows.
- [Agent Run State projection decision](../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.md) — identity, durability, observer, health, and error boundaries.
- [Backend capability reasoning policy](../../.agents/notes/implemented/architecture/2026-09-14-backend-capability-reasoning-policy.md) — IQ3_S reasoning normalization and Context Pressure observation.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
