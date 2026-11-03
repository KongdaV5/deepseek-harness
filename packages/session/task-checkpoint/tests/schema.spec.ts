/**
 * Strict runtime schemas and legacy identity behavior for the restored Final
 * Product v1 task authority.
 *
 * The durable payloads these schemas admit were written by a runtime that no
 * longer exists, so the tests pin the two properties a reader depends on: a
 * legacy payload validates without reinterpretation, and every rule the Final
 * Product enforced with `superRefine` is still enforced rather than silently
 * loosened.
 */

import { describe, expect, it } from 'vitest'
import {
  createTaskId,
  createTaskOutputId,
  resultManifestCollectionSchema,
  resultManifestEventDataSchema,
  resultManifestProjectionStateSchema,
  resultManifestSchema,
  taskCheckpointEventDataSchema,
  taskCheckpointProjectionSchema,
  taskCheckpointProjectionStateSchema,
  taskCheckpointSchema,
  taskIdFromString,
  taskOutputIdFromString,
  taskStepIdFromString,
} from '@deepseek-ai/dsh-task-checkpoint'
import { brandLegacyAttemptId, brandLegacyRunId } from '../src/legacy-identity.ts'

/** A minimal valid checkpoint; overrides express exactly one rule at a time. */
function checkpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    taskId: 'task-1',
    revision: 1,
    taskType: 'report',
    sessionId: 'session-1',
    originRunId: 'run-1',
    latestRunId: 'run-1',
    status: 'running',
    originalExecution: { provider: 'deepseek', model: 'chat' },
    latestExecution: { provider: 'deepseek', model: 'chat' },
    modelRelation: 'same-model',
    completedSteps: [],
    pendingSteps: [{ id: 'step-1', title: 'Draft' }],
    createdAt: 1,
    lastActivityAt: 2,
    resumeContext: { objective: 'write', constraints: [], decisions: [], criticalContext: [] },
    outputs: [],
    ...overrides,
  }
}

