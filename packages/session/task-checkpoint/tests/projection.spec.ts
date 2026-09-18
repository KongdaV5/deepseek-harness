/**
 * Pure fold semantics for the restored Final Product v1 task authority.
 *
 * A checkpoint is a whole revision that must advance by exactly one and may
 * never rewrite its identity, its completed steps, or its output references; a
 * result manifest is a separate authority with the same revision discipline.
 * These tests pin those rules, the crash-repair hazard evidence the fold
 * derives from tool results, and the two exported projection definitions a
 * consumer registers.
 */

import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session/types'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import {
  applyResultManifestProjection,
  applyTaskCheckpointProjection,
  assertResultManifestTransition,
  assertTaskCheckpointTransition,
  emptyResultManifestProjection,
  emptyTaskCheckpointProjection,
  resultManifestProjectionDefinition,
  taskCheckpointProjectionDefinition,
  taskIdFromString,
  taskOutputIdFromString,
  taskStepIdFromString,
} from '@deepseek-ai/dsh-task-checkpoint'
import type {
  ResultManifest,
  TaskCheckpoint,
  TaskCheckpointProjectionState,
  TaskResumeRecord,
} from '@deepseek-ai/dsh-task-checkpoint'
import { brandLegacyRunId } from '../src/legacy-identity.ts'

/** Branded fixtures shared by every case; the brands never change the value. */
const session = SessionId('session-1')
const run = brandLegacyRunId('run-1')
const task = taskIdFromString('task-1')
const step = taskStepIdFromString('step-1')
const output = taskOutputIdFromString('output-1')

/** Build one committed log-only event; `data` stays typed at the call site. */
function event<T extends SessionEventType>(type: T, seq: number, data: SessionEventMap[T]): SessionEvent {
  return { type, seq: SessionSeq(seq), time: seq, data } as unknown as SessionEvent
}

/** A whole valid checkpoint revision; overrides change exactly one rule. */
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

/** A whole valid result manifest revision; overrides change exactly one rule. */
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

const checkpointEvent = (seq: number, value: TaskCheckpoint): SessionEvent =>
  event('task/checkpoint', seq, { kind: 'task/checkpoint', version: 1, checkpoint: value })

const manifestEvent = (seq: number, value: ResultManifest): SessionEvent =>
  event('task/result-manifest', seq, { kind: 'task/result-manifest', version: 1, manifest: value })

const toolResultEvent = (seq: number, callId: string, options: { isError?: boolean; code?: string } = {}): SessionEvent =>
  event('tool/result', seq, {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      isError: options.isError === true,
      content: [{ type: 'text', text: 'result' }],
    }),
    ...(options.code === undefined ? {} : { error: { name: 'ToolError', code: options.code } }),
  })

/** Fold a whole event range from the empty state. */
function fold(events: readonly SessionEvent[]): TaskCheckpointProjectionState {
  return events.reduce(applyTaskCheckpointProjection, emptyTaskCheckpointProjection())
}

const failed = (state: TaskCheckpointProjectionState): string => state.failure ?? ''

