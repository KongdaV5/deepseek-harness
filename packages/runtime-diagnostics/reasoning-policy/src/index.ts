/**
 * Plugin-first deterministic reasoning selection and Context Pressure
 * observation. The service changes only the request proposal in the existing
 * `agent/request` waterfall and publishes transient diagnostics; it never
 * changes retry, compaction, launcher, Profile, or Session state.
 *
 * @module @deepseek-ai/dsh-reasoning-policy
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  RunDiagnosticsObserverId,
  type LocalRunDiagnosticsObserver,
  type RunDiagnosticsObservation,
} from '@deepseek-ai/dsh-agent-run-state'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import { classifyContextPressure, expectedOutputReserve } from './context-pressure.ts'
import { normalizeReasoning, ReasoningPolicyError } from './normalize.ts'
import { classifyReasoningTask } from './task-classifier.ts'
import { CompactionAuxiliaryPolicy } from './compaction-policy.ts'
import type {
  CanonicalReasoningLevel,
  BenchmarkPresetPolicy,
  ContextPressureDecision,
  CompactionPolicyDiagnostics,
  ModelReasoningCapability,
  ReasoningLevel,
  ReasoningPolicyConfig,
  ReasoningPolicyControl,
  ReasoningTaskClass,
  ResolvedReasoningDecision,
} from './types.ts'

export * from './capabilities.ts'
export * from './context-pressure.ts'
export * from './normalize.ts'
export * from './task-classifier.ts'
export type * from './types.ts'

/** Loader-visible service name. */
export const name = 'reasoningPolicy'

declare module '@deepseek-ai/cordis' {
  interface Context {
    reasoningPolicy: ReasoningPolicyService
  }
}

interface AgentPolicyState {
  control: ReasoningPolicyControl
  taskClass: ReasoningTaskClass
  last?: ResolvedReasoningDecision
}

interface ResumeDiagnostics {
  readonly resume?: {
    readonly runId?: unknown
    readonly contextEstimatedTokens?: unknown
  }
}

interface TaskCheckpointDiagnosticsReader {
  diagnostics(session: Session): ResumeDiagnostics
}

/** Optional preset registry used only to identify an already composed benchmark session. */
interface AgentPresetReader {
  composedPreset(agentCtx: Agent['ctx']): string | undefined
}

