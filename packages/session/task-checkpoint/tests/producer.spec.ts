/**
 * The Stage 8 durable producers and the rules that make a Task revision
 * trustworthy: compare-and-set revision advance, immutable origin, append-only
 * completed work, evidence that still resolves to durable success, and result
 * ordering. Every write is asserted on the *committed envelope*, so a producer
 * that quietly used an ordinary append would fail here.
 */

import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { describe, expect, it } from 'vitest'
import {
  appendTaskCheckpointUpdate,
  applyResultManifestProjection,
  applyTaskCheckpointProjection,
  createTaskCheckpoint,
  emptyResultManifestProjection,
  emptyTaskCheckpointProjection,
  publishResultManifest,
  recordAcceptedResume,
  TaskContinuityError,
  taskIdFromString,
  taskOutputIdFromString,
  taskStepIdFromString,
} from '@deepseek-ai/dsh-task-checkpoint'
import type {
  CompletedTaskStep,
  CreateTaskCheckpointInput,
  ResultManifest,
  TaskAuthority,
  TaskCheckpoint,
  TaskCheckpointProjectionState,
} from '@deepseek-ai/dsh-task-checkpoint'

const session = SessionId('task-producer')
const task = taskIdFromString('task-1')
const otherTask = taskIdFromString('task-2')
const step1 = taskStepIdFromString('step-1')
const step2 = taskStepIdFromString('step-2')
const step3 = taskStepIdFromString('step-3')
const output = taskOutputIdFromString('output-1')

/** The Run identity of one committed turn — the only way a test may name a Run. */
const run = (turn: number) => runIdFor(session, turn)

const execution = { provider: 'deepseek', model: 'chat' }
const resumeContext = { objective: 'write the report', constraints: [], decisions: [], criticalContext: [] }
const budget = { estimatedTokens: 10, maxTokens: 100, includedSections: ['task'], omittedSections: [] }

/**
 * The durable facts a producer validates against, folded from the committed log
 * exactly as the projection registry folds them. Tests call the deprecated
 * reader deliberately: observing the log is the sanctioned test use, and a
 * production caller must read the same facts from the projections.
 */
function authorityOf(
  log: Session,
  lastTurn: number,
  evidence: {
    readonly successfulToolResults?: TaskCheckpointProjectionState['successfulToolResults']
  } = {},
): TaskAuthority {
  const events = log.snapshotEvents()
  const folded = events.reduce(applyTaskCheckpointProjection, emptyTaskCheckpointProjection())
  if (folded.failure !== null) throw new Error(`task fold failed: ${folded.failure}`)
  const results = events.reduce(applyResultManifestProjection, emptyResultManifestProjection())
  if (results.failure !== null) throw new Error(`result fold failed: ${results.failure}`)
  return {
    session: log,
    lastTurn,
    openRun: false,
    checkpoint: evidence.successfulToolResults === undefined
      ? folded
      : { ...folded, successfulToolResults: evidence.successfulToolResults },
    results,
  }
}

/** One durable successful tool result, as the task projection would have recorded it. */
const durableResults = (eventSeq = 5, callId = 'call-1') => [{ eventSeq: SessionSeq(eventSeq), callId }]

/** A whole valid completed step citing one durable tool result. */
function completedStep(id = step1, eventSeq = 5): CompletedTaskStep {
  return {
    id,
    title: 'Draft',
    completedAt: 10,
    evidence: { kind: 'tool-result', eventSeq: SessionSeq(eventSeq), callId: 'call-1' },
  }
}

/** Open one Task at revision 1 through the producer. */
function openTask(
  log: Session,
  lastTurn: number,
  overrides: Partial<CreateTaskCheckpointInput> = {},
  evidence: { readonly successfulToolResults?: TaskCheckpointProjectionState['successfulToolResults'] } = {},
): TaskCheckpoint {
  return createTaskCheckpoint(authorityOf(log, lastTurn, evidence), {
    taskId: task,
    taskType: 'report',
    originTurn: lastTurn,
    execution,
    createdAt: 1,
    lastActivityAt: 2,
    pendingSteps: [{ id: step1, title: 'Draft' }, { id: step2, title: 'Review' }],
    resumeContext,
    ...overrides,
  })
}

