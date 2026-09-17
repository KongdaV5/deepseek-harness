# Agent Note: Backend capability reasoning policy and Context Pressure observation

Status: implemented

English | [中文](2026-09-14-backend-capability-reasoning-policy.zh.md)

## Problem

A local-model configuration can request a reasoning label that the exact backend template does not accept, or confuse a launcher fallback with the value that reaches one request. It can also estimate prompt pressure from a token total that includes earlier output and then make an unsafe compaction decision. Run State records backend activity and health but does not own model-request selection or backend capability declarations.

## Decision

`@deepseek-ai/dsh-reasoning-policy` is an opt-in external Cordis service. It owns deterministic local-model reasoning selection, exact backend capability normalization, and Context Pressure observation. It uses the existing `agent/pre-step` and `agent/request` waterfalls, `TokenMeter`, Session context projections, optional task-checkpoint diagnostics, and `LocalRunDiagnosticsObserver`. The companion [compaction auxiliary policy](2026-09-14-compaction-auxiliary-policy.md) owns its separate optional request path. No Agent Loop, LLM core, Session core, client runtime, Desktop, launcher, Profile, Benchmark, retry, recovery, or checkpoint changes.

The policy's identity remains `session_id → run_id → attempt_id`. Every policy and pressure observation is associated with the current Run, is process-local, and is removed with its observer or Session. It emits no Session event and does not change durable Run lifecycle, backend health, primary/secondary errors, retry facts, cancellation facts, or terminal state.

### IQ3_S GGUF declaration

The first declaration is exact: provider route `local-qwen` and `/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf`. The live llama.cpp audit confirms request-level `none`, `low`, `medium`, and `xhigh`. `none` suppresses `reasoning_content`; `low`, `medium`, and `xhigh` render different chat-template/prompt-cache shapes. `high`, `off`, and arbitrary values are rejected by the template, while the policy accepts `off` only as an alias for `none` and normalizes user-policy `high` to `xhigh` before transport.

The declaration carries `source: gguf-live-audit` and `confidence: confirmed`. Request-level values override the tested launcher fallback `--reasoning-effort xhigh`. The meaning and consumption relationship of `--reasoning-budget 8192` remains unknown; no policy or launcher value changes. The backend declaration is replaceable: an MLX declaration may expose a different accepted set, mapping, confidence, and request-override behavior without falsifying IQ3_S capability.

### Deterministic selection and pressure

Selection precedence is user override, benchmark lock, entry-point task policy, exact route profile default, then a deterministic current-text task class or global default. A capability normalizer owns aliases, backend fallbacks, request wire values, and failure. An unsupported benchmark lock fails before provider I/O because benchmark conditions must not be silently altered. A governed provider with no exact capability also fails closed. An ungoverned provider is unchanged.

Context Pressure derives an effective prompt budget by subtracting a resolved-reasoning reserve and provider safety margin from the known context window. Complex-work and long-output increments are deterministic and capped. The existing context projection provides a projected prompt total when available. A usage-anchored token-meter total that includes past output is not used as a next-prompt estimate; pressure stays unknown. Resume-context tokens appear only when the task-checkpoint diagnostics names the same Run and are never double counted.

The classifier reports `unknown`, `normal`, `watch`, `prepare`, `compact`, or `critical`. Classification changes no threshold, max tokens, model, retry, or recovery. The separate opt-in compaction policy may consume these facts while preserving normal-request reasoning.

### Diagnostics boundary

Agent Run State gains one generic `LocalRunDiagnosticsObserver` registration. An observer can publish correlated reasoning and Context Pressure facts. The registration validates observer identity, ignores stale cuts, removes facts at disposal, and merges them only into `ctx.agentRunState.diagnostics(session)` and `/agent_run_state`. It has no lifecycle or request authority. A terminal Run remains terminal when a later diagnostics observation arrives.

The diagnostics view distinguishes requested, policy-selected, resolved, backend-default, and wire values. It reports context window, projected prompt, resume-context tokens, reserve, safety margin, effective budget, ratio, and pressure state. Unknown remains absent in the service contract and appears as `null` or `unknown` in the JSON view.

## Alternatives considered

- **Put mutable policy state in Agent Loop.** Rejected because the loop would own backend-specific capability knowledge and a second long-lived state machine. Existing waterfalls plus a transient observer keep selection external and upgradeable.
- **Treat every reasoning label as a common backend capability.** Rejected because the IQ3_S audit disproves it: `high` is invalid while `xhigh` is valid. Per-backend mappings retain truthful capability differences.
- **Infer pressure from every token-meter total.** Rejected because usage anchors can include previous response tokens. Reporting unknown preserves a safe diagnostic distinction.
- **Put compaction behavior in the normal-request policy.** Rejected because compaction uses a separate auxiliary request path; its dedicated owner is documented in the companion Agent Note.

## Verification

The unit suite covers IQ3_S aliases, unsupported-value fallback, benchmark-lock failure, task-class precedence, explicit controls, unknown governed-model failure, stable repeated selections, reserve boundaries, unknown pressure, and same-Run resume visibility. The real Loader composition mounts the service through `cordis.yml`, sends an explicit `high`, observes `xhigh` at the adapter, and reads the transient diagnostics cut. Agent Run State tests prove diagnostics overlays make no durable write and cannot replace terminal lifecycle.

## Consequences

Local GGUF requests have a truthful, auditable policy path without making MLX conform to IQ3_S semantics. Diagnostics reveal selection and pressure without adding high-frequency Session records or context pollution. Deployments must declare exact capability records and maintain them when a backend template changes. MLX capability support remains a separate audit and declaration rather than a compatibility assumption.