describe('task checkpoint fold', () => {
  it('returns the same state reference for events that do not concern it', () => {
    const state = emptyTaskCheckpointProjection()
    expect(applyTaskCheckpointProjection(state, event('turn/start', 0, { turn: 1 }))).toBe(state)
  })

  it('records a first revision and tracks the latest task', () => {
    const state = fold([checkpointEvent(0, checkpoint())])
    expect(state.tasks).toHaveLength(1)
    expect(state.latestTaskId).toBe('task-1')
    expect(state.failure).toBeNull()
  })

  it('replaces a task in place when the next revision arrives', () => {
    const state = fold([
      checkpointEvent(0, checkpoint()),
      checkpointEvent(1, checkpoint({ revision: 2, lastActivityAt: 3, pendingSteps: [] })),
    ])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]?.revision).toBe(2)
  })

  it('retains the first replay failure and stops folding further events', () => {
    const broken = fold([checkpointEvent(0, checkpoint({ revision: 3 }))])
    expect(failed(broken)).toBe('task checkpoint replay failed at session event 0: new task checkpoint must start at revision 1')
    expect(applyTaskCheckpointProjection(broken, checkpointEvent(1, checkpoint()))).toBe(broken)
  })

  it('fails on an event envelope that is not a task checkpoint revision', () => {
    const state = applyTaskCheckpointProjection(
      emptyTaskCheckpointProjection(),
      event('task/checkpoint', 4, { kind: 'task/checkpoint', version: 1 } as SessionEventMap['task/checkpoint']),
    )
    expect(failed(state)).toBe('task checkpoint replay failed at session event 4: invalid task/checkpoint event envelope')
  })

  it('rejects a revision that does not advance by exactly one', () => {
    const state = fold([checkpointEvent(0, checkpoint()), checkpointEvent(1, checkpoint({ revision: 3 }))])
    expect(failed(state)).toBe('task checkpoint replay failed at session event 1: task checkpoint revision must advance by exactly one')
  })

  it('treats a completed task as terminal', () => {
    const state = fold([
      checkpointEvent(0, checkpoint({ status: 'completed', pendingSteps: [] })),
      checkpointEvent(1, checkpoint({ revision: 2 })),
    ])
    expect(failed(state)).toBe('task checkpoint replay failed at session event 1: completed task is terminal')
  })

  it('rejects a revision that rewrites immutable identity or origin metadata', () => {
    const rewrite = (overrides: Partial<TaskCheckpoint>): TaskCheckpointState => fold([
      checkpointEvent(0, checkpoint()),
      checkpointEvent(1, checkpoint({ revision: 2, ...overrides })),
    ])
    // Each override keeps the envelope internally valid, so the rejection can
    // only come from the transition rule under test.
    const rewrites: Partial<TaskCheckpoint>[] = [
      { sessionId: SessionId('session-2') },
      { taskType: 'other' },
      { originRunId: brandLegacyRunId('run-2') },
      { createdAt: 2, lastActivityAt: 2 },
      { originalExecution: { provider: 'other', model: 'chat' } },
    ]
    for (const overrides of rewrites) {
      expect(failed(rewrite(overrides))).toBe(
        'task checkpoint replay failed at session event 1: task checkpoint changed immutable identity or origin metadata',
      )
    }
  })

  it('rejects a revision that drops or rewrites a completed step', () => {
    const completed = checkpoint({
      revision: 1,
      pendingSteps: [],
      completedSteps: [{
        id: step,
        title: 'Draft',
        completedAt: 2,
        evidence: { kind: 'runtime-validation', validator: 'lint', reference: 'r' },
      }],
    })
    expect(failed(fold([
      checkpointEvent(0, completed),
      checkpointEvent(1, checkpoint({ revision: 2, pendingSteps: [], completedSteps: [] })),
    ]))).toBe('task checkpoint replay failed at session event 1: completed task steps are append-only')

    expect(failed(fold([
      checkpointEvent(0, completed),
      checkpointEvent(1, checkpoint({
        revision: 2,
        pendingSteps: [],
        completedSteps: [{
          id: step,
          title: 'Renamed',
          completedAt: 2,
          evidence: { kind: 'runtime-validation', validator: 'lint', reference: 'r' },
        }],
      })),
    ]))).toBe('task checkpoint replay failed at session event 1: completed task steps cannot be rewritten')
  })

  it('rejects a revision that drops an output reference or moves lastActivityAt backwards', () => {
    const withOutput = checkpoint({ outputs: [output] })
    expect(failed(fold([
      checkpointEvent(0, withOutput),
      checkpointEvent(1, checkpoint({ revision: 2, outputs: [] })),
    ]))).toBe('task checkpoint replay failed at session event 1: task output references are append-only')

    expect(failed(fold([
      checkpointEvent(0, checkpoint({ lastActivityAt: 5 })),
      checkpointEvent(1, checkpoint({ revision: 2, lastActivityAt: 4 })),
    ]))).toBe('task checkpoint replay failed at session event 1: task lastActivityAt cannot move backwards')
  })

  it('rejects resume metadata rewritten inside the same run', () => {
    const resume: TaskResumeRecord = {
      requestedAt: 2,
      runId: run,
      executionPlan: [step],
      context: { estimatedTokens: 5, maxTokens: 10, includedSections: [], omittedSections: [] },
    }
    const state = fold([
      checkpointEvent(0, checkpoint({ latestResume: resume })),
      checkpointEvent(1, checkpoint({
        revision: 2,
        latestResume: { ...resume, requestedAt: 3 },
      })),
    ])
    expect(failed(state)).toBe('task checkpoint replay failed at session event 1: resume metadata cannot be rewritten within the same Run')
  })

  it('accepts an appended output, a preserved output, and an unchanged completed prefix', () => {
    const completedStep = {
      id: step,
      title: 'Draft',
      completedAt: 2,
      evidence: { kind: 'runtime-validation' as const, validator: 'lint', reference: 'r' },
    }
    const state = fold([
      checkpointEvent(0, checkpoint({ completedSteps: [completedStep], pendingSteps: [], outputs: [output] })),
      checkpointEvent(1, checkpoint({
        revision: 2,
        completedSteps: [completedStep],
        pendingSteps: [],
        outputs: [output, taskOutputIdFromString('output-2')],
        latestRunId: brandLegacyRunId('run-2'),
      })),
    ])
    expect(state.failure).toBeNull()
    expect(state.tasks[0]?.revision).toBe(2)
    expect(state.tasks[0]?.outputs).toEqual(['output-1', 'output-2'])
  })
})

