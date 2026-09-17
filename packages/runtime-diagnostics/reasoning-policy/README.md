---
description: "Select audited reasoning for normal and opt-in compaction requests, preserve task facts during safe compaction, and expose read-only Context Pressure diagnostics."
kind: "package-reference"
---

# @deepseek-ai/dsh-reasoning-policy

English | [中文](README.zh.md)

## Summary

`dsh-reasoning-policy` lets a local-model composition send only reasoning values that an exact provider/model route has been audited to accept. It uses xhigh-first task selection for normal work, and can opt in to low then medium compaction requests that preserve compact task facts. It shows normal-request reasoning through Agent Run State and exposes a separate read-only compaction diagnostic. It also reports whether the next prompt approaches the context budget after an explicit output reserve and provider safety margin. The package never changes launcher defaults, retry, checkpoints, or Profile composition; a Benchmark condition exists only when the deployment explicitly declares one.

## Table of Contents

- [Use this package](#use-this-package)
- [IQ3_S capability and policy](#iq3_s-capability-and-policy)
- [Context Pressure](#context-pressure)
- [Diagnostics and implementation](#diagnostics-and-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount Agent Run State, the existing model runtime and token meter, then this opt-in policy before Agent Loop.

```yaml
- name: '@deepseek-ai/dsh-agent-run-state'
  config:
    slowAfterMs: 300000
    stalledAfterMs: 600000

- name: '@deepseek-ai/dsh-reasoning-policy'
  config:
    observerId: local-iq3s-policy
    governedProviders: [local-qwen]
    capabilities:
      - provider: local-qwen
        model: /Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf
        supported: [none, low, medium, xhigh]
        aliases: { off: none }
        fallbacks: { high: xhigh }
        wireValues: { none: none, low: low, medium: medium, high: high, xhigh: xhigh }
        requestOverrideSupported: true
        backendDefault: xhigh
        confidence: confirmed
        source: gguf-live-audit
    globalDefault: xhigh
    taskPolicies: { simple: low, normal: medium, complex: xhigh, long-output: xhigh }
    contextPressure:
      providerSafetyMargin: 4096
      reserve: { none: 1024, low: 2048, medium: 6144, high: 8192, xhigh: 12288 }
      complexReserve: 2048
      longOutputIncrement: 4096
      maxReserve: 16384
      thresholds: { watch: 0.55, prepare: 0.7, compact: 0.8, critical: 0.9 }
    compaction: { enabled: true, autoTrigger: false, preserveBenchmarkContext: true }
    benchmarkPresets:
      - preset: benchmark
        provider: local-qwen
        model: /Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf
        reasoning: xhigh
        preserveRawContext: true

- name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: false
    maxSummaryValidationRetries: 1
```

| Field | Required | Meaning |
|---|---:|---|
| `observerId` | yes | Unique identity for the transient diagnostics source |
| `governedProviders` | yes | Provider routes that fail closed when their exact model lacks an audited declaration |
| `capabilities` | yes | Exact provider/model declarations, supported values, and backend mappings |
| `globalDefault` | yes | Fallback policy value when no higher-priority control or task class applies |
| `taskPolicies` | no | Deterministic `simple`, `normal`, `complex`, and `long-output` selections |
| `contextPressure` | yes | Output reserves, safety margin, and observation thresholds; no compaction action |
| `compaction` | no | Opt-in low/medium auxiliary policy; `autoTrigger` requires `compaction-basic.auto: false` |
| `benchmarkPresets` | no | Explicit fixed conditions for non-routine benchmark preset ids; no ordinary Profile acquires this behavior by name |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for accepted fields.

-----

<a id="iq3_s-capability-and-policy"></a>
## IQ3_S capability and policy

The audited IQ3_S GGUF route accepts request-level `none`, `low`, `medium`, and `xhigh`. `none` sends `none` and disables template reasoning. `off` is a policy alias for `none`; it never reaches llama.cpp as `off`. `high` is not accepted by this template, so this package explicitly normalizes it to `xhigh`; a benchmark lock using unsupported `high` fails before provider I/O rather than silently changing the benchmark condition. An undeclared exact model on a governed provider also fails closed.

An explicitly configured benchmark preset is a reproducibility lock ahead of user override: its declared provider/model must exactly match before provider I/O, its declared reasoning is sent unchanged, and an unsupported condition fails closed rather than normalizing it. It may require raw context, in which case automatic compaction refuses it. No ordinary Profile name has a reasoning meaning. Outside an explicit benchmark lock, priority is user override, entry-point task policy, exact route profile default, then deterministic task class or `globalDefault`. Clear mechanical work is low and clear short supporting work is medium; coding, analysis, planning, Amazon work, long work, and unknown user work are xhigh. The task classifier uses only the current user text and does not call a model. A continuing unforced xhigh or medium segment retains the same resolved value; an explicit control and simple work take precedence immediately.

When `compaction.enabled` is set, the compaction-only waterfall sends `low` on its first candidate. A deterministic TaskCheckpoint/Result Manifest fact check may request one `medium` candidate when `maxSummaryValidationRetries: 1` is configured on `dsh-compaction-basic`; a second failure retains the old context and never requests xhigh. This local auxiliary choice neither changes the normal request segment nor the user override.

The capability declaration records the audit source and confidence. It does not assert that a launcher fallback is the effective request value. For IQ3_S, the live audit confirmed that a request value overrides the tested launcher fallback `--reasoning-effort xhigh`; the relationship between `--reasoning-budget 8192` and hidden reasoning consumption remains unknown and this package does not modify it.

-----

<a id="context-pressure"></a>
## Context Pressure

The service reads the existing token-meter and context projection to calculate `effectivePromptBudget = contextWindow - expectedOutputReserve - providerSafetyMargin`. It reports `unknown`, `normal`, `watch`, `prepare`, `compact`, or `critical` from the projected-prompt ratio. A usage-anchored token-meter total that contains earlier response tokens is not treated as a next-prompt estimate; pressure remains `unknown` until the existing projection supplies a projected prompt total.

`expectedOutputReserve` comes from the resolved reasoning value plus deterministic complex-work and long-output increments, capped by `maxReserve`. The policy exposes resume-context tokens only when the existing task-checkpoint diagnostics names the same Run; it does not add the value again because the token meter already measures the assembled prompt. Pressure classification itself writes nothing. With the opt-in auto trigger, `compact` asks the existing executor once and `critical` fails closed unless a safe compaction lowers pressure; neither state lowers normal-request reasoning.

-----

<a id="diagnostics-and-implementation"></a>
## Diagnostics and implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ReasoningPolicyService` observes `agent/pre-step` to classify current text and wraps the existing `agent/request` waterfall to replace only `reasoningEffort` in the proposed request. It registers one `LocalRunDiagnosticsObserver` with Agent Run State. The observer publishes process-local facts keyed by the current `run_id`; Agent Run State retains ownership of lifecycle, health, retry, cancellation, durable events, and terminal state.

| File | Role |
|---|---|
| [`src/capabilities.ts`](src/capabilities.ts) | Audited IQ3_S GGUF declaration |
| [`src/normalize.ts`](src/normalize.ts) | Backend-specific alias, fallback, and fail-closed normalization |
| [`src/task-classifier.ts`](src/task-classifier.ts) | Deterministic task-class rules |
| [`src/context-pressure.ts`](src/context-pressure.ts) | Pure reserve and pressure classification |
| [`src/compaction-policy.ts`](src/compaction-policy.ts) | Optional compaction request decoration, task-fact validation, and read-only facts |
| [`src/index.ts`](src/index.ts) | Request-waterfall policy and transient diagnostics publisher |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | Capability, xhigh-first selection, pressure, and normal-request diagnostics |
| [`tests/compaction-policy.spec.ts`](tests/compaction-policy.spec.ts) | Auxiliary low/medium, semantic validation, task safety, and fail-closed coverage |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Real Loader composition proving normal and compaction transport |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-agent-run-state`](../agent-run-state/README.md) — durable Run projection and transient diagnostics owner.
- [`dsh-agent-run-policy`](../../guard/agent-run-policy/README.md) — separate retry and cancellation policy.
- [`dsh-task-checkpoint`](../../session/task-checkpoint/README.md) — Task resume facts used only for same-Run context visibility.
- [Backend capability reasoning policy](../../../.agents/notes/implemented/architecture/2026-09-14-backend-capability-reasoning-policy.md) — decision, audit evidence, and trade-offs.

-----

<a id="model-experience"></a>
## Model Experience

### Reasoning request control

#### What the model sees

The normal request carries the audited resolved `reasoningEffort` value and no added prompt, tool, message, or diagnostics text.

#### Token effect

IQ3_S request-level reasoning can change llama.cpp chat-template rendering and the measured prompt-token total; the policy preserves backend-specific behavior instead of claiming one cross-backend value.

#### KV Cache effect

The selected IQ3_S reasoning value can change rendered prompt tokens and cache reuse. The policy does not invalidate, clear, or manually preserve a cache; it reports the token-meter and projection facts that are available for the current Run.

### Compaction auxiliary request

#### What the model sees

An enabled policy adds a compact `<task-runtime-facts>` message immediately before the fixed compaction instruction. It contains only durable objective, constraints, decisions, step, output, blocker, and reference facts available from TaskCheckpoint and Result Manifest. Historical hidden reasoning and raw evidence are not injected.

#### Token effect

The auxiliary request explicitly sends low, or medium only after deterministic validation rejects the low candidate. The resulting checkpoint replaces old model-visible history; original Session events, TaskCheckpoint values, manifests, and tool evidence remain durable.

#### KV Cache effect

The fact message and low/medium template may use a distinct cache path. They do not change the following main-request reasoning value, which remains its xhigh-first policy decision.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shipped capability declaration covers only the exact IQ3_S GGUF model and audited llama.cpp behavior. MLX and other GGUF routes require separate declarations and may use different mappings.
- `high` has no direct IQ3_S request value. User policy normalizes it to `xhigh`; a benchmark lock with `high` fails fast.
- The audit confirms request-level override of the tested launcher effort fallback, but not a quantitative relation between the launcher reasoning budget and hidden reasoning consumption.
- Context Pressure classification is read-only. The optional trigger delegates only to the existing compaction executor; it never lowers normal-request reasoning, changes an output cap, or alters retry/recovery.
- Pressure may be `unknown` before a projected prompt total is available. Unknown is retained rather than inferred from an incompatible usage total.
- The optional task-checkpoint read supplies compaction facts and refusal evidence only. It does not authorize resume or modify Task state.
- A benchmark lock exists only for an id declared in `benchmarkPresets`; it is not inferred from a preset name, a UI label, or the current backend's single-concurrency behavior. A fixed route mismatch fails before adapter I/O.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The IQ3_S capability declaration is pinned to the local live audit captured by the accompanying Agent Note. The package stays opt-in while MLX capability work remains a separate backend audit.

</details>
