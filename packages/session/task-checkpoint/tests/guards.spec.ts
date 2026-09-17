import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TaskCheckpointService, {
  applyResultManifestProjection,
  applyTaskCheckpointProjection,
  assertResultManifestTransition,
  assertTaskCheckpointTransition,
  classifyResumeEligibility,
  createTaskId,
  emptyResultManifestProjection,
  emptyTaskCheckpointProjection,
  resultManifestSchema,
  resultManifestProjectionDefinition,
  taskCheckpointProjectionDefinition,
  taskCheckpointSchema,
  taskIdFromString,
  taskOutputIdFromString,
  taskStepIdFromString,
} from '@deepseek-ai/dsh-task-checkpoint'
import type {
  ResultManifest,
  TaskCheckpoint,
  TaskCheckpointProjectionState,
  TaskExecutionMetadata,
} from '@deepseek-ai/dsh-task-checkpoint'
import { FakeTask, FakeTaskStep, fakeTaskStepId } from '@deepseek-ai/dsh-task-checkpoint/testing'

const execution: TaskExecutionMetadata = { provider: 'local', model: 'model-a' }

function cp(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  const sessionId = SessionId('guard-session')
  const runId = runIdFor(sessionId, 1)
  const one = FakeTaskStep('one')
  return {
    version: 1,
    taskId: taskIdFromString('task-guard'),
    revision: 1,
    taskType: 'guard',
    sessionId,
    originRunId: runId,
    latestRunId: runId,
    status: 'running',
    originalExecution: execution,
    latestExecution: execution,
    modelRelation: 'same-model',
    completedSteps: [],
    currentStep: one,
    pendingSteps: [one],
    createdAt: 1,
    lastActivityAt: 1,
    resumeContext: { objective: 'guard', constraints: [], decisions: [], criticalContext: [] },
    outputs: [],
    ...overrides,
  }
}

function cpWithoutCurrent(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  const { currentStep: _currentStep, ...checkpoint } = cp()
  return { ...checkpoint, ...overrides }
}

function completedStep(id = 'done') {
  return {
    ...FakeTaskStep(id),
    completedAt: 2,
    evidence: { kind: 'runtime-validation', validator: 'test', reference: `ok:${id}` } as const,
  }
}

function manifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  const base = cp()
  return {
    version: 1,
    outputId: taskOutputIdFromString('output-guard'),
    revision: 1,
    taskId: base.taskId,
    runId: base.latestRunId,
    path: '/tmp/result.md',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    execution,
    validation: { status: 'pending', checks: [] },
    ...overrides,
  }
}

function checkpointEvent(checkpoint: TaskCheckpoint, seq = 0) {
  return {
    type: 'task/checkpoint', seq: SessionSeq(seq), time: seq,
    data: { kind: 'task/checkpoint', version: 1, checkpoint },
  } as const
}

function manifestEvent(value: ResultManifest, seq = 0) {
  return {
    type: 'task/result-manifest', seq: SessionSeq(seq), time: seq,
    data: { kind: 'task/result-manifest', version: 1, manifest: value },
  } as const
}

