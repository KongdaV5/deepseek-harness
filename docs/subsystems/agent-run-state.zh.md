# Agent Run State

[English](agent-run-state.md) | 中文

[dsh-agent-run-state](../../packages/runtime-diagnostics/agent-run-state) 是可选的 runtime-diagnostics 服务（`ctx.agentRunState`）：它从现有 Session event 投影一次用户触发的 Run，并在读取时合并进程内 assistant stream 与 backend observation。它独立于粗粒度 `AgentStatus`，不拥有 recovery policy，也不需要修改 agent loop。

源码：[`packages/runtime-diagnostics/agent-run-state/src/index.ts`](../../packages/runtime-diagnostics/agent-run-state/src/index.ts)

## 身份与投影

Identity hierarchy 是 Session → Run → Attempt。Session 是长期 conversation；一个正整数 Session turn 确定性标识一个 Run；step 与 attempt ordinal 标识一次实际模型请求。Retry 增加 Attempt ordinal，并保持 Run 不变。Backend attribution 指向精确 Run、精确 Attempt 或正式的 `unknown`；无法解析的 observation 不会根据 concurrency assumption 自动归属。

客户端可见的 `agentRunState` projection 包含最新 Run 的 durable cut。现有 turn、step、request、assistant、tool、retry 与 compaction event 提供生命周期事实。`AgentRunDiagnostics` 在不新增高频 Session event 的前提下合并 transient activity、run-control 与只读 policy fact。`LocalBackendObserver` 是可替换 provider contract；其可选 `probe()` 在决策前刷新当前可获得的证据。`LocalRunControlObserver` 提供 retry/cancellation display fact，`LocalRunDiagnosticsObserver` 提供没有 lifecycle authority 的有关联 reasoning/context fact，`DiagnosticsListener` 接收 activity-driven diagnostics cut。

## MLX observation 与 diagnostics

可选的 [MLX provider](../../packages/runtime-diagnostics/agent-run-state-mlx/README.zh.md) 跟随新增日志记录，并可选探测 HTTP health。它只输出 `BackendObservation`；MLX 解析与 provisional request correlation 不进入本子系统的 state 或 classifier。日志派生 prefill 标记为 `backend-log`/`provisional`。Attempt attribution 同样是 provisional，并且只在部署声明 exclusive single-flight endpoint、同时恰好一个合格 DSH Attempt 与 MLX request marker 重叠时建立；所有歧义都保持 `unknown`。

可选的 `@deepseek-ai/dsh-agent-run-state/command` plugin 通过 `/agent_run_state` 提供 host-side 合并 diagnostics 只读 JSON view。其中包括 last meaningful activity、stale threshold、retry current/max/reason，以及 requested/confirmed/unconfirmed cancellation timestamp。持久 wire projection 保持不变，Desktop presentation 不属于本子系统当前约定。

## 分类边界

Health 区分 `unknown`、`healthy`、`slow`、`stalled`、`degraded` 与 `fatal`。Stall 规则是 `now - lastMeaningfulActivityAt > stalledAfterMs`；Run 总耗时可以产生 `slow`，绝不会产生 `stalled`。Assistant reasoning/text、tool event 与有归属且持续推进的 backend progress 会刷新 meaningful activity；diagnostics read 与 health polling 不会。Process、model 与 generation health 保持独立，因此 healthy process 无法掩盖 fatal generation worker。Fatal error 需要强结构化 backend evidence、结构化 fatal code，或已识别的 backend-origin resource-limit/OOM signature。Primary error 会保留，后续 signal 保持为 secondary。Classification 永远不会触发 retry、restart、resume、cancellation、checkpoint 或 policy change。

## 可选 Run control policy

[`dsh-agent-run-policy`](../../packages/guard/agent-run-policy/README.zh.md) 是位于本 observation service 之上的独立 guard。它在受管 request-error decision 前 probe observer，把瞬态 transport/provider retry 限制为零至二次，并拒绝对 fatal 或永久 failure 原样重试。现有 `dsh-llm-retry` plugin 仍是 executor 与 durable event owner；retry 在同一 Run 内开始新 Attempt。

