/**
 * Synthetic durable-authority fixtures for the task-aware policy tests.
 *
 * Every fixture is a plain value: the policy's decision modules are pure, so a
 * test can state exactly the authority cut it wants to judge without mounting a
 * Session, a projection registry, or a writer.
 */

import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  taskIdFromString,
  taskOutputIdFromString,
  taskStepIdFromString,
} from '@deepseek-ai/dsh-task-checkpoint'
import type {
  CompletedTaskStep,
  ResultManifest,
  RunId,
  SuccessfulTaskToolResult,
  TaskAuthoritySnapshot,
  TaskCheckpoint,
  TaskExecutionMetadata,
  TaskRepairHazard,
} from '@deepseek-ai/dsh-task-checkpoint'
import { protectTaskAuthority } from '../src/protection.ts'
import type { TaskProtection } from '../src/types.ts'

/** The Session every fixture belongs to. */
export const SESSION_ID = SessionId('session-1')
/** The Run the fixtures are recorded under. */
export const RUN_ID = 'run-1' as RunId
/** The protected Task identity. */
export const TASK_ID = taskIdFromString('task-1')
/** The one cited output identity. */
export const OUTPUT_ID = taskOutputIdFromString('output-1')
/** The one completed step identity. */
export const STEP_ID = taskStepIdFromString('step-1')
/** The one successful tool result's event seq. */
export const TOOL_EVENT_SEQ = SessionSeq(7)

/** One execution record. */
export function execution(resolvedReasoning?: string): TaskExecutionMetadata {
  return {
    provider: 'local-qwen',
    model: 'iq3-s',
    ...resolvedReasoning === undefined ? {} : { requestedReasoning: resolvedReasoning, resolvedReasoning },
  }
}

/** One durable checkpoint with a completed citation and a cited result revision. */
export function checkpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  const completed: CompletedTaskStep = {
    id: STEP_ID,
    title: 'collect evidence',
    completedAt: 1_000,
    evidence: { kind: 'tool-result', eventSeq: TOOL_EVENT_SEQ, callId: 'call-1' },
  }
  return {
    version: 1,
    taskId: TASK_ID,
    revision: 3,
    taskType: 'investigation',
    sessionId: SESSION_ID,
    originRunId: RUN_ID,
    latestRunId: RUN_ID,
    status: 'running',
    originalExecution: execution('xhigh'),
    latestExecution: execution('xhigh'),
    modelRelation: 'same-model',
    completedSteps: [completed],
    pendingSteps: [{ id: taskStepIdFromString('step-2'), title: 'report' }],
    createdAt: 900,
    lastActivityAt: 1_100,
    resumeContext: {
      objective: 'prove the task survives compaction',
      constraints: ['never truncate protected facts'],
      decisions: ['low then medium'],
      criticalContext: ['the authority cut is durable'],
    },
    outputs: [OUTPUT_ID],
    ...overrides,
  }
}

/** One durable result manifest revision. */
export function manifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  return {
    version: 1,
    outputId: OUTPUT_ID,
    revision: 2,
    taskId: TASK_ID,
    runId: RUN_ID,
    path: 'reports/out.md',
    status: 'completed',
    createdAt: 950,
    updatedAt: 1_000,
    completedAt: 1_000,
    size: 42,
    checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
    execution: execution('xhigh'),
    validation: { status: 'passed', checks: [{ id: 'schema', status: 'passed' }] },
    ...overrides,
  }
}

/** One projected successful tool result the citation resolves against. */
export const SUCCESSFUL_TOOL_RESULT: SuccessfulTaskToolResult = {
  eventSeq: TOOL_EVENT_SEQ,
  callId: 'call-1',
}

/** One repair hazard for the protected Task. */
export function hazard(code: TaskRepairHazard['code']): TaskRepairHazard {
  return { taskId: TASK_ID, callId: 'call-1', code, eventSeq: TOOL_EVENT_SEQ }
}

/**
 * One repair hazard another Task owns.
 *
 * The projection reports every hazard in the Session, so the addressed-Task
 * filter has something real to drop.
 * @param code - the hazard code.
 * @param taskId - the owning Task identity; defaults to a second Task.
 * @returns the hazard, exactly as the projection reports it.
 */
export function foreignHazard(code: TaskRepairHazard['code'], taskId = 'other-task'): TaskRepairHazard {
  return { taskId: taskIdFromString(taskId), callId: 'call-2', code, eventSeq: TOOL_EVENT_SEQ }
}

/** One detached authority cut. */
export function snapshot(overrides: Partial<TaskAuthoritySnapshot> = {}): TaskAuthoritySnapshot {
  return {
    task: checkpoint(),
    latestTaskId: TASK_ID,
    results: [manifest()],
    repairHazards: [],
    successfulToolResults: [SUCCESSFUL_TOOL_RESULT],
    asOfSeq: SessionSeq(11),
    lastTurn: 1,
    openRun: true,
    ...overrides,
  }
}

/** The protection root for the default cut. */
export function protection(overrides: Partial<TaskAuthoritySnapshot> = {}): TaskProtection {
  return protectTaskAuthority(snapshot(overrides))
}

/**
 * The same cut for a Session that tracks no Task at all.
 *
 * Both Task facts are *absent*: the projection reports no addressed Task and no
 * latest Task identity, which `exactOptionalPropertyTypes` distinguishes from
 * present-and-`undefined`.
 * @returns a detached cut with no Task.
 */
export function tasklessSnapshot(): TaskAuthoritySnapshot {
  const { results, repairHazards, successfulToolResults, asOfSeq, lastTurn, openRun } = snapshot()
  return { results, repairHazards, successfulToolResults, asOfSeq, lastTurn, openRun }
}