describe('identity and strict schemas', () => {
  it('validates all branded string constructors', () => {
    expect(taskIdFromString('task')).toBe('task')
    expect(taskOutputIdFromString('output')).toBe('output')
    expect(taskStepIdFromString('step')).toBe('step')
    expect(createTaskId()).toMatch(/^task-/)
    expect(fakeTaskStepId('fixture')).toBe('fixture')
    expect(() => taskIdFromString('')).toThrow(/non-empty normalized/)
    expect(() => taskStepIdFromString(' padded ')).toThrow(/non-empty normalized/)
  })

  it.each([
    { name: 'duplicate completed', patch: { completedSteps: [completedStep(), completedStep()] } },
    { name: 'duplicate pending', patch: { currentStep: FakeTaskStep('one'), pendingSteps: [FakeTaskStep('one'), FakeTaskStep('one')] } },
    { name: 'completed and pending', patch: { completedSteps: [completedStep('one')] } },
    { name: 'completed retains work', patch: { status: 'completed' } },
    { name: 'last success after activity', patch: { lastSuccessAt: 3, lastActivityAt: 2 } },
    { name: 'creation after activity', patch: { createdAt: 2, lastActivityAt: 1 } },
    { name: 'wrong model relation', patch: { latestExecution: { provider: 'local', model: 'model-b' } } },
    { name: 'duplicate outputs', patch: { outputs: [taskOutputIdFromString('same'), taskOutputIdFromString('same')] } },
  ])('rejects checkpoint invariant: $name', ({ patch }) => {
    expect(taskCheckpointSchema.safeParse(cp(patch as Partial<TaskCheckpoint>)).success).toBe(false)
  })

  it('rejects a failure context that names a different current step', () => {
    expect(taskCheckpointSchema.safeParse(cp({
      failureContext: {
        primaryError: { code: 'UNKNOWN', message: 'failed', severity: 'degraded', origin: 'session', time: 2 },
        failedAt: 2,
        currentStepId: taskStepIdFromString('other'),
      },
      lastActivityAt: 2,
    })).success).toBe(false)
  })

  it('covers aggregate result validation and completion invariants', () => {
    expect(resultManifestSchema.safeParse(manifest({
      validation: { status: 'passed', checks: [{ id: 'x', status: 'failed' }] },
    })).success).toBe(false)
    expect(resultManifestSchema.safeParse(manifest({
      validation: { status: 'failed', checks: [{ id: 'x', status: 'passed' }] },
    })).success).toBe(false)
    expect(resultManifestSchema.safeParse(manifest({ updatedAt: 0 })).success).toBe(false)
    expect(resultManifestSchema.safeParse(manifest({ completedAt: 0 })).success).toBe(false)
    const invalidCompleted = manifest({
      status: 'completed',
      size: 1,
      checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
      validation: { status: 'passed', checks: [{ id: 'x', status: 'passed' }] },
    })
    expect(resultManifestSchema.safeParse(invalidCompleted).success).toBe(false)
    expect(resultManifestSchema.safeParse({ ...invalidCompleted, completedAt: 2 }).success).toBe(true)
  })
})

