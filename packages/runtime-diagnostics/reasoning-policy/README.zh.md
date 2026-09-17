---
description: "为普通和可选 compaction 请求选择已审计 reasoning，安全保留 Task facts，并暴露只读 Context Pressure diagnostics。"
kind: "package-reference"
---

# @deepseek-ai/dsh-reasoning-policy

[English](README.md) | 中文

## 概述

`dsh-reasoning-policy` 让本地模型组合只发送已经审计确认可被精确 provider/model route 接受的 reasoning 值。它对普通工作采用 xhigh-first task selection，并可选地发送 low、再 medium 的 compaction 请求以保留紧凑 Task facts。它通过 Agent Run State 展示普通请求 reasoning，并提供独立的只读 compaction diagnostic。它还会展示在明确 output reserve 与 provider safety margin 后，下一个 prompt 是否接近 context budget。本包不会改变 launcher default、retry、checkpoint 或 Profile composition；只有 deployment 显式声明时才存在 Benchmark condition。

## 目录

- [使用本包](#use-this-package)
- [IQ3_S 能力与策略](#iq3_s-capability-and-policy)
- [Context Pressure](#context-pressure)
- [诊断与实现](#diagnostics-and-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先挂载 Agent Run State、现有模型 runtime 与 token meter，再在 Agent Loop 之前挂载这一 opt-in 策略。

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

| 字段 | 必填 | 含义 |
|---|---:|---|
| `observerId` | 是 | transient diagnostics source 的唯一标识 |
| `governedProviders` | 是 | 缺少精确模型已审计声明时快速失败的 provider route |
| `capabilities` | 是 | 精确 provider/model 声明、支持值和 backend mapping |
| `globalDefault` | 是 | 没有更高优先级 control 或 task class 时的 fallback policy 值 |
| `taskPolicies` | 否 | 确定性的 `simple`、`normal`、`complex` 和 `long-output` 选择 |
| `contextPressure` | 是 | Output reserve、safety margin 和 observation threshold；不执行 compaction 动作 |
| `compaction` | 否 | 可选 low/medium auxiliary policy；`autoTrigger` 要求 `compaction-basic.auto: false` |
| `benchmarkPresets` | 否 | 非日常 benchmark preset id 的显式固定条件；普通 Profile 不会仅因名称获得此行为 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是所有接受字段的完整来源。

-----

<a id="iq3_s-capability-and-policy"></a>
## IQ3_S 能力与策略

已审计的 IQ3_S GGUF route 接受 request-level `none`、`low`、`medium` 与 `xhigh`。`none` 发送 `none` 并关闭 template reasoning。`off` 是指向 `none` 的 policy alias；它绝不会作为 `off` 到达 llama.cpp。该 template 不接受 `high`，因此本包明确把它 normalization 为 `xhigh`；使用不受支持 `high` 的 benchmark lock 会在 provider I/O 前失败，而不是静默改变 benchmark condition。受管 provider 上未声明的精确 model 同样快速失败。

显式配置的 benchmark preset 是优先于 user override 的可复现性 lock：它声明的 provider/model 必须在 provider I/O 前精确匹配，声明的 reasoning 会原样发送，不受支持的条件会 fail closed，而不是 normalization。它可要求保留 raw context，此时 automatic compaction 会拒绝。普通 Profile 名称没有 reasoning 含义。显式 benchmark lock 之外，优先级依次为 user override、entry-point task policy、精确 route profile default，随后是确定性的 task class 或 `globalDefault`。明确机械工作是 low，明确短辅助工作是 medium；Coding、分析、规划、Amazon 工作、长工作与未知用户工作都是 xhigh。Task classifier 只使用当前 user text，不调用模型。连续且未强制的 xhigh 或 medium segment 会保持同一 resolved 值；explicit control 和 simple work 会立即优先。

设置 `compaction.enabled` 后，compaction-only waterfall 在第一个 candidate 发送 `low`。若在 `dsh-compaction-basic` 配置 `maxSummaryValidationRetries: 1`，确定性的 TaskCheckpoint/Result Manifest fact check 可以请求一个 `medium` candidate；第二次失败会保留旧 context，且绝不请求 xhigh。这一局部 auxiliary choice 不会改变普通请求 segment 或 user override。

能力声明记录 audit source 与 confidence，但不把 launcher fallback 断言为 effective request 值。对于 IQ3_S，live audit 已确认 request 值会覆盖受测 launcher fallback `--reasoning-effort xhigh`；`--reasoning-budget 8192` 与 hidden reasoning consumption 的关系仍是 unknown，本包不会修改它。

-----

<a id="context-pressure"></a>
## Context Pressure

服务读取现有 token-meter 与 context projection，计算 `effectivePromptBudget = contextWindow - expectedOutputReserve - providerSafetyMargin`。它根据 projected-prompt ratio 报告 `unknown`、`normal`、`watch`、`prepare`、`compact` 或 `critical`。包含早先 response token 的 usage-anchored token-meter total 不会被当作 next-prompt estimate；在现有 projection 提供 projected prompt total 前，pressure 保持 `unknown`。

`expectedOutputReserve` 来自 resolved reasoning 值与确定性的 complex-work、long-output increment，并受 `maxReserve` 限制。只有现有 task-checkpoint diagnostics 指向同一 Run 时，策略才暴露 resume-context token；它不会再次添加该值，因为 token meter 已测量 assembled prompt。Pressure classification 本身不写入任何内容。启用 auto trigger 时，`compact` 会请求现有 executor 一次，`critical` 只有在安全 compaction 降低 pressure 后才继续；两者都不会降低普通请求 reasoning。

-----

<a id="diagnostics-and-implementation"></a>
## 诊断与实现

<details>
<summary>实现内部细节——点击展开</summary>

`ReasoningPolicyService` 观察 `agent/pre-step` 来分类当前 text，并包装现有 `agent/request` waterfall，只替换 proposal request 中的 `reasoningEffort`。它向 Agent Run State 注册一个 `LocalRunDiagnosticsObserver`。Observer 发布由当前 `run_id` 关联的进程内事实；Agent Run State 继续拥有 lifecycle、health、retry、cancellation、durable event 与 terminal state。

| 文件 | 职责 |
|---|---|
| [`src/capabilities.ts`](src/capabilities.ts) | 已审计的 IQ3_S GGUF 声明 |
| [`src/normalize.ts`](src/normalize.ts) | Backend-specific alias、fallback 和快速失败 normalization |
| [`src/task-classifier.ts`](src/task-classifier.ts) | 确定性的 task-class 规则 |
| [`src/context-pressure.ts`](src/context-pressure.ts) | 纯 reserve 与 pressure classification |
| [`src/compaction-policy.ts`](src/compaction-policy.ts) | 可选 compaction request decoration、task-fact validation 与只读 facts |
| [`src/index.ts`](src/index.ts) | Request-waterfall policy 与 transient diagnostics publisher |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | Capability、xhigh-first selection、pressure 与 normal-request diagnostics |
| [`tests/compaction-policy.spec.ts`](tests/compaction-policy.spec.ts) | Auxiliary low/medium、semantic validation、task safety 与 fail-closed 覆盖 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 证明 normal 与 compaction transport 的真实 Loader 组合 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [`dsh-agent-run-state`](../agent-run-state/README.zh.md)——durable Run projection 与 transient diagnostics owner。
- [`dsh-agent-run-policy`](../../guard/agent-run-policy/README.zh.md)——独立的 retry 与 cancellation policy。
- [`dsh-task-checkpoint`](../../session/task-checkpoint/README.zh.md)——只用于同一 Run context visibility 的 Task resume fact。
- [后端能力 reasoning 策略](../../../.agents/notes/implemented/architecture/2026-09-14-backend-capability-reasoning-policy.zh.md)——决策、audit evidence 与 trade-off。

-----

<a id="model-experience"></a>
## 模型体验

### Reasoning request control

#### What the model sees

普通请求携带已审计的 resolved `reasoningEffort` 值，不增加 prompt、tool、message 或 diagnostics text。

#### Token effect

IQ3_S request-level reasoning 会改变 llama.cpp chat-template rendering 和已测量 prompt-token total；策略保留 backend-specific behavior，而不声称跨 backend 有统一值。

#### KV Cache 影响

选定的 IQ3_S reasoning 值会改变 rendered prompt token 与 cache reuse。本策略不会 invalidate、clear 或手动 preserve cache；它报告当前 Run 可获得的 token-meter 与 projection fact。

### Compaction auxiliary request

#### What the model sees

启用的 policy 会在固定 compaction instruction 前立即添加紧凑的 `<task-runtime-facts>` message。它只含来自 TaskCheckpoint 和 Result Manifest 的 durable objective、constraint、decision、step、output、blocker 与 reference fact。不注入历史 hidden reasoning 或 raw evidence。

#### Token effect

Auxiliary request 显式发送 low，只有 deterministic validation 拒绝 low candidate 时才发送 medium。生成的 checkpoint 替换旧 model-visible history；原始 Session event、TaskCheckpoint value、manifest 与 tool evidence 仍保持 durable。

#### KV Cache 影响

Fact message 与 low/medium template 可以使用独立 cache path。它们不会改变后续 main-request reasoning 值，后者仍是其 xhigh-first policy decision。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 已发布的 capability declaration 仅覆盖精确 IQ3_S GGUF model 与已审计 llama.cpp behavior。MLX 与其他 GGUF route 需要独立声明，并可能使用不同 mapping。
- `high` 没有直接的 IQ3_S request 值。User policy 将它 normalization 为 `xhigh`；使用 `high` 的 benchmark lock 会快速失败。
- Audit 确认 request-level override 能覆盖受测 launcher effort fallback，但没有确认 launcher reasoning budget 与 hidden reasoning consumption 的量化关系。
- Context Pressure classification 是只读的。可选 trigger 只委托给现有 compaction executor；它不会降低 normal-request reasoning、改变 output cap 或改变 retry/recovery。
- Projected prompt total 可用前，pressure 可能为 `unknown`。它会保留 unknown，而不是从不兼容 usage total 推断。
- 可选 task-checkpoint read 只提供 compaction facts 与 refusal evidence。它不授权 resume，也不修改 Task state。
- benchmark lock 只为 `benchmarkPresets` 中声明的 id 存在；绝不从 preset 名称、UI 标签或当前 backend 的单并发行为推断。固定 route 不匹配会在 adapter I/O 前失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

IQ3_S capability declaration 固定到随附 Agent Note 记录的本地 live audit。MLX capability 工作仍是独立 backend audit 时，本包保持 opt-in。

</details>
