import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import { BackendObserverId, RunControlObserverId, RunDiagnosticsObserverId, runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import type {
  BackendObservation,
  LocalBackendObserver,
  LocalRunControlObserver,
  LocalRunDiagnosticsObserver,
  RunControlObservation,
  RunDiagnosticsObservation,
  RunId,
} from '@deepseek-ai/dsh-agent-run-state'
import { FakeBackendObserver, FakeStream, FakeWorker } from '@deepseek-ai/dsh-agent-run-state/testing'

async function harness(id: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const run = ctx.sessionProjections.snapshot(session).values.agentRunState!
  const observer = new FakeBackendObserver(`${id}-observer`)
  const worker = new FakeWorker(observer)
  const dispose = ctx.agentRunState.registerObserver(observer)
  return { ctx, session, run, observer, worker, dispose }
}

function activeObservation(runId: RunId, time: number) {
  return {
    attribution: { kind: 'run' as const, runId },
    observedAt: time,
    lastActivityAt: time,
    activity: 'prefill' as const,
    processHealth: 'healthy' as const,
    modelHealth: 'healthy' as const,
    generationHealth: 'active' as const,
    prefill: {
      current: 512,
      total: 15_572,
      source: 'backend-log' as const,
      confidence: 'provisional' as const,
    },
  }
}

describe('transient backend activity projection', () => {
  it('Case A: projects controlled prefill without writing high-frequency session events', async () => {
    const { ctx, session, run, worker } = await harness('prefill')
    const eventCount = session.seq
    for (const current of [512, 1_024, 1_536]) {
      worker.observe({
        ...activeObservation(run.runId, run.startedAt + current),
        prefill: { current, total: 15_572, source: 'backend-log', confidence: 'provisional' },
      })
    }
    const current = ctx.agentRunState.diagnostics(session, run.startedAt + 1_536)
    expect(current.run).toMatchObject({
      phase: 'prefill',
      health: 'slow',
      backend: {
        prefill: { current: 1_536, total: 15_572, source: 'backend-log', confidence: 'provisional' },
      },
    })
    expect(session.seq).toBe(eventCount)
  })

  it('Case B: ten minutes without a token is not stalled while prefill advances every two seconds', async () => {
    const { ctx, session, run, worker } = await harness('long-prefill')
    const eventCount = session.seq
    for (let elapsed = 0; elapsed <= 600_000; elapsed += 2_000) {
      worker.observe({
        ...activeObservation(run.runId, run.startedAt + elapsed),
        prefill: {
          current: 512 + elapsed / 2_000,
          total: 15_572,
          source: 'backend-log',
          confidence: 'provisional',
        },
      })
    }
    const now = run.startedAt + 602_000
    expect(ctx.agentRunState.diagnostics(session, now).run?.health).toBe('slow')
    expect(session.seq).toBe(eventCount)
  })

  it('Case C: classifies an active generation with no remaining activity as stalled', async () => {
    const { ctx, session, run, worker } = await harness('stalled')
    worker.observe({
      attribution: { kind: 'run', runId: run.runId },
      observedAt: run.startedAt + 10,
      lastActivityAt: run.startedAt + 10,
      activity: 'generation',
      processHealth: 'healthy',
      modelHealth: 'healthy',
      generationHealth: 'active',
    })
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 5_011).run?.health).toBe('stalled')
  })

  it('Case C recovery: fresh attributed progress moves a stalled run back to slow', async () => {
    const { ctx, session, run, worker } = await harness('stalled-recovery')
    worker.observe(activeObservation(run.runId, run.startedAt + 10))
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 5_011).run?.health).toBe('stalled')

    worker.observe(activeObservation(run.runId, run.startedAt + 5_012))
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 5_013).run).toMatchObject({
      health: 'slow',
      lastMeaningfulActivityAt: run.startedAt + 5_012,
      lastBackendActivityAt: run.startedAt + 5_012,
    })
  })

  it('pulses request activity only for advancing attributed backend progress', async () => {
    const { ctx, run, worker } = await harness('request-activity')
    const activity: number[] = []
    ctx.on('llm/request-activity', (payload) => { activity.push(payload.observedAt) })

    worker.observe(activeObservation(run.runId, run.startedAt + 10))
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 20),
      observedAt: run.startedAt + 30,
      lastActivityAt: run.startedAt + 10,
      activity: 'heartbeat',
    })
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 40),
      attribution: { kind: 'unknown' },
    })
    worker.observe(activeObservation(run.runId, run.startedAt + 50))

    expect(activity).toEqual([run.startedAt + 10, run.startedAt + 50])
  })

  it('Case D: classifies Metal resource limit as fatal and primary', async () => {
    const { ctx, session, run, worker } = await harness('metal')
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 10),
      generationHealth: 'fatal',
      failure: { error: '[metal::malloc] Resource limit (499000) exceeded' },
    })
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 11).run).toMatchObject({
      phase: 'prefill',
      health: 'fatal',
      primaryError: { code: 'RESOURCE_LIMIT', severity: 'fatal' },
    })
  })

  it('Case F: a healthy process cannot hide a fatal generation worker', async () => {
    const { ctx, session, run, worker } = await harness('split-health')
    worker.observe({
      attribution: { kind: 'run', runId: run.runId },
      observedAt: run.startedAt + 10,
      lastActivityAt: run.startedAt + 10,
      processHealth: 'healthy',
      modelHealth: 'healthy',
      generationHealth: 'fatal',
      failure: { error: 'generation worker terminated', kind: 'generation-worker-terminated' },
    })
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 11).run).toMatchObject({
      health: 'fatal',
      backend: { processHealth: 'healthy', generationHealth: 'fatal' },
    })
  })

  it('keeps unknown attribution separate instead of guessing the only active run', async () => {
    const { ctx, session, run, worker } = await harness('unknown-attribution')
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 10),
      attribution: { kind: 'unknown' },
    })
    const diagnostics = ctx.agentRunState.diagnostics(session, run.startedAt + 11)
    expect(diagnostics.run?.backend.attribution).toEqual({ kind: 'unknown' })
    expect(diagnostics.unattributedBackendObservations).toHaveLength(1)
  })

  it('keeps an unknown run and unmapped attempt unattributed', async () => {
    const { ctx, session, run, worker } = await harness('unknown-targets')
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 10),
      attribution: { kind: 'run', runId: runIdFor(SessionId('missing'), 1) },
    })
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 11),
      attribution: { kind: 'attempt', attemptId: 'missing-attempt' as never },
    })
    expect(ctx.agentRunState.diagnostics(session).unattributedBackendObservations[0]?.attribution)
      .toEqual({ kind: 'unknown' })
  })

  it.each([
    ['generation', 'generating'],
    ['model-loading', 'starting'],
    ['heartbeat', 'preparing_context'],
  ] as const)('maps backend activity %s without fabricating prefill', async (activity, phase) => {
    const { ctx, session, run, worker } = await harness(`activity-${activity}`)
    worker.observe({
      attribution: { kind: 'run', runId: run.runId },
      observedAt: run.startedAt + 10,
      activity,
      processHealth: 'healthy',
      modelHealth: 'healthy',
      generationHealth: 'active',
    })
    const state = ctx.agentRunState.diagnostics(session, run.startedAt + 11).run
    expect(state?.phase).toBe(phase)
    expect(state?.backend.prefill).toBeUndefined()
    expect(state?.lastBackendActivityAt).toBeUndefined()
  })

  it('attributes backend activity through a mapped stream attempt', async () => {
    const { ctx, session, run, worker } = await harness('attempt-attribution')
    const agent = { session } as unknown as Agent
    const stream = new FakeStream('mapped', 1, 1)
    ctx.emit('agent/assistant-stream', { agent, frame: stream.start() })
    worker.observe({
      attribution: { kind: 'attempt', attemptId: run.attempt!.attemptId },
      observedAt: run.startedAt + 10,
      lastActivityAt: run.startedAt + 10,
      activity: 'generation',
      processHealth: 'healthy',
      modelHealth: 'healthy',
      generationHealth: 'active',
    })
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 11).run?.backend.attribution.kind).toBe('attempt')
  })

  it('preserves observer-supplied attribution evidence in the merged view', async () => {
    const { ctx, session, run, worker } = await harness('attribution-evidence')
    const agent = { session } as unknown as Agent
    ctx.emit('agent/assistant-stream', { agent, frame: new FakeStream('evidence', 1, 1).start() })
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 10),
      attribution: {
        kind: 'attempt',
        attemptId: run.attempt!.attemptId,
        source: 'request-and-backend-lifecycle',
        confidence: 'provisional',
      },
    })
    expect(ctx.agentRunState.diagnostics(session).run?.backend.attribution).toMatchObject({
      source: 'request-and-backend-lifecycle', confidence: 'provisional',
    })
  })
})

