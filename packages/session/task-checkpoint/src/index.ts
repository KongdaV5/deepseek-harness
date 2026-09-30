/** Custom task authority, guarded continuation and V4 Session projections.
 * Producers write plugin-qualified metadata through the canonical Session
 * writer. The incoming format catalog converts legacy V3 identities; native
 * projections consume only V4 identities. Reading stored authority never arms
 * an in-memory continuation or executes a Run.
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

export {
  readableTaskAuthority,
  taskAuthoritySnapshot,
  taskRevisionResolves,
} from './authority.ts'
export type {
  TaskAuthorityLookups,
  TaskAuthorityReadings,
  TaskAuthoritySnapshot,
  TaskAuthoritySnapshotOptions,
} from './authority.ts'

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
