/**
 * The bounded retry plugin over the real agent loop and the real retry executor.
 *
 * Nothing here re-implements retry. `dsh-llm-retry` schedules and performs every
 * attempt, `dsh-agent-loop` re-runs the failed step inside the open turn, and
 * this package only decides whether the executor may proceed. The assertions are
 * therefore about what the existing mechanisms actually did — how many requests
 * reached the adapter, which durable events exist, and which Run the retries
 * belong to.
 *
 * `snapshotEvents()` is a deprecated historical reader. Test files are the one
 * place the repository permits it, which is exactly why the retry budget is a
 * Session projection instead of a production read of this kind.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { lifecycleFactsFrom } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import { projectRuns, runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import * as policy from '../src/index.ts'

const PROVIDER = 'mock'

type RetryEvent = Extract<SessionEvent, { type: 'llm/retry' }>

type ScriptEntry = StreamChunk[] | ((options: { signal?: AbortSignal }) => StreamChunk[])

/** One scripted route: each entry answers one request attempt in order. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: { signal?: AbortSignal }[] = []
  private configured: ResolvedRetryPolicy | undefined

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  configureRetryPolicy(config: RetryPolicyConfig): void {
    this.configured = resolveRetryPolicy(config, `test provider "${PROVIDER}" retryPolicy`)
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.configured
  }

  async * stream(options: { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('retry policy test script exhausted')
    yield* typeof entry === 'function' ? entry(options) : entry
  }
}

/** A transient provider failure as a terminal error finish chunk. */
function transientFailure(failure: LlmFailure): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure } }]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function maxTokensResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'truncated' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'truncated' } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

const TRANSIENT: LlmFailure = { message: 'transport reset', code: 'TRANSPORT' }

/** The upstream provider policy: five retries, far above the Stage 9 ceiling. */
const WIDE_POLICY: RetryPolicyConfig = {
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: ['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT'],
  backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
}

/** A provider policy that retries exactly one code, to isolate one category. */
function policyForCode(code: string): RetryPolicyConfig {
  return {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: [code],
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  }
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
}