/** A minimal valid result manifest; overrides express exactly one rule at a time. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    outputId: 'output-1',
    revision: 1,
    taskId: 'task-1',
    runId: 'run-1',
    path: 'report.md',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    execution: { provider: 'deepseek', model: 'chat' },
    validation: { status: 'pending', checks: [] },
    ...overrides,
  }
}

/** Every issue message a failed parse reported. */
function issues(result: { success: boolean; error?: { issues: readonly { message: string }[] } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map(issue => issue.message)
}

const CHECKSUM = { algorithm: 'sha256' as const, value: 'a'.repeat(64) }

describe('task checkpoint schema', () => {
  it('admits a whole legacy revision and preserves the brandless identity values', () => {
    const parsed = taskCheckpointSchema.parse(checkpoint({
      completedSteps: [{
        id: 'step-1',
        title: 'Draft',
        completedAt: 2,
        evidence: { kind: 'result-validation', outputId: 'output-1', manifestRevision: 1 },
      }],
      pendingSteps: [],
      outputs: ['output-1'],
    }))
    expect(parsed.taskId).toBe('task-1')
    expect(parsed.sessionId).toBe('session-1')
    expect(parsed.originRunId).toBe('run-1')
    expect(parsed.completedSteps[0]?.evidence).toEqual({
      kind: 'result-validation', outputId: 'output-1', manifestRevision: 1,
    })
  })

  it('accepts every step-completion evidence variant', () => {
    const evidence = [
      { kind: 'tool-result', eventSeq: 7, callId: 'call-1' },
      { kind: 'result-validation', outputId: 'output-1', manifestRevision: 3 },
      { kind: 'runtime-validation', validator: 'lint', reference: 'run-1' },
    ]
    for (const [index, item] of evidence.entries()) {
      const parsed = taskCheckpointSchema.safeParse(checkpoint({
        completedSteps: [{ id: 'step-1', title: 'Draft', completedAt: 2, evidence: item }],
        pendingSteps: [],
      }))
      expect(parsed.success, `evidence variant ${index}`).toBe(true)
    }
  })

  it('rejects an unknown step-completion evidence kind', () => {
    const result = taskCheckpointSchema.safeParse(checkpoint({
      completedSteps: [{ id: 'step-1', title: 'Draft', completedAt: 2, evidence: { kind: 'guessed' } }],
      pendingSteps: [],
    }))
    expect(result.success).toBe(false)
  })

  it('rejects unnormalized and empty identity strings', () => {
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({ taskId: ' padded' }))))
      .toContain('taskId must be normalized')
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({ taskId: '' }))))
      .toContain('Too small: expected string to have >=1 characters')
    expect(taskCheckpointSchema.safeParse(checkpoint({ originRunId: ' run-1' })).success).toBe(false)
  })

  it('rejects unknown keys at every level', () => {
    expect(taskCheckpointSchema.safeParse(checkpoint({ extra: 1 })).success).toBe(false)
    expect(taskCheckpointSchema.safeParse(checkpoint({ originalExecution: { provider: 'p', model: 'm', extra: 1 } })).success)
      .toBe(false)
    expect(taskCheckpointSchema.safeParse(checkpoint({ completedSteps: [{ id: 's', title: 't', completedAt: 1, evidence: { kind: 'runtime-validation', validator: 'v', reference: 'r', extra: 1 } }], pendingSteps: [] })).success)
      .toBe(false)
  })

  it('accepts the optional execution, failure, and resume fields when present', () => {
    const parsed = taskCheckpointSchema.safeParse(checkpoint({
      status: 'failed',
      originalExecution: {
        provider: 'deepseek',
        model: 'chat',
        backend: 'primary',
        requestedReasoning: 'high',
        resolvedReasoning: 'medium',
      },
      latestExecution: { provider: 'deepseek', model: 'reasoner', backend: 'fallback' },
      modelRelation: 'model-changed',
      currentStep: { id: 'step-1', title: 'Draft' },
      lastSuccessAt: 2,
      failureContext: {
        primaryError: {
          code: 'PROVIDER_TIMEOUT',
          message: 'timed out',
          severity: 'fatal',
          origin: 'provider',
          time: 2,
          providerRequestId: 'req-1',
        },
        failedAt: 2,
        failedAttemptId: 'attempt-1',
        currentStepId: 'step-1',
      },
      latestResume: {
        requestedAt: 2,
        runId: 'run-1',
        executionPlan: ['step-1'],
        context: { estimatedTokens: 10, maxTokens: 20, includedSections: ['objective'], omittedSections: [] },
      },
    }))
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown error code, severity, or origin', () => {
    const failure = (primaryError: Record<string, unknown>): Record<string, unknown> => ({
      failureContext: { primaryError, failedAt: 2 },
    })
    const base = { code: 'UNKNOWN', message: 'm', severity: 'fatal', origin: 'provider', time: 2 }
    expect(taskCheckpointSchema.safeParse(checkpoint(failure({ ...base, code: 'NOT_A_CODE' }))).success).toBe(false)
    expect(taskCheckpointSchema.safeParse(checkpoint(failure({ ...base, severity: 'minor' }))).success).toBe(false)
    expect(taskCheckpointSchema.safeParse(checkpoint(failure({ ...base, origin: 'nowhere' }))).success).toBe(false)
  })

  it('rejects a duplicate completed step', () => {
    const step = { id: 'step-1', title: 'Draft', completedAt: 2, evidence: { kind: 'runtime-validation', validator: 'v', reference: 'r' } }
    const result = taskCheckpointSchema.safeParse(checkpoint({ completedSteps: [step, step], pendingSteps: [] }))
    expect(issues(result)).toContain('duplicate completed step step-1')
  })

  it('rejects a duplicate pending step', () => {
    const result = taskCheckpointSchema.safeParse(checkpoint({
      pendingSteps: [{ id: 'step-1', title: 'Draft' }, { id: 'step-1', title: 'Draft' }],
    }))
    expect(issues(result)).toContain('duplicate pending step step-1')
  })

  it('rejects a step that is both completed and pending', () => {
    const result = taskCheckpointSchema.safeParse(checkpoint({
      completedSteps: [{ id: 'step-1', title: 'Draft', completedAt: 2, evidence: { kind: 'runtime-validation', validator: 'v', reference: 'r' } }],
      pendingSteps: [{ id: 'step-1', title: 'Draft' }],
      currentStep: { id: 'step-1', title: 'Draft' },
    }))
    expect(issues(result)).toContain('step step-1 cannot be completed and pending')
  })

  it('rejects a current step that is not pending', () => {
    const result = taskCheckpointSchema.safeParse(checkpoint({
      pendingSteps: [{ id: 'step-2', title: 'Publish' }],
      currentStep: { id: 'step-1', title: 'Draft' },
    }))
    expect(issues(result)).toContain('currentStep must remain in pendingSteps until completion')
  })

  it('rejects a completed task that retains current or pending work', () => {
    const result = taskCheckpointSchema.safeParse(checkpoint({ status: 'completed' }))
    expect(issues(result)).toContain('completed task cannot retain current or pending steps')
  })

  it('accepts a completed task with no outstanding work', () => {
    expect(taskCheckpointSchema.safeParse(checkpoint({ status: 'completed', pendingSteps: [] })).success).toBe(true)
  })

  it('rejects a failure context that disagrees with the current step', () => {
    const result = taskCheckpointSchema.safeParse(checkpoint({
      currentStep: { id: 'step-1', title: 'Draft' },
      failureContext: {
        primaryError: { code: 'BLOCKED', message: 'm', severity: 'fatal', origin: 'session', time: 2 },
        failedAt: 2,
        currentStepId: 'step-2',
      },
    }))
    expect(issues(result)).toContain('failureContext.currentStepId must identify currentStep')
  })

  it('rejects timestamps that cannot have happened in that order', () => {
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({ lastSuccessAt: 5, lastActivityAt: 2 }))))
      .toContain('lastSuccessAt cannot follow lastActivityAt')
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({ createdAt: 5, lastActivityAt: 2 }))))
      .toContain('createdAt cannot follow lastActivityAt')
  })

  it('rejects a model relation that disagrees with the recorded executions', () => {
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({ modelRelation: 'model-changed' }))))
      .toContain('modelRelation must be same-model')
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({
      latestExecution: { provider: 'deepseek', model: 'reasoner' },
      modelRelation: 'same-model',
    })))).toContain('modelRelation must be model-changed')
  })

  it('rejects duplicate output references', () => {
    const result = taskCheckpointSchema.safeParse(checkpoint({ outputs: ['output-1', 'output-1'] }))
    expect(issues(result)).toContain('outputs must be unique')
  })

  it('rejects resume metadata that contradicts the current run or budget', () => {
    const latestResume = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      requestedAt: 2,
      runId: 'run-1',
      executionPlan: ['step-1'],
      context: { estimatedTokens: 10, maxTokens: 20, includedSections: [], omittedSections: [] },
      ...overrides,
    })
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({ latestResume: latestResume({ runId: 'run-2' }) }))))
      .toContain('latestResume.runId must equal latestRunId')
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({
      latestResume: latestResume({ executionPlan: ['step-1', 'step-1'] }),
    })))).toContain('latestResume.executionPlan must be unique')
    expect(issues(taskCheckpointSchema.safeParse(checkpoint({
      latestResume: latestResume({
        context: { estimatedTokens: 21, maxTokens: 20, includedSections: [], omittedSections: [] },
      }),
    })))).toContain('latestResume context cannot exceed its admitted budget')
    expect(taskCheckpointSchema.safeParse(checkpoint({ latestResume: latestResume() })).success).toBe(true)
  })

  it('requires a positive revision and version 1', () => {
    expect(taskCheckpointSchema.safeParse(checkpoint({ revision: 0 })).success).toBe(false)
    expect(taskCheckpointSchema.safeParse(checkpoint({ version: 2 })).success).toBe(false)
  })
})