/** A whole valid result-manifest revision. */
function manifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  return {
    version: 1,
    outputId: output,
    revision: 1,
    taskId: task,
    runId: run(4),
    path: 'report.md',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    execution,
    validation: { status: 'pending', checks: [] },
    ...overrides,
  }
}

/** A durably completed manifestation, the only shape a Task may complete against. */
function completedManifest(revision: number): ResultManifest {
  return manifest({
    revision,
    status: 'completed',
    updatedAt: 3,
    completedAt: 3,
    size: 12,
    checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
    validation: { status: 'passed', checks: [{ id: 'non-empty', status: 'passed' }] },
  })
}

/** The committed event at the log tail. */
function lastEvent(log: Session) {
  const event = log.snapshotEvents().at(-1)
  if (event === undefined) throw new Error('no event committed')
  return event
}

describe('durable Task producers', () => {
  it('creates revision 1 as an ignorable known event carrying the real Run', () => {
    const log = Session.create(session)

    const checkpoint = openTask(log, 4)
    const event = lastEvent(log)

    expect(checkpoint.revision).toBe(1)
    expect(checkpoint.originRunId).toBe(run(4))
    expect(checkpoint.latestRunId).toBe(run(4))
    expect(event.type).toBe('task/checkpoint')
    expect(event.ignorable).toBe(true)
    expect(event.data).toEqual({ kind: 'task/checkpoint', version: 1, checkpoint })
  })

  it('refuses an origin turn that has not committed, before anything is written', () => {
    const log = Session.create(session)

    const call = () => openTask(log, 4, { originTurn: 5 })
    expect(call).toThrow(TaskContinuityError)
    expect(call).toThrow('only 4 durable turn(s) have committed')
    expect(log.seq).toBe(SessionSeq(0))
  })

  it('refuses a non-positive origin turn', () => {
    expect(() => openTask(Session.create(session), 4, { originTurn: 0 }))
      .toThrow('must be a positive safe integer')
  })

  it('refuses a second Task while another one is still open', () => {
    const log = Session.create(session)
    openTask(log, 4)

    expect(() => openTask(log, 4, { taskId: otherTask })).toThrow('is still active in this Session')
    expect(log.seq).toBe(SessionSeq(1))
  })

  it('refuses a checkpoint that belongs to another Session', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)

    expect(() => appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5), sessionId: SessionId('elsewhere') },
    })).toThrow('does not match the owning session')
    expect(log.seq).toBe(SessionSeq(1))
  })

  it('refuses an update to a Task that has no durable revision', () => {
    const log = Session.create(session)

    expect(() => appendTaskCheckpointUpdate(authorityOf(log, 4), {
      expectedRevision: 1,
      latestTurn: 4,
      checkpoint: {
        version: 1,
        taskId: task,
        revision: 1,
        taskType: 'report',
        sessionId: session,
        originRunId: run(4),
        latestRunId: run(4),
        status: 'running',
        originalExecution: execution,
        latestExecution: execution,
        modelRelation: 'same-model',
        completedSteps: [],
        pendingSteps: [{ id: step1, title: 'Draft' }],
        createdAt: 1,
        lastActivityAt: 2,
        resumeContext,
        outputs: [],
      },
    })).toThrow('has no durable revision to supersede')
  })

  it('advances exactly one revision and leaves originRunId immutable', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)

    const second = appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5), lastActivityAt: 11 },
    })

    expect(second.revision).toBe(2)
    expect(second.originRunId).toBe(run(4))
    expect(second.latestRunId).toBe(run(5))
    expect(lastEvent(log).ignorable).toBe(true)
  })

  it('refuses a successor declared against a stale revision', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)
    appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5) },
    })

    expect(() => appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5) },
    })).toThrow('declared expected revision 1, but the durable revision is 2')
  })

  it('refuses a same-revision replacement and a revision regression', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)
    appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5), lastActivityAt: 11 },
    })
    const authority = authorityOf(log, 5)

    // 2 -> 2: the declared predecessor matches, but no revision advance exists.
    expect(() => appendTaskCheckpointUpdate(authority, {
      expectedRevision: 2,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5), lastActivityAt: 11 },
    })).toThrow('revision must advance by exactly one')
    // 2 -> 1: a regression is not a legal successor either.
    expect(() => appendTaskCheckpointUpdate(authority, {
      expectedRevision: 2,
      latestTurn: 5,
      checkpoint: { ...first, revision: 1, latestRunId: run(5), lastActivityAt: 11 },
    })).toThrow('revision must advance by exactly one')
    expect(log.seq).toBe(SessionSeq(2))
  })

  it('refuses a successor that rewrites immutable identity', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)
    const authority = authorityOf(log, 5)
    const successor = (patch: Partial<TaskCheckpoint>) => () => appendTaskCheckpointUpdate(authority, {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5), ...patch },
    })

    expect(successor({ originRunId: run(5) })).toThrow('changed immutable identity or origin metadata')
    expect(successor({ taskType: 'other' })).toThrow('changed immutable identity or origin metadata')
    expect(successor({ createdAt: 0 })).toThrow('changed immutable identity or origin metadata')
  })

  it('refuses a successor that rewrites or drops a completed step', () => {
    const log = Session.create(session)
    openTask(log, 6, {
      completedSteps: [completedStep()],
      pendingSteps: [{ id: step2, title: 'Review' }],
    }, { successfulToolResults: durableResults() })
    const authority = authorityOf(log, 6, { successfulToolResults: durableResults() })
    const base = { ...authority.checkpoint.tasks[0]!, revision: 2, latestRunId: run(5), lastActivityAt: 11 }

    expect(() => appendTaskCheckpointUpdate(authority, {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...base, completedSteps: [], pendingSteps: [{ id: step2, title: 'Review' }] },
    })).toThrow('completed task steps are append-only')
    expect(() => appendTaskCheckpointUpdate(authority, {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...base, completedSteps: [{ ...completedStep(), title: 'Rewritten' }] },
    })).toThrow('completed task steps cannot be rewritten')
    expect(log.seq).toBe(SessionSeq(1))
  })

  it('refuses a successor whose latestRunId is not the Run of its declared turn', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)

    expect(() => appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(4) },
    })).toThrow('is not the Run of committed turn 5')
  })

  it('refuses a Run that has not committed', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)

    expect(() => appendTaskCheckpointUpdate(authorityOf(log, 4), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: { ...first, revision: 2, latestRunId: run(5) },
    })).toThrow('only 4 durable turn(s) have committed')
    expect(log.seq).toBe(SessionSeq(1))
  })

  it('lets only one of two competing successors become authoritative', () => {
    const log = Session.create(session)
    const first = openTask(log, 4)
    /** Both writers built a revision 2 candidate from the very same predecessor. */
    const candidateA = { ...first, revision: 2, latestRunId: run(5), lastActivityAt: 11 }
    const candidateB = { ...first, revision: 2, latestRunId: run(5), lastActivityAt: 12 }

    appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: candidateA,
    })
    // The rival still declares predecessor 1, which the fold has already left.
    expect(() => appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: candidateB,
    })).toThrow('declared expected revision 1, but the durable revision is 2')
    // Even claiming the new predecessor cannot land a second revision 2.
    expect(() => appendTaskCheckpointUpdate(authorityOf(log, 5), {
      expectedRevision: 2,
      latestTurn: 5,
      checkpoint: candidateB,
    })).toThrow('revision must advance by exactly one')

    const after = authorityOf(log, 5)
    expect(after.checkpoint.tasks).toHaveLength(1)
    expect(after.checkpoint.tasks[0]?.lastActivityAt).toBe(11)
    expect(log.seq).toBe(SessionSeq(2))
  })
})

