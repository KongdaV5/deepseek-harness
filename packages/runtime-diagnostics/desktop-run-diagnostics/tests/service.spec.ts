import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import { FakeBackendObserver, FakeWorker } from '@deepseek-ai/dsh-agent-run-state/testing'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import DesktopRunDiagnosticsService from '../src/index.ts'

async function harness(id: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  await ctx.plugin(DesktopRunDiagnosticsService, { coalesceMs: 10, elapsedRefreshMs: 10, maxResumeContextTokens: 8_192 })
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const run = ctx.agentRunState.diagnostics(session).run!
  const observer = new FakeBackendObserver(`${id}-observer`)
  const dispose = ctx.agentRunState.registerObserver(observer)
  return { ctx, agent: { session } as Agent, run, worker: new FakeWorker(observer), dispose }
}

describe('Desktop Run diagnostics Remote projection', () => {
  it('returns a versioned terminal-safe view rather than raw backend observations', async () => {
    const { ctx, agent, run, worker, dispose } = await harness('desktop-transport')
    worker.observe({
      attribution: { kind: 'run', runId: run.runId },
      observedAt: run.startedAt + 1,
      lastActivityAt: run.startedAt + 1,
      processHealth: 'healthy', modelHealth: 'healthy', generationHealth: 'fatal',
      failure: { error: '[metal::malloc] Resource limit (499000) exceeded' },
    })
    const snapshot = ctx.desktopRunDiagnostics.snapshot(agent)
    expect(snapshot).toMatchObject({
      version: 1,
      run: {
        health: 'fatal',
        backend: { processHealth: 'healthy', generationHealth: 'fatal' },
        primaryError: { code: 'RESOURCE_LIMIT' },
      },
    })
    expect('unattributedBackendObservations' in snapshot).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('failure')
    dispose()
  })

  it('begins a stream with a complete snapshot and stops with caller cancellation', async () => {
    const { ctx, agent, dispose } = await harness('desktop-stream')
    const controller = new AbortController()
    const iterator = ctx.desktopRunDiagnostics.watch(agent, controller.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({ version: 1, revision: 1 })
    controller.abort()
    expect((await iterator.next()).done).toBe(true)
    dispose()
  })
})
