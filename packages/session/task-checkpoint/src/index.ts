/**
 * Read compatibility for the Final Product v1 task authority and the pure
 * projections that fold it.
 *
 * The package restores two durable Session event types (`task/checkpoint`,
 * `task/result-manifest`) as first-party known vocabulary, the strict runtime
 * schemas that admit a legacy payload unchanged, and the Task/Result
 * projection definitions a consumer can register. It deliberately owns no
 * Cordis service, no producer, and no resume policy: the current build never
 * writes these events, and nothing here authorizes or blocks a resume.
 *
 * @module @deepseek-ai/dsh-task-checkpoint
 */

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
