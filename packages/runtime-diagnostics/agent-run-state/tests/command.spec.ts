import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRunStateService, { agentRunDiagnosticsView } from '@deepseek-ai/dsh-agent-run-state'
import * as AgentRunStateCommand from '@deepseek-ai/dsh-agent-run-state/command'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  await ctx.plugin(AgentRunStateCommand)
  const session = ctx.sessions.create(SessionId('diagnostics-command'))
  const agent = { session } as unknown as Agent
  return { ctx, session, agent }
}

describe('read-only diagnostics view', () => {
  it('represents a missing run with explicit unknown and null fields', async () => {
    const { ctx, session } = await harness()
    expect(agentRunDiagnosticsView(session.header.id, ctx.agentRunState.diagnostics(session))).toMatchObject({
      session_id: 'diagnostics-command',
      run_id: null,
      attempt_id: null,
      phase: 'unknown',
      health: 'unknown',
      processHealth: 'unknown',
      primaryError: null,
      secondaryErrors: [],
    })
  })

  it('serves the requested identity, route, health, activity, prefill, and error fields as JSON', async () => {
    const { ctx, session, agent } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'local', model: 'mlx' } },
      reason: 'initial',
    })
    const result = await ctx.commands.execute(agent, '/agent_run_state', [], new AbortController().signal)
    const text = result?.result.text
    if (text === undefined) throw new Error('diagnostics command returned no text')
    expect(JSON.parse(text)).toMatchObject({
      session_id: 'diagnostics-command',
      provider: 'local',
      model: 'mlx',
      phase: 'preparing_context',
      health: 'unknown',
      processHealth: 'unknown',
      modelHealth: 'unknown',
      generationHealth: 'unknown',
      prefill: null,
      primaryError: null,
      secondaryErrors: [],
    })
    await expect(ctx.commands.execute(
      agent,
      '/agent_run_state unexpected',
      [],
      new AbortController().signal,
    )).resolves.toMatchObject({ result: { kind: 'error' } })
  })

  it('preserves partial and complete prefill fields in the JSON-compatible view', async () => {
    const { session } = await harness()
    const base = {
      sessionId: session.id,
      runId: 'run' as never,
      turn: 1,
      startedAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      lastMeaningfulActivityAt: 1,
      phase: 'prefill' as const,
      retryCount: 0,
      reasoning: {},
      context: {},
      health: 'healthy' as const,
      backend: {
        processHealth: 'healthy' as const,
        modelHealth: 'healthy' as const,
        generationHealth: 'active' as const,
        attribution: { kind: 'unknown' as const },
        prefill: { source: 'backend-log' as const, confidence: 'provisional' as const },
      },
      secondaryErrors: [],
    }
    expect(agentRunDiagnosticsView(session.id, {
      run: base,
      staleThresholdMs: 5_000,
      unattributedBackendObservations: [],
    }).prefill).toEqual({
      processed: null,
      total: null,
      speed: null,
      source: 'backend-log',
      confidence: 'provisional',
    })
    expect(agentRunDiagnosticsView(session.id, {
      run: { ...base, backend: { ...base.backend, prefill: { ...base.backend.prefill, current: 1, total: 2, speed: 3 } } },
      staleThresholdMs: 5_000,
      unattributedBackendObservations: [],
    }).prefill).toMatchObject({ processed: 1, total: 2, speed: 3 })

    expect(agentRunDiagnosticsView(session.id, {
      run: {
        ...base,
        cancellation: { status: 'confirmed', requestedAt: 2, resolvedAt: 3 },
      },
      staleThresholdMs: 5_000,
      unattributedBackendObservations: [],
    }).cancellation).toEqual({ status: 'confirmed', requestedAt: 2, resolvedAt: 3 })
  })
})
