# Agent Run State

English | [中文](agent-run-state.zh.md)

[dsh-agent-run-state](../../packages/runtime-diagnostics/agent-run-state) is the optional runtime-diagnostics service (`ctx.agentRunState`) that projects one user-triggered Run from existing Session events and merges process-local assistant stream and backend observations on read. It is independent of the coarse `AgentStatus`, owns no recovery policy, and requires no agent-loop mutation.

Source: [`packages/runtime-diagnostics/agent-run-state/src/index.ts`](../../packages/runtime-diagnostics/agent-run-state/src/index.ts)

## Identity and projection

The identity hierarchy is Session → Run → Attempt. A Session is the long-lived conversation; one positive Session turn deterministically identifies a Run; step plus attempt ordinal identifies an actual model request. Retry advances the Attempt ordinal and preserves the Run. Backend attribution names an exact Run, an exact Attempt, or formal `unknown`; unresolved observations are never assigned from concurrency assumptions.

The client-visible `agentRunState` projection contains the latest Run's durable cut. Existing turn, step, request, assistant, tool, retry, and compaction events supply its lifecycle facts. `AgentRunDiagnostics` merges that projection with transient activity, run-control, and read-only policy facts without adding high-frequency Session events. `LocalBackendObserver` is the replaceable provider contract; its optional `probe()` refreshes immediately available evidence before a decision. `LocalRunControlObserver` supplies retry/cancellation display facts, `LocalRunDiagnosticsObserver` supplies correlated reasoning/context facts without lifecycle authority, and `DiagnosticsListener` receives activity-driven diagnostic cuts.

## MLX observation and diagnostics

The optional [MLX provider](../../packages/runtime-diagnostics/agent-run-state-mlx/README.md) follows new log records and optionally probes HTTP health. It emits only `BackendObservation`; MLX parsing and provisional request correlation do not enter this subsystem's state or classifier. Log-derived prefill is `backend-log`/`provisional`. Attempt attribution is also provisional and exists only when a deployment declares an exclusive single-flight endpoint and exactly one eligible DSH attempt overlaps an MLX request marker; all ambiguity stays `unknown`.

The optional `@deepseek-ai/dsh-agent-run-state/command` plugin exposes `/agent_run_state` as a host-side read-only JSON view over merged diagnostics. It includes last meaningful activity, the stale threshold, retry current/max/reason, and requested/confirmed/unconfirmed cancellation timestamps. The durable wire projection remains unchanged, and Desktop presentation is outside this subsystem's current contract.

## Classification boundary

Health separates `unknown`, `healthy`, `slow`, `stalled`, `degraded`, and `fatal`. Stall is `now - lastMeaningfulActivityAt > stalledAfterMs`; total Run age can produce `slow` but never `stalled`. Assistant reasoning/text, tool events, and attributed advancing backend progress refresh meaningful activity. Diagnostics reads and health polling do not. Process, model, and generation health stay separate, so a healthy process cannot hide a fatal generation worker. Fatal errors need strong structured backend evidence, a structured fatal code, or a recognized backend-origin resource-limit/OOM signature. Primary errors are retained and later signals remain secondary. Classification never triggers retry, restart, resume, cancellation, checkpoint, or policy changes.

## Optional Run control policy

[`dsh-agent-run-policy`](../../packages/guard/agent-run-policy/README.md) is an independent guard over this observation service. It probes observers before a governed request-error decision, caps transient transport/provider retries at zero through two, and denies raw retries for fatal or permanent failures. The existing `dsh-llm-retry` plugin remains the executor and durable event owner; retry starts a new Attempt in the same Run.

On abort the policy reports cancellation `requested`. Only a backend observation with confirmed inactive generation changes it to `confirmed`; window expiry produces `unconfirmed` and degraded health. These are transient diagnostic facts. Durable `turn/end` remains the terminal-state owner, and the policy performs no backend restart or Run resume.

Attributed advancing backend observations emit `llm/request-activity`. The pi-ai adapter uses that provider-neutral event to rearm only the matching Session's outstanding idle-watchdog demand, allowing a long MLX prefill to remain live without treating health polling as progress.

The complete identity, durability, transient-data, health, error, configuration, testing, and deferred-work contract is in the [Run State package README](../../packages/runtime-diagnostics/agent-run-state/README.md), the [MLX provider README](../../packages/runtime-diagnostics/agent-run-state-mlx/README.md), the [Run policy README](../../packages/guard/agent-run-policy/README.md), and the [progress-aware control decision](../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.md).

## Optional reasoning policy

[`dsh-reasoning-policy`](../../packages/runtime-diagnostics/reasoning-policy/README.md) is an independent request-waterfall policy for audited exact backend/model routes. It selects a deterministic policy value, normalizes aliases and unsupported policy values under the backend declaration, and sends only the resolved wire value. An unsupported benchmark lock or undeclared exact model on a governed provider fails before provider I/O.

The service uses `LocalRunDiagnosticsObserver` only to report requested, policy-selected, resolved, backend-default, and wire reasoning values with Context Pressure. Context Pressure subtracts an explicit reserve and provider safety margin from a known context window, then reports a read-only state. Unknown prompt totals remain unknown. Its optional compaction auxiliary policy consumes the independent pressure observation, decorates only a `dsh-compaction-basic` auxiliary request with low (then medium only after deterministic validation rejects low), and reports its latest transient `CompactionPolicyDiagnostics`. It never changes the primary work request's resolved reasoning. The [reasoning policy README](../../packages/runtime-diagnostics/reasoning-policy/README.md) and its [decision records](../../.agents/notes/implemented/architecture/2026-09-14-backend-capability-reasoning-policy.md) own the IQ3_S declaration and backend-specific details.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.md)

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

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/runtime-diagnostics/reasoning-policy/src/index.ts`](../../packages/runtime-diagnostics/reasoning-policy/src/index.ts)
<!-- END GENERATED cordis-surface -->
