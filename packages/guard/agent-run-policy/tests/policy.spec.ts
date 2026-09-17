import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentRunStateService, { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { FakeBackendObserver, FakeWorker } from '@deepseek-ai/dsh-agent-run-state/testing'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, decideRunRetry } from '../src/index.ts'
import { FakeClock } from '../src/testing.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(id: string, maxRetryCount = 2, useSystemClock = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  const clock = new FakeClock(10_000)
  const config = {
    observerId: `${id}-policy`,
    providers: ['local'],
    maxRetryCount,
    cancellationConfirmationMs: 500,
  }
  if (useSystemClock) apply(ctx, config)
  else apply(ctx, config, { clock })
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'local', model: 'mlx' } },
    reason: 'initial',
  })
  const agent = { session } as Agent
  const backend = new FakeBackendObserver(`${id}-backend`)
  const worker = new FakeWorker(backend)
  ctx.agentRunState.registerObserver(backend)
  const runId = runIdFor(session.id, 1)
  return { ctx, clock, session, agent, backend, worker, runId }
}

function active(runId: ReturnType<typeof runIdFor>, time: number) {
  return {
    attribution: { kind: 'run' as const, runId },
    observedAt: time,
    lastActivityAt: time,
    activity: 'prefill' as const,
    processHealth: 'healthy' as const,
    modelHealth: 'healthy' as const,
    generationHealth: 'active' as const,
    generationActivity: {
      state: 'active' as const,
      source: 'backend-log' as const,
      confidence: 'provisional' as const,
    },
  }
}

async function requestError(
  subject: Awaited<ReturnType<typeof harness>>,
  code: string,
  signal = new AbortController().signal,
): Promise<number> {
  let downstream = 0
  await agentEvents(subject.ctx, subject.agent).waterfall('agent/request-error', {
    turn: 1,
    step: 1,
    provider: 'local',
    failure: { code, message: code },
    retryPolicy: undefined,
    signal,
  }, () => {
    downstream += 1
    return Promise.resolve({ kind: 'retry' as const })
  })
  return downstream
}

describe('retry matrix', () => {
  it('allows a bounded transient transport retry and publishes its effective budget', async () => {
    const subject = await harness('transport', 1)
    expect(await requestError(subject, 'TRANSPORT')).toBe(1)
    expect(subject.backend.probes).toBe(1)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run).toMatchObject({
      retryCount: 0,
      maxRetryCount: 1,
      retryReason: 'TRANSPORT',
    })
  })

  it.each([
    ['RESOURCE_LIMIT', 'fatal'],
    ['WORKER_CRASH', 'fatal'],
    ['MODEL_LOAD_FAILED', 'fatal'],
    ['INVALID_MODEL_CONFIG', 'degraded'],
    ['INVALID_REASONING_PARAMETER', 'degraded'],
    ['CLIENT_CANCELLED', 'degraded'],
    ['CONTEXT_OVERFLOW', 'degraded'],
    ['GENERATION_STALLED', 'degraded'],
  ] as const)('denies %s without entering downstream retry', async (code, health) => {
    const subject = await harness(`deny-${code}`)
    const run = subject.ctx.agentRunState.diagnostics(subject.session).run!
    const decision = decideRunRetry({
      failure: { code, message: code },
      retryCount: 0,
      maxRetryCount: 2,
      signalAborted: false,
      run: { ...run, health },
    })
    expect(decision).toEqual({ kind: 'deny', reason: code })
  })

  it('denies a transport retry after the configured budget is consumed', async () => {
    const subject = await harness('exhausted', 1)
    const run = subject.ctx.agentRunState.diagnostics(subject.session).run!
    expect(decideRunRetry({
      failure: { code: 'TRANSPORT', message: 'temporary' },
      retryCount: 1,
      maxRetryCount: 1,
      signalAborted: false,
      run,
    })).toEqual({ kind: 'deny', reason: 'TRANSPORT' })
  })

  it('denies an unclassified permanent failure and leaves ungoverned providers downstream', async () => {
    const subject = await harness('other-failure')
    const run = subject.ctx.agentRunState.diagnostics(subject.session).run!
    expect(decideRunRetry({
      failure: { code: 'OTHER', message: 'permanent' },
      retryCount: 0,
      maxRetryCount: 2,
      signalAborted: false,
      run,
    })).toEqual({ kind: 'deny', reason: 'UNKNOWN' })

    let downstream = 0
    await agentEvents(subject.ctx, subject.agent).waterfall('agent/request-error', {
      turn: 1,
      step: 1,
      provider: 'remote',
      failure: { code: 'TRANSPORT', message: 'temporary' },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    }, () => {
      downstream += 1
      return Promise.resolve(undefined)
    })
    expect(downstream).toBe(1)
    expect(subject.backend.probes).toBe(0)
  })

  it('does not act on a stale error callback from another turn', async () => {
    const subject = await harness('stale-error')
    let downstream = 0
    await agentEvents(subject.ctx, subject.agent).waterfall('agent/request-error', {
      turn: 2,
      step: 1,
      provider: 'local',
      failure: { code: 'TRANSPORT', message: 'temporary' },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    }, () => {
      downstream += 1
      return Promise.resolve({ kind: 'retry' as const })
    })
    expect(downstream).toBe(0)
    expect(subject.backend.probes).toBe(1)
  })

  it('Case D/J: refreshed Metal fatal overrides SERVER and healthy process evidence', async () => {
    const subject = await harness('metal')
    subject.worker.observe({
      ...active(subject.runId, subject.clock.now()),
      processHealth: 'healthy',
      generationHealth: 'fatal',
      generationActivity: { state: 'inactive', source: 'backend-log', confidence: 'confirmed' },
      failure: { error: 'RuntimeError: [metal::malloc] Resource limit (499000) exceeded.' },
    })
    expect(await requestError(subject, 'SERVER')).toBe(0)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run).toMatchObject({
      health: 'fatal',
      retryCount: 0,
      maxRetryCount: 2,
      retryReason: 'RESOURCE_LIMIT',
      primaryError: { code: 'RESOURCE_LIMIT' },
      backend: { processHealth: 'healthy', generationHealth: 'fatal' },
    })
  })

  it('Case F/G: invalid reasoning and caller cancellation are fail-fast', async () => {
    const subject = await harness('fail-fast')
    expect(await requestError(subject, 'INVALID_REASONING_PARAMETER')).toBe(0)
    const cancelled = new AbortController()
    cancelled.abort({ kind: 'user' })
    expect(await requestError(subject, 'TRANSPORT', cancelled.signal)).toBe(0)
  })
})

