/** Optional IQ3_S-aware policy for compaction auxiliary requests. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionRequestPolicyContext,
  CompactionSummaryValidationContext,
  CompactionSummaryValidationDecision,
} from '@deepseek-ai/dsh-compaction-basic'
import type { ContentBlock, GenerateOptions, LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { TaskDiagnostics } from '@deepseek-ai/dsh-task-checkpoint'
import type { ModelReasoningCapability, ResolvedReasoningDecision } from './types.ts'
import { normalizeReasoning, ReasoningPolicyError } from './normalize.ts'
import type { CompactionPolicyDiagnostics, CompactionReasoningPolicyConfig } from './types.ts'

/** Optional task-checkpoint reader; older compositions may not mount Phase 4. */
interface TaskCheckpointReader {
  diagnostics(session: Agent['session']): TaskDiagnostics
}

/** Facts copied verbatim into an auxiliary compaction prompt and required in its candidate. */
interface TaskFactBundle {
  readonly message: Message
  readonly required: readonly string[]
}

/** Meaningful candidate facts and policy decisions retained only for diagnostics. */
interface CompactionPolicyFact extends CompactionPolicyDiagnostics {}

/** Resolve one optional policy config without changing first-batch behavior when it is absent. */
export function resolveCompactionReasoningPolicy(
  configured: CompactionReasoningPolicyConfig | undefined,
): CompactionReasoningPolicyConfig {
  return {
    enabled: configured?.enabled ?? false,
    autoTrigger: configured?.autoTrigger ?? false,
    preserveBenchmarkContext: configured?.preserveBenchmarkContext ?? true,
  }
}

/**
 * Install compaction-only request decoration and candidate validation. This
 * consumer owns no Session writes: BasicCompactionEngine retains range
 * selection, token shrink validation, durable brackets, and atomic apply.
 */
export class CompactionAuxiliaryPolicy {
  private readonly facts = new WeakMap<Agent['session'], CompactionPolicyFact>()
  private readonly config: CompactionReasoningPolicyConfig

  /**
   * @param ctx - composition context carrying optional compaction and task services.
   * @param configured - deployment policy; disabled keeps the underlying compactor unchanged.
   * @param capabilityFor - exact backend capability lookup owned by the parent reasoning policy.
   * @param benchmarkPreservesContext - whether the current Agent's benchmark condition forbids automatic compaction.
   */
  constructor(
    private readonly ctx: Context,
    configured: CompactionReasoningPolicyConfig | undefined,
    private readonly capabilityFor: (config: Pick<LlmCallConfig, 'provider' | 'model'>) => ModelReasoningCapability | undefined,
    private readonly benchmarkPreservesContext: (agent: Agent) => boolean,
    private readonly pressureFor: (agent: Agent, signal: AbortSignal) => Promise<CompactionPolicyDiagnostics['pressureState']>,
  ) {
    this.config = resolveCompactionReasoningPolicy(configured)
    if (!this.config.enabled) return
    ctx.on('compaction/request-policy', async (context, next) => {
      const proposed = await next()
      return this.decorate(context, proposed)
    })
    ctx.on('compaction/summary-validation', async (context, next) => {
      const inherited = await next()
      return inherited.kind === 'accept' ? this.validate(context) : inherited
    })
  }

  /** Read the last policy fact for one Session without changing compaction state. */
  diagnostics(session: Agent['session']): CompactionPolicyDiagnostics | undefined {
    const fact = this.facts.get(session)
    return fact === undefined ? undefined : structuredClone(fact)
  }