describe('completed-step evidence', () => {
  it('accepts a tool-result citation that matches a projected successful result', () => {
    const log = Session.create(session)

    expect(() => openTask(log, 4, {
      completedSteps: [completedStep()],
      pendingSteps: [{ id: step2, title: 'Review' }],
    }, { successfulToolResults: durableResults() })).not.toThrow()
    expect(lastEvent(log).ignorable).toBe(true)
  })

  it('refuses a tool-result citation with no durable success', () => {
    const log = Session.create(session)

    expect(() => openTask(log, 4, {
      completedSteps: [completedStep()],
      pendingSteps: [{ id: step2, title: 'Review' }],
    })).toThrow('does not cite a durable successful tool/result')
    expect(log.seq).toBe(SessionSeq(0))
  })

  it('refuses a tool-result citation whose call identity does not match the durable success', () => {
    const log = Session.create(session)

    expect(() => openTask(log, 4, {
      completedSteps: [{
        id: step1,
        title: 'Draft',
        completedAt: 10,
        evidence: { kind: 'tool-result', eventSeq: SessionSeq(5), callId: 'call-other' },
      }],
      pendingSteps: [{ id: step2, title: 'Review' }],
    }, { successfulToolResults: durableResults() })).toThrow('does not cite a durable successful tool/result')
  })

  it('accepts runtime-validation evidence without durable re-derivation', () => {
    const log = Session.create(session)

    expect(() => openTask(log, 4, {
      completedSteps: [{
        id: step1,
        title: 'Draft',
        completedAt: 10,
        evidence: { kind: 'runtime-validation', validator: 'schema', reference: 'ref-1' },
      }],
      pendingSteps: [{ id: step2, title: 'Review' }],
    })).not.toThrow()
  })

  it('refuses a result-validation citation whose manifest is absent or a later revision', () => {
    const log = Session.create(session)
    openTask(log, 4, { outputs: [output] })
    publishResultManifest(authorityOf(log, 4), manifest(), 4)
    const authority = authorityOf(log, 5)
    const absent = taskOutputIdFromString('output-absent')
    const cite = (outputId: typeof output, manifestRevision: number) => () => appendTaskCheckpointUpdate(authority, {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: {
        ...authority.checkpoint.tasks[0]!,
        revision: 2,
        latestRunId: run(5),
        completedSteps: [{
          id: step1,
          title: 'Draft',
          completedAt: 10,
          evidence: { kind: 'result-validation', outputId, manifestRevision },
        }],
        pendingSteps: [{ id: step2, title: 'Review' }],
        lastActivityAt: 11,
      },
    })

    // No manifest exists for that output at all.
    expect(cite(absent, 1)).toThrow('no durable manifest satisfies')
    // Revision 2 does not exist yet: a forward reference is refused.
    expect(cite(output, 2)).toThrow('but the durable revision is 1')
    // Revision 1 exists but never validated: citing it is refused too.
    expect(cite(output, 1)).toThrow('whose validation did not pass')
    expect(log.seq).toBe(SessionSeq(2))
  })

  it('accepts a result-validation citation of a durably passed manifest', () => {
    const log = Session.create(session)
    openTask(log, 4, { outputs: [output] })
    publishResultManifest(authorityOf(log, 4), manifest(), 4)
    publishResultManifest(authorityOf(log, 4), completedManifest(2), 4)
    const authority = authorityOf(log, 5)

    const advanced = appendTaskCheckpointUpdate(authority, {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: {
        ...authority.checkpoint.tasks[0]!,
        revision: 2,
        latestRunId: run(5),
        completedSteps: [{
          id: step1,
          title: 'Draft',
          completedAt: 10,
          evidence: { kind: 'result-validation', outputId: output, manifestRevision: 2 },
        }],
        pendingSteps: [{ id: step2, title: 'Review' }],
        lastActivityAt: 11,
      },
    })

    expect(advanced.revision).toBe(2)
    expect(lastEvent(log).ignorable).toBe(true)
  })
})

