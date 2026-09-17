import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import { agentRunStateProjectionDefinition, applyAgentRunEvent } from '@deepseek-ai/dsh-agent-run-state'
import type { AgentRunState } from '@deepseek-ai/dsh-agent-run-state'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm-retry/types'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  const session = ctx.sessions.create(SessionId('projection'))
  return { ctx, session }
}

describe('durable AgentRunState projection', () => {
  it('projects a retry as a new attempt in the same run', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const before = ctx.sessionProjections.snapshot(session).values.agentRunState!
    session.append('llm/retry', {
      retryId: 'retry' as never,
      turn: 1,
      step: 1,
      provider: 'local',
      mode: 'normal',
      policyKey: 'test',
      retry: 1,
      maxRetries: 2,
      delayMs: 0,
      failure: { code: 'SERVER', message: 'temporary' },
    })
    session.append('llm/retry-started', { retryId: 'retry' as never, turn: 1, step: 1, retry: 1 })
    const after = ctx.sessionProjections.snapshot(session).values.agentRunState!
    expect(after.runId).toBe(before.runId)
    expect(after.attempt?.attemptId).not.toBe(before.attempt?.attemptId)
    expect(after.attempt?.ordinal).toBe(2)
    expect(after.retryCount).toBe(1)
    expect(after.primaryError).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', severity: 'degraded' })
  })

  it('distinguishes requested from adapter-default reasoning and projects context only', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: {
        config: { provider: 'local', model: 'model', reasoningEffort: 'high' as never },
        adapterDefaults: { reasoningEffort: true },
      },
    })
    session.append('request/context', { provider: 'local', model: 'model', contextWindow: 32_768 })
    expect(ctx.sessionProjections.snapshot(session).values.agentRunState).toMatchObject({
      provider: 'local',
      model: 'model',
      reasoning: { resolvedReasoning: 'high' },
      context: { contextWindow: 32_768 },
    })
    expect(ctx.sessionProjections.snapshot(session).values.agentRunState?.reasoning.requestedReasoning).toBeUndefined()
  })

  it('persists cancellation as the primary error and completes without backend facts', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(ctx.sessionProjections.snapshot(session).values.agentRunState).toMatchObject({
      phase: 'cancelled',
      health: 'degraded',
      primaryError: { code: 'CLIENT_CANCELLED' },
      backend: { attribution: { kind: 'unknown' } },
    })
  })
})

function at(time: number, type: string, data: unknown): SessionEvent {
  return { type, seq: time, time, data } as unknown as SessionEvent
}

function fold(events: readonly SessionEvent[]): AgentRunState | null {
  return events.reduce<AgentRunState | null>(
    (state, event) => applyAgentRunEvent({ id: SessionId('pure') }, state, event),
    null,
  )
}

