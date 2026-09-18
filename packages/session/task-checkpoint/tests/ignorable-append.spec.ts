/**
 * The DS Harness task authority is the first — and currently only — opt-in
 * consumer of the typed ignorable append seam.
 *
 * `Session.appendIgnorable` is the single-writer path that makes
 * `task/checkpoint` and `task/result-manifest` skippable for a reader without
 * the task layer while they stay authoritative known events here. These tests
 * pin that registration, the emitted envelope, and the two properties legacy
 * compatibility depends on: an event written without the marker still reads
 * unchanged, and the marker survives a persistence round trip.
 */

import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { taskIdFromString, taskOutputIdFromString, taskStepIdFromString } from '@deepseek-ai/dsh-task-checkpoint'
import {
  applyResultManifestProjection,
  applyTaskCheckpointProjection,
  emptyResultManifestProjection,
  emptyTaskCheckpointProjection,
} from '@deepseek-ai/dsh-task-checkpoint'
import type {
  ResultManifest,
  ResultManifestEventData,
  TaskCheckpoint,
  TaskCheckpointEventData,
} from '@deepseek-ai/dsh-task-checkpoint'
import { brandLegacyRunId } from '../src/legacy-identity.ts'

const session = SessionId('task-ignorable')
const run = brandLegacyRunId('run-1')
const task = taskIdFromString('task-1')
const step = taskStepIdFromString('step-1')
const output = taskOutputIdFromString('output-1')

/** A whole valid checkpoint revision. */
function checkpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return {
    version: 1,
    taskId: task,
    revision: 1,
    taskType: 'report',
    sessionId: session,
    originRunId: run,
    latestRunId: run,
    status: 'running',
    originalExecution: { provider: 'deepseek', model: 'chat' },
    latestExecution: { provider: 'deepseek', model: 'chat' },
    modelRelation: 'same-model',
    completedSteps: [],
    pendingSteps: [{ id: step, title: 'Draft' }],
    createdAt: 1,
    lastActivityAt: 2,
    resumeContext: { objective: 'write', constraints: [], decisions: [], criticalContext: [] },
    outputs: [],
    ...overrides,
  }
}

/** A whole valid result manifest revision. */
function manifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  return {
    version: 1,
    outputId: output,
    revision: 1,
    taskId: task,
    runId: run,
    path: 'report.md',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    execution: { provider: 'deepseek', model: 'chat' },
    validation: { status: 'pending', checks: [] },
    ...overrides,
  }
}

const checkpointEventData = (value: TaskCheckpoint = checkpoint()): TaskCheckpointEventData =>
  ({ kind: 'task/checkpoint', version: 1, checkpoint: value })

const resultManifestEventData = (value: ResultManifest = manifest()): ResultManifestEventData =>
  ({ kind: 'task/result-manifest', version: 1, manifest: value })

/**
 * Compile-time contract for the opt-in set. Never executed: the negative arms
 * must fail to type-check, and running them would append ordinary events.
 */
function typedTaskEventContracts(target: Session): void {
  expectTypeOf(target.appendIgnorable('task/checkpoint', checkpointEventData()))
    .toEqualTypeOf<SessionEvent<'task/checkpoint'>>()
  expectTypeOf(target.appendIgnorable('task/result-manifest', resultManifestEventData()))
    .toEqualTypeOf<SessionEvent<'task/result-manifest'>>()

  // Registration adds an ignorable route; it does not replace the required one.
  expectTypeOf(target.append('task/checkpoint', checkpointEventData()))
    .toEqualTypeOf<SessionEvent<'task/checkpoint'>>()

  // The other task event's payload is not interchangeable with this one.
  // @ts-expect-error -- a result manifest is not a checkpoint payload.
  target.appendIgnorable('task/checkpoint', resultManifestEventData())
  // @ts-expect-error -- a checkpoint is not a result-manifest payload.
  target.appendIgnorable('task/result-manifest', checkpointEventData())
  // @ts-expect-error -- core history events are not registered reader-optional.
  target.appendIgnorable('turn/start', { turn: 1 })
}
void typedTaskEventContracts