describe('pure projection guards', () => {
  it('retains strict task replay failures and ignores unrelated events', () => {
    const empty = emptyTaskCheckpointProjection()
    const unrelated = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } } as const
    expect(applyTaskCheckpointProjection(empty, unrelated)).toBe(empty)
    const malformed = { ...checkpointEvent(cp()), data: { kind: 'wrong', version: 1, checkpoint: cp() } } as never
    const failed = applyTaskCheckpointProjection(empty, malformed)
    expect(failed.failure).toMatch(/invalid task\/checkpoint event envelope/)
    expect(applyTaskCheckpointProjection(failed, unrelated)).toBe(failed)
  })

  it('rejects illegal Task revision and immutable-state transitions', () => {
    const initial = cp()
    const state: TaskCheckpointProjectionState = {
      tasks: [initial], latestTaskId: initial.taskId, repairHazards: [], successfulToolResults: [], failure: null,
    }
    expect(() => {
      assertTaskCheckpointTransition(emptyTaskCheckpointProjection(), cp({ revision: 2 }))
    }).toThrow(/start at revision 1/)
    expect(() => {
      assertTaskCheckpointTransition(state, cp({ revision: 1 }))
    }).toThrow(/advance by exactly one/)
    expect(() => {
      assertTaskCheckpointTransition({
        ...state,
        tasks: [cpWithoutCurrent({ status: 'completed', pendingSteps: [] })],
      }, cp({ revision: 2 }))
    })
      .toThrow(/terminal/)
    expect(() => {
      assertTaskCheckpointTransition(state, cp({ revision: 2, taskType: 'changed' }))
    }).toThrow(/immutable/)
    expect(() => {
      assertTaskCheckpointTransition({ ...state, tasks: [cp({ completedSteps: [completedStep()] })] }, cp({ revision: 2 }))
    })
      .toThrow(/append-only/)
    const priorCompleted = cp({ completedSteps: [completedStep('a')] })
    expect(() => {
      assertTaskCheckpointTransition({ ...state, tasks: [priorCompleted] }, cp({
        revision: 2, completedSteps: [completedStep('b')],
      }))
    }).toThrow(/cannot be rewritten/)
    const output = taskOutputIdFromString('out')
    expect(() => {
      assertTaskCheckpointTransition({ ...state, tasks: [cp({ outputs: [output] })] }, cp({ revision: 2 }))
    })
      .toThrow(/output references are append-only/)
    expect(() => {
      assertTaskCheckpointTransition(state, cp({ revision: 2, lastActivityAt: 0 }))
    }).toThrow(/move backwards/)
  })

  it('updates and strictly guards independent result revisions', () => {
    const empty = emptyResultManifestProjection()
    const unrelated = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } } as const
    expect(applyResultManifestProjection(empty, unrelated)).toBe(empty)
    const first = applyResultManifestProjection(empty, manifestEvent(manifest()))
    expect(first.manifests).toHaveLength(1)
    const secondValue = manifest({ revision: 2, updatedAt: 2 })
    expect(applyResultManifestProjection(first, manifestEvent(secondValue, 1)).manifests[0]?.revision).toBe(2)
    expect(() => {
      assertResultManifestTransition(empty, manifest({ revision: 2 }))
    }).toThrow(/start at revision 1/)
    expect(() => {
      assertResultManifestTransition(first, manifest({ revision: 1 }))
    }).toThrow(/advance by exactly one/)
    expect(() => {
      assertResultManifestTransition(first, manifest({ revision: 2, path: '/changed' }))
    }).toThrow(/immutable/)
    expect(() => {
      assertResultManifestTransition({
        manifests: [manifest({
          status: 'completed',
          size: 1,
          completedAt: 1,
          checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
          validation: { status: 'passed', checks: [] },
        })],
        failure: null,
      }, secondValue)
    }).toThrow(/terminal/)
    expect(() => {
      assertResultManifestTransition(first, manifest({ revision: 2, updatedAt: 0 }))
    }).toThrow(/move backwards/)
    const malformed = { ...manifestEvent(manifest()), data: { kind: 'wrong', version: 1, manifest: manifest() } } as never
    const failed = applyResultManifestProjection(empty, malformed)
    expect(failed.failure).toMatch(/invalid task\/result-manifest event envelope/)
    expect(applyResultManifestProjection(failed, manifestEvent(manifest()))).toBe(failed)
  })

  it('projects repair hazards only for an unfinished latest Task and de-duplicates calls', () => {
    const initial = applyTaskCheckpointProjection(emptyTaskCheckpointProjection(), checkpointEvent(cp()))
    const result = (code: string, seq: number) => ({
      type: 'tool/result', seq: SessionSeq(seq), time: seq,
      data: {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: ToolCallId('call'), content: [{ type: 'text', text: 'x' }], isError: true }),
        error: { name: 'Repair', code },
      },
      surfaceOp: 'append',
    }) as const
    expect(applyTaskCheckpointProjection(initial, result('OTHER', 1))).toBe(initial)
    const hazard = applyTaskCheckpointProjection(initial, result('TOOL_NOT_STARTED', 1))
    expect(hazard.repairHazards).toHaveLength(1)
    expect(applyTaskCheckpointProjection(hazard, result('TOOL_NOT_STARTED', 2))).toBe(hazard)
    expect(applyTaskCheckpointProjection(emptyTaskCheckpointProjection(), result('TOOL_OUTCOME_UNKNOWN', 1)))
      .toBe(emptyTaskCheckpointProjection())

    const success = {
      type: 'tool/result',
      seq: SessionSeq(3),
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('successful-call'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      },
      surfaceOp: 'append',
    } as const
    const evidenced = applyTaskCheckpointProjection(initial, success)
    expect(evidenced.successfulToolResults).toHaveLength(1)
    expect(applyTaskCheckpointProjection(evidenced, success)).toBe(evidenced)
  })
})