describe('crash-repair evidence from durable tool results', () => {
  const withTask = (overrides: Partial<TaskCheckpoint> = {}): TaskCheckpointProjectionState =>
    fold([checkpointEvent(0, checkpoint(overrides))])

  it('records a successful tool result as step-completion evidence', () => {
    const state = applyTaskCheckpointProjection(withTask(), toolResultEvent(1, 'call-1'))
    expect(state.successfulToolResults).toEqual([{ eventSeq: 1, callId: 'call-1' }])
    expect(state.repairHazards).toEqual([])
  })

  it('records no evidence without a task, and none after the task completed', () => {
    const noTask = applyTaskCheckpointProjection(emptyTaskCheckpointProjection(), toolResultEvent(1, 'call-1'))
    expect(noTask).toBe(emptyTaskCheckpointProjection())
    expect(noTask.successfulToolResults).toEqual([])

    const completed = applyTaskCheckpointProjection(
      withTask({ status: 'completed', pendingSteps: [] }),
      toolResultEvent(1, 'call-1'),
    )
    expect(completed.successfulToolResults).toEqual([])
  })

  it('records one evidence row per sequence number', () => {
    const first = applyTaskCheckpointProjection(withTask(), toolResultEvent(1, 'call-1'))
    const repeated = applyTaskCheckpointProjection(first, toolResultEvent(1, 'call-1'))
    expect(repeated).toBe(first)
  })

  it.each([TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN])('records a repair hazard for %s', (code) => {
    const state = applyTaskCheckpointProjection(withTask(), toolResultEvent(1, 'call-1', { isError: true, code }))
    expect(state.repairHazards).toEqual([{ taskId: 'task-1', callId: 'call-1', code, eventSeq: 1 }])
  })

  it('records one hazard per call and keeps unrelated failures out of the hazard list', () => {
    const first = applyTaskCheckpointProjection(withTask(), toolResultEvent(1, 'call-1', { isError: true, code: TOOL_NOT_STARTED }))
    const repeated = applyTaskCheckpointProjection(first, toolResultEvent(2, 'call-1', { isError: true, code: TOOL_OUTCOME_UNKNOWN }))
    expect(repeated).toBe(first)

    const unrelated = applyTaskCheckpointProjection(withTask(), toolResultEvent(1, 'call-1', { isError: true, code: 'SOMETHING_ELSE' }))
    expect(unrelated.repairHazards).toEqual([])
    expect(unrelated.successfulToolResults).toEqual([])
  })

  it('records no hazard without a task or after the task completed', () => {
    expect(applyTaskCheckpointProjection(emptyTaskCheckpointProjection(), toolResultEvent(1, 'call-1', { isError: true, code: TOOL_NOT_STARTED })))
      .toBe(emptyTaskCheckpointProjection())
    const completed = withTask({ status: 'completed', pendingSteps: [] })
    expect(applyTaskCheckpointProjection(completed, toolResultEvent(1, 'call-1', { isError: true, code: TOOL_NOT_STARTED })))
      .toBe(completed)
  })
})

describe('result manifest fold', () => {
  it('ignores events it does not own and retains a recorded failure', () => {
    const state = emptyResultManifestProjection()
    expect(applyResultManifestProjection(state, event('turn/start', 0, { turn: 1 }))).toBe(state)
    expect(applyResultManifestProjection(state, checkpointEvent(1, checkpoint()))).toBe(state)

    const broken = applyResultManifestProjection(state, manifestEvent(2, manifest({ revision: 5 })))
    expect(broken.failure).toBe('result manifest replay failed at session event 2: new result manifest must start at revision 1')
    expect(applyResultManifestProjection(broken, manifestEvent(3, manifest()))).toBe(broken)
  })

  it('records a first revision and replaces it in place on the next', () => {
    const added = applyResultManifestProjection(emptyResultManifestProjection(), manifestEvent(0, manifest()))
    expect(added.manifests).toHaveLength(1)
    const next = applyResultManifestProjection(added, manifestEvent(1, manifest({ revision: 2, updatedAt: 3 })))
    expect(next.manifests).toHaveLength(1)
    expect(next.manifests[0]?.revision).toBe(2)
  })

  it('fails on an event envelope that is not a result manifest revision', () => {
    const state = applyResultManifestProjection(
      emptyResultManifestProjection(),
      event('task/result-manifest', 6, { kind: 'task/result-manifest', version: 1 } as SessionEventMap['task/result-manifest']),
    )
    expect(state.failure).toBe('result manifest replay failed at session event 6: invalid task/result-manifest event envelope')
  })

  it('enforces the same revision and terminality discipline as task checkpoints', () => {
    const cases: Array<[ResultManifest, string]> = [
      [manifest({ revision: 3 }), 'result manifest revision must advance by exactly one'],
      [manifest({ revision: 2, taskId: taskIdFromString('task-2') }), 'result manifest changed immutable identity metadata'],
      [manifest({ revision: 2, path: 'other.md' }), 'result manifest changed immutable identity metadata'],
      [manifest({ revision: 2, createdAt: 2 }), 'result manifest changed immutable identity metadata'],
      [manifest({ revision: 2, updatedAt: 1 }), 'result manifest updatedAt cannot move backwards'],
    ]
    for (const [next, message] of cases) {
      const state = applyResultManifestProjection(
        applyResultManifestProjection(emptyResultManifestProjection(), manifestEvent(0, manifest())),
        manifestEvent(1, next),
      )
      expect(state.failure).toBe(`result manifest replay failed at session event 1: ${message}`)
    }

    const terminal = applyResultManifestProjection(
      applyResultManifestProjection(emptyResultManifestProjection(), manifestEvent(0, manifest({
        status: 'completed',
        completedAt: 3,
        size: 1,
        checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
        validation: { status: 'passed', checks: [] },
      }))),
      manifestEvent(1, manifest({ revision: 2 })),
    )
    expect(terminal.failure).toContain('completed result manifest is terminal')
  })
})

