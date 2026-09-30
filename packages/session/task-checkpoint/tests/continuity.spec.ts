/**
 * The Stage 8 continuity seam on a live Session.
 *
 * These tests drive real committed turns through the Session store so the
 * `session/event` publication path, the `turnBoundary` projection, and the
 * deferred checkpoint write are exercised exactly as they are in production.
 * The central claim — that a Task adopts the Run whose `turn/start` already
 * committed, and never a predicted one — is asserted on the committed log.
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'
import TaskCheckpoint, { taskIdFromString, taskStepIdFromString } from '@deepseek-ai/dsh-task-checkpoint'
import type { CreateTaskCheckpointInput, TaskCheckpoint as TaskCheckpointValue } from '@deepseek-ai/dsh-task-checkpoint'

const sessionId = SessionId('task-continuity')
const task = taskIdFromString('task-1')
const step1 = taskStepIdFromString('step-1')
const step2 = taskStepIdFromString('step-2')

const execution = { provider: 'deepseek', model: 'chat' }
const resumeContext = { objective: 'write the report', constraints: [], decisions: [], criticalContext: [] }
const budget = { estimatedTokens: 10, maxTokens: 100, includedSections: ['task'], omittedSections: [] }

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A Cordis context with the session store, the projections, and the service. */
async function runtime(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(TaskCheckpoint)
  return ctx
}

/** A live Session from {@link runtime}. */
async function harness(id = sessionId): Promise<{ ctx: Context; session: Session }> {
  const ctx = await runtime()
  return { ctx, session: ctx.sessions.create(id) }
}

/** Commit one closed durable turn. */
function commitTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Commit every turn from 1 through `last`. */
function commitTurns(session: Session, last: number): void {
  for (let turn = 1; turn <= last; turn += 1) commitTurn(session, turn)
}

/** Let the deferred seam step run. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/** Open the standard Task through the service, attributed to the Run of `originTurn`. */
function openTask(ctx: Context, session: Session, originTurn: number): TaskCheckpointValue {
  const input: CreateTaskCheckpointInput = {
    taskId: task,
    taskType: 'report',
    originTurn,
    execution,
    pendingSteps: [{ id: step1, title: 'Draft' }, { id: step2, title: 'Review' }],
    resumeContext,
  }
  return ctx.taskCheckpoints.createCheckpoint(session, input)
}

/** Capture logger warnings so a contained failure is observable. */
function captureWarnings(ctx: Context): string[] {
  const warnings: string[] = []
  ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  return warnings
}

/** The seq of every committed event of one type. */
const seqsOfType = (events: readonly { readonly type: string }[], type: string): number[] =>
  events.flatMap((event, seq) => event.type === type ? [seq] : [])

/** The same event as a pre-seam writer stored it: a lossless payload with no envelope marker. */
function asLegacyStored(event: SessionEvent): SessionEvent {
  const stored = JSON.parse(JSON.stringify(event)) as Record<string, unknown>
  delete stored['ignorable']
  return stored as SessionEvent
}