  /** Invoke the existing executor only at an observed compact or critical pressure state. */
  async trigger(agent: Agent, signal: AbortSignal): Promise<void> {
    if (!this.config.enabled || !this.config.autoTrigger) return
    const pressureState = await this.pressureFor(agent, signal)
    if (pressureState !== 'compact' && pressureState !== 'critical') return
    const refusal = this.eligibility(agent)
    if (refusal !== undefined) {
      this.record(agent, {
        pressureState,
        eligibility: 'ineligible',
        triggerReason: 'pressure',
        taskFactsInjected: false,
        toolResultsPruned: 'unknown',
      })
      if (pressureState === 'critical') throw new Error(`critical context pressure cannot proceed: ${refusal}`)
      return
    }
    const compaction = this.ctx.get('compaction') as CompactionEngine | undefined
    if (compaction === undefined) {
      if (pressureState === 'critical') throw new Error('critical context pressure requires a mounted compaction executor')
      return
    }
    const basicAuto = (compaction as { config?: { auto?: boolean } }).config?.auto
    if (basicAuto === true) {
      throw new Error('compaction policy autoTrigger requires compaction-basic auto: false to avoid duplicate trigger ownership')
    }
    this.record(agent, {
      pressureState,
      eligibility: 'eligible',
      triggerReason: 'pressure',
      taskFactsInjected: false,
      toolResultsPruned: 'unknown',
    })
    try {
      const result = await compaction.compactIfNeeded(agent, 'pressure', signal)
      const after = await this.pressureFor(agent, signal)
      if (pressureState === 'critical' && (result === null || after === 'critical')) {
        throw new Error('critical context pressure remains above the admitted budget after compaction')
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      this.record(agent, {
        ...(this.facts.get(agent.session) ?? defaultFact()),
        pressureState,
        triggerReason: 'pressure',
        eligibility: 'eligible',
        attempt: { ordinal: 1, validation: 'failed', failureReason: reason },
      })
      if (pressureState === 'critical') throw error
    }
  }

  /** Add audited auxiliary reasoning plus compact authoritative task facts. */
  private decorate(
    context: CompactionRequestPolicyContext,
    proposed: GenerateOptions,
  ): GenerateOptions {
    const eligibility = this.eligibility(context.agent)
    const pressureState = this.ctx.agentRunState.diagnostics(context.agent.session).run?.context.pressureState ?? 'unknown'
    if (eligibility !== undefined) {
      this.record(context.agent, {
        pressureState,
        eligibility: 'ineligible',
        attempt: { ordinal: context.attempt, validation: 'failed', failureReason: eligibility },
        taskFactsInjected: false,
        toolResultsPruned: 'unknown',
      })
      throw new Error(`compaction policy refused this auxiliary request: ${eligibility}`)
    }
    if (context.attempt > 2) {
      throw new Error('compaction policy permits only low then medium auxiliary reasoning')
    }
    const capability = this.capabilityFor(proposed)
    if (capability === undefined) {
      throw new ReasoningPolicyError(
        'UNKNOWN_CAPABILITY',
        `compaction policy lacks an audited capability for ${proposed.provider}/${proposed.model}`,
      )
    }
    const selected = context.attempt === 1 ? 'low' : 'medium'
    const decision = normalizeReasoning(capability, {
      selected,
      requested: selected,
      selectionSource: 'compaction-policy',
    })
    const facts = this.taskFacts(context.agent)
    const instruction = proposed.messages.at(-1)
    if (instruction === undefined) throw new Error('compaction policy received an empty request')
    const messages = facts === undefined
      ? proposed.messages
      : [...proposed.messages.slice(0, -1), facts.message, instruction]
    this.record(context.agent, {
      pressureState,
      eligibility: 'eligible',
      reasoning: reasoningDiagnostic(decision),
      attempt: { ordinal: context.attempt, validation: 'pending' },
      taskFactsInjected: facts !== undefined,
      toolResultsPruned: 'unknown',
    })
    return { ...proposed, messages, reasoningEffort: ReasoningEffortId(decision.wireValue) }
  }

  /** Reject a candidate only when durable task facts prove a required item disappeared. */
  private validate(context: CompactionSummaryValidationContext): CompactionSummaryValidationDecision {
    const fact = this.facts.get(context.agent.session)
    const bundle = this.taskFacts(context.agent)
    const candidate = context.summary
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const missing = bundle?.required.filter(value => !candidate.includes(value)) ?? []
    if (missing.length === 0) {
      this.record(context.agent, {
        ...(fact ?? defaultFact()),
        attempt: { ordinal: context.attempt, validation: 'passed' },
      })
      return { kind: 'accept' }
    }
    const reason = `candidate omitted authoritative task facts: ${missing.join(', ')}`
    this.record(context.agent, {
      ...(fact ?? defaultFact()),
      attempt: { ordinal: context.attempt, validation: 'failed', failureReason: reason },
    })
    return { kind: 'retry', reason }
  }

  /** Build the smallest factual checkpoint supplement without serializing TaskCheckpoint YAML. */
  private taskFacts(agent: Agent): TaskFactBundle | undefined {
    const diagnostics = this.taskDiagnostics(agent)
    if (diagnostics === undefined || diagnostics.task === undefined) return undefined
    const { task } = diagnostics
    const outputs = diagnostics.outputs
    const facts = [
      ['task_id', String(task.taskId)],
      ['objective', task.resumeContext.objective],
      ...task.resumeContext.constraints.map((value, index) => [`constraint_${index + 1}`, value] as const),
      ...task.resumeContext.decisions.map((value, index) => [`decision_${index + 1}`, value] as const),
      ['completed_steps', task.completedSteps.map(step => `${step.id}: ${step.title}`).join('; ') || '(none)'],
      ['current_step', task.currentStep === undefined ? '(none)' : `${task.currentStep.id}: ${task.currentStep.title}`],
      ...task.pendingSteps.map((step, index) => [`pending_${index + 1}`, `${step.id}: ${step.title}`] as const),
      ...outputs.map((output, index) => [`output_${index + 1}`, `${output.outputId}: ${output.path} (${output.status})`] as const),
      ...task.failureContext === undefined ? [] : [[
        'primary_blocker',
        `${task.failureContext.primaryError.code}: ${task.failureContext.primaryError.message}`,
      ] as const],
      ...task.resumeContext.criticalContext.map((value, index) => [`critical_context_${index + 1}`, value] as const),
    ].filter(([, value]) => value !== '(none)')
    const text = [
      'Authoritative runtime task facts follow. Preserve every value verbatim when relevant; they do not replace durable TaskCheckpoint or Result Manifest truth.',
      '<task-runtime-facts>',
      ...facts.map(([key, value]) => `${key}: ${value}`),
      '</task-runtime-facts>',
    ].join('\n')
    return {
      message: createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-reasoning-policy' },
      }),
      required: facts.map(([, value]) => value),
    }
  }

  /** Read Phase 4 task truth when that optional service is mounted. */
  private taskDiagnostics(agent: Agent): TaskDiagnostics | undefined {
    const service = this.ctx.get('taskCheckpoints') as TaskCheckpointReader | undefined
    return service?.diagnostics(agent.session)
  }

  /** Return a conservative refusal reason from only observed facts. */
  private eligibility(agent: Agent): string | undefined {
    const run = this.ctx.agentRunState.diagnostics(agent.session).run
    if (run?.health === 'fatal') return 'Run health is fatal.'
    if (run?.phase === 'cancelled' || run?.cancellation?.status === 'requested') return 'Run cancellation is active.'
    if (run?.phase === 'tool_wait') return 'A tool operation is active and may not be interrupted.'
    if (this.config.preserveBenchmarkContext && this.benchmarkPreservesContext(agent)) {
      return 'Benchmark lock requires the original context.'
    }
    const task = this.taskDiagnostics(agent)
    if (task?.repairHazards.some(hazard => hazard.code === 'TOOL_OUTCOME_UNKNOWN')) {
      return 'Task has TOOL_OUTCOME_UNKNOWN and requires external-state verification.'
    }
    if (task?.task?.status === 'blocked') return 'Task resume is blocked.'
    return undefined
  }

  /** Store detached transient facts only; this never appends a Session event. */
  private record(agent: Agent, fact: CompactionPolicyFact): void {
    this.facts.set(agent.session, structuredClone(fact))
  }
}

function defaultFact(): CompactionPolicyFact {
  return {
    pressureState: 'unknown',
    eligibility: 'unknown',
    taskFactsInjected: false,
    toolResultsPruned: 'unknown',
  }
}

function reasoningDiagnostic(
  decision: ResolvedReasoningDecision,
): NonNullable<CompactionPolicyDiagnostics['reasoning']> {
  return {
    ...(decision.requested === undefined ? {} : { requested: decision.requested }),
    resolved: decision.resolved,
    wireValue: decision.wireValue,
    source: decision.source,
  }
}