describe('task events through the typed ignorable append seam', () => {
  it('writes a checkpoint and a result manifest carrying ignorable: true', () => {
    const log = Session.create(session)

    const checkpointed = log.appendIgnorable('task/checkpoint', checkpointEventData())
    const published = log.appendIgnorable('task/result-manifest', resultManifestEventData())

    expect(checkpointed).toMatchObject({
      type: 'task/checkpoint',
      seq: 0,
      ignorable: true,
      data: { kind: 'task/checkpoint', version: 1 },
    })
    expect(published).toMatchObject({
      type: 'task/result-manifest',
      seq: 1,
      ignorable: true,
      data: { kind: 'task/result-manifest', version: 1 },
    })
    expect(log.eventAt(SessionSeq(0))).toBe(checkpointed)
    expect(log.eventAt(SessionSeq(1))).toBe(published)
    expect(log.snapshotEvents()).toEqual([checkpointed, published])
    expect(log.deriveMessages()).toEqual([])
  })

  it('leaves the required append route for task events without a marker', () => {
    const log = Session.create(session)

    const required = log.append('task/checkpoint', checkpointEventData())

    expect(required.type).toBe('task/checkpoint')
    expect(Object.hasOwn(required, 'ignorable')).toBe(false)
    expect(log.snapshotEvents()).toEqual([required])
  })

  it('folds newly written ignorable task events through the Stage 6 projections', () => {
    const log = Session.create(session)
    log.append('turn/start', { turn: 1 })
    const checkpointed = log.appendIgnorable('task/checkpoint', checkpointEventData())
    const published = log.appendIgnorable('task/result-manifest', resultManifestEventData())
    log.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const events = log.snapshotEvents()
    const tasks = events.reduce(applyTaskCheckpointProjection, emptyTaskCheckpointProjection())
    const results = events.reduce(applyResultManifestProjection, emptyResultManifestProjection())

    // The ignorable envelope is admitted by the same fold as a required one.
    expect(checkpointed.ignorable).toBe(true)
    expect(published.ignorable).toBe(true)
    expect(tasks.failure).toBeNull()
    expect(tasks.tasks).toHaveLength(1)
    expect(tasks.tasks[0]?.taskId).toBe(task)
    expect(tasks.latestTaskId).toBe(task)
    expect(results.failure).toBeNull()
    expect(results.manifests).toHaveLength(1)
    expect(results.manifests[0]?.outputId).toBe(output)
  })

  it('reads a legacy required task event unchanged through the seed path', () => {
    const legacy = {
      type: 'task/checkpoint',
      seq: SessionSeq(0),
      time: 1,
      data: checkpointEventData(),
    } as unknown as SessionEvent

    const restored = Session.create(session, [legacy])
    const replayed = restored.snapshotEvents()

    expect(replayed[0]).toEqual(legacy)
    expect(Object.hasOwn(replayed[0]!, 'ignorable')).toBe(false)
    // Reading never normalizes a required legacy event into an ignorable one.
    expect(restored.eventAt(SessionSeq(0))?.ignorable).toBeUndefined()
    // The seed keeps its exact payload; only the lifecycle marker follows it.
    expect(replayed.filter(event => event.type === 'task/checkpoint')).toEqual([legacy])
  })
})

describe('task events through persistence', () => {
  const contexts: Context[] = []
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function backend(): Promise<Context> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-ignorable-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    return ctx
  }

  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: session, createdAt: 1, isSeeded: false }

  it('round-trips new ignorable task events unchanged and keeps required ones required', async () => {
    const ctx = await backend()
    const log = Session.create(session)
    const optional = log.appendIgnorable('task/checkpoint', checkpointEventData())
    const required = log.append('task/result-manifest', resultManifestEventData())

    const writer = await ctx.sessionPersistence.create(header)
    await writer.append([optional, required])
    await writer.close()

    const reader = await ctx.sessionPersistence.open(session, 'read')
    const { events } = await reader.read()
    await reader.close()

    expect(events).toEqual([optional, required])
    expect(events[0]?.ignorable).toBe(true)
    expect(events[0]?.seq).toBe(SessionSeq(0))
    expect(Object.hasOwn(events[1]!, 'ignorable')).toBe(false)
    expect(events[1]?.seq).toBe(SessionSeq(1))
  })

  it('restores a persisted ignorable task event through a Session read', async () => {
    const ctx = await backend()
    const optional = Session.create(session).appendIgnorable('task/result-manifest', resultManifestEventData())

    const writer = await ctx.sessionPersistence.create(header)
    await writer.append([optional])
    await writer.close()

    const reader = await ctx.sessionPersistence.open(session, 'read')
    const { events, eventState } = await reader.read()
    await reader.close()

    const restored = Session.fromRestore(session, events, { ...header }, SessionLogOffset(0), eventState)

    expect(restored.eventAt(SessionSeq(0))).toEqual(optional)
    expect(restored.eventAt(SessionSeq(0))?.ignorable).toBe(true)
  })
})