async function harness(
  adapter: ScriptedAdapter,
  options: { readonly withPolicy?: boolean; readonly maxRetryCount?: number } = {},
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Object.assign((inner: Context) => {
    retry.apply(inner, {}, { random: () => 0.5 })
  }, { inject: retry.inject }))
  if (options.withPolicy !== false) {
    await ctx.plugin(Object.assign((inner: Context) => {
      policy.apply(inner, options.maxRetryCount === undefined ? {} : { maxRetryCount: options.maxRetryCount })
    }, { inject: policy.inject }))
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter }
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** All committed events for one agent's session. */
function allEvents(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

function eventsOf(agent: Agent, type: SessionEvent['type']): readonly SessionEvent[] {
  return allEvents(agent).filter(event => event.type === type)
}

function retryEvents(agent: Agent): readonly RetryEvent[] {
  return allEvents(agent).filter((event): event is RetryEvent => event.type === 'llm/retry')
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('A, B, C: the automatic chain stops after two retries', () => {
  it('makes exactly three attempts when the provider policy would allow six', async () => {
    const adapter = new ScriptedAdapter([
      transientFailure(TRANSIENT),
      transientFailure(TRANSIENT),
      transientFailure(TRANSIENT),
      transientFailure(TRANSIENT),
      textResponse('never reached'),
    ])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('bounded-chain'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(policy.MAX_AUTOMATIC_ATTEMPTS)
    expect(retryEvents(agent).map(event => event.data.retry)).toEqual([1, 2])
    const end = eventsOf(agent, 'turn/end')[0]
    expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('error')
  })

  it('control: without the policy the same script retries the full upstream budget', async () => {
    const adapter = new ScriptedAdapter(Array.from({ length: 6 }, () => transientFailure(TRANSIENT)))
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter, { withPolicy: false })
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('unbounded-chain'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    // Five retries after the initial attempt: the provider's own budget, which
    // Stage 9 replaces with a hard ceiling of two.
    expect(adapter.requests).toHaveLength(6)
    expect(retryEvents(agent).map(event => event.data.retry)).toEqual([1, 2, 3, 4, 5])
  })

  it('honours a configured cap of zero by making one attempt', async () => {
    const adapter = new ScriptedAdapter([transientFailure(TRANSIENT), textResponse('never reached')])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter, { maxRetryCount: 0 })
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('zero-cap'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(retryEvents(agent)).toHaveLength(0)
  })

  it('lets a recovered step finish normally inside the same turn', async () => {
    const adapter = new ScriptedAdapter([transientFailure(TRANSIENT), textResponse('recovered')])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('recovers'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(eventsOf(agent, 'turn/start')).toHaveLength(1)
    expect(eventsOf(agent, 'step/start')).toHaveLength(1)
    const end = eventsOf(agent, 'turn/end')[0]
    expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('completed')
  })
})

describe('D, E: every retry shares one chain, one turn, one Run, one step', () => {
  it('reuses one RetryId across the whole chain', async () => {
    const adapter = new ScriptedAdapter([
      transientFailure(TRANSIENT),
      transientFailure(TRANSIENT),
      transientFailure(TRANSIENT),
    ])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('one-retry-id'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    const ids = new Set(retryEvents(agent).map(event => String(event.data.retryId)))
    expect(ids.size).toBe(1)
    expect(retryEvents(agent).every(event => event.data.provider === PROVIDER)).toBe(true)
  })

  it('keeps one Session, one turn, one step, and one RunId for the whole chain', async () => {
    const adapter = new ScriptedAdapter([
      transientFailure(TRANSIENT),
      transientFailure(TRANSIENT),
      transientFailure(TRANSIENT),
    ])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('one-run'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(eventsOf(agent, 'turn/start')).toHaveLength(1)
    expect(eventsOf(agent, 'step/start')).toHaveLength(1)
    expect(retryEvents(agent).map(event => [event.data.turn, event.data.step])).toEqual([[1, 1], [1, 1]])
    // One Run is one durable turn, so the identity derived from that turn is the
    // same before, during, and after the retry chain.
    const runIds = retryEvents(agent).map(event => String(runIdFor(agent.session.id, event.data.turn)))
    expect(new Set(runIds)).toEqual(new Set([String(runIdFor(agent.session.id, 1))]))
  })
})

describe('F, G: cancellation and fatality are attempted once', () => {
  it('F: a fatal failure is attempted once', async () => {
    const adapter = new ScriptedAdapter([
      transientFailure({ message: 'worker died', code: 'WORKER_CRASH' }),
      textResponse('never reached'),
    ])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('fatal-once'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(retryEvents(agent)).toHaveLength(0)
  })

  it('G: a cancelled execution is attempted once', async () => {
    const adapter = new ScriptedAdapter([transientFailure(TRANSIENT), textResponse('never reached')])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('cancelled-once'), { provider: PROVIDER, model: PROVIDER })
    // Cancellation lands in the window between the failed attempt's durable
    // settlement and the recovery waterfall, so the policy sees an aborted
    // signal rather than a transient failure.
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/attempt') agent.cancel({ kind: 'user' })
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(retryEvents(agent)).toHaveLength(0)
  })
})

describe('H, I, J, K, L: no-retry categories stay single-attempt even when the provider retries them', () => {
  const providerRetryableButDenied: readonly [string, LlmFailure][] = [
    ['H context overflow', { message: 'context window exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' }],
    ['I invalid reasoning parameter', { message: 'bad effort', code: 'INVALID_REASONING_PARAMETER' }],
    ['I invalid model config', { message: 'unknown model', code: 'INVALID_MODEL_CONFIG' }],
    ['L tool failure', { message: 'tool blew up', code: 'TOOL_FAILED' }],
    ['a Session interruption needing guarded resume', { message: 'interrupted', code: 'SESSION_INTERRUPTED' }],
    ['a failed retry chain', { message: 'retry failed', code: 'RETRY_FAILED' }],
    ['a stalled generation', { message: 'no progress', code: 'GENERATION_STALLED' }],
    ['a blocked run', { message: 'blocked', code: 'BLOCKED' }],
  ]

  it.each(providerRetryableButDenied)('%s is attempted once and retried zero times', async (_label, failure) => {
    const adapter = new ScriptedAdapter([transientFailure(failure), textResponse('never reached')])
    // The provider policy explicitly declares this code retryable, so the denial
    // can only come from the Stage 9 no-retry category set.
    adapter.configureRetryPolicy(policyForCode(failure.code))
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId(`no-retry-${failure.code}`), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(retryEvents(agent)).toHaveLength(0)
  })

  it('J: a failure no current contract names is attempted once under the default policy', async () => {
    const adapter = new ScriptedAdapter([
      transientFailure({ message: 'something new', code: 'UNCLASSIFIED_PROVIDER_CONDITION' }),
      textResponse('never reached'),
    ])
    // The default policy names no such code, and the Stage 7 classifier has no
    // category for it: it stays UNKNOWN and fails closed.
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('unknown-once'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(retryEvents(agent)).toHaveLength(0)
  })

  it('K: a max-token terminal result is not retried', async () => {
    const adapter = new ScriptedAdapter([maxTokensResponse(), textResponse('never reached')])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('max-tokens-once'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(retryEvents(agent)).toHaveLength(0)
    const end = eventsOf(agent, 'turn/end')[0]
    expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('max-tokens')
  })
})

describe('M, N, O: exhaustion settles through the existing paths and invents nothing', () => {
  it('M: an exhausted budget leaves the run terminal through the existing turn/end path', async () => {
    const adapter = new ScriptedAdapter(Array.from({ length: 4 }, () => transientFailure(TRANSIENT)))
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('exhausted'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    const ends = eventsOf(agent, 'turn/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]?.type === 'turn/end' ? ends[0].data.reason.kind : undefined).toBe('error')
    expect(ends[0]?.type === 'turn/end' && ends[0].data.reason.kind === 'error'
      ? ends[0].data.reason.error.code
      : undefined).toBe('TRANSPORT')
    // The run's own summary already explains the exhaustion from durable facts:
    // the retries stayed inside one turn, and the provider's cap is still
    // visible beside the count Stage 9 stopped at.
    const runs = projectRuns(agent.session.id, lifecycleFactsFrom(allEvents(agent)))
    expect(runs.active).toBeNull()
    expect(runs.terminal?.retryCount).toBe(2)
    expect(runs.terminal?.maxRetryCount).toBe(5)
    expect(runs.terminal?.retryReason).toBe('TRANSPORT')
    expect(runs.terminal?.phase).toBe('failed')
  })

  it('N, O: no retry writes a checkpoint, a result manifest, or a resume record', async () => {
    const adapter = new ScriptedAdapter(Array.from({ length: 4 }, () => transientFailure(TRANSIENT)))
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('nothing-invented'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    expect(retryEvents(agent).length).toBeGreaterThan(0)
    // The only durable vocabulary a retry may add is the executor's own.
    expect(eventsOf(agent, 'task/checkpoint')).toHaveLength(0)
    expect(eventsOf(agent, 'task/result-manifest')).toHaveLength(0)
    // One turn, so one Run, so nothing for a cross-run continuation to record.
    expect(eventsOf(agent, 'turn/start')).toHaveLength(1)
  })

  it('O: the durable retry budget counts retries and closes with the turn', async () => {
    const adapter = new ScriptedAdapter([transientFailure(TRANSIENT), transientFailure(TRANSIENT), textResponse('done')])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('budget-projection'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    const state = ctx.sessionProjections.stateOf(agent.session, policy.AGENT_RUN_RETRY_BUDGET_KEY)
    expect(state).toEqual({ turn: 1, step: 1, retries: 2, turnOpen: false })
    expect(policy.retryCountFor(state, 1, 1)).toBe(2)
    expect(policy.retryCountFor(state, 2, 1)).toBe(0)
    expect(policy.retryCountFor(undefined, 1, 1)).toBe(0)
  })

  it('reads a zero budget for a step that never retried', async () => {
    const adapter = new ScriptedAdapter([textResponse('done')])
    adapter.configureRetryPolicy(WIDE_POLICY)
    const { ctx } = await harness(adapter)
    context = ctx
    const agent = await ctx.agentLoop.create(SessionId('no-budget'), { provider: PROVIDER, model: PROVIDER })

    send(agent, 'go')
    await agent.whenIdle()

    // The unit exists and is closed with its turn; no retry ever bumped it.
    expect(ctx.sessionProjections.stateOf(agent.session, policy.AGENT_RUN_RETRY_BUDGET_KEY))
      .toEqual({ turn: 1, step: 1, retries: 0, turnOpen: false })
    expect(retryEvents(agent)).toHaveLength(0)
  })
})

describe('configuration', () => {
  it('refuses a cap outside the product ceiling, a negative cap, and a non-integer cap', async () => {
    const adapter = new ScriptedAdapter([textResponse('done')])
    const { ctx } = await harness(adapter)
    context = ctx
    expect(() => { policy.apply(ctx, { maxRetryCount: policy.MAX_AUTOMATIC_RETRIES + 1 }) }).toThrow(/maxRetryCount/)
    expect(() => { policy.apply(ctx, { maxRetryCount: -1 }) }).toThrow(/maxRetryCount/)
    expect(() => { policy.apply(ctx, { maxRetryCount: 1.5 }) }).toThrow(/maxRetryCount/)
  })

  it('accepts the whole legal range and defaults to the ceiling', async () => {
    const adapter = new ScriptedAdapter([textResponse('done')])
    const { ctx } = await harness(adapter, { withPolicy: false })
    context = ctx
    expect(() => { policy.apply(ctx, {}) }).not.toThrow()
    expect(() => { policy.apply(ctx, { maxRetryCount: 0 }) }).not.toThrow()
    expect(() => { policy.apply(ctx, { maxRetryCount: policy.MAX_AUTOMATIC_RETRIES }) }).not.toThrow()
  })
})
