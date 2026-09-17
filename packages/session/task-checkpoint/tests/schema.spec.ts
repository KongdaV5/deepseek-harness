import { describe, expect, it } from 'vitest'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  createTaskId,
  resultManifestSchema,
  taskCheckpointSchema,
  taskStepIdFromString,
} from '@deepseek-ai/dsh-task-checkpoint'

const sessionId = SessionId('schema')
const runId = runIdFor(sessionId, 1)
const execution = { provider: 'local', model: 'a' }

function checkpoint() {
  const step = { id: taskStepIdFromString('step'), title: 'step' }
  return {
    version: 1,
    taskId: createTaskId(),
    revision: 1,
    taskType: 'test',
    sessionId,
    originRunId: runId,
    latestRunId: runId,
    status: 'running',
    originalExecution: execution,
    latestExecution: execution,
    modelRelation: 'same-model',
    completedSteps: [],
    currentStep: step,
    pendingSteps: [step],
    createdAt: 1,
    lastActivityAt: 1,
    resumeContext: { objective: 'test', constraints: [], decisions: [], criticalContext: [] },
    outputs: [],
  } as const
}

describe('durable schemas', () => {
  it('requires the current step to remain pending and derives no guessed state', () => {
    expect(taskCheckpointSchema.safeParse(checkpoint()).success).toBe(true)
    expect(taskCheckpointSchema.safeParse({ ...checkpoint(), pendingSteps: [] }).error?.message)
      .toContain('currentStep must remain in pendingSteps')
  })

  it('rejects zero-byte or unvalidated completed manifests', () => {
    const base = {
      version: 1,
      outputId: 'output' as never,
      revision: 1,
      taskId: checkpoint().taskId,
      runId,
      path: '/tmp/result.md',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
      size: 0,
      execution,
      validation: { status: 'pending', checks: [] },
    } as const
    const parsed = resultManifestSchema.safeParse(base)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.message).toContain('completed result must have size > 0')
    expect(parsed.error?.message).toContain('completed result requires passed validation')
  })
})