describe('transient policy diagnostics overlays', () => {
  it('merges a correlated external reasoning/context cut without durable writes or lifecycle authority', async () => {
    const { ctx, session, run } = await harness('diagnostics-overlay')
    const listeners = new Set<(observation: RunDiagnosticsObservation) => void>()
    const observer: LocalRunDiagnosticsObserver = {
      id: RunDiagnosticsObserverId('reasoning-policy-fixture'),
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const dispose = ctx.agentRunState.registerDiagnosticsObserver(observer)
    const durableCount = session.seq
    const publish = (observedAt: number) => {
      for (const listener of listeners) listener({
        observerId: observer.id,
        runId: run.runId,
        observedAt,
        reasoning: {
          requestedReasoning: 'high',
          policySelected: 'high',
          resolvedReasoning: 'medium',
          wireValue: 'medium',
          source: 'gguf-backend-capability-fallback',
          capabilityConfidence: 'confirmed',
        },
        context: {
          contextWindow: 65_536,
          projectedPromptTokens: 12_000,
          expectedOutputReserve: 8_192,
          providerSafetyMargin: 4_096,
          effectivePromptBudget: 53_248,
          pressureRatio: 0.225,
          pressureState: 'normal',
        },
      })
    }

    publish(run.startedAt + 10)
    expect(ctx.agentRunState.diagnostics(session).run).toMatchObject({
      phase: 'preparing_context',
      reasoning: { resolvedReasoning: 'medium', wireValue: 'medium', capabilityConfidence: 'confirmed' },
      context: { projectedPromptTokens: 12_000, pressureState: 'normal' },
    })
    expect(session.seq).toBe(durableCount)

    // A late overlay can refresh read-only facts, but cannot resurrect or
    // change terminal lifecycle projection.
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    publish(run.startedAt + 20)
    expect(ctx.agentRunState.diagnostics(session).run).toMatchObject({
      phase: 'completed',
      reasoning: { resolvedReasoning: 'medium' },
      context: { pressureState: 'normal' },
    })
    dispose()
    expect(ctx.agentRunState.diagnostics(session).run?.reasoning.resolvedReasoning).toBeUndefined()
  })
})

describe('transient stream and error projection', () => {
  it('uses FakeStream activity without claiming prefill before evidence', async () => {
    const { ctx, session, run } = await harness('stream')
    const agent = { session } as unknown as Agent
    const stream = new FakeStream('attempt', 1, 1)
    ctx.emit('agent/assistant-stream', { agent, frame: stream.start() })
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 10).run?.phase).toBe('preparing_context')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: stream.chunk(run.startedAt + 20, { type: 'reasoning-delta', index: 0, text: 'thinking' }),
    })
    expect(ctx.agentRunState.diagnostics(session, run.startedAt + 21).run?.phase).toBe('reasoning')
    ctx.emit('agent/assistant-stream', { agent, frame: stream.end() })
  })

  it('covers text, tool-call, empty, unrelated, and unknown-attempt stream frames', async () => {
    const { ctx, session, run } = await harness('stream-variants')
    const agent = { session } as unknown as Agent
    const stream = new FakeStream('variants', 1, 9)
    ctx.emit('agent/assistant-stream', { agent, frame: stream.start() })
    ctx.emit('agent/assistant-stream', {
      agent, frame: stream.chunk(run.startedAt + 1, { type: 'text-delta', index: 0, text: '' }),
    })
    ctx.emit('agent/assistant-stream', {
      agent, frame: stream.chunk(run.startedAt + 2, { type: 'text-delta', index: 0, text: 'answer' }),
    })
    expect(ctx.agentRunState.diagnostics(session).run?.phase).toBe('generating')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: stream.chunk(run.startedAt + 3, {
        type: 'tool-call-delta', index: 0, id: 'c' as never, name: 'read', argumentsDelta: '',
      }),
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: stream.chunk(run.startedAt + 3, {
        type: 'tool-call-delta', index: 0, id: 'c' as never, argumentsDelta: '{}',
      }),
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: stream.chunk(run.startedAt + 3, {
        type: 'tool-call-delta', index: 0, id: 'c' as never, argumentsDelta: '',
      }),
    })
    ctx.emit('agent/assistant-stream', {
      agent, frame: stream.chunk(run.startedAt + 3, { type: 'reasoning-delta', index: 0, text: '' }),
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: stream.chunk(run.startedAt + 4, { type: 'block-start', index: 0, blockType: 'text' }),
    })
    ctx.emit('agent/assistant-stream', { agent, frame: stream.end() })
    ctx.emit('agent/assistant-stream', { agent, frame: stream.end() })
  })

  it('ignores stream and agent errors when no run exists', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRunStateService, { slowAfterMs: 1, stalledAfterMs: 2 })
    const session = ctx.sessions.create(SessionId('empty'))
    const agent = { session } as unknown as Agent
    const stream = new FakeStream('empty', 1, 1)
    ctx.emit('agent/assistant-stream', { agent, frame: stream.start() })
    ctx.emit('agent/error', { agent, turn: 1, step: 1, error: 'ignored' })
    expect(ctx.agentRunState.diagnostics(session).run).toBeNull()
  })

  it('Case E: keeps cancellation primary when BrokenPipe arrives later', async () => {
    const { ctx, session } = await harness('cancel')
    const agent = { session } as unknown as Agent
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('BrokenPipe after disconnect') })
    expect(ctx.agentRunState.diagnostics(session).run).toMatchObject({
      phase: 'cancelled',
      primaryError: { code: 'CLIENT_CANCELLED' },
      secondaryErrors: [{ code: 'STREAM_DISCONNECTED' }],
    })
  })
})