/** Preserve only known policy vocabulary before it can reach one adapter. */
function assertReasoningLevel(value: string): asserts value is ReasoningLevel {
  if (!['none', 'off', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
    throw new ReasoningPolicyError('UNSUPPORTED_REASONING', `unknown reasoning level ${JSON.stringify(value)}`)
  }
}

function capabilityKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

function textOf(decision: PreStepDecision): string {
  if (decision.kind !== 'enter') return ''
  return decision.messages
    .flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

function validateConfig(config: ReasoningPolicyConfig): void {
  if (config.observerId.trim().length === 0) throw new Error('reasoning-policy: observerId must not be blank')
  if (config.governedProviders.length === 0 || config.governedProviders.some(provider => provider.trim().length === 0)) {
    throw new Error('reasoning-policy: governedProviders must contain non-blank routes')
  }
  if (new Set(config.governedProviders).size !== config.governedProviders.length) {
    throw new Error('reasoning-policy: governedProviders must not contain duplicates')
  }
  for (const capability of config.capabilities) {
    if (capability.provider.trim().length === 0 || capability.model.trim().length === 0) {
      throw new Error('reasoning-policy: capability provider and model must not be blank')
    }
    if (!capability.requestOverrideSupported) continue
    for (const level of capability.supported) {
      if (capability.wireValues[level]?.trim().length !== 0) continue
      throw new Error(`reasoning-policy: ${capability.provider}/${capability.model} lacks wire value for ${level}`)
    }
  }
  const pressure = config.contextPressure
  for (const [key, value] of Object.entries(pressure.reserve)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`reasoning-policy: reserve.${key} must be a non-negative safe integer`)
  }
  for (const [key, value] of Object.entries({
    providerSafetyMargin: pressure.providerSafetyMargin,
    complexReserve: pressure.complexReserve,
    longOutputIncrement: pressure.longOutputIncrement,
    maxReserve: pressure.maxReserve,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`reasoning-policy: ${key} must be a non-negative safe integer`)
  }
  const { watch, prepare, compact, critical } = pressure.thresholds
  if (!(watch > 0 && watch < prepare && prepare < compact && compact < critical)) {
    throw new Error('reasoning-policy: thresholds must be strictly ascending positive ratios')
  }
  if (config.compaction !== undefined) {
    for (const [key, value] of Object.entries(config.compaction)) {
      if (typeof value !== 'boolean') throw new Error(`reasoning-policy: compaction.${key} must be a boolean`)
    }
  }
  const benchmarkIds = new Set<string>()
  for (const benchmark of config.benchmarkPresets ?? []) {
    if (benchmark.preset.trim().length === 0) throw new Error('reasoning-policy: benchmark preset must not be blank')
    if (!benchmarkIds.add(benchmark.preset)) throw new Error(`reasoning-policy: duplicate benchmark preset ${benchmark.preset}`)
    if ((benchmark.provider === undefined) !== (benchmark.model === undefined)) {
      throw new Error(`reasoning-policy: benchmark ${benchmark.preset} must set provider and model together`)
    }
  }
}

/**
 * Opt-in service whose one exact-model capability declaration drives policy
 * normalization. It owns no durable state and emits no model-visible message.
 */
export class ReasoningPolicyService extends Service implements LocalRunDiagnosticsObserver {
  static inject = ['agentRunState', 'llm', 'sessionProjections', 'tokenMeter']
  static Config: z<ReasoningPolicyConfig> = z.object({
    observerId: z.string().required(),
    governedProviders: z.array(z.string()).required(),
    capabilities: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      supported: z.array(z.union(['none', 'low', 'medium', 'high', 'xhigh'])).required(),
      aliases: z.dict(z.union(['none', 'low', 'medium', 'high', 'xhigh']), z.union(['none', 'off', 'low', 'medium', 'high', 'xhigh'])),
      fallbacks: z.dict(z.union(['none', 'low', 'medium', 'high', 'xhigh']), z.union(['none', 'low', 'medium', 'high', 'xhigh'])),
      wireValues: z.object({
        none: z.string().required(),
        low: z.string().required(),
        medium: z.string().required(),
        high: z.string().required(),
        xhigh: z.string().required(),
      }).required(),
      requestOverrideSupported: z.boolean().required(),
      backendDefault: z.union(['none', 'low', 'medium', 'high', 'xhigh']),
      confidence: z.union(['confirmed', 'provisional']).required(),
      source: z.string().required(),
    })).required(),
    globalDefault: z.union(['none', 'low', 'medium', 'high', 'xhigh']).required(),
    profileDefaults: z.dict(z.union(['none', 'low', 'medium', 'high', 'xhigh'])),
    taskPolicies: z.object({
      simple: z.union(['none', 'low', 'medium', 'high', 'xhigh']),
      normal: z.union(['none', 'low', 'medium', 'high', 'xhigh']),
      complex: z.union(['none', 'low', 'medium', 'high', 'xhigh']),
      'long-output': z.union(['none', 'low', 'medium', 'high', 'xhigh']),
    }),
    contextPressure: z.object({
      providerSafetyMargin: z.number().step(1).min(0).required(),
      reserve: z.object({
        none: z.number().step(1).min(0).required(),
        low: z.number().step(1).min(0).required(),
        medium: z.number().step(1).min(0).required(),
        high: z.number().step(1).min(0).required(),
        xhigh: z.number().step(1).min(0).required(),
      }).required(),
      complexReserve: z.number().step(1).min(0).required(),
      longOutputIncrement: z.number().step(1).min(0).required(),
      maxReserve: z.number().step(1).min(0).required(),
      thresholds: z.object({
        watch: z.number().min(Number.MIN_VALUE).required(),
        prepare: z.number().min(Number.MIN_VALUE).required(),
        compact: z.number().min(Number.MIN_VALUE).required(),
        critical: z.number().min(Number.MIN_VALUE).required(),
      }).required(),
    }).required(),
    compaction: z.object({
      enabled: z.boolean(),
      autoTrigger: z.boolean(),
      preserveBenchmarkContext: z.boolean(),
    }),
    benchmarkPresets: z.array(z.object({
      preset: z.string().required(),
      reasoning: z.union(['none', 'low', 'medium', 'high', 'xhigh']).required(),
      provider: z.string(),
      model: z.string(),
      preserveRawContext: z.boolean().required(),
    })),
  }) as unknown as z<ReasoningPolicyConfig>

  readonly id: RunDiagnosticsObserverId
  private readonly listeners = new Set<(observation: RunDiagnosticsObservation) => void>()
  private readonly capabilities: ReadonlyMap<string, ModelReasoningCapability>
  private readonly governedProviders: ReadonlySet<string>
  private readonly agentState = new WeakMap<Agent, AgentPolicyState>()
  private readonly runtimeCtx: Context
  private readonly compactionAuxiliary: CompactionAuxiliaryPolicy

  constructor(ctx: Context, private readonly config: ReasoningPolicyConfig) {
    super(ctx, 'reasoningPolicy')
    this.runtimeCtx = ctx
    validateConfig(config)
    this.id = RunDiagnosticsObserverId(config.observerId)
    this.governedProviders = new Set(config.governedProviders)
    this.capabilities = new Map(config.capabilities.map(capability => [capabilityKey(capability.provider, capability.model), capability]))
    this.compactionAuxiliary = new CompactionAuxiliaryPolicy(
      ctx,
      config.compaction,
      call => this.capabilityFor(call),
      agent => this.benchmarkFor(agent)?.preserveRawContext ?? this.stateFor(agent).control.benchmarkLock !== undefined,
      (agent, signal) => this.currentPressureState(agent, signal),
    )
    ctx.agentRunState.registerDiagnosticsObserver(this)
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      const state = this.stateFor(agent)
      const text = textOf(decision)
      if (text.length > 0) state.taskClass = classifyReasoningTask(text)
      await this.compactionAuxiliary.trigger(agent, signal)
      return decision
    })
    ctx.on('agent/request', async ({ agent, signal }, next): Promise<LlmCallConfig> => {
      const proposed = await next()
      this.assertBenchmarkRoute(agent, proposed)
      const capability = this.capabilityFor(proposed)
      if (capability === undefined) return proposed
      const decision = this.resolveDecision(agent, capability, proposed)
      const resolved = { ...proposed, reasoningEffort: ReasoningEffortId(decision.wireValue) }
      await this.observe(agent, resolved, decision, signal)
      return resolved
    })
  }

  /**
   * Subscribe to detached transient diagnostics emitted after each governed request decision.
   * @param listener - receiver for an immutable per-Run policy and pressure cut.
   * @returns idempotent disposer that stops delivery to the listener.
   */
  subscribe(listener: (observation: RunDiagnosticsObservation) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Set the highest-priority explicit user request for one live Agent.
   * @param agent - live Agent whose subsequent request proposal is governed.
   * @param level - requested policy vocabulary, or undefined to clear the override.
   */
  setUserOverride(agent: Agent, level: ReasoningLevel | undefined): void {
    if (level !== undefined) assertReasoningLevel(level)
    this.patchControl(agent, 'userOverride', level)
  }

  /**
   * Set or clear a benchmark lock; an unsupported lock fails before the backend call.
   * @param agent - live Agent whose subsequent request proposal is governed.
   * @param level - exact benchmark condition, or undefined to clear the lock.
   */
  setBenchmarkLock(agent: Agent, level: CanonicalReasoningLevel | undefined): void {
    if (level !== undefined) assertReasoningLevel(level)
    this.patchControl(agent, 'benchmarkLock', level)
  }

  /**
   * Set or clear one entry-point-provided task policy without changing durable Task state.
   * @param agent - live Agent whose subsequent request proposal is governed.
   * @param level - entry-point policy value, or undefined to clear it.
   */
  setTaskPolicy(agent: Agent, level: CanonicalReasoningLevel | undefined): void {
    if (level !== undefined) assertReasoningLevel(level)
    this.patchControl(agent, 'taskPolicy', level)
  }

  /**
   * Return the last detached policy decision seen for an Agent, if any.
   * @param agent - live Agent whose most recent decision is read.
   * @returns immutable decision or undefined before the first governed request.
   */
  decisionFor(agent: Agent): ResolvedReasoningDecision | undefined {
    const decision = this.stateFor(agent).last
    return decision === undefined ? undefined : structuredClone(decision)
  }

  /**
   * Read the latest optional compaction auxiliary policy fact without changing
   * a Run, Session, compaction transaction, or main-request reasoning segment.
   * @param session - Session whose latest transient compaction fact is read.
   * @returns the fact, or `undefined` before an enabled policy sees a compaction request.
   */
  compactionDiagnostics(session: Session): CompactionPolicyDiagnostics | undefined {
    return this.compactionAuxiliary.diagnostics(session)
  }

  private stateFor(agent: Agent): AgentPolicyState {
    const existing = this.agentState.get(agent)
    if (existing !== undefined) return existing
    const fresh: AgentPolicyState = { control: {}, taskClass: 'normal' }
    this.agentState.set(agent, fresh)
    return fresh
  }

  private patchControl<K extends keyof ReasoningPolicyControl>(
    agent: Agent,
    key: K,
    value: ReasoningPolicyControl[K] | undefined,
  ): void {
    const state = this.stateFor(agent)
    const entries = Object.entries(state.control)
      .filter(([candidate]) => candidate !== key)
    const control = value === undefined
      ? Object.fromEntries(entries)
      : Object.fromEntries([...entries, [key, value]])
    state.control = control as ReasoningPolicyControl
  }

  private capabilityFor(config: LlmCallConfig): ModelReasoningCapability | undefined {
    const capability = this.capabilities.get(capabilityKey(config.provider, config.model))
    if (capability !== undefined) return capability
    if (!this.governedProviders.has(config.provider)) return undefined
    throw new ReasoningPolicyError('UNKNOWN_CAPABILITY', `no audited reasoning capability for ${config.provider}/${config.model}`)
  }

  /** Return an explicitly configured benchmark policy for the Agent's actual composed preset. */
  private benchmarkFor(agent: Agent): BenchmarkPresetPolicy | undefined {
    const presets = this.runtimeCtx.get('agentPresets') as AgentPresetReader | undefined
    const preset = presets?.composedPreset(agent.ctx) ?? agent.session.header.agentPreset
    return preset === undefined
      ? undefined
      : this.config.benchmarkPresets?.find(candidate => candidate.preset === preset)
  }

  /** Fail before provider I/O when a benchmark's declared route does not match. */
  private assertBenchmarkRoute(agent: Agent, proposed: LlmCallConfig): void {
    const benchmark = this.benchmarkFor(agent)
    if (benchmark?.provider === undefined || benchmark.model === undefined) return
    if (benchmark.provider === proposed.provider && benchmark.model === proposed.model) return
    throw new ReasoningPolicyError(
      'BENCHMARK_ROUTE_MISMATCH',
      `benchmark preset ${benchmark.preset} requires ${benchmark.provider}/${benchmark.model}, received ${proposed.provider}/${proposed.model}`,
    )
  }

  private resolveDecision(
    agent: Agent,
    capability: ModelReasoningCapability,
    _config: LlmCallConfig,
  ): ResolvedReasoningDecision {
    const state = this.stateFor(agent)
    const { control, taskClass } = state
    const benchmark = this.benchmarkFor(agent)
    let selected: ReasoningLevel
    let requested: ReasoningLevel | undefined
    let source: ResolvedReasoningDecision['source']
    let benchmarkLocked = false
    if (benchmark !== undefined) {
      selected = benchmark.reasoning
      requested = benchmark.reasoning
      source = 'benchmark-lock'
      benchmarkLocked = true
    } else if (control.userOverride !== undefined) {
      selected = control.userOverride
      requested = control.userOverride
      source = 'user-override'
    } else if (control.benchmarkLock !== undefined) {
      selected = control.benchmarkLock
      requested = control.benchmarkLock
      source = 'benchmark-lock'
      benchmarkLocked = true
    } else if (control.taskPolicy !== undefined) {
      selected = control.taskPolicy
      source = 'task-policy'
    } else {
      const profile = this.config.profileDefaults?.[capabilityKey(capability.provider, capability.model)]
      if (profile !== undefined) {
        selected = profile
        source = 'profile-default'
      } else {
        selected = this.config.taskPolicies?.[taskClass] ?? this.config.globalDefault
        source = this.config.taskPolicies?.[taskClass] === undefined ? 'global-default' : 'task-policy'
      }
    }
    const decision = normalizeReasoning(capability, {
      selected,
      ...requested === undefined ? {} : { requested },
      selectionSource: source,
      ...benchmarkLocked ? { benchmarkLocked: true } : {},
    })
    // Preserve a continuous analysis segment's resolved effort. The branch is
    // intentionally narrow: explicit controls and simple/tool-oriented work
    // still win immediately, while same-class medium/xhigh continuation does
    // not oscillate between request shapes for no task reason.
    const previous = state.last
    if (benchmark === undefined
      && control.userOverride === undefined && control.benchmarkLock === undefined && control.taskPolicy === undefined
      && taskClass !== 'simple' && previous?.resolved === decision.resolved
      && (previous.resolved === 'medium' || previous.resolved === 'xhigh')) {
      state.last = previous
      return previous
    }
    state.last = decision
    return decision
  }

  private async observe(
    agent: Agent,
    config: LlmCallConfig,
    reasoning: ResolvedReasoningDecision,
    signal: AbortSignal,
  ): Promise<void> {
    const run = this.runtimeCtx.agentRunState.diagnostics(agent.session).run
    if (run === null) return
    const taskClass = this.stateFor(agent).taskClass
    const reserve = expectedOutputReserve(this.config.contextPressure, {
      resolvedReasoning: reasoning.resolved,
      policySelected: reasoning.policySelected,
      taskClass,
    })
    const pressure = await this.contextPressure(agent.session, config, reserve, signal, run.runId)
    this.emit({
      observerId: this.id,
      runId: run.runId,
      observedAt: Date.now(),
      reasoning: {
        ...reasoning.requested === undefined ? {} : { requestedReasoning: reasoning.requested },
        policySelected: reasoning.policySelected,
        resolvedReasoning: reasoning.resolved,
        wireValue: reasoning.wireValue,
        ...reasoning.backendDefault === undefined ? {} : { backendDefaultReasoning: reasoning.backendDefault },
        source: reasoning.source,
        capabilityConfidence: reasoning.capabilityConfidence,
      },
      context: {
        ...pressure.contextWindow === undefined ? {} : { contextWindow: pressure.contextWindow },
        ...pressure.projectedPromptTokens === undefined ? {} : {
          projectedPromptTokens: pressure.projectedPromptTokens,
          projectedTokens: pressure.projectedPromptTokens,
        },
        ...pressure.resumeContextTokens === undefined ? {} : { resumeContextTokens: pressure.resumeContextTokens },
        expectedOutputReserve: pressure.expectedOutputReserve,
        providerSafetyMargin: pressure.providerSafetyMargin,
        ...pressure.effectivePromptBudget === undefined ? {} : { effectivePromptBudget: pressure.effectivePromptBudget },
        ...pressure.pressureRatio === undefined ? {} : { pressureRatio: pressure.pressureRatio },
        pressureState: pressure.pressureState,
      },
    })
  }

  private async contextPressure(
    session: Session,
    config: LlmCallConfig,
    reserve: number,
    signal: AbortSignal,
    runId: string,
  ): Promise<ContextPressureDecision> {
    const projected = this.runtimeCtx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure
    const measurement = this.runtimeCtx.tokenMeter.measure(session, canonicalHeader({ config }))
    const model = await this.runtimeCtx.llm.resolveModelInfo(config.provider, config.model, signal)
    const contextWindow = projected?.contextWindow ?? model.context?.contextWindow
    const resumeContextTokens = this.resumeContextTokens(session, runId)
    return classifyContextPressure(this.config.contextPressure, {
      ...contextWindow === undefined ? {} : { contextWindow },
      // A usage-anchored meter total includes prior response tokens. It is not
      // a trustworthy next-prompt value until the existing projection supplies
      // its own projected prompt total, so retain Unknown rather than guess.
      ...projected?.projectedTokens === undefined && measurement.baseline.kind === 'usage'
        ? {}
        : { projectedPromptTokens: projected?.projectedTokens ?? measurement.totalTokens },
      ...resumeContextTokens === undefined ? {} : { resumeContextTokens },
      expectedOutputReserve: reserve,
    })
  }

  /** Reprice the current durable surface after a compaction attempt without changing main-request reasoning. */
  private async currentPressureState(agent: Agent, signal: AbortSignal): Promise<ContextPressureDecision['pressureState']> {
    const run = this.runtimeCtx.agentRunState.diagnostics(agent.session).run
    const config = agent.session.requestHeader()?.config
    const decision = this.stateFor(agent).last
    if (run === null || config === undefined || decision === undefined) return 'unknown'
    const reserve = expectedOutputReserve(this.config.contextPressure, {
      resolvedReasoning: decision.resolved,
      policySelected: decision.policySelected,
      taskClass: this.stateFor(agent).taskClass,
    })
    return (await this.contextPressure(agent.session, config, reserve, signal, String(run.runId))).pressureState
  }

  private resumeContextTokens(session: Session, runId: string): number | undefined {
    const reader = this.runtimeCtx.get('taskCheckpoints') as unknown as TaskCheckpointDiagnosticsReader | undefined
    const resume = reader?.diagnostics(session).resume
    if (resume === undefined || String(resume.runId) !== runId || !Number.isSafeInteger(resume.contextEstimatedTokens)) return undefined
    return resume.contextEstimatedTokens as number
  }

  private emit(observation: RunDiagnosticsObservation): void {
    for (const listener of this.listeners) listener(structuredClone(observation))
  }
}

export default ReasoningPolicyService