describe('pure durable fold event coverage', () => {
  it('ignores events until a run starts and events for another turn', () => {
    expect(fold([at(1, 'step/start', { turn: 1, step: 1 })])).toBeNull()
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 2, step: 1 }),
      at(3, 'assistant/attempt', { turn: 2, step: 1, stream: [] }),
      at(4, 'tool/call', { turn: 2, step: 1, callId: 'x', name: 'read', arguments: '{}' }),
      at(5, 'llm/retry', { turn: 2, step: 1 }),
      at(6, 'llm/retry-started', { turn: 2, step: 1, retry: 1 }),
      at(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    expect(state).toMatchObject({ phase: 'starting', turn: 1 })
  })

  it('folds explicit reasoning, assistant usage, tools, and stream phases', () => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'request/header', {
        header: { config: { provider: 'local', model: 'm', reasoningEffort: 'high' } }, reason: 'initial',
      }),
      at(4, 'request/context', { provider: 'local', model: 'm' }),
      at(5, 'assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [
          { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
          { type: 'chunk', time: 4, chunk: { type: 'reasoning-delta', index: 0, text: 'r' } },
          { type: 'chunk', time: 5, chunk: { type: 'text-delta', index: 1, text: 'x' } },
          { type: 'chunk', time: 6, chunk: { type: 'tool-call-delta', index: 2, id: 'c', argumentsDelta: '{}' } },
        ],
      }),
      at(6, 'assistant/message', {
        turn: 1,
        step: 1,
        stream: [{ type: 'chunk', time: 6, chunk: { type: 'reasoning-delta', index: 0, text: 'r' } }],
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
      }),
      at(7, 'tool/call', { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' }),
      at(8, 'tool/result', { turn: 1, step: 1, message: {} }),
    ])
    expect(state).toMatchObject({
      phase: 'preparing_context',
      reasoning: { requestedReasoning: 'high', resolvedReasoning: 'high' },
      context: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
    })
    expect(state?.currentTool).toBeUndefined()
  })

  it('folds tool-call delta names, missing usage, and current tools', () => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        stream: [{
          type: 'chunk', time: 3,
          chunk: { type: 'tool-call-delta', index: 0, id: 'c', name: 'read', argumentsDelta: '' },
        }],
      }),
      at(4, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' }),
    ])
    expect(state).toMatchObject({ phase: 'tool_wait', currentTool: { callId: 'c', name: 'read' }, context: {} })
  })

  it.each([
    [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [0], texts: ['r'] }, 'reasoning'],
    [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [0], texts: [''] }, 'preparing_context'],
    [{ type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: ['t'] }, 'generating'],
    [{ type: 'tool-call-chunks', time0: 1, index: 0, dt: [0], id: 'c', name: 'read', args: [''] }, 'generating'],
    [{ type: 'tool-call-chunks', time0: 1, index: 0, dt: [0], id: 'c', args: ['{}'] }, 'generating'],
    [{ type: 'tool-call-chunks', time0: 1, index: 0, dt: [0], id: 'c', args: [''] }, 'preparing_context'],
    [{ type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: [''] }, 'preparing_context'],
  ] as const)('reads compacted durable stream record %#', (record, phase) => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'assistant/attempt', { turn: 1, step: 1, stream: [record] }),
    ])
    expect(state?.phase).toBe(phase)
  })

  it('keeps absent reasoning/context/cache and ignores mismatched tool results', () => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' }),
      at(3, 'request/context', { provider: 'p', model: 'm' }),
      at(4, 'assistant/message', {
        turn: 1, step: 1, stream: [], usage: { inputTokens: 1, outputTokens: 2 },
      }),
      at(5, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' }),
      at(6, 'tool/result', { turn: 2, step: 1, message: {} }),
    ])
    expect(state).toMatchObject({ phase: 'tool_wait', reasoning: {}, context: { inputTokens: 1, outputTokens: 2 } })
  })

  it('folds retry modes and compaction boundaries', () => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'llm/retry', {
        retryId: 'r', turn: 1, step: 1, provider: 'p', mode: 'always', policyKey: 'p', retry: 1,
        delayMs: 10, failure: { code: 'SERVER', message: 'first' },
      }),
      at(4, 'llm/retry-started', { retryId: 'r', turn: 1, step: 1, retry: 1 }),
      at(5, 'compaction/start', { compactionId: 'c', turn: 2 }),
      at(6, 'compaction/start', { compactionId: 'c', turn: 1 }),
      at(7, 'compaction/end', { compactionId: 'c', turn: 2 }),
      at(8, 'compaction/end', { compactionId: 'c', turn: 1 }),
    ])
    expect(state).toMatchObject({ phase: 'preparing_context', retryCount: 1, attempt: { ordinal: 2 } })
    expect(state?.maxRetryCount).toBeUndefined()
  })

  it.each([
    ['completed', 'completed', 'healthy', undefined],
    ['error', 'failed', 'degraded', 'PROVIDER_UNAVAILABLE'],
    ['blocked', 'failed', 'degraded', 'BLOCKED'],
    ['max-tokens', 'failed', 'degraded', 'MAX_TOKENS'],
    ['interrupted', 'failed', 'degraded', 'SESSION_INTERRUPTED'],
  ] as const)('folds terminal reason %s', (kind, phase, health, code) => {
    const reason = kind === 'error' ? { kind, error: { code: 'SERVER', message: 'failed' } } : { kind }
    const state = fold([at(1, 'turn/start', { turn: 1 }), at(2, 'turn/end', { turn: 1, reason })])
    expect(state).toMatchObject({ phase, health, completedAt: 2 })
    if (code === undefined) expect(state?.primaryError).toBeUndefined()
    else expect(state?.primaryError?.code).toBe(code)
  })

  it('keeps a fatal prior failure fatal when a later failure arrives', () => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'llm/retry', {
        retryId: 'r', turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'p', retry: 1,
        maxRetries: 2, delayMs: 0, failure: { code: 'RESOURCE_LIMIT', message: 'fatal' },
      }),
      at(4, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'secondary' } } }),
    ])
    expect(state).toMatchObject({ health: 'fatal', primaryError: { code: 'RESOURCE_LIMIT' } })
    expect(state?.secondaryErrors).toHaveLength(1)
  })

  it('replaces the latest projection when a new turn starts', () => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(3, 'turn/start', { turn: 2 }),
    ])
    expect(state).toMatchObject({ turn: 2, phase: 'starting', retryCount: 0 })
  })

  it('validates and views the registered projection state', () => {
    const initial = agentRunStateProjectionDefinition.init({ id: SessionId('definition') } as never)
    expect(agentRunStateProjectionDefinition.stateSchema.parse(initial)).toEqual(initial)
    expect(agentRunStateProjectionDefinition.wire.view(initial)).toBeNull()
    const unchanged = agentRunStateProjectionDefinition.apply(initial, at(1, 'user/message', {}))
    expect(unchanged).toBe(initial)
  })

  it('fails closed on an extension turn-end outcome unknown to this version', () => {
    const state = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'turn/end', { turn: 1, reason: { kind: 'plugin/custom-outcome' } }),
    ])
    expect(state).toMatchObject({ phase: 'failed', health: 'degraded' })
  })
})