Abort 时 policy 报告 cancellation `requested`。只有 generation 已确认 inactive 的 backend observation 才会把它改为 `confirmed`；窗口到期产生 `unconfirmed` 与 degraded health。这些是 transient diagnostic fact。Durable `turn/end` 仍是 terminal-state owner，policy 不执行 backend restart 或 Run resume。

有归属且持续推进的 backend observation 会发出 `llm/request-activity`。pi-ai adapter 使用这一 provider-neutral event，只重新设置匹配 Session 的 outstanding idle-watchdog demand，让长 MLX prefill 保持 live，同时不把 health polling 当作 progress。

完整的 identity、durability、transient-data、health、error、configuration、testing 与 deferred-work 约定见 [Run State 包 README](../../packages/runtime-diagnostics/agent-run-state/README.zh.md)、[MLX provider README](../../packages/runtime-diagnostics/agent-run-state-mlx/README.zh.md)、[Run policy README](../../packages/guard/agent-run-policy/README.zh.md)与[进度感知控制决策](../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.zh.md)。

## 可选 reasoning policy

[`dsh-reasoning-policy`](../../packages/runtime-diagnostics/reasoning-policy/README.zh.md) 是面向已审计精确 backend/model route 的独立 request-waterfall policy。它选择确定性的 policy 值，根据 backend declaration normalization alias 与不支持的 policy 值，并且只发送 resolved wire 值。受管 provider 上不支持的 benchmark lock 或未声明的精确 model 会在 provider I/O 前失败。

服务仅用 `LocalRunDiagnosticsObserver` 报告 requested、policy-selected、resolved、backend-default 与 wire reasoning 值以及 Context Pressure。Context Pressure 从已知 context window 中减去明确 reserve 与 provider safety margin，然后报告只读状态。Unknown prompt total 保持 unknown。它可选的 compaction auxiliary policy 使用独立的 pressure observation，只用 low 装饰 `dsh-compaction-basic` 的辅助请求（只有 deterministic validation 拒绝 low 后才使用 medium），并报告最新 transient `CompactionPolicyDiagnostics`。它永远不会改变主工作请求的 resolved reasoning。IQ3_S declaration 与 backend-specific detail 由[reasoning policy README](../../packages/runtime-diagnostics/reasoning-policy/README.zh.md)及其[决策记录](../../.agents/notes/implemented/architecture/2026-09-14-backend-capability-reasoning-policy.zh.md)负责。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentrunstate--agentrunstateservice"></a>

### `ctx.agentRunState` — `AgentRunStateService`

Read-only projection and observer registry for run diagnostics.

```ts cordis-catalog
/**
 * Register one replaceable backend observer. Duplicate ids fail loud.
 * @param observer - backend-neutral observation provider.
 * @returns idempotent disposer that unsubscribes and releases its identity.
 */
registerObserver(observer: LocalBackendObserver): () => void

/**
 * Register one policy-fact observer. Duplicate ids fail loud.
 * @param observer - run-control observation provider.
 * @returns idempotent disposer that removes its transient overlays.
 */
registerControlObserver(observer: LocalRunControlObserver): () => void

/**
 * Register an external read-only diagnostics overlay. The overlay is merged
 * only into current diagnostics; it is never durable Run State and cannot
 * alter terminal lifecycle, health, retry, or cancellation facts.
 * @param observer - provider of one Run-correlated diagnostic fact stream.
 * @returns idempotent disposer that removes this observer's transient facts.
 */
registerDiagnosticsObserver(observer: LocalRunDiagnosticsObserver): () => void

/**
 * Ask every registered backend observer to refresh immediately available evidence.
 * Observer failures are logged and do not fabricate health or activity.
 * @param session - Session whose policy decision is waiting for current evidence.
 */
async probe(session: Session): Promise<void>

/**
 * Read a detached current diagnostic snapshot without mutating run state.
 * @param session - Session whose latest run is read.
 * @param now - timestamp used only for elapsed health classification.
 * @returns durable Run State merged with attributed transient observations.
 */
diagnostics(session: Session, now: number = Date.now()): AgentRunDiagnostics

/**
 * Subscribe to activity-driven changes. Elapsed-only health changes are visible when diagnostics is polled.
 * @param session - Session whose latest diagnostics are observed.
 * @param listener - receiver of detached merged diagnostic cuts.
 * @returns idempotent listener disposer.
 */
subscribe(session: Session, listener: DiagnosticsListener): () => void
```