describe('post-turn-start resume seam', () => {
  it('adopts the Run of the turn that actually started, after its turn/start committed', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    const opened = openTask(ctx, session, 3)
    expect(opened.originRunId).toBe(runIdFor(session.id, 3))
    expect(opened.latestRunId).toBe(runIdFor(session.id, 3))

    const armed = ctx.taskCheckpoints.armResume(session, { taskId: task, requestedAt: 20, context: budget })
    expect(armed.armed).toBe(true)
    expect(armed.decision.decision).toBe('allowed')
    expect(armed.decision.plan).toEqual([step1, step2])
    // Arming writes nothing durable: only the origin revision exists so far.
    expect(seqsOfType(session.snapshotEvents(), 'plugin:task/checkpoint')).toHaveLength(1)

    session.append('turn/start', { turn: 4 })
    await settle()

    const resumed = ctx.taskCheckpoints.diagnostics(session).task
    expect(resumed?.revision).toBe(2)
    expect(resumed?.status).toBe('running')
    expect(resumed?.originRunId).toBe(runIdFor(session.id, 3))
    expect(resumed?.latestRunId).toBe(runIdFor(session.id, 4))
    expect(resumed?.latestResume?.runId).toBe(runIdFor(session.id, 4))
    expect(resumed?.latestResume?.executionPlan).toEqual([step1, step2])

    // The adoption is ordered after the durable turn/start it was derived from,
    // and it travelled the ignorable single-writer path at the next seq.
    const events = session.snapshotEvents()
    const startSeq = events.findIndex(event => event.type === 'turn/start' && event.data.turn === 4)
    const checkpoints = seqsOfType(events, 'plugin:task/checkpoint')
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[1]).toBeGreaterThan(startSeq)
    expect(events[checkpoints[1]!]?.ignorable).toBe(true)
    expect(events[checkpoints[1]!]?.seq).toBe(checkpoints[1])
  })

  it('keeps the admission inert until a turn actually starts', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    openTask(ctx, session, 3)

    const armed = ctx.taskCheckpoints.armResume(session, { taskId: task, context: budget })
    expect(armed.armed).toBe(true)
    await settle()

    // No turn, no Run identity, no revision: the admission is process-local.
    expect(ctx.taskCheckpoints.diagnostics(session).task?.revision).toBe(1)
    expect(ctx.taskCheckpoints.diagnostics(session).task?.latestResume).toBeUndefined()
  })

  it('refuses a nested append from a Session observer, which is why the write is deferred', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    openTask(ctx, session, 3)
    ctx.taskCheckpoints.armResume(session, { taskId: task, context: budget })

    // An observer that writes eagerly proves the publication latch is the only
    // obstacle, and that clearing it needs exactly one deferral.
    let nested = ''
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'turn/start') return
      try {
        session.append('turn/end', { turn: event.data.turn, reason: { kind: 'completed' } })
      } catch (error: unknown) {
        nested = (error as Error).message
      }
    })

    session.append('turn/start', { turn: 4 })
    await settle()

    expect(nested).toContain('cannot reenter while another append is being published')
    // The deferred write from the same publication stack succeeded afterwards.
    expect(ctx.taskCheckpoints.diagnostics(session).task?.latestRunId).toBe(runIdFor(session.id, 4))
  })

  it('discards an admission after its durable Task revision changes', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    const opened = openTask(ctx, session, 3)
    ctx.taskCheckpoints.armResume(session, { taskId: task, context: budget })
    // A newer Task boundary now owns the unfinished work, so the admitted plan
    // no longer describes it.
    ctx.taskCheckpoints.advanceCheckpoint(session, {
      expectedRevision: 1,
      latestTurn: 3,
      checkpoint: {
        ...opened,
        revision: 2,
        pendingSteps: [{ id: step2, title: 'Review' }],
        lastActivityAt: opened.lastActivityAt + 1,
      },
    })
    const warnings = captureWarnings(ctx)

    session.append('turn/start', { turn: 4 })
    await settle()

    expect(warnings).toEqual([])
    // Fail-closed: the newer revision stands and no Run was adopted.
    const current = ctx.taskCheckpoints.diagnostics(session).task
    expect(current?.revision).toBe(2)
    expect(current?.latestRunId).toBe(runIdFor(session.id, 3))
    expect(current?.latestResume).toBeUndefined()
  })

  it('drops an admission the caller withdrew before any turn started', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    openTask(ctx, session, 3)
    ctx.taskCheckpoints.armResume(session, { taskId: task, context: budget })
    expect(ctx.taskCheckpoints.disarmResume(session)).toBe(true)
    expect(ctx.taskCheckpoints.disarmResume(session)).toBe(false)

    session.append('turn/start', { turn: 4 })
    await settle()

    expect(ctx.taskCheckpoints.diagnostics(session).task?.revision).toBe(1)
  })

  it('refuses to arm a resume the policy did not allow', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    const opened = openTask(ctx, session, 3)
    ctx.taskCheckpoints.advanceCheckpoint(session, {
      expectedRevision: 1,
      latestTurn: 3,
      checkpoint: {
        ...opened,
        revision: 2,
        status: 'completed',
        pendingSteps: [],
        lastActivityAt: opened.lastActivityAt + 1,
      },
    })

    const armed = ctx.taskCheckpoints.armResume(session, { taskId: task, context: budget })

    expect(armed.armed).toBe(false)
    expect(armed.decision.decision).toBe('not_applicable')
    expect(armed.decision.reason).toBe('TASK_COMPLETED')
  })

  it('records an explicitly supplied adopted Run through the same guard', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 4)
    openTask(ctx, session, 4)
    session.append('turn/start', { turn: 5 })

    const recorded = ctx.taskCheckpoints.recordAcceptedResume(session, {
      turn: 5,
      taskId: task,
      requestedAt: 20,
      executionPlan: [step1, step2],
      context: budget,
    })

    expect(recorded.revision).toBe(2)
    expect(recorded.latestRunId).toBe(runIdFor(session.id, 5))
    expect(recorded.latestResume?.runId).toBe(runIdFor(session.id, 5))
  })

  it('run bridge: a Task spanning turn 4 and turn 9 keeps turn 4 as its origin', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 4)
    const opened = openTask(ctx, session, 4)

    // The adjacent continuation is automatic: the Task's Run is still the
    // Session's last Run, so the seam adopts the Run that actually starts.
    ctx.taskCheckpoints.armResume(session, { taskId: task, requestedAt: 20, context: budget })
    session.append('turn/start', { turn: 5 })
    await settle()
    expect(ctx.taskCheckpoints.diagnostics(session).task?.latestRunId).toBe(runIdFor(session.id, 5))

    // The conversation then runs on without this Task. Turns 6–8 explain
    // nothing about it, so the policy refuses to silently skip the Runs between
    // — an unexplained advance is reconciled, never bridged.
    session.append('turn/end', { turn: 5, reason: { kind: 'interrupted' } })
    for (let turn = 6; turn <= 8; turn += 1) commitTurn(session, turn)
    const refused = ctx.taskCheckpoints.armResume(session, { taskId: task, requestedAt: 30, context: budget })
    expect(refused.armed).toBe(false)
    expect(refused.decision.reason).toBe('SESSION_DIVERGED')
    expect(seqsOfType(session.snapshotEvents(), 'plugin:task/checkpoint')).toHaveLength(2)

    // Once that reconciliation is accepted, the caller records the resume against
    // the turn that actually started. The Run is still derived from the durable
    // turn, and the origin is still the first Run the Task ever had.
    session.append('turn/start', { turn: 9 })
    const bridged = ctx.taskCheckpoints.recordAcceptedResume(session, {
      turn: 9,
      taskId: task,
      requestedAt: 30,
      executionPlan: [step1, step2],
      context: budget,
    })

    expect(bridged.revision).toBe(3)
    expect(bridged.originRunId).toBe(opened.originRunId)
    expect(bridged.originRunId).toBe(runIdFor(session.id, 4))
    expect(bridged.latestRunId).toBe(runIdFor(session.id, 9))
    expect(bridged.latestResume?.runId).toBe(runIdFor(session.id, 9))
  })
})

