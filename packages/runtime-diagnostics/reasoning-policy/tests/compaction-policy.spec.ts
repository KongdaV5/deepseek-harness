import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { TaskDiagnostics } from '@deepseek-ai/dsh-task-checkpoint'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ReasoningPolicyService, { iq3sGgufReasoningCapability, type ReasoningPolicyConfig } from '@deepseek-ai/dsh-reasoning-policy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionAuxiliaryPolicy } from '../src/compaction-policy.ts'

const PROVIDER = 'local-qwen'
const MODEL = '/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'
const CAPABILITY = iq3sGgufReasoningCapability(PROVIDER)

class SummaryAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(
    private readonly summaryFor: (options: GenerateOptions) => string,
    private readonly contextWindow: number = 65_536,
  ) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
      reasoning: {
        efforts: ['none', 'low', 'medium', 'xhigh'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('xhigh'),
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: this.summaryFor(options) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class TaskReader extends Service {
  static override readonly name = 'taskCheckpoints'
  constructor(ctx: Context, private readonly value: TaskDiagnostics) { super(ctx, 'taskCheckpoints') }
  diagnostics(): TaskDiagnostics { return this.value }
}

const CONFIG: ReasoningPolicyConfig = {
  observerId: 'compaction-policy-test',
  governedProviders: [PROVIDER],
  capabilities: [CAPABILITY],
  globalDefault: 'xhigh',
  taskPolicies: { simple: 'low', normal: 'medium', complex: 'xhigh', 'long-output': 'xhigh' },
  contextPressure: {
    providerSafetyMargin: 4_096,
    reserve: { none: 1_024, low: 2_048, medium: 6_144, high: 8_192, xhigh: 12_288 },
    complexReserve: 2_048,
    longOutputIncrement: 4_096,
    maxReserve: 16_384,
    thresholds: { watch: 0.55, prepare: 0.7, compact: 0.8, critical: 0.9 },
  },
  compaction: { enabled: true, autoTrigger: false, preserveBenchmarkContext: true },
}

const contexts: Context[] = []

afterEach(async () => { await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose())) })

function conversation(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'old request '.repeat(1_500) }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL } }, reason: 'initial' })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'old response '.repeat(1_500) }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return session
}

function agent(session: Session): Agent {
  return { session, options: { provider: PROVIDER, model: MODEL } } as Agent
}

