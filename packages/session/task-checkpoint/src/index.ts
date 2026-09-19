/**
 * Durable Task authority for the current upstream: read compatibility for the
 * Final Product v1 task vocabulary, the pure projections that fold it, the
 * guarded-continuation producers and policy, and the seam that adopts a new Run.
 *
 * The package restores two durable Session event types (`task/checkpoint`,
 * `task/result-manifest`) as first-party known vocabulary, the strict runtime
 * schemas that admit a legacy payload unchanged, the projection definitions a
 * consumer registers, and the Stage 8 writer that emits new revisions through
 * `Session.appendIgnorable`. Legacy events keep their exact bytes and stay
 * required-on-read; only newly produced revisions carry the opt-out marker.
 *
 * @module @deepseek-ai/dsh-task-checkpoint
 */

export { TaskContinuityError } from './errors.ts'
export type { TaskContinuityErrorCode } from './errors.ts'

export {
  appendTaskCheckpointUpdate,
  createTaskCheckpoint,
  publishResultManifest,
  recordAcceptedResume,
} from './producer.ts'
export type {
  AcceptedResumeInput,
  CreateTaskCheckpointInput,
  TaskAuthority,
  TaskCheckpointUpdate,
} from './producer.ts'

export { buildResumeContext, decideGuardedResume } from './resume.ts'
export type {
  GuardedResumeDecision,
  GuardedResumeDecisionClass,
  GuardedResumeInput,
  GuardedResumeReason,
  ResumeContext,
  ResumeContextOptions,
} from './resume.ts'

export { default } from './service.ts'
export type { TaskDiagnostics, TaskResumeAdmission, TaskResumeRequest } from './service.ts'

export type {
  AttemptId,
  ClassifiedRunError,
  CompletedTaskStep,
  ResultChecksum,
  ResultManifest,
  ResultManifestProjectionState,
  ResultManifestStatus,
  ResultValidation,
  ResultValidationCheck,
  RunErrorCode,
  RunErrorOrigin,
  RunId,
  SuccessfulTaskToolResult,
  TaskCheckpoint,
  TaskCheckpointProjection,
  TaskCheckpointProjectionState,
  TaskCheckpointRef,
  TaskExecutionMetadata,
  TaskFailureContext,
  TaskId,
  TaskModelRelation,
  TaskOutputId,
  TaskRepairHazard,
  TaskResumeContext,
  TaskResumeContextBudget,
  TaskResumeRecord,
  TaskStatus,
  TaskStep,
  TaskStepCompletionEvidence,
  TaskStepId,
} from './types.ts'

export type { ResultManifestEventData, TaskCheckpointEventData } from './domain.ts'

export {
  resultManifestCollectionSchema,
  resultManifestEventDataSchema,
  resultManifestProjectionStateSchema,
  resultManifestSchema,
  taskCheckpointEventDataSchema,
  taskCheckpointProjectionSchema,
  taskCheckpointProjectionStateSchema,
  taskCheckpointSchema,
} from './schema.ts'

export {
  applyResultManifestProjection,
  applyTaskCheckpointProjection,
  assertResultManifestTransition,
  assertTaskCheckpointTransition,
  emptyResultManifestProjection,
  emptyTaskCheckpointProjection,
  resultManifestProjectionDefinition,
  taskCheckpointProjectionDefinition,
} from './projection.ts'

export {
  createTaskId,
  createTaskOutputId,
  taskIdFromString,
  taskOutputIdFromString,
  taskStepIdFromString,
} from './identity.ts'