describe('result manifest schema', () => {
  it('admits a whole legacy revision', () => {
    const parsed = resultManifestSchema.parse(manifest({
      status: 'completed',
      completedAt: 3,
      size: 128,
      checksum: CHECKSUM,
      validation: { status: 'passed', checks: [{ id: 'structure', status: 'passed' }] },
    }))
    expect(parsed.outputId).toBe('output-1')
    expect(parsed.runId).toBe('run-1')
    expect(parsed.checksum).toEqual(CHECKSUM)
  })

  it('rejects a checksum that is not lowercase sha256 hex', () => {
    expect(resultManifestSchema.safeParse(manifest({ checksum: { algorithm: 'sha256', value: 'A'.repeat(64) } })).success)
      .toBe(false)
    expect(resultManifestSchema.safeParse(manifest({ checksum: { algorithm: 'md5', value: 'a'.repeat(64) } })).success)
      .toBe(false)
  })

  it('rejects a validation aggregate that contradicts its checks', () => {
    expect(issues(resultManifestSchema.safeParse(manifest({
      validation: { status: 'passed', checks: [{ id: 'a', status: 'failed' }] },
    })))).toContain('passed validation cannot contain failed checks')
    expect(issues(resultManifestSchema.safeParse(manifest({
      validation: { status: 'failed', checks: [{ id: 'a', status: 'passed' }] },
    })))).toContain('failed validation requires a failed check')
    expect(resultManifestSchema.safeParse(manifest({
      validation: { status: 'failed', checks: [{ id: 'a', status: 'failed', message: 'bad' }] },
    })).success).toBe(true)
  })

  it('rejects timestamps that cannot have happened in that order', () => {
    expect(issues(resultManifestSchema.safeParse(manifest({ updatedAt: 0 }))))
      .toContain('result updatedAt cannot precede createdAt')
    expect(issues(resultManifestSchema.safeParse(manifest({ completedAt: 0 }))))
      .toContain('result completedAt cannot precede createdAt')
  })

  it('requires a completed result to carry size, checksum, completion time, and passed validation', () => {
    const completed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => manifest({
      status: 'completed',
      completedAt: 3,
      size: 128,
      checksum: CHECKSUM,
      validation: { status: 'passed', checks: [] },
      ...overrides,
    })
    expect(issues(resultManifestSchema.safeParse(completed({ size: undefined }))))
      .toContain('completed result must have size > 0')
    expect(issues(resultManifestSchema.safeParse(completed({ size: 0 }))))
      .toContain('completed result must have size > 0')
    expect(issues(resultManifestSchema.safeParse(completed({ checksum: undefined }))))
      .toContain('completed result requires a checksum')
    expect(issues(resultManifestSchema.safeParse(completed({ completedAt: undefined }))))
      .toContain('completed result requires completedAt')
    expect(issues(resultManifestSchema.safeParse(completed({ validation: { status: 'pending', checks: [] } }))))
      .toContain('completed result requires passed validation')
    expect(resultManifestSchema.safeParse(completed()).success).toBe(true)
  })

  it('rejects an unknown status or an unnormalized path', () => {
    expect(resultManifestSchema.safeParse(manifest({ status: 'abandoned' })).success).toBe(false)
    expect(issues(resultManifestSchema.safeParse(manifest({ path: ' report.md' }))))
      .toContain('result path must be normalized')
  })
})

