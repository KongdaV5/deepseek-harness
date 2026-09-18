/**
 * Pure Session-event projections for task progress, repair hazards, and result
 * manifests.
 *
 * The folds are the Final Product v1 semantics: a checkpoint is a whole
 * revision that must advance by exactly one and may not rewrite completed
 * steps, output references, or its immutable identity; a result manifest is a
 * separate authority that must also advance by exactly one. The definitions are
 * exported values, not registered ones: this package owns no Cordis service, so
 * a consumer registers them through the session-projection registry.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  resultManifestCollectionSchema,
  resultManifestEventDataSchema,
  resultManifestProjectionStateSchema,
  taskCheckpointEventDataSchema,
  taskCheckpointProjectionSchema,
  taskCheckpointProjectionStateSchema,
} from './schema.ts'
import type {
  ResultManifest,
  ResultManifestProjectionState,
  TaskCheckpoint,
  TaskCheckpointProjectionState,
  TaskRepairHazard,
} from './types.ts'

const EMPTY_TASKS: TaskCheckpointProjectionState = {
  tasks: [],
  repairHazards: [],
  successfulToolResults: [],
  failure: null,
}
const EMPTY_RESULTS: ResultManifestProjectionState = { manifests: [], failure: null }

function sameExecution(left: TaskCheckpoint['originalExecution'], right: TaskCheckpoint['originalExecution']): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateCheckpointTransition(previous: TaskCheckpoint | undefined, next: TaskCheckpoint): void {
  if (previous === undefined) {
    if (next.revision !== 1) throw new Error('new task checkpoint must start at revision 1')
    return
  }
  if (next.revision !== previous.revision + 1) throw new Error('task checkpoint revision must advance by exactly one')
  if (previous.status === 'completed') throw new Error('completed task is terminal')
  if (next.sessionId !== previous.sessionId || next.taskType !== previous.taskType
    || next.originRunId !== previous.originRunId || next.createdAt !== previous.createdAt
    || !sameExecution(next.originalExecution, previous.originalExecution)) {
    throw new Error('task checkpoint changed immutable identity or origin metadata')
  }
  if (next.completedSteps.length < previous.completedSteps.length) {
    throw new Error('completed task steps are append-only')
  }
  for (const [index, completed] of previous.completedSteps.entries()) {
    const candidate = next.completedSteps[index]
    if (candidate === undefined || JSON.stringify(candidate) !== JSON.stringify(completed)) {
      throw new Error('completed task steps cannot be rewritten')
    }
  }
  for (const output of previous.outputs) {
    if (!next.outputs.includes(output)) throw new Error('task output references are append-only')
  }
  if (next.lastActivityAt < previous.lastActivityAt) throw new Error('task lastActivityAt cannot move backwards')
  if (previous.latestResume !== undefined && next.latestRunId === previous.latestRunId
    && JSON.stringify(next.latestResume) !== JSON.stringify(previous.latestResume)) {
    throw new Error('resume metadata cannot be rewritten within the same Run')
  }
}

function validateManifestTransition(previous: ResultManifest | undefined, next: ResultManifest): void {
  if (previous === undefined) {
    if (next.revision !== 1) throw new Error('new result manifest must start at revision 1')
    return
  }
  if (next.revision !== previous.revision + 1) throw new Error('result manifest revision must advance by exactly one')
  if (next.taskId !== previous.taskId || next.path !== previous.path || next.createdAt !== previous.createdAt) {
    throw new Error('result manifest changed immutable identity metadata')
  }
  if (previous.status === 'completed') throw new Error('completed result manifest is terminal')
  if (next.updatedAt < previous.updatedAt) throw new Error('result manifest updatedAt cannot move backwards')
}

/**
 * Apply one event to the strict task-checkpoint fold.
 * @param state - state covering all prior events.
 * @param event - next committed Session event.
 * @returns next fold state or the first retained replay failure.
 */
