# Agent Note: 后端能力 reasoning 策略与 Context Pressure observation

Status: implemented

[English](2026-09-14-backend-capability-reasoning-policy.md) | 中文

## Problem

本地模型配置可能请求精确 backend template 不接受的 reasoning label，或把 launcher fallback 误认为到达单个 request 的值。它还可能从包含早先 output 的 token total 估算 prompt pressure，随后作出不安全的 compaction 决策。Run State 记录 backend activity 与 health，但不拥有模型请求选择或 backend capability declaration。

## Decision

`@deepseek-ai/dsh-reasoning-policy` 是一个 opt-in 外置 Cordis 服务。它拥有确定性的本地模型 reasoning selection、精确 backend capability normalization 与 Context Pressure observation。它使用现有 `agent/pre-step` 和 `agent/request` waterfall、`TokenMeter`、Session context projection、可选 task-checkpoint diagnostics 与 `LocalRunDiagnosticsObserver`。配套的[compaction auxiliary policy](2026-09-14-compaction-auxiliary-policy.zh.md)拥有独立的可选 request path。不修改 Agent Loop、LLM core、Session core、client runtime、Desktop、launcher、Profile、Benchmark、retry、recovery 或 checkpoint。

策略 identity 保持为 `session_id → run_id → attempt_id`。每条 policy 和 pressure observation 都关联到当前 Run，保留在进程内，并随 observer 或 Session 移除。它不发出 Session event，也不改变 durable Run lifecycle、backend health、primary/secondary error、retry fact、cancellation fact 或 terminal state。

### IQ3_S GGUF declaration

第一个 declaration 是精确的：provider route `local-qwen` 和 `/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf`。Live llama.cpp audit 确认 request-level `none`、`low`、`medium` 与 `xhigh`。`none` 会抑制 `reasoning_content`；`low`、`medium` 与 `xhigh` 会渲染不同的 chat-template/prompt-cache shape。`high`、`off` 和任意值都会被 template 拒绝，而策略仅把 `off` 接受为 `none` 的 alias，并在 transport 前把 user-policy `high` normalization 为 `xhigh`。

Declaration 携带 `source: gguf-live-audit` 和 `confidence: confirmed`。Request-level 值会覆盖已测试 launcher fallback `--reasoning-effort xhigh`。`--reasoning-budget 8192` 的含义与 consumption relationship 仍是 unknown；不会改变 policy 或 launcher 值。Backend declaration 可替换：MLX declaration 可以暴露不同的接受集合、mapping、confidence 和 request-override behavior，而不会伪造 IQ3_S capability。

### Deterministic selection and pressure

Selection precedence 依次是 user override、benchmark lock、entry-point task policy、精确 route profile default，随后是确定性的 current-text task class 或 global default。Capability normalizer 拥有 alias、backend fallback、request wire value 与 failure。Unsupported benchmark lock 在 provider I/O 前失败，因为 benchmark condition 不能被静默改变。没有精确 capability 的受管 provider 也快速失败。未受管 provider 不变。

Context Pressure 通过从已知 context window 减去 resolved-reasoning reserve 与 provider safety margin 得到 effective prompt budget。Complex-work 和 long-output increment 是确定性的并受限。现有 context projection 在可用时提供 projected prompt total。包含过去 output 的 usage-anchored token-meter total 不会用作 next-prompt estimate；pressure 保持 unknown。只有 task-checkpoint diagnostics 指向同一 Run 时才显示 resume-context token，且绝不重复计数。

Classifier 报告 `unknown`、`normal`、`watch`、`prepare`、`compact` 或 `critical`。Classification 不改变 threshold、max tokens、model、retry 或 recovery。独立的 opt-in compaction policy 可以消费这些 facts，同时保持 normal-request reasoning。

### Diagnostics boundary

Agent Run State 新增一个通用 `LocalRunDiagnosticsObserver` 注册。Observer 可以发布有关联的 reasoning 与 Context Pressure fact。注册会验证 observer identity、忽略 stale cut、在 dispose 时移除 fact，并且只把它们合并到 `ctx.agentRunState.diagnostics(session)` 和 `/agent_run_state`。它没有 lifecycle 或 request authority。Terminal Run 在之后到达 diagnostics observation 时仍保持 terminal。

Diagnostics view 区分 requested、policy-selected、resolved、backend-default 与 wire 值。它报告 context window、projected prompt、resume-context token、reserve、safety margin、effective budget、ratio 与 pressure state。Unknown 在 service contract 中保持缺失，在 JSON view 中显示为 `null` 或 `unknown`。

## Alternatives considered

- **将 mutable policy state 放入 Agent Loop。** 不采用，因为 loop 会拥有 backend-specific capability knowledge 和第二个长期状态机。现有 waterfall 加 transient observer 使 selection 保持外置且可升级。
- **把每个 reasoning label 当成 common backend capability。** 不采用，因为 IQ3_S audit 已证明不成立：`high` 无效而 `xhigh` 有效。每个 backend 的 mapping 保留真实 capability 差异。
- **从每个 token-meter total 推断 pressure。** 不采用，因为 usage anchor 可能包含之前的 response token。报告 unknown 保留安全的 diagnostics 区分。
- **把 compaction behavior 放在 normal-request policy 中。** 不采用，因为 compaction 使用独立 auxiliary request path；其专用 owner 记录在配套 Agent Note 中。

## Verification

Unit suite 覆盖 IQ3_S alias、unsupported-value fallback、benchmark-lock failure、task-class precedence、explicit control、unknown governed-model failure、稳定的 repeated selection、reserve boundary、unknown pressure 与 same-Run resume visibility。真实 Loader composition 通过 `cordis.yml` 挂载服务，发送 explicit `high`，在 adapter 观察到 `xhigh`，并读取 transient diagnostics cut。Agent Run State test 证明 diagnostics overlay 不产生 durable write，也不能替换 terminal lifecycle。

## Consequences

本地 GGUF request 获得真实且可审计的 policy path，而不要求 MLX 符合 IQ3_S semantics。Diagnostics 暴露 selection 与 pressure，不添加高频 Session record 或 context pollution。部署必须声明精确 capability record，并在 backend template 变化时维护它。MLX capability support 仍是独立 audit 与 declaration，而不是 compatibility assumption。
