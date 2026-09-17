/** Pure resume eligibility classification. It authorizes no execution. */

import type {
  ResultManifest,
  ResumeDecision,
  TaskCheckpoint,
  TaskExecutionMetadata,
  TaskRepairHazard,
} from './types.ts'

/** Inputs to one read-only resume-safety decision. */
export interface ResumeEligibilityInput {
  readonly checkpoint?: TaskCheckpoint
  readonly outputs: readonly ResultManifest[]
  readonly repairHazards: readonly TaskRepairHazard[]
  readonly requestedExecution?: TaskExecutionMetadata
  /** Automatic is the conservative default; cancellation requires an explicit user trigger. */
  readonly trigger?: 'automatic' | 'user'
}

function relation(checkpoint: TaskCheckpoint | undefined, requested: TaskExecutionMetadata | undefined) {
  if (checkpoint === undefined || requested === undefined) return checkpoint?.modelRelation ?? 'same-model'
  return checkpoint.originalExecution.model === requested.model ? 'same-model' : 'model-changed'
}

/**
 * Classify whether a checkpoint may be resumed. `SAFE_TO_RESUME` means only
 * that a future orchestrator may proceed to its own external-state validation;
 * this function never retries a tool or starts a Run.
 * @param input - checkpoint, output, repair, model, and trigger facts.
 * @returns finite read-only eligibility and exact pending steps.
 */
export function classifyResumeEligibility(input: ResumeEligibilityInput): ResumeDecision {
  const checkpoint = input.checkpoint
  const modelRelation = relation(checkpoint, input.requestedExecution)
  if (checkpoint === undefined) {
    return { eligibility: 'NOT_RESUMABLE', reason: 'No task checkpoint exists.', pendingSteps: [], modelRelation }
  }
  if (checkpoint.status === 'completed') {
    return { eligibility: 'COMPLETED', reason: 'The task is already completed.', pendingSteps: [], modelRelation }
  }
  const hazards = input.repairHazards.filter(hazard => hazard.taskId === checkpoint.taskId)
  if (hazards.some(hazard => hazard.code === 'TOOL_OUTCOME_UNKNOWN')) {
    return {
      eligibility: 'BLOCKED_UNKNOWN_SIDE_EFFECT',
      reason: 'A recorded tool call has no durable outcome; external state must be verified before any retry.',
      pendingSteps: checkpoint.pendingSteps,
      modelRelation,
    }
  }
  if (checkpoint.status === 'blocked') {
    return {
      eligibility: 'NOT_RESUMABLE',
      reason: 'The task is explicitly blocked and requires its blocker to be resolved.',
      pendingSteps: checkpoint.pendingSteps,
      modelRelation,
    }
  }
  if (checkpoint.status === 'cancelled' && input.trigger !== 'user') {
    return {
      eligibility: 'NOT_RESUMABLE',
      reason: 'A user-cancelled task is never resumed automatically.',
      pendingSteps: checkpoint.pendingSteps,
      modelRelation,
    }
  }
  if (checkpoint.pendingSteps.length === 0) {
    return {
      eligibility: 'NOT_RESUMABLE',
      reason: 'The checkpoint has no pending step to resume.',
      pendingSteps: [],
      modelRelation,
    }
  }
  const ownedOutputs = input.outputs.filter(output => checkpoint.outputs.includes(output.outputId))
  if (ownedOutputs.length !== checkpoint.outputs.length) {
    return {
      eligibility: 'NEEDS_VALIDATION',
      reason: 'At least one governed output reference has no Result Manifest.',
      pendingSteps: checkpoint.pendingSteps,
      modelRelation,
    }
  }
  if (ownedOutputs.some(output => output.status === 'running' || output.validation.status === 'pending')) {
    return {
      eligibility: 'NEEDS_VALIDATION',
      reason: 'At least one governed result has an unsettled state that must be validated.',
      pendingSteps: checkpoint.pendingSteps,
      modelRelation,
    }
  }
  if (ownedOutputs.some(output => output.status !== 'completed' && output.status !== 'partial')) {
    return {
      eligibility: 'NEEDS_VALIDATION',
      reason: 'At least one governed result is neither completed nor an explicitly partial resume input.',
      pendingSteps: checkpoint.pendingSteps,
      modelRelation,
    }
  }
  if (modelRelation === 'model-changed') {
    return {
      eligibility: 'NEEDS_VALIDATION',
      reason: `Resume model ${input.requestedExecution?.model ?? checkpoint.latestExecution.model} differs from original model ${checkpoint.originalExecution.model}.`,
      pendingSteps: checkpoint.pendingSteps,
      modelRelation,
    }
  }
  return {
    eligibility: 'SAFE_TO_RESUME',
    reason: hazards.some(hazard => hazard.code === 'TOOL_NOT_STARTED')
      ? 'The interrupted tool was never recorded as started; the remaining steps may be planned again.'
      : 'The checkpoint has pending work and no known unsafe side effect.',
    pendingSteps: checkpoint.pendingSteps,
    modelRelation,
  }
}