describe('result-manifest producers', () => {
  it('starts at revision 1 and advances monotonically', () => {
    const log = Session.create(session)
    openTask(log, 4)

    const first = publishResultManifest(authorityOf(log, 4), manifest(), 4)
    const second = publishResultManifest(authorityOf(log, 4), completedManifest(2), 4)

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(second.status).toBe('completed')
    const event = lastEvent(log)
    expect(event.type).toBe('task/result-manifest')
    expect(event.ignorable).toBe(true)
  })

  it('refuses a same-revision replacement and a revision regression', () => {
    const log = Session.create(session)
    openTask(log, 4)
    publishResultManifest(authorityOf(log, 4), manifest(), 4)
    const authority = authorityOf(log, 4)

    expect(() => publishResultManifest(authority, manifest(), 4))
      .toThrow('revision must advance by exactly one')
    expect(() => publishResultManifest(authority, manifest({ revision: 3, updatedAt: 5 }), 4))
      .toThrow('revision must advance by exactly one')
    expect(log.seq).toBe(SessionSeq(2))
  })

  it('refuses a manifest for an unknown Task or an uncommitted Run', () => {
    const log = Session.create(session)
    openTask(log, 4)
    const authority = authorityOf(log, 4)

    expect(() => publishResultManifest(authority, manifest({ taskId: otherTask }), 4))
      .toThrow('refers to unknown task')
    expect(() => publishResultManifest(authority, manifest({ runId: run(5) }), 5))
      .toThrow('only 4 durable turn(s) have committed')
  })

  it('refuses to complete a Task while a governed output is not durably completed', () => {
    const log = Session.create(session)
    openTask(log, 4, { outputs: [output] })
    const authority = authorityOf(log, 5)
    const done = (): TaskCheckpoint => ({
      ...authority.checkpoint.tasks[0]!,
      revision: 2,
      status: 'completed',
      latestRunId: run(5),
      completedSteps: [],
      pendingSteps: [],
      lastActivityAt: 11,
    })

    // No manifest exists at all for the governed output.
    expect(() => appendTaskCheckpointUpdate(authority, {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: done(),
    })).toThrow('has no durable completed manifest')
  })

  it('accepts completion once the governed output is durably completed', () => {
    const log = Session.create(session)
    openTask(log, 4, { outputs: [output] })
    publishResultManifest(authorityOf(log, 4), completedManifest(1), 4)
    const authority = authorityOf(log, 5)

    const done = appendTaskCheckpointUpdate(authority, {
      expectedRevision: 1,
      latestTurn: 5,
      checkpoint: {
        ...authority.checkpoint.tasks[0]!,
        revision: 2,
        status: 'completed',
        latestRunId: run(5),
        completedSteps: [{
          id: step1,
          title: 'Draft',
          completedAt: 10,
          evidence: { kind: 'result-validation', outputId: output, manifestRevision: 1 },
        }],
        pendingSteps: [],
        lastActivityAt: 11,
      },
    })

    expect(done.status).toBe('completed')
    expect(done.pendingSteps).toEqual([])
    expect(lastEvent(log).ignorable).toBe(true)
  })
})

