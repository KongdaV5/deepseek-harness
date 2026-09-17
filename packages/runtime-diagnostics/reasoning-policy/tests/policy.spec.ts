import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import ReasoningPolicyService, {
  classifyContextPressure,
  expectedOutputReserve,
  iq3sGgufReasoningCapability,
  normalizeReasoning,
  type ReasoningPolicyConfig,
} from '@deepseek-ai/dsh-reasoning-policy'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'

const PROVIDER = 'local-qwen'
const CAPABILITY = iq3sGgufReasoningCapability(PROVIDER)

const CONFIG: ReasoningPolicyConfig = {
  observerId: 'gguf-policy-test',
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
}

class RecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 65_536 },
      reasoning: {
        efforts: ['none', 'low', 'medium', 'xhigh'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('xhigh'),
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 20, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ResumeReader extends Service {
  static override readonly name = 'taskCheckpoints'

  constructor(ctx: Context) {
    super(ctx, 'taskCheckpoints')
  }

  diagnostics(session: { id: string }) {
    return { resume: { runId: runIdFor(session.id as never, 1), contextEstimatedTokens: 777 } }
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

async function harness(config: ReasoningPolicyConfig = CONFIG, agentPreset?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  await ctx.plugin(ResumeReader)
  await ctx.plugin(ReasoningPolicyService, config)
  await ctx.plugin(AgentLoop)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(`policy-${randomUUID()}`),
    agentOptions: { provider: PROVIDER, model: CAPABILITY.model },
    ...agentPreset === undefined ? {} : { meta: { agentPreset } },
  })
  const agent = handle.agent
  return { ctx, agent, adapter }
}

function waitForIdle(ctx: Context, agent: Awaited<ReturnType<typeof harness>>['agent']): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

async function run(ctx: Context, agent: Awaited<ReturnType<typeof harness>>['agent'], text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

describe('IQ3_S reasoning normalization', () => {
  it('keeps audited values, aliases off to none, and explicitly falls high back to xhigh', () => {
    expect(normalizeReasoning(CAPABILITY, {
      selected: 'low', selectionSource: 'task-policy',
    })).toMatchObject({ policySelected: 'low', resolved: 'low', wireValue: 'low', source: 'task-policy' })
    expect(normalizeReasoning(CAPABILITY, {
      selected: 'high', requested: 'high', selectionSource: 'user-override',
    })).toMatchObject({ requested: 'high', policySelected: 'high', resolved: 'xhigh', wireValue: 'xhigh', source: 'gguf-backend-capability-fallback' })
    expect(normalizeReasoning(CAPABILITY, {
      selected: 'off', requested: 'off', selectionSource: 'user-override',
    })).toMatchObject({ requested: 'off', policySelected: 'none', resolved: 'none', wireValue: 'none', source: 'gguf-alias-normalization' })
  })

  it('fails a benchmark lock that would alter its declared condition', () => {
    expect(() => normalizeReasoning(CAPABILITY, {
      selected: 'high', selectionSource: 'benchmark-lock', benchmarkLocked: true,
    })).toThrow(/benchmark lock high is unsupported/)
  })
})

describe('Context Pressure observation', () => {
  it('moves monotonically across normal, watch, prepare, compact, and critical', () => {
    const reserve = expectedOutputReserve(CONFIG.contextPressure, {
      resolvedReasoning: 'medium', policySelected: 'medium', taskClass: 'normal',
    })
    const budget = 65_536 - reserve - CONFIG.contextPressure.providerSafetyMargin
    const state = (ratio: number) => classifyContextPressure(CONFIG.contextPressure, {
      contextWindow: 65_536, projectedPromptTokens: Math.ceil(budget * ratio), expectedOutputReserve: reserve,
    }).pressureState
    expect(state(0.54)).toBe('normal')
    expect(state(0.55)).toBe('watch')
    expect(state(0.7)).toBe('prepare')
    expect(state(0.8)).toBe('compact')
    expect(state(0.9)).toBe('critical')
  })

  it('uses task/reasoning reserves rather than maxTokens and holds unknown facts unknown', () => {
    expect(expectedOutputReserve(CONFIG.contextPressure, {
      resolvedReasoning: 'low', policySelected: 'low', taskClass: 'simple',
    })).toBe(2_048)
    expect(expectedOutputReserve(CONFIG.contextPressure, {
      resolvedReasoning: 'xhigh', policySelected: 'xhigh', taskClass: 'long-output',
    })).toBe(16_384)
    expect(classifyContextPressure(CONFIG.contextPressure, {
      expectedOutputReserve: 2_048,
    })).toMatchObject({ pressureState: 'unknown', providerSafetyMargin: 4_096 })
  })

  it('keeps the provider safety margin in the effective budget at the boundary', () => {
    expect(classifyContextPressure(CONFIG.contextPressure, {
      contextWindow: 10_000,
      projectedPromptTokens: 4_000,
      expectedOutputReserve: 2_000,
    })).toMatchObject({ effectivePromptBudget: 3_904, pressureState: 'critical' })
  })
})

describe('Agent request integration', () => {
  it('uses deterministic task policy and publishes a read-only policy/context overlay', async () => {
    const { ctx, agent, adapter } = await harness()
    await run(ctx, agent, 'ls and check whether this path exists')
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.reasoningEffort).toBe('low')
    const diagnostics = ctx.agentRunState.diagnostics(agent.session).run
    expect(diagnostics?.reasoning).toMatchObject({ policySelected: 'low', resolvedReasoning: 'low', wireValue: 'low', source: 'task-policy', capabilityConfidence: 'confirmed' })
    expect(diagnostics?.context).toMatchObject({
      contextWindow: 65_536,
      expectedOutputReserve: 2_048,
      providerSafetyMargin: 4_096,
      resumeContextTokens: 777,
      pressureState: 'normal',
    })
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('keeps complex work at xhigh and keeps the durable header aligned', async () => {
    const { ctx, agent, adapter } = await harness()
    await run(ctx, agent, 'Debug this complex multi-file SQL issue')
    expect(adapter.calls[0]?.reasoningEffort).toBe('xhigh')
    expect(agent.session.requestHeader()?.config.reasoningEffort).toBe('xhigh')
    expect(ctx.agentRunState.diagnostics(agent.session).run?.reasoning).toMatchObject({
      policySelected: 'xhigh', resolvedReasoning: 'xhigh', wireValue: 'xhigh', source: 'task-policy',
    })
  })

  it('keeps ordinary Profiles task-driven: lite-general, lite-amazon, and code do not encode a reasoning tier', async () => {
    const general = await harness(CONFIG, 'lite-general')
    await run(general.ctx, general.agent, 'Diagnose this complex multi-file coding regression and propose a safe fix')
    expect(general.adapter.calls[0]?.reasoningEffort).toBe('xhigh')

    const amazon = await harness(CONFIG, 'lite-amazon')
    await run(amazon.ctx, amazon.agent, 'Analyze Amazon campaign performance across search terms, placements, and profitability')
    expect(amazon.adapter.calls[0]?.reasoningEffort).toBe('xhigh')
    await run(amazon.ctx, amazon.agent, 'Read this fixed metadata field')
    expect(amazon.adapter.calls[1]?.reasoningEffort).toBe('low')

    const code = await harness(CONFIG, 'code')
    await run(code.ctx, code.agent, 'Debug this multi-file TypeScript runtime failure')
    expect(code.adapter.calls[0]?.reasoningEffort).toBe('xhigh')
    await run(code.ctx, code.agent, 'path check')
    expect(code.adapter.calls[1]?.reasoningEffort).toBe('low')
  })

  it('honours explicit xhigh, high, and off without sending unsupported GGUF values', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.reasoningPolicy.setUserOverride(agent, 'xhigh')
    await run(ctx, agent, 'ordinary request')
    expect(adapter.calls[0]?.reasoningEffort).toBe('xhigh')
    ctx.reasoningPolicy.setUserOverride(agent, 'high')
    await run(ctx, agent, 'ordinary request')
    expect(adapter.calls[1]?.reasoningEffort).toBe('xhigh')
    ctx.reasoningPolicy.setUserOverride(agent, 'off')
    await run(ctx, agent, 'ordinary request')
    expect(adapter.calls[2]?.reasoningEffort).toBe('none')
    expect(ctx.agentRunState.diagnostics(agent.session).run?.reasoning).toMatchObject({
      requestedReasoning: 'off', policySelected: 'none', resolvedReasoning: 'none', wireValue: 'none', source: 'gguf-alias-normalization',
    })
  })

  it('holds an xhigh benchmark lock and fails closed for an undeclared governed model', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.reasoningPolicy.setBenchmarkLock(agent, 'xhigh')
    await run(ctx, agent, 'simple metadata')
    expect(adapter.calls[0]?.reasoningEffort).toBe('xhigh')
    expect(ctx.agentRunState.diagnostics(agent.session).run?.reasoning.source).toBe('benchmark-lock')

    const unknown = await ctx.agentLoop.create(SessionId(`unknown-${randomUUID()}`), {
      provider: PROVIDER, model: 'unknown-IQ3_S-variant',
    })
    await run(ctx, unknown, 'normal')
    expect(adapter.calls).toHaveLength(1)
    expect(ctx.agentRunState.diagnostics(unknown.session).run?.primaryError?.message).toMatch(/no audited reasoning capability/)
  })

  it('locks an explicitly configured hidden benchmark preset over an ordinary user override', async () => {
    const { ctx, agent, adapter } = await harness({
      ...CONFIG,
      benchmarkPresets: [{
        preset: 'benchmark',
        reasoning: 'xhigh',
        provider: PROVIDER,
        model: CAPABILITY.model,
        preserveRawContext: true,
      }],
    }, 'benchmark')
    ctx.reasoningPolicy.setUserOverride(agent, 'low')

    await run(ctx, agent, 'simple metadata')

    expect(adapter.calls[0]?.reasoningEffort).toBe('xhigh')
    expect(ctx.agentRunState.diagnostics(agent.session).run?.reasoning).toMatchObject({
      requestedReasoning: 'xhigh',
      resolvedReasoning: 'xhigh',
      source: 'benchmark-lock',
    })
  })

  it('fails before provider I/O when an explicit benchmark preset does not match its fixed route', async () => {
    const { ctx, agent, adapter } = await harness({
      ...CONFIG,
      benchmarkPresets: [{
        preset: 'benchmark',
        reasoning: 'xhigh',
        provider: PROVIDER,
        model: 'another-fixed-model',
        preserveRawContext: true,
      }],
    }, 'benchmark')

    await run(ctx, agent, 'benchmark request')

    expect(adapter.calls).toHaveLength(0)
    expect(ctx.agentRunState.diagnostics(agent.session).run?.primaryError?.message).toMatch(/requires local-qwen\/another-fixed-model/)
  })

  it('keeps consecutive unknown-complex requests at xhigh rather than oscillating effort', async () => {
    const { ctx, agent, adapter } = await harness()
    await run(ctx, agent, 'ordinary analysis')
    await run(ctx, agent, 'ordinary analysis')
    await run(ctx, agent, 'ordinary analysis')
    expect(adapter.calls.map(call => call.reasoningEffort)).toEqual(['xhigh', 'xhigh', 'xhigh'])
  })
})