describe('observer registration', () => {
  it('rejects duplicate ids and unsubscribes idempotently', async () => {
    const { ctx, observer, dispose } = await harness('lifecycle')
    expect(observer.subscriberCount).toBe(1)
    expect(() => ctx.agentRunState.registerObserver(new FakeBackendObserver(String(observer.id))))
      .toThrow(/already registered/)
    dispose()
    dispose()
    expect(observer.subscriberCount).toBe(0)
  })

  it('rejects an observation whose identity differs from its observer', async () => {
    const { ctx, run } = await harness('identity-mismatch')
    let publish: ((observation: BackendObservation) => void) | undefined
    const observer: LocalBackendObserver = {
      id: BackendObserverId('strict'),
      subscribe(listener) {
        publish = listener
        return () => {}
      },
    }
    ctx.agentRunState.registerObserver(observer)
    const publishObservation = publish
    if (publishObservation === undefined) throw new Error('observer did not subscribe')
    expect(() => {
      publishObservation({
        ...activeObservation(run.runId, run.startedAt + 1),
        observerId: BackendObserverId('wrong'),
      })
    }).toThrow(/identity does not match/)
  })

  it('notifies subscribers and removes listener/session-owned transient state', async () => {
    const { ctx, session, run, worker } = await harness('subscriptions')
    const agent = { session } as unknown as Agent
    ctx.emit('agent/assistant-stream', { agent, frame: new FakeStream('owned-attempt', 1, 1).start() })
    const seen: string[] = []
    const disposeA = ctx.agentRunState.subscribe(session, diagnostics => seen.push(diagnostics.run?.phase ?? 'none'))
    const disposeB = ctx.agentRunState.subscribe(session, diagnostics => seen.push(`b:${diagnostics.run?.phase ?? 'none'}`))
    worker.observe(activeObservation(run.runId, run.startedAt + 1))
    expect(seen).toContain('prefill')
    expect(seen).toContain('b:prefill')
    disposeA()
    disposeB()
    disposeB()
    const other = ctx.sessions.create(SessionId('subscriptions-other'))
    other.append('turn/start', { turn: 1 })
    other.append('step/start', { turn: 1, step: 1 })
    const otherAgent = { session: other } as unknown as Agent
    const otherStream = new FakeStream('other-attempt', 1, 1)
    ctx.emit('agent/assistant-stream', { agent: otherAgent, frame: otherStream.start() })
    ctx.emit('session/disposed', session)
    expect(ctx.agentRunState.diagnostics(session).run?.backend.attribution).toEqual({ kind: 'unknown' })
  })

  it('validates direct-constructor configuration and disposes registered observers with the service', async () => {
    async function invalid(config: ConstructorParameters<typeof AgentRunStateService>[1]) {
      const subject = new Context()
      await subject.plugin(SessionStore)
      await subject.plugin(SessionProjectionRegistry)
      return () => new AgentRunStateService(subject, config)
    }
    expect(await invalid(null as never)).toThrow(/configuration is required/)
    expect(await invalid({ slowAfterMs: 0, stalledAfterMs: 2 })).toThrow(/slowAfterMs/)
    expect(await invalid({ slowAfterMs: 2, stalledAfterMs: 2 })).toThrow(/stalledAfterMs/)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(AgentRunStateService, { slowAfterMs: 1, stalledAfterMs: 2 })
    const observer = new FakeBackendObserver('disposed')
    ctx.agentRunState.registerObserver(observer)
    let controlSubscribed = true
    ctx.agentRunState.registerControlObserver({
      id: RunControlObserverId('disposed-control'),
      subscribe() {
        return () => { controlSubscribed = false }
      },
    })
    expect(observer.subscriberCount).toBe(1)
    await fiber.dispose()
    expect(observer.subscriberCount).toBe(0)
    expect(controlSubscribed).toBe(false)
  })

  it('isolates control-observer identity, ordering, ownership, and unknown Runs', async () => {
    const { ctx, session, run } = await harness('control-observer')
    let publish: ((observation: RunControlObservation) => void) | undefined
    const observer: LocalRunControlObserver = {
      id: RunControlObserverId('control'),
      subscribe(listener) {
        publish = listener
        return () => { publish = undefined }
      },
    }
    const dispose = ctx.agentRunState.registerControlObserver(observer)
    let publishOther: ((observation: RunControlObservation) => void) | undefined
    const other: LocalRunControlObserver = {
      id: RunControlObserverId('other-control'),
      subscribe(listener) {
        publishOther = listener
        return () => { publishOther = undefined }
      },
    }
    const disposeOther = ctx.agentRunState.registerControlObserver(other)
    expect(() => ctx.agentRunState.registerControlObserver(observer)).toThrow(/already registered/)
    if (publish === undefined) throw new Error('control observer did not subscribe')

    expect(() => publish?.({
      observerId: RunControlObserverId('wrong'),
      runId: run.runId,
      observedAt: run.startedAt + 1,
      retry: { maxRetryCount: 1, reason: 'TRANSPORT' },
    })).toThrow(/identity does not match/)

    publish({
      observerId: observer.id,
      runId: runIdFor(SessionId('missing-control-run'), 1),
      observedAt: run.startedAt + 1,
      retry: { maxRetryCount: 1, reason: 'TRANSPORT' },
    })
    publish({
      observerId: observer.id,
      runId: run.runId,
      observedAt: run.startedAt + 2,
      retry: { maxRetryCount: 2, reason: 'PROVIDER_UNAVAILABLE' },
    })
    publish({
      observerId: observer.id,
      runId: run.runId,
      observedAt: run.startedAt + 1,
      retry: { maxRetryCount: 1, reason: 'TRANSPORT' },
    })
    expect(ctx.agentRunState.diagnostics(session).run).toMatchObject({
      maxRetryCount: 2,
      retryReason: 'PROVIDER_UNAVAILABLE',
    })

    publishOther?.({
      observerId: other.id,
      runId: run.runId,
      observedAt: run.startedAt + 3,
      cancellation: { status: 'unconfirmed', requestedAt: run.startedAt + 2, resolvedAt: run.startedAt + 3 },
    })
    expect(ctx.agentRunState.diagnostics(session).run).toMatchObject({
      health: 'degraded',
      cancellation: { status: 'unconfirmed' },
    })

    dispose()
    dispose()
    expect(ctx.agentRunState.diagnostics(session).run?.maxRetryCount).toBeUndefined()
    expect(publish).toBeUndefined()
    disposeOther()
  })

  it('does not let unconfirmed cancellation downgrade fatal backend evidence', async () => {
    const { ctx, session, run, worker } = await harness('fatal-cancellation')
    let publish: ((observation: RunControlObservation) => void) | undefined
    ctx.agentRunState.registerControlObserver({
      id: RunControlObserverId('fatal-cancellation-control'),
      subscribe(listener) {
        publish = listener
        return () => {}
      },
    })
    worker.observe({
      ...activeObservation(run.runId, run.startedAt + 1),
      generationHealth: 'fatal',
      failure: { error: '[metal::malloc] Resource limit exceeded' },
    })
    publish?.({
      observerId: RunControlObserverId('fatal-cancellation-control'),
      runId: run.runId,
      observedAt: run.startedAt + 2,
      cancellation: { status: 'unconfirmed', requestedAt: run.startedAt + 1, resolvedAt: run.startedAt + 2 },
    })
    expect(ctx.agentRunState.diagnostics(session).run?.health).toBe('fatal')
  })

  it('contains a rejected backend probe without turning it into activity', async () => {
    const { ctx, session, observer: fake } = await harness('probe-failure')
    const observer: LocalBackendObserver = {
      id: BackendObserverId('rejecting-probe'),
      subscribe() { return () => {} },
      probe() { return Promise.reject(new Error('probe unavailable')) },
    }
    ctx.agentRunState.registerObserver(observer)
    await expect(ctx.agentRunState.probe(session)).resolves.toBeUndefined()
    expect(fake.probes).toBe(1)
    const lastActivityAt = ctx.agentRunState.diagnostics(session).run!.lastActivityAt
    expect(ctx.agentRunState.diagnostics(session, lastActivityAt + 5_001).run?.health).toBe('stalled')
  })
})