export function applyTaskCheckpointProjection(
  state: TaskCheckpointProjectionState,
  event: SessionEvent,
): TaskCheckpointProjectionState {
  if (state.failure !== null) return state
  try {
    if (event.type === 'task/checkpoint') {
      const parsed = taskCheckpointEventDataSchema.safeParse(event.data)
      if (!parsed.success) throw new Error('invalid task/checkpoint event envelope')
      const checkpoint = parsed.data.checkpoint
      const index = state.tasks.findIndex(task => task.taskId === checkpoint.taskId)
      validateCheckpointTransition(index < 0 ? undefined : state.tasks[index], checkpoint)
      const tasks = index < 0
        ? [...state.tasks, checkpoint]
        : [...state.tasks.slice(0, index), checkpoint, ...state.tasks.slice(index + 1)]
      return { ...state, tasks, latestTaskId: checkpoint.taskId }
    }
    if (event.type !== 'tool/result') return state
    const callId = event.data.message.source.callId
    const latest = state.latestTaskId === undefined
      ? undefined
      : state.tasks.find(task => task.taskId === state.latestTaskId)
    const succeeded = event.data.message.content[0].isError !== true
    const evidenceAlreadyProjected = state.successfulToolResults.some(result => result.eventSeq === event.seq)
    const stateWithEvidence = latest !== undefined && latest.status !== 'completed'
      && succeeded && !evidenceAlreadyProjected
      ? {
        ...state,
        successfulToolResults: [...state.successfulToolResults, { eventSeq: event.seq, callId }],
      }
      : state
    const code = event.data.error?.code
    if (code !== TOOL_NOT_STARTED && code !== TOOL_OUTCOME_UNKNOWN) return stateWithEvidence
    if (latest === undefined || latest.status === 'completed') return stateWithEvidence
    if (stateWithEvidence.repairHazards.some(hazard => hazard.taskId === latest.taskId && hazard.callId === callId)) {
      return stateWithEvidence
    }
    const hazard: TaskRepairHazard = { taskId: latest.taskId, callId, code, eventSeq: event.seq }
    return { ...stateWithEvidence, repairHazards: [...stateWithEvidence.repairHazards, hazard] }
  } catch (error) {
    return { ...state, failure: `task checkpoint replay failed at session event ${event.seq}: ${(error as Error).message}` }
  }
}

/**
 * Apply one event to the strict, separate result-manifest fold.
 * @param state - state covering all prior events.
 * @param event - next committed Session event.
 * @returns next fold state or the first retained replay failure.
 */
export function applyResultManifestProjection(
  state: ResultManifestProjectionState,
  event: SessionEvent,
): ResultManifestProjectionState {
  if (state.failure !== null || event.type !== 'task/result-manifest') return state
  try {
    const parsed = resultManifestEventDataSchema.safeParse(event.data)
    if (!parsed.success) throw new Error('invalid task/result-manifest event envelope')
    const manifest = parsed.data.manifest
    const index = state.manifests.findIndex(item => item.outputId === manifest.outputId)
    validateManifestTransition(index < 0 ? undefined : state.manifests[index], manifest)
    const manifests = index < 0
      ? [...state.manifests, manifest]
      : [...state.manifests.slice(0, index), manifest, ...state.manifests.slice(index + 1)]
    return { manifests, failure: null }
  } catch (error) {
    return { ...state, failure: `result manifest replay failed at session event ${event.seq}: ${(error as Error).message}` }
  }
}

/** `taskCheckpoint` projection definition, registered by its consumer. */
export const taskCheckpointProjectionDefinition = {
  key: 'taskCheckpoint',
  stateVersion: 1,
  stateSchema: taskCheckpointProjectionStateSchema,
  init: () => EMPTY_TASKS,
  apply: applyTaskCheckpointProjection,
  wire: {
    viewSchema: taskCheckpointProjectionSchema,
    view: state => ({
      tasks: state.tasks,
      ...(state.latestTaskId === undefined ? {} : { latestTaskId: state.latestTaskId }),
      repairHazards: state.repairHazards,
    }),
  },
} satisfies ProjectionDefinition<'taskCheckpoint', TaskCheckpointProjectionState>

/** `taskResults` projection definition, kept independent from task progress. */
export const resultManifestProjectionDefinition = {
  key: 'taskResults',
  stateVersion: 1,
  stateSchema: resultManifestProjectionStateSchema,
  init: () => EMPTY_RESULTS,
  apply: applyResultManifestProjection,
  wire: {
    viewSchema: resultManifestCollectionSchema,
    view: state => state.manifests,
  },
} satisfies ProjectionDefinition<'taskResults', ResultManifestProjectionState>

/**
 * Assert that a candidate task revision advances a known fold without poisoning it.
 * @param state - current validated Task projection state.
 * @param checkpoint - candidate complete next revision.
 * @throws when the candidate is not the next legal revision of this task.
 */
export function assertTaskCheckpointTransition(state: TaskCheckpointProjectionState, checkpoint: TaskCheckpoint): void {
  const prior = state.tasks.find(task => task.taskId === checkpoint.taskId)
  validateCheckpointTransition(prior, checkpoint)
}

/**
 * Assert that a candidate result revision advances a known fold without poisoning it.
 * @param state - current validated result projection state.
 * @param manifest - candidate complete next manifest revision.
 * @throws when the candidate is not the next legal revision of this output.
 */
export function assertResultManifestTransition(state: ResultManifestProjectionState, manifest: ResultManifest): void {
  const prior = state.manifests.find(item => item.outputId === manifest.outputId)
  validateManifestTransition(prior, manifest)
}

/**
 * Test and diagnostics initializer for an empty task fold.
 * @returns immutable empty Task projection state.
 */
export function emptyTaskCheckpointProjection(): TaskCheckpointProjectionState {
  return EMPTY_TASKS
}

/**
 * Test and diagnostics initializer for an empty result fold.
 * @returns immutable empty Result projection state.
 */
export function emptyResultManifestProjection(): ResultManifestProjectionState {
  return EMPTY_RESULTS
}