describe('producers through the service', () => {
  it('writes the task stream as an ignorable event and leaves normal append alone', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 4)
    openTask(ctx, session, 4)
    const plain = session.append('turn/start', { turn: 5 })

    expect(Object.hasOwn(plain, 'ignorable')).toBe(false)
    const writes = seqsOfType(session.snapshotEvents(), 'plugin:task/checkpoint')
    expect(writes).toHaveLength(1)
    expect(session.snapshotEvents()[writes[0]!]?.ignorable).toBe(true)
    // One writer, one sequence authority: the write sits at the next seq, and
    // the ordinary append that followed is the current log end.
    expect(writes[0]).toBe(session.seq - 2)
  })

  it('reports an unavailable projection instead of guessing a turn watermark', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TaskCheckpoint)
    const session = ctx.sessions.create(SessionId('task-continuity-unprojected'))

    expect(() => openTask(ctx, session, 1)).toThrow('turnBoundary session projection')
  })
})

describe('cross-reader compatibility', () => {
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false }

  it('admits a producer-written event in this build and stays skippable for a reader that lacks the layer', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    openTask(ctx, session, 3)
    const written = session.snapshotEvents().filter(event => event.type === 'plugin:task/checkpoint')

    // This build knows the type, so the event stays authoritative.
    expect(() => validateStoredEvents({ ...header }, [...written])).not.toThrow()
    // Admission is `known || ignorable`, so a reader without the task layer
    // skips it: the marker is the whole opt-out contract.
    expect(written[0]?.ignorable).toBe(true)

    const unknownOptional = { type: 'task/future-optional', seq: 0, time: 1, data: {}, ignorable: true } as never
    expect(() => validateStoredEvents({ ...header }, [unknownOptional])).not.toThrow()
    const unknownRequired = { type: 'task/future-required', seq: 0, time: 1, data: {} } as never
    expect(() => validateStoredEvents({ ...header }, [unknownRequired]))
      .toThrow('unknown to this harness and not marked ignorable')
  })

  it('keeps a required canonical V4 task event byte-exact through a live restore', async () => {
    // Known V4 events remain required when the producer omitted the optional marker.
    const source = await harness(SessionId('task-continuity-legacy'))
    commitTurns(source.session, 3)
    openTask(source.ctx, source.session, 3)
    const legacy = source.session.snapshotEvents().map(asLegacyStored)

    const legacyId = SessionId('task-continuity-legacy')
    const ctx = await runtime()
    const restored = ctx.sessions.create(legacyId, {
      seed: legacy,
      meta: { createdAt: 1, isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
    })

    const replayed = restored.snapshotEvents()
    // The restored log replays the seeded prefix verbatim; the only addition is
    // the live-log boundary marker the restore itself appends.
    expect(replayed.slice(0, legacy.length)).toEqual(legacy)
    expect(replayed.slice(legacy.length).map(event => event.type)).toEqual(['session/end-seed'])
    // Reading never normalizes a required legacy event into an optional one.
    expect(replayed.some(event => Object.hasOwn(event, 'ignorable'))).toBe(false)
    // A known type is admissible without the marker, so the event is not lost.
    expect(() => validateStoredEvents({ ...header, id: legacyId }, [...replayed])).not.toThrow()
    // The Task still projects, attributed to the Runs its own turns explain.
    expect(ctx.taskCheckpoints.diagnostics(restored).task?.revision).toBe(1)
    expect(ctx.taskCheckpoints.diagnostics(restored).decision.reason).toBe('PENDING_ONLY')

    // The same legacy checkpoint folded into a *different* Session history is not
    // this Session's unfinished work, so it is refused rather than reinterpreted.
    const orphanId = SessionId('task-continuity-orphan')
    const orphan = ctx.sessions.create(orphanId, {
      seed: legacy.filter(event => event.type === 'plugin:task/checkpoint').map(event => ({ ...event, seq: SessionSeq(0) })),
      meta: { createdAt: 1, isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
    })
    expect(ctx.taskCheckpoints.diagnostics(orphan).task?.revision).toBe(1)
    expect(ctx.taskCheckpoints.diagnostics(orphan).decision.reason).toBe('SESSION_DIVERGED')
  })

  it('drops queued adoption when its plugin lifetime is disposed', async () => {
    const { ctx, session } = await harness()
    commitTurns(session, 3)
    openTask(ctx, session, 3)
    expect(ctx.taskCheckpoints.armResume(session, { taskId: task, context: budget }).armed).toBe(true)
    session.append('turn/start', { turn: 4 })
    const committed = session.seq
    await ctx.fiber.dispose()
    await settle()
    expect(session.seq).toBe(committed)
    expect(session.snapshotEvents().filter(event => event.type === 'plugin:task/checkpoint')).toHaveLength(1)
  })

  it('restores authority after restart without restoring a pending admission', async () => {
    const source = await harness()
    commitTurns(source.session, 3)
    openTask(source.ctx, source.session, 3)
    expect(source.ctx.taskCheckpoints.armResume(source.session, { taskId: task, context: budget }).armed).toBe(true)
    const seed = source.session.snapshotEvents()
    await source.ctx.fiber.dispose()
    const ctx = await runtime()
    const session = ctx.sessions.create(sessionId, {
      seed, meta: { createdAt: 1, isSeeded: false }, inheritedEventCount: SessionLogOffset(0),
    })
    expect(ctx.taskCheckpoints.diagnostics(session).task?.latestRunId).toBe(runIdFor(sessionId, 3))
    session.append('turn/start', { turn: 4 })
    await settle()
    expect(ctx.taskCheckpoints.diagnostics(session).task?.revision).toBe(1)
    expect(ctx.taskCheckpoints.diagnostics(session).task?.latestRunId).toBe(runIdFor(sessionId, 3))
    expect(session.snapshotEvents().filter(event => event.type === 'plugin:task/checkpoint')).toHaveLength(1)
  })

  it('uses the canonical Session V4 generation', () => {
    expect(SESSION_FORMAT_VERSION).toBe(4)
  })
})