describe('durable event envelopes', () => {
  it('requires the restored event kind and version', () => {
    expect(taskCheckpointEventDataSchema.safeParse({ kind: 'task/checkpoint', version: 1, checkpoint: checkpoint() }).success)
      .toBe(true)
    expect(taskCheckpointEventDataSchema.safeParse({ kind: 'task/result-manifest', version: 1, checkpoint: checkpoint() }).success)
      .toBe(false)
    expect(taskCheckpointEventDataSchema.safeParse({ kind: 'task/checkpoint', version: 2, checkpoint: checkpoint() }).success)
      .toBe(false)
    expect(resultManifestEventDataSchema.safeParse({ kind: 'task/result-manifest', version: 1, manifest: manifest() }).success)
      .toBe(true)
    expect(resultManifestEventDataSchema.safeParse({ kind: 'task/result-manifest', version: 1, manifest: manifest({ taskId: 'x ' }) }).success)
      .toBe(false)
  })
})

describe('projection schemas', () => {
  it('validates cached task state and its client view', () => {
    const state = { tasks: [checkpoint()], latestTaskId: 'task-1', repairHazards: [], successfulToolResults: [], failure: null }
    expect(taskCheckpointProjectionStateSchema.safeParse(state).success).toBe(true)
    expect(taskCheckpointProjectionSchema.safeParse({
      tasks: [checkpoint()],
      latestTaskId: 'task-1',
      repairHazards: [{ taskId: 'task-1', callId: 'call-1', code: 'TOOL_NOT_STARTED', eventSeq: 3 }],
    }).success).toBe(true)
    expect(taskCheckpointProjectionSchema.safeParse({
      tasks: [],
      repairHazards: [{ taskId: 'task-1', callId: 'call-1', code: 'TOOL_MAYBE', eventSeq: 3 }],
    }).success).toBe(false)
  })

  it('validates cached result state and the wire collection', () => {
    expect(resultManifestProjectionStateSchema.safeParse({ manifests: [manifest()], failure: null }).success).toBe(true)
    expect(resultManifestCollectionSchema.safeParse([manifest()]).success).toBe(true)
    expect(resultManifestCollectionSchema.safeParse([manifest({ revision: 0 })]).success).toBe(false)
  })
})

describe('task-domain identity constructors', () => {
  it('brands normalized non-empty identities', () => {
    expect(taskIdFromString('task-1')).toBe('task-1')
    expect(taskStepIdFromString('step-1')).toBe('step-1')
    expect(taskOutputIdFromString('output-1')).toBe('output-1')
  })

  it('rejects empty or unnormalized identities', () => {
    expect(() => taskIdFromString('')).toThrow(/task id must be a non-empty normalized string/)
    expect(() => taskStepIdFromString(' step-1')).toThrow(/task step id must be a non-empty normalized string/)
    expect(() => taskOutputIdFromString('output-1 ')).toThrow(/task output id must be a non-empty normalized string/)
  })

  it('mints collision-resistant identities with the expected prefixes', () => {
    expect(createTaskId()).toMatch(/^task-[0-9a-f-]{36}$/)
    expect(createTaskOutputId()).toMatch(/^task-output-[0-9a-f-]{36}$/)
    expect(createTaskId()).not.toBe(createTaskId())
  })
})

describe('legacy identity branding', () => {
  it('applies the preserved brand without changing the value', () => {
    expect(brandLegacyRunId('run-1')).toBe('run-1')
    expect(brandLegacyAttemptId('attempt-1')).toBe('attempt-1')
  })
})