Types: [Session](session.zh.md)

Source: [`packages/runtime-diagnostics/agent-run-state/src/index.ts`](../../packages/runtime-diagnostics/agent-run-state/src/index.ts)

<a id="ctxmlxbackendobserver--mlxbackendobserver"></a>

### `ctx.mlxBackendObserver` — `MLXBackendObserver`

Real MLX observation provider over a followed log and optional HTTP health endpoint.

```ts cordis-catalog
/**
 * Subscribe to normalized MLX observations until the returned disposer is called.
 * @param listener - contained receiver for each backend-neutral observation.
 * @returns idempotent disposer that removes the listener.
 */
subscribe(listener: (observation: BackendObservation) => void): () => void

/**
 * Parse one complete MLX log line and publish only recognized backend facts.
 * @param line - one complete log record without its line terminator.
 * @param observedAt - fallback timestamp when the record contains no recognized time.
 */
ingestLogLine(line: string, observedAt: number = Date.now()): void

/**
 * Publish a process exit only when the process owner directly observed settlement.
 * @param exit - direct child-process settlement evidence and its observation time.
 */
observeProcessExit(exit: MlxProcessExit): void

/** Probe the configured health endpoint once; failure degrades process health but is never fatal evidence. */
async pollHealth(): Promise<void>

/** Force one file poll for deterministic source tests and manual diagnostics. */
async pollLog(): Promise<void>

/** Refresh appended MLX failure/progress evidence before a policy decision. */
async probe(): Promise<void>
```

Source: [`packages/runtime-diagnostics/agent-run-state-mlx/src/index.ts`](../../packages/runtime-diagnostics/agent-run-state-mlx/src/index.ts)

<a id="ctxreasoningpolicy--reasoningpolicyservice"></a>

### `ctx.reasoningPolicy` — `ReasoningPolicyService`

Opt-in service whose one exact-model capability declaration drives policy normalization. It owns no durable state and emits no model-visible message.

```ts cordis-catalog
/**
 * Subscribe to detached transient diagnostics emitted after each governed request decision.
 * @param listener - receiver for an immutable per-Run policy and pressure cut.
 * @returns idempotent disposer that stops delivery to the listener.
 */
subscribe(listener: (observation: RunDiagnosticsObservation) => void): () => void

/**
 * Set the highest-priority explicit user request for one live Agent.
 * @param agent - live Agent whose subsequent request proposal is governed.
 * @param level - requested policy vocabulary, or undefined to clear the override.
 */
setUserOverride(agent: Agent, level: ReasoningLevel | undefined): void

/**
 * Set or clear a benchmark lock; an unsupported lock fails before the backend call.
 * @param agent - live Agent whose subsequent request proposal is governed.
 * @param level - exact benchmark condition, or undefined to clear the lock.
 */
setBenchmarkLock(agent: Agent, level: CanonicalReasoningLevel | undefined): void

/**
 * Set or clear one entry-point-provided task policy without changing durable Task state.
 * @param agent - live Agent whose subsequent request proposal is governed.
 * @param level - entry-point policy value, or undefined to clear it.
 */
setTaskPolicy(agent: Agent, level: CanonicalReasoningLevel | undefined): void

/**
 * Return the last detached policy decision seen for an Agent, if any.
 * @param agent - live Agent whose most recent decision is read.
 * @returns immutable decision or undefined before the first governed request.
 */
decisionFor(agent: Agent): ResolvedReasoningDecision | undefined

/**
 * Read the latest optional compaction auxiliary policy fact without changing
 * a Run, Session, compaction transaction, or main-request reasoning segment.
 * @param session - Session whose latest transient compaction fact is read.
 * @returns the fact, or `undefined` before an enabled policy sees a compaction request.
 */
compactionDiagnostics(session: Session): CompactionPolicyDiagnostics | undefined
```

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/runtime-diagnostics/reasoning-policy/src/index.ts`](../../packages/runtime-diagnostics/reasoning-policy/src/index.ts)
<!-- END GENERATED cordis-surface -->