describe('exported projection definitions', () => {
  it('describes the taskCheckpoint unit a consumer registers', () => {
    expect(taskCheckpointProjectionDefinition.key).toBe('taskCheckpoint')
    expect(taskCheckpointProjectionDefinition.stateVersion).toBe(1)
    expect(taskCheckpointProjectionDefinition.init()).toEqual(emptyTaskCheckpointProjection())

    const state = taskCheckpointProjectionDefinition.apply(
      emptyTaskCheckpointProjection(),
      checkpointEvent(0, checkpoint()),
    )
    expect(taskCheckpointProjectionDefinition.wire.view(state)).toEqual({
      tasks: [checkpoint()],
      latestTaskId: 'task-1',
      repairHazards: [],
    })
    expect(taskCheckpointProjectionDefinition.wire.view(emptyTaskCheckpointProjection())).toEqual({
      tasks: [],
      repairHazards: [],
    })
  })

  it('describes the taskResults unit a consumer registers', () => {
    expect(resultManifestProjectionDefinition.key).toBe('taskResults')
    expect(resultManifestProjectionDefinition.stateVersion).toBe(1)
    expect(resultManifestProjectionDefinition.init()).toEqual(emptyResultManifestProjection())

    const state = resultManifestProjectionDefinition.apply(
      emptyResultManifestProjection(),
      manifestEvent(0, manifest()),
    )
    expect(resultManifestProjectionDefinition.wire.view(state)).toEqual([manifest()])
  })
})

describe('transition assertions', () => {
  it('accepts the next legal revision of a known task and output', () => {
    const tasks = fold([checkpointEvent(0, checkpoint())])
    expect(() => { assertTaskCheckpointTransition(tasks, checkpoint({ revision: 2, pendingSteps: [] })) }).not.toThrow()

    const manifests = applyResultManifestProjection(emptyResultManifestProjection(), manifestEvent(0, manifest()))
    expect(() => { assertResultManifestTransition(manifests, manifest({ revision: 2, updatedAt: 3 })) }).not.toThrow()
  })

  it('rejects a candidate that is not the next legal revision', () => {
    const tasks = fold([checkpointEvent(0, checkpoint())])
    expect(() => { assertTaskCheckpointTransition(tasks, checkpoint({ revision: 4 })) })
      .toThrow(/revision must advance by exactly one/)

    const manifests = applyResultManifestProjection(emptyResultManifestProjection(), manifestEvent(0, manifest()))
    expect(() => { assertResultManifestTransition(manifests, manifest({ revision: 4 })) })
      .toThrow(/revision must advance by exactly one/)
  })
})

describe('empty fold initializers', () => {
  it('returns immutable empty states shared by every caller', () => {
    expect(emptyTaskCheckpointProjection()).toBe(emptyTaskCheckpointProjection())
    expect(emptyTaskCheckpointProjection()).toEqual({ tasks: [], repairHazards: [], successfulToolResults: [], failure: null })
    expect(emptyResultManifestProjection()).toBe(emptyResultManifestProjection())
    expect(emptyResultManifestProjection()).toEqual({ manifests: [], failure: null })
  })
})

/** Alias kept local so the identity-rewrite table reads as data, not casts. */
type TaskCheckpointState = TaskCheckpointProjectionState