describe('resume classifier branches', () => {
  it('classifies absent, complete, blocked, and no-pending tasks', () => {
    expect(classifyResumeEligibility({ outputs: [], repairHazards: [] }).eligibility).toBe('NOT_RESUMABLE')
    expect(classifyResumeEligibility({ checkpoint: cpWithoutCurrent({ status: 'completed', pendingSteps: [] }), outputs: [], repairHazards: [] }).eligibility).toBe('COMPLETED')
    expect(classifyResumeEligibility({ checkpoint: cp({ status: 'blocked' }), outputs: [], repairHazards: [] }).eligibility).toBe('NOT_RESUMABLE')
    expect(classifyResumeEligibility({ checkpoint: cpWithoutCurrent({ pendingSteps: [] }), outputs: [], repairHazards: [] }).eligibility).toBe('NOT_RESUMABLE')
  })

  it('requires validation for unsettled outputs and changed models', () => {
    const output = manifest()
    const checkpoint = cp({ outputs: [output.outputId] })
    expect(classifyResumeEligibility({ checkpoint, outputs: [output], repairHazards: [] }).eligibility).toBe('NEEDS_VALIDATION')
    expect(classifyResumeEligibility({
      checkpoint,
      outputs: [manifest({ status: 'partial', validation: { status: 'pending', checks: [] } })],
      repairHazards: [],
    }).eligibility).toBe('NEEDS_VALIDATION')
    expect(classifyResumeEligibility({
      checkpoint,
      outputs: [manifest({ status: 'partial', validation: { status: 'failed', checks: [{ id: 'draft', status: 'failed' }] } })],
      repairHazards: [],
      requestedExecution: execution,
    })).toMatchObject({ eligibility: 'SAFE_TO_RESUME', modelRelation: 'same-model' })
    const changed = { provider: 'local', model: 'model-b' }
    expect(classifyResumeEligibility({ checkpoint, outputs: [], repairHazards: [], requestedExecution: changed })).toMatchObject({
      eligibility: 'NEEDS_VALIDATION', modelRelation: 'model-changed',
    })
    expect(classifyResumeEligibility({
      checkpoint,
      outputs: [manifest({ status: 'failed', validation: { status: 'failed', checks: [{ id: 'x', status: 'failed' }] } })],
      repairHazards: [],
    }).eligibility).toBe('NEEDS_VALIDATION')
    expect(classifyResumeEligibility({
      checkpoint: cp({
        latestExecution: changed,
        modelRelation: 'model-changed',
      }),
      outputs: [],
      repairHazards: [],
    })).toMatchObject({ eligibility: 'NEEDS_VALIDATION', modelRelation: 'model-changed' })
  })

  it('guards durable resume metadata and prevents same-Run rewrites', () => {
    const runId = runIdFor(SessionId('guard-session'), 2)
    const latestResume = {
      requestedAt: 2,
      runId,
      executionPlan: [taskStepIdFromString('one')],
      context: {
        estimatedTokens: 10,
        maxTokens: 20,
        includedSections: ['task'],
        omittedSections: ['reasoning'],
      },
    } as const
    expect(taskCheckpointSchema.safeParse(cp({ latestRunId: runId, latestResume })).success).toBe(true)
    expect(taskCheckpointSchema.safeParse(cp({ latestResume })).success).toBe(false)
    expect(taskCheckpointSchema.safeParse(cp({
      latestRunId: runId,
      latestResume: { ...latestResume, executionPlan: [latestResume.executionPlan[0], latestResume.executionPlan[0]] },
    })).success).toBe(false)
    expect(taskCheckpointSchema.safeParse(cp({
      latestRunId: runId,
      latestResume: { ...latestResume, context: { ...latestResume.context, estimatedTokens: 21 } },
    })).success).toBe(false)

    const previous = cp({ latestRunId: runId, latestResume })
    expect(() => assertTaskCheckpointTransition({
      tasks: [previous], latestTaskId: previous.taskId, repairHazards: [], successfulToolResults: [], failure: null,
    }, { ...previous, revision: 2, latestResume: { ...latestResume, requestedAt: 3 }, lastActivityAt: 3 }))
      .toThrow(/cannot be rewritten/)
  })
})