describe('accepted resume recording', () => {
  it('records the Run that actually started and never rewrites originRunId', () => {
    const log = Session.create(session)
    openTask(log, 4)

    const resumed = recordAcceptedResume(authorityOf(log, 5), {
      turn: 5,
      taskId: task,
      requestedAt: 20,
      executionPlan: [step1, step2],
      context: budget,
    })

    expect(resumed.revision).toBe(2)
    expect(resumed.originRunId).toBe(run(4))
    expect(resumed.latestRunId).toBe(run(5))
    expect(resumed.status).toBe('running')
    expect(resumed.latestResume).toEqual({
      requestedAt: 20,
      runId: run(5),
      executionPlan: [step1, step2],
      context: budget,
    })
    expect(lastEvent(log).ignorable).toBe(true)
  })

  it('refuses a plan that reaches into completed work', () => {
    const log = Session.create(session)
    openTask(log, 6, {
      completedSteps: [completedStep()],
      pendingSteps: [{ id: step2, title: 'Review' }],
    }, { successfulToolResults: durableResults() })

    expect(() => recordAcceptedResume(authorityOf(log, 7, { successfulToolResults: durableResults() }), {
      turn: 7,
      taskId: task,
      requestedAt: 20,
      executionPlan: [step1],
      context: budget,
    })).toThrow('which is not unfinished work of task')
    expect(log.seq).toBe(SessionSeq(1))
  })

  it('refuses an empty, unknown, or repeated plan', () => {
    const log = Session.create(session)
    openTask(log, 4)
    const authority = authorityOf(log, 5)
    const resume = (executionPlan: readonly typeof step1[]) => recordAcceptedResume(authority, {
      turn: 5,
      taskId: task,
      requestedAt: 20,
      executionPlan,
      context: budget,
    })

    expect(() => resume([])).toThrow('must contain at least one step')
    expect(() => resume([step3])).toThrow('which is not unfinished work of task')
    expect(() => resume([step1, step1])).toThrow('must not repeat a step')
    expect(log.seq).toBe(SessionSeq(1))
  })

  it('refuses a Run that has not committed', () => {
    const log = Session.create(session)
    openTask(log, 4)

    expect(() => recordAcceptedResume(authorityOf(log, 4), {
      turn: 5,
      taskId: task,
      requestedAt: 20,
      executionPlan: [step1],
      context: budget,
    })).toThrow('only 4 durable turn(s) have committed')
    expect(log.seq).toBe(SessionSeq(1))
  })

  it('is idempotent for a redelivered Run', () => {
    const log = Session.create(session)
    openTask(log, 4)
    const input = {
      turn: 5,
      taskId: task,
      requestedAt: 20,
      executionPlan: [step1],
      context: budget,
    }

    const first = recordAcceptedResume(authorityOf(log, 5), input)
    const second = recordAcceptedResume(authorityOf(log, 5), input)

    expect(second).toEqual(first)
    // The redelivery wrote nothing: the origin plus one resume revision.
    expect(log.seq).toBe(SessionSeq(2))
  })

  it('run bridge: origin stays at turn 4 while the latest Run advances to turn 9', () => {
    const log = Session.create(session)
    const opened = openTask(log, 4)
    const atFive = recordAcceptedResume(authorityOf(log, 5), {
      turn: 5,
      taskId: task,
      requestedAt: 20,
      executionPlan: [step1, step2],
      context: budget,
    })
    const atNine = recordAcceptedResume(authorityOf(log, 9), {
      turn: 9,
      taskId: task,
      requestedAt: 30,
      executionPlan: [step2],
      context: budget,
    })

    expect(opened.originRunId).toBe(run(4))
    expect(atFive.originRunId).toBe(run(4))
    expect(atFive.latestRunId).toBe(run(5))
    expect(atFive.latestResume?.runId).toBe(run(5))
    expect(atNine.originRunId).toBe(run(4))
    expect(atNine.latestRunId).toBe(run(9))
    expect(atNine.latestResume?.runId).toBe(run(9))
    expect(atNine.revision).toBe(3)
    // Turns between Task Runs need not be contiguous, and none of them was ever
    // named before its own turn/start committed.
    expect(log.seq).toBe(SessionSeq(3))
  })
})