describe('cancellation acknowledgement', () => {
  async function observeRequest(subject: Awaited<ReturnType<typeof harness>>, controller: AbortController): Promise<void> {
    await agentEvents(subject.ctx, subject.agent).waterfall('agent/request', {
      turn: 1,
      step: 1,
      signal: controller.signal,
    }, () => Promise.resolve({ provider: 'local', model: 'mlx' }))
  }

  it('Case H: confirms cancellation only after confirmed generation disappearance', async () => {
    const subject = await harness('cancel-confirmed')
    subject.worker.observe(active(subject.runId, subject.clock.now()))
    const controller = new AbortController()
    await observeRequest(subject, controller)
    controller.abort({ kind: 'user' })
    expect(subject.ctx.agentRunState.diagnostics(subject.session, subject.clock.now()).run?.cancellation)
      .toEqual({ status: 'requested', requestedAt: 10_000 })

    subject.clock.advance(100)
    subject.worker.observe({
      ...active(subject.runId, subject.clock.now()),
      generationHealth: 'unknown',
      generationActivity: { state: 'inactive', source: 'callback', confidence: 'confirmed' },
    })
    expect(subject.ctx.agentRunState.diagnostics(subject.session, subject.clock.now()).run?.cancellation)
      .toEqual({ status: 'confirmed', requestedAt: 10_000, resolvedAt: 10_100 })
    expect(subject.clock.pendingTimers).toBe(0)
    subject.worker.observe({
      ...active(subject.runId, subject.clock.now()),
      generationActivity: { state: 'inactive', source: 'callback', confidence: 'confirmed' },
    })
    expect(subject.ctx.agentRunState.diagnostics(subject.session, subject.clock.now()).run?.cancellation?.status)
      .toBe('confirmed')
  })

  it('confirms immediately when the backend already reports generation inactive', async () => {
    const subject = await harness('cancel-already-inactive')
    subject.worker.observe({
      ...active(subject.runId, subject.clock.now()),
      generationActivity: { state: 'inactive', source: 'callback', confidence: 'confirmed' },
    })
    const controller = new AbortController()
    await observeRequest(subject, controller)
    await observeRequest(subject, controller)
    controller.abort({ kind: 'user' })
    expect(subject.ctx.agentRunState.diagnostics(subject.session, subject.clock.now()).run?.cancellation)
      .toEqual({ status: 'confirmed', requestedAt: 10_000, resolvedAt: 10_000 })
    expect(subject.clock.pendingTimers).toBe(0)
  })

  it('ignores cancellation acknowledgement when no Run has started', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
    const clock = new FakeClock(10_000)
    apply(ctx, {
      observerId: 'no-run-policy', providers: ['local'], maxRetryCount: 1, cancellationConfirmationMs: 500,
    }, { clock })
    const agent = { session: ctx.sessions.create(SessionId('no-run')) } as Agent
    const controller = new AbortController()
    await agentEvents(ctx, agent).waterfall('agent/request', {
      turn: 1, step: 1, signal: controller.signal,
    }, () => Promise.resolve({ provider: 'local', model: 'mlx' }))
    controller.abort({ kind: 'user' })
    expect(ctx.agentRunState.diagnostics(agent.session).run).toBeNull()
    expect(clock.pendingTimers).toBe(0)
  })

  it('handles an already-aborted request through the production clock and clears its timer on confirmation', async () => {
    const subject = await harness('cancel-production-clock', 1, true)
    subject.worker.observe(active(subject.runId, Date.now()))
    const controller = new AbortController()
    controller.abort({ kind: 'user' })
    await observeRequest(subject, controller)
    subject.worker.observe({
      ...active(subject.runId, Date.now()),
      generationActivity: { state: 'inactive', source: 'callback', confidence: 'confirmed' },
    })
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run?.cancellation?.status).toBe('confirmed')
  })

  it('Case I: marks cancellation unconfirmed when generation remains active through the window', async () => {
    const subject = await harness('cancel-unconfirmed')
    subject.worker.observe(active(subject.runId, subject.clock.now()))
    const controller = new AbortController()
    await observeRequest(subject, controller)
    controller.abort({ kind: 'user' })
    subject.clock.advance(500)
    expect(subject.ctx.agentRunState.diagnostics(subject.session, subject.clock.now()).run).toMatchObject({
      health: 'degraded',
      cancellation: { status: 'unconfirmed', requestedAt: 10_000, resolvedAt: 10_500 },
    })
  })

  it('drains an in-flight cancellation probe before a policy fiber can unload', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
    const clock = new FakeClock(10_000)
    const session = ctx.sessions.create(SessionId('cancel-dispose-race'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'local', model: 'mlx' } },
      reason: 'initial',
    })
    const agent = { session } as Agent
    const backend = new FakeBackendObserver('cancel-dispose-race-backend')
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve })
    backend.probe = () => probeGate
    ctx.agentRunState.registerObserver(backend)
    const policy = await ctx.plugin(Object.assign((inner: Context) => {
      apply(inner, {
        observerId: 'cancel-dispose-race-policy',
        providers: ['local'],
        maxRetryCount: 1,
        cancellationConfirmationMs: 500,
      }, { clock })
    }, { inject: ['agentRunState'] }))

    const controller = new AbortController()
    await agentEvents(ctx, agent).waterfall('agent/request', {
      turn: 1, step: 1, signal: controller.signal,
    }, () => Promise.resolve({ provider: 'local', model: 'mlx' }))
    controller.abort({ kind: 'user' })

    let disposed = false
    const disposing = policy.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseProbe()
    await disposing
    expect(clock.pendingTimers).toBe(0)
  })
})