describe('service rejection and evidence branches', () => {
  async function serviceHarness(id: string) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(TaskCheckpointService)
    return { ctx, fiber, session: ctx.sessions.create(SessionId(id)), service: ctx.taskCheckpoints }
  }

  it('rejects session mismatch, concurrent Task creation, and unknown-task results', async () => {
    const { ctx, session, service } = await serviceHarness('service-guards')
    const task = new FakeTask(service, session, { runId: runIdFor(session.id, 1), execution, objective: 'x', steps: [FakeTaskStep('one')] })
    expect(() => service.saveCheckpoint(session, { ...task.checkpoint, sessionId: SessionId('other'), revision: 2 })).toThrow(/does not match/)
    expect(() => new FakeTask(service, session, { runId: runIdFor(session.id, 2), execution, objective: 'y', steps: [FakeTaskStep('two')] })).toThrow(/still active/)
    expect(() => service.saveResultManifest(session, manifest({ taskId: taskIdFromString('missing') }))).toThrow(/unknown task/)
    expect(service.get(session, task.checkpoint.taskId)).toEqual(task.checkpoint)
    await ctx.fiber.dispose()
  })

  it('accepts matching successful tool and result-validation evidence', async () => {
    const { ctx, session, service } = await serviceHarness('service-evidence')
    const task = new FakeTask(service, session, { runId: runIdFor(session.id, 1), execution, objective: 'x', steps: [FakeTaskStep('one'), FakeTaskStep('two')] })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const callId = ToolCallId('successful')
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
    const result = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    const first = task.checkpoint.currentStep!
    const second = task.checkpoint.pendingSteps[1]!
    task.checkpoint = service.saveCheckpoint(session, {
      ...task.checkpoint,
      revision: 2,
      completedSteps: [{ ...first, completedAt: 2, evidence: { kind: 'tool-result', eventSeq: result.seq, callId } }],
      currentStep: second,
      pendingSteps: [second],
      lastSuccessAt: 2,
      lastActivityAt: 2,
    })
    const output = service.saveResultManifest(session, manifest({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      status: 'partial',
      validation: { status: 'passed', checks: [{ id: 'structure', status: 'passed' }] },
    }))
    const prior = task.checkpoint
    const completedCandidate = {
      ...prior,
      revision: 3,
      completedSteps: [...prior.completedSteps, {
        ...second, completedAt: 3,
        evidence: { kind: 'result-validation', outputId: output.outputId, manifestRevision: output.revision },
      }],
      pendingSteps: [],
      lastSuccessAt: 3,
      lastActivityAt: 3,
    } as TaskCheckpoint & { currentStep?: TaskCheckpoint['currentStep'] }
    delete completedCandidate.currentStep
    task.checkpoint = service.saveCheckpoint(session, completedCandidate)
    expect(task.checkpoint.completedSteps).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('rejects incomplete outputs at Task completion and fails reads after projection unload', async () => {
    const { ctx, fiber, session, service } = await serviceHarness('service-output')
    const task = new FakeTask(service, session, { runId: runIdFor(session.id, 1), execution, objective: 'x', steps: [] })
    const output = service.saveResultManifest(session, manifest({ taskId: task.checkpoint.taskId, runId: task.checkpoint.latestRunId }))
    task.attachOutput(output.outputId, 2)
    expect(() => task.complete(3)).toThrow(/is not completed/)
    await fiber.dispose()
    expect(() => service.diagnostics(session)).toThrow(/projection is unavailable/)
    await ctx.fiber.dispose()
  })

  it('returns empty diagnostics before a Task and guards no-current fake completion', async () => {
    const { ctx, session, service } = await serviceHarness('service-empty')
    expect(service.diagnostics(session)).toMatchObject({
      resume: { eligibility: 'NOT_RESUMABLE' }, outputs: [], repairHazards: [],
    })
    const task = new FakeTask(service, session, { runId: runIdFor(session.id, 1), execution, objective: 'x', steps: [] })
    expect(() => task.completeCurrent(2)).toThrow(/no current step/)
    task.fail({ code: 'UNKNOWN', message: 'x', severity: 'degraded', origin: 'session', time: 2 }, 2)
    expect(task.checkpoint.failureContext?.currentStepId).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails closed when either durable projection is missing or poisoned', async () => {
    const { ctx, session, service } = await serviceHarness('service-projection-failure')
    const stateOf = ctx.sessionProjections.stateOf.bind(ctx.sessionProjections)
    const spy = vi.spyOn(ctx.sessionProjections, 'stateOf')

    spy.mockImplementation((ownedSession, key) => key === 'taskCheckpoint'
      ? { tasks: [], repairHazards: [], successfulToolResults: [], failure: 'bad task fold' }
      : stateOf(ownedSession, key))
    expect(() => {
      service.diagnostics(session)
    }).toThrow('bad task fold')

    spy.mockImplementation((ownedSession, key) => key === 'taskResults'
      ? undefined
      : stateOf(ownedSession, key))
    expect(() => {
      service.diagnostics(session)
    }).toThrow(/task result projection is unavailable/)

    spy.mockImplementation((ownedSession, key) => key === 'taskResults'
      ? { manifests: [], failure: 'bad result fold' }
      : stateOf(ownedSession, key))
    expect(() => {
      service.diagnostics(session)
    }).toThrow('bad result fold')
    spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('rejects missing, mismatched, failed, and unsettled step evidence', async () => {
    const { ctx, session, service } = await serviceHarness('service-invalid-evidence')
    const task = new FakeTask(service, session, {
      runId: runIdFor(session.id, 1), execution, objective: 'x', steps: [FakeTaskStep('one')],
    })
    const current = task.checkpoint.currentStep!
    const candidate = (evidence: TaskCheckpoint['completedSteps'][number]['evidence']) => {
      const value = {
        ...task.checkpoint,
        revision: 2,
        completedSteps: [{ ...current, completedAt: 2, evidence }],
        pendingSteps: [],
        lastSuccessAt: 2,
        lastActivityAt: 2,
      } as TaskCheckpoint & { currentStep?: TaskCheckpoint['currentStep'] }
      delete value.currentStep
      return value
    }

    expect(() => service.saveCheckpoint(session, candidate({
      kind: 'tool-result', eventSeq: SessionSeq(99), callId: 'missing',
    }))).toThrow(/successful matching/)

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const callId = ToolCallId('failed')
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: '{}' })
    const failed = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'failed' }],
        isError: true,
      }),
    }, { surfaceOp: 'append' })
    expect(() => service.saveCheckpoint(session, candidate({
      kind: 'tool-result', eventSeq: failed.seq, callId: 'other-call',
    }))).toThrow(/successful matching/)
    expect(() => service.saveCheckpoint(session, candidate({
      kind: 'tool-result', eventSeq: failed.seq, callId,
    }))).toThrow(/successful matching/)

    expect(() => service.saveCheckpoint(session, candidate({
      kind: 'result-validation', outputId: taskOutputIdFromString('missing'), manifestRevision: 1,
    }))).toThrow(/passed result-manifest/)
    const output = service.saveResultManifest(session, manifest({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      validation: { status: 'failed', checks: [{ id: 'check', status: 'failed' }] },
    }))
    expect(() => service.saveCheckpoint(session, candidate({
      kind: 'result-validation', outputId: output.outputId, manifestRevision: output.revision,
    }))).toThrow(/passed result-manifest/)
    await ctx.fiber.dispose()
  })

  it('exposes both projection wire views and fixture guard branches', async () => {
    const emptyTasks = emptyTaskCheckpointProjection()
    expect(taskCheckpointProjectionDefinition.wire.view(emptyTasks)).toEqual({ tasks: [], repairHazards: [] })
    const checkpoint = cp()
    expect(taskCheckpointProjectionDefinition.wire.view({
      tasks: [checkpoint], latestTaskId: checkpoint.taskId, repairHazards: [], successfulToolResults: [], failure: null,
    })).toMatchObject({ latestTaskId: checkpoint.taskId })
    expect(resultManifestProjectionDefinition.wire.view({ manifests: [manifest()], failure: null })).toHaveLength(1)

    const { ctx, session, service } = await serviceHarness('service-fixture-guards')
    const pendingTask = new FakeTask(service, session, {
      runId: runIdFor(session.id, 1), execution, objective: 'x', steps: [FakeTaskStep('one')],
    })
    expect(() => pendingTask.complete(2)).toThrow(/still has pending steps/)
    pendingTask.recordResumeSelection(runIdFor(session.id, 2), execution, 2)
    expect(pendingTask.checkpoint.modelRelation).toBe('same-model')
    await ctx.fiber.dispose()
  })
})
