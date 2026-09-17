---
description: "Package map for loop and request-safety guards: repeat-tool guidance, tool-call time limits, and progress-informed local model recovery governance."
kind: "package-group"
---

# guard/ — loop and request-safety guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop and model-request recovery bounded. `repeat-tool-reminder` detects repeated identical tool calls, `timeout-policy` enforces tool-declared cooperative limits, and `agent-run-policy` uses Agent Run State to cap transient local-provider retries and acknowledge cancellation without mistaking AbortSignal for backend termination. The first two ship in the `dsh` base bundle; the Run policy is an opt-in composition capability for deployments that mount Run State and a backend observer.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three focused plugins cover the patterns; each README explains its composition boundary.

| Package | What it provides |
|---|---|
| [`agent-run-policy/`](agent-run-policy/README.md) | Probes Run State, caps transient model retries, blocks fatal blind retry, and distinguishes requested from confirmed cancellation |
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the relevant request or tool subsystem, then follow the package-specific decision record.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions both guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
- [Agent Run State subsystem](../../docs/subsystems/agent-run-state.md) — identity, meaningful activity, backend evidence, and diagnostics consumed by `agent-run-policy`.
- [Progress-aware Run control Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.md) — the retry/cancellation policy boundary and minimum activity hook.