describe('configuration', () => {
  it.each([
    [{ observerId: '', providers: ['local'], maxRetryCount: 1, cancellationConfirmationMs: 1 }, /observerId/],
    [{ observerId: 'x', providers: [], maxRetryCount: 1, cancellationConfirmationMs: 1 }, /providers/],
    [{ observerId: 'x', providers: ['local', 'local'], maxRetryCount: 1, cancellationConfirmationMs: 1 }, /duplicates/],
    [{ observerId: 'x', providers: ['local'], maxRetryCount: 3, cancellationConfirmationMs: 1 }, /maxRetryCount/],
    [{ observerId: 'x', providers: ['local'], maxRetryCount: 1, cancellationConfirmationMs: 0 }, /cancellationConfirmationMs/],
  ] as const)('rejects invalid config %#', async (config, expected) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRunStateService, { slowAfterMs: 1, stalledAfterMs: 2 })
    expect(() => { apply(ctx, config as never) }).toThrow(expected)
  })

  it('FakeClock validates advances and cancellation is idempotent', () => {
    const clock = new FakeClock()
    const order: number[] = []
    const handle = clock.setTimeout(() => { order.push(3) }, 1)
    clock.setTimeout(() => { order.push(2) }, 2)
    clock.setTimeout(() => { order.push(1) }, 2)
    clock.clearTimeout(handle)
    clock.clearTimeout('unknown')
    clock.advance(2)
    expect(order).toEqual([2, 1])
    expect(clock.pendingTimers).toBe(0)
    expect(() => { clock.advance(-1) }).toThrow(/non-negative/)
  })
})