async function harness(
  adapter: SummaryAdapter,
  options: {
    policy?: boolean
    task?: TaskDiagnostics
    maxSummaryValidationRetries?: number
    compactionRetries?: number
    thresholdRatio?: number
    retainRatio?: number
  } = {},
): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  if (options.task !== undefined) await ctx.plugin(TaskReader, options.task)
  if (options.policy === true) await ctx.plugin(ReasoningPolicyService, CONFIG)
  await ctx.plugin(BasicCompactionEngine, {
    auto: false,
    ...(options.compactionRetries === undefined ? {} : { compactionRetries: options.compactionRetries }),
    ...(options.thresholdRatio === undefined ? {} : { thresholdRatio: options.thresholdRatio }),
    ...(options.retainRatio === undefined ? {} : { retainRatio: options.retainRatio }),
    maxSummaryValidationRetries: options.maxSummaryValidationRetries ?? 0,
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return ctx
}

function compact(ctx: Context, session: Session) {
  const [start, end] = session.surface.nodes
  if (start === undefined || end === undefined) throw new Error('test conversation has no surface nodes')
  return ctx.compaction.compactRegion(start, end, agent(session), new AbortController().signal)
}

function taskDiagnostics(hazard = false): TaskDiagnostics {
  const task = {
    taskId: 'task-1' as never,
    revision: 1,
    version: 1 as const,
    taskType: 'coding',
    sessionId: 'task-session' as never,
    originRunId: 'run-1' as never,
    latestRunId: 'run-1' as never,
    status: 'running' as const,
    originalExecution: { provider: PROVIDER, model: MODEL },
    latestExecution: { provider: PROVIDER, model: MODEL },
    modelRelation: 'same-model' as const,
    completedSteps: [{ id: 'step-1' as never, title: 'inspect', completedAt: 1, evidence: { kind: 'runtime-validation' as const, validator: 'test', reference: 'test' } }],
    currentStep: { id: 'step-2' as never, title: 'implement' },
    pendingSteps: [{ id: 'step-2' as never, title: 'implement' }, { id: 'step-3' as never, title: 'verify' }],
    createdAt: 1,
    lastActivityAt: 1,
    resumeContext: {
      objective: 'Preserve task safety.',
      constraints: ['Do not restart the backend.'],
      decisions: ['Main work remains xhigh.'],
      criticalContext: ['Keep /tmp/result.txt.'],
    },
    outputs: ['output-1' as never],
  }
  return {
    task,
    checkpoint: { revision: 1, completedSteps: task.completedSteps, currentStep: task.currentStep, pendingSteps: task.pendingSteps },
    resume: { eligibility: hazard ? 'BLOCKED_UNKNOWN_SIDE_EFFECT' : 'SAFE_TO_RESUME', reason: 'test', pendingSteps: task.pendingSteps, modelRelation: 'same-model', requested: false, started: false },
    outputs: [{
      version: 1, outputId: 'output-1' as never, revision: 1, taskId: 'task-1' as never, runId: 'run-1' as never,
      path: '/tmp/result.txt', status: 'partial', createdAt: 1, updatedAt: 1,
      execution: { provider: PROVIDER, model: MODEL }, validation: { status: 'passed', checks: [] },
    }],
    repairHazards: hazard ? [{ taskId: 'task-1' as never, callId: 'call-1', code: 'TOOL_OUTCOME_UNKNOWN' as const, eventSeq: 1 as never }] : [],
  }
}

describe('compaction-only reasoning policy', () => {
  it('leaves a base compaction request without an explicit effort when no Phase 5 policy is mounted', async () => {
    const adapter = new SummaryAdapter(() => 'small summary')
    const ctx = await harness(adapter, { compactionRetries: 0 })
    let baselineEffort: unknown = 'unseen'
    ctx.on('compaction/request-policy', async (context, next) => {
      baselineEffort = context.options.reasoningEffort
      return next()
    })
    await compact(ctx, conversation('baseline'))
    expect(baselineEffort).toBeUndefined()
    expect(adapter.calls[0]?.reasoningEffort).toBe('xhigh')
  })

  it('sends explicit low through the real adapter and leaves no main-run reasoning mutation', async () => {
    const adapter = new SummaryAdapter(() => 'small summary')
    const ctx = await harness(adapter, { policy: true })
    const session = conversation('low')
    await compact(ctx, session)
    expect(adapter.calls.map(call => call.reasoningEffort)).toEqual(['low'])
    expect(ctx.reasoningPolicy.compactionDiagnostics(session)).toMatchObject({
      reasoning: { requested: 'low', resolved: 'low', wireValue: 'low', source: 'compaction-policy' },
      attempt: { ordinal: 1, validation: 'passed' },
    })
  })

  it('retries a task-fact validation failure once at medium and commits only the validated candidate', async () => {
    const adapter = new SummaryAdapter(options => options.reasoningEffort === 'low'
      ? 'summary missing runtime facts'
      : options.messages.flatMap(message => message.content)
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .find(text => text.includes('<task-runtime-facts>')) ?? 'missing facts')
    const ctx = await harness(adapter, { policy: true, task: taskDiagnostics(), maxSummaryValidationRetries: 1 })
    const session = conversation('medium-retry')
    await compact(ctx, session)
    expect(adapter.calls.map(call => call.reasoningEffort)).toEqual(['low', 'medium'])
    expect(ctx.reasoningPolicy.compactionDiagnostics(session)?.attempt).toMatchObject({ ordinal: 2, validation: 'passed' })
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  })

  it('fails closed after medium validation failure and never escalates to xhigh', async () => {
    const adapter = new SummaryAdapter(() => 'summary missing runtime facts')
    const ctx = await harness(adapter, { policy: true, task: taskDiagnostics(), maxSummaryValidationRetries: 1 })
    const session = conversation('fail-closed')
    const before = [...session.surface.nodes]
    await expect(compact(ctx, session)).rejects.toThrow(/semantic validation failed/)
    expect(adapter.calls.map(call => call.reasoningEffort)).toEqual(['low', 'medium'])
    expect(session.surface.nodes).toEqual(before)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('refuses TOOL_OUTCOME_UNKNOWN before it dispatches an auxiliary request', async () => {
    const adapter = new SummaryAdapter(() => 'small summary')
    const ctx = await harness(adapter, { policy: true, task: taskDiagnostics(true), maxSummaryValidationRetries: 1 })
    await expect(compact(ctx, conversation('hazard'))).rejects.toThrow(/TOOL_OUTCOME_UNKNOWN/)
    expect(adapter.calls).toHaveLength(0)
  })

  it('fails closed at critical pressure after only a low compaction attempt, never by lowering main reasoning', async () => {
    const adapter = new SummaryAdapter(() => 'small summary', 4_096)
    const ctx = await harness(adapter, { compactionRetries: 0, thresholdRatio: 0.1, retainRatio: 0.01 })
    const session = conversation('critical-pressure')
    let probeCount = 0
    const policy = new CompactionAuxiliaryPolicy(
      ctx,
      { enabled: true, autoTrigger: true, preserveBenchmarkContext: true },
      () => CAPABILITY,
      () => false,
      async () => probeCount++ === 0 ? 'critical' : 'normal',
    )

    await expect(policy.trigger(agent(session), new AbortController().signal)).rejects.toThrow(/compaction still above threshold/)

    expect(adapter.calls.map(call => call.reasoningEffort)).toEqual(['low'])
    expect(policy.diagnostics(session)).toMatchObject({
      pressureState: 'critical',
      eligibility: 'eligible',
      triggerReason: 'pressure',
      reasoning: { resolved: 'low' },
      attempt: { validation: 'failed' },
    })
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  })
})
