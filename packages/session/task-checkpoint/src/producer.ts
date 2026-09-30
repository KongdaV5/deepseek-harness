/**
 * Durable producers for the two Final Product task event streams.
 *
 * Every write here goes through {@link Session.appendIgnorable}, the single
 * writer that already carries the `ignorable` envelope marker: the task events
 * are authoritative in this build and skippable for a reader that has no task
 * layer. Nothing in this module reads Session history — the canonical reader contract
 * requires live projection state — so a producer validates a candidate
 * against an explicit {@link TaskAuthority} the caller read from the Session
 * projections.
 *
 * Two invariants keep the producers honest:
 *
 * - **No predicted Run.** A Run identity is one durable upstream turn, so a
 *   candidate may only name a Run whose `turn/start` already committed. Each
 *   input therefore names a *turn*, and the producer mints the identity itself
 *   with `runIdFor`, rejecting any turn beyond the durable
 *   turn-boundary watermark. A producer cannot record a Run that has not
 *   started, because it never receives a free-form Run identity to record.
 * - **No guessed progress.** The task domain owns the schema and the transition rules.
 *   A successor is validated by them, so revisions advance by exactly one,
 *   completed steps are append-only, and a completed Task stays terminal.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/producer
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { TaskContinuityError } from './errors.ts'
import {
  assertTaskCheckpointTransition,
  assertResultManifestTransition,
} from './projection.ts'
import { resultManifestSchema, taskCheckpointSchema } from './schema.ts'
import type {
  CompletedTaskStep,
  ResultManifest,
  ResultManifestProjectionState,
  TaskCheckpoint,
  TaskCheckpointProjectionState,
  TaskExecutionMetadata,
  TaskId,
  TaskModelRelation,
  TaskOutputId,
  TaskResumeContext,
  TaskResumeContextBudget,
  TaskStatus,
  TaskStep,
  TaskStepId,
  RunId,
} from './types.ts'

/**
 * One consistent read of the durable facts a write validates against.
 *
 * `lastTurn` is the owning Session's turn-boundary watermark: the highest turn
 * whose `turn/start` has committed, or `0` before the first turn. It is the
 * only authority that makes a Run identity durable, so it is a required input
 * rather than something a producer infers.
 */
export interface TaskAuthority {
  /** The Session that owns the durable Task. */
  readonly session: Session
  /** Highest committed turn of {@link TaskAuthority.session}; `0` before the first turn. */
  readonly lastTurn: number
  /** Whether a committed turn is still open — no `turn/end` has closed it. */
  readonly openRun: boolean
  /** Current `taskCheckpoint` fold state covering every committed revision. */
  readonly checkpoint: TaskCheckpointProjectionState
  /** Current `taskResults` fold state covering every committed manifest revision. */
  readonly results: ResultManifestProjectionState
}

/** Explicit input for the first durable revision of one Task. */
export interface CreateTaskCheckpointInput {
  readonly taskId: TaskId
  readonly taskType: string
  /** The committed turn whose Run owns the Task; never a predicted turn. */
  readonly originTurn: number
  readonly execution: TaskExecutionMetadata
  readonly status?: TaskStatus
  readonly completedSteps?: readonly CompletedTaskStep[]
  readonly currentStep?: TaskStep
  readonly pendingSteps: readonly TaskStep[]
  readonly resumeContext: TaskResumeContext
  readonly outputs?: readonly TaskOutputId[]
  readonly createdAt?: number
  readonly lastActivityAt?: number
}

/**
 * One compare-and-set successor revision of an existing Task.
 *
 * `expectedRevision` is what makes two writers that read the same predecessor
 * unable to both succeed: the second one declares a revision the fold has
 * already left behind and is rejected before it reaches the log.
 */
export interface TaskCheckpointUpdate {
  /** The durable revision this successor supersedes; any other value fails closed. */
  readonly expectedRevision: number
  /** The complete successor value, already at `expectedRevision + 1`. */
  readonly checkpoint: TaskCheckpoint
  /** The committed turn of `checkpoint.latestRunId`; never a predicted turn. */
  readonly latestTurn: number
}

/** Explicit input for recording an admitted resume against the Run that actually started. */
export interface AcceptedResumeInput {
  /** The committed turn whose `turn/start` already exists; never a predicted turn. */
  readonly turn: number
  readonly taskId: TaskId
  readonly requestedAt: number
  /** The unfinished work this Run is admitted to execute, in order. */
  readonly executionPlan: readonly TaskStepId[]
  readonly context: TaskResumeContextBudget
  readonly latestExecution?: TaskExecutionMetadata
  readonly modelRelation?: TaskModelRelation
}

/** The exact Run identity of one committed turn, or a fail-closed rejection. */
function durableRun(sessionId: SessionId, turn: number, lastTurn: number, subject: string): RunId {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new TaskContinuityError('TASK_RUN_NOT_DURABLE', `${subject} turn must be a positive safe integer, got ${String(turn)}`)
  }
  if (turn > lastTurn) {
    throw new TaskContinuityError(
      'TASK_RUN_NOT_DURABLE',
      `${subject} names turn ${String(turn)}, but only ${String(lastTurn)} durable turn(s) have committed in session "${String(sessionId)}"`,
    )
  }
  return runIdFor(sessionId, turn)
}

/** Translate one projection/transition rejection into the stable write-boundary code. */
function transitionFailure(code: 'TASK_TRANSITION_INVALID', error: unknown): TaskContinuityError {
  const detail = error instanceof Error ? error.message : String(error)
  return new TaskContinuityError(code, detail, { cause: error })
}

/** Validate one whole checkpoint candidate against the domain schema. */
function parseCheckpoint(candidate: TaskCheckpoint, sessionId: SessionId): TaskCheckpoint {
  const checkpoint = taskCheckpointSchema.parse(candidate)
  if (checkpoint.sessionId !== sessionId) {
    throw new TaskContinuityError(
      'TASK_SESSION_MISMATCH',
      `checkpoint sessionId "${String(checkpoint.sessionId)}" does not match the owning session "${String(sessionId)}"`,
    )
  }
  return checkpoint
}

/**
 * Prove that every completed step still rests on durable success.
 *
 * A step may be treated as safely completed only while its stored evidence is
 * still resolvable: a `tool-result` citation must still match a projected
 * successful tool result, and a `result-validation` citation must still name a
 * durable manifest revision whose validation passed. `runtime-validation`
 * evidence keeps the stored validator reference; the runtime that ran it owns
 * its meaning, so this producer neither re-derives nor invalidates it.
 *
 * Missing evidence can never be regenerated from model prose, so it fails
 * closed here instead of silently downgrading a completed step.
 */
function verifyCompletedEvidence(authority: TaskAuthority, checkpoint: TaskCheckpoint): void {
  for (const step of checkpoint.completedSteps) {
    const evidence = step.evidence
    if (evidence.kind === 'runtime-validation') continue
    if (evidence.kind === 'tool-result') {
      const match = authority.checkpoint.successfulToolResults
        .find(candidate => candidate.eventSeq === evidence.eventSeq)
      if (match?.callId !== evidence.callId) {
        throw new TaskContinuityError(
          'TASK_EVIDENCE_INVALID',
          `completed step ${String(step.id)} does not cite a durable successful tool/result`,
        )
      }
      continue
    }
    const manifest = authority.results.manifests
      .find(candidate => candidate.outputId === evidence.outputId)
    if (manifest === undefined) {
      throw new TaskContinuityError(
        'TASK_EVIDENCE_INVALID',
        `completed step ${String(step.id)} cites result ${String(evidence.outputId)} revision ${String(evidence.manifestRevision)}, which no durable manifest satisfies`,
      )
    }
    if (manifest.revision !== evidence.manifestRevision) {
      throw new TaskContinuityError(
        'TASK_EVIDENCE_INVALID',
        `completed step ${String(step.id)} cites result ${String(evidence.outputId)} revision ${String(evidence.manifestRevision)}, but the durable revision is ${String(manifest.revision)}`,
      )
    }
    if (manifest.validation.status !== 'passed') {
      throw new TaskContinuityError(
        'TASK_EVIDENCE_INVALID',
        `completed step ${String(step.id)} cites result ${String(evidence.outputId)} revision ${String(evidence.manifestRevision)}, whose validation did not pass`,
      )
    }
  }
}

/**
 * Enforce the result-manifest ordering rule for one Task revision.
 *
 * A Task may only reference result revisions that already exist, so a manifest
 * is always appended before the checkpoint that cites it. Completion is the
 * strict case: the Task may not finish while one of its governed outputs is
 * still short of a durable `completed` revision.
 */
function verifyResultOrdering(authority: TaskAuthority, checkpoint: TaskCheckpoint): void {
  if (checkpoint.status !== 'completed') return
  for (const outputId of checkpoint.outputs) {
    const manifest = authority.results.manifests.find(candidate => candidate.outputId === outputId)
    if (manifest?.status !== 'completed') {
      throw new TaskContinuityError(
        'TASK_RESULT_INVALID',
        `task cannot complete while output ${String(outputId)} has no durable completed manifest`,
      )
    }
  }
}

/** Reject a new Task while another Task in the same Session is still open. */
function assertNoCompetingTask(authority: TaskAuthority, checkpoint: TaskCheckpoint): void {
  if (authority.checkpoint.tasks.some(task => task.taskId === checkpoint.taskId)) return
  const active = authority.checkpoint.tasks
    .find(task => task.status !== 'completed' && task.status !== 'cancelled')
  if (active === undefined) return
  throw new TaskContinuityError(
    'TASK_ALREADY_ACTIVE',
    `task ${String(active.taskId)} is still active in this Session`,
  )
}

/**
 * Commit the first durable revision of one Task.
 *
 * The Task's origin Run is derived from a committed turn, so a caller cannot
 * open a Task against work that has not started. A Session may hold only one
 * open Task at a time: two Tasks in one conversation would leave the second's
 * progress unattributable.
 *
 * @param authority - durable facts read from the owning Session's projections.
 * @param input - explicit Task identity, origin turn, plan, and resume facts.
 * @returns the committed checkpoint, now at revision 1.
 * @throws TaskContinuityError when the origin Run is not durable, the Session
 *   already holds an open Task, or the value is not a valid revision 1.
 */
export function createTaskCheckpoint(
  authority: TaskAuthority,
  input: CreateTaskCheckpointInput,
): TaskCheckpoint {
  const { session } = authority
  const originRunId = durableRun(session.id, input.originTurn, authority.lastTurn, 'task origin')
  const createdAt = input.createdAt ?? Date.now()
  const checkpoint = parseCheckpoint({
    version: 1,
    taskId: input.taskId,
    revision: 1,
    taskType: input.taskType,
    sessionId: session.id,
    originRunId,
    latestRunId: originRunId,
    status: input.status ?? 'running',
    originalExecution: input.execution,
    latestExecution: input.execution,
    modelRelation: 'same-model',
    completedSteps: [...input.completedSteps ?? []],
    ...input.currentStep === undefined ? {} : { currentStep: input.currentStep },
    pendingSteps: [...input.pendingSteps],
    createdAt,
    lastActivityAt: input.lastActivityAt ?? createdAt,
    resumeContext: input.resumeContext,
    outputs: [...input.outputs ?? []],
  }, session.id)
  assertNoCompetingTask(authority, checkpoint)
  try {
    assertTaskCheckpointTransition(authority.checkpoint, checkpoint)
  } catch (error: unknown) {
    throw transitionFailure('TASK_TRANSITION_INVALID', error)
  }
  verifyCompletedEvidence(authority, checkpoint)
  verifyResultOrdering(authority, checkpoint)
  session.appendIgnorable('plugin:task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint })
  return checkpoint
}

/**
 * Commit the next durable revision of an existing Task.
 *
 * @param authority - durable facts read from the owning Session's projections.
 * @param update - the superseded revision, the committed turn of the successor's
 *   latest Run, and the complete successor value.
 * @returns the committed successor revision.
 * @throws TaskContinuityError when the declared revision is stale, the successor
 *   is not the next legal revision, its latest Run is not durable, or a
 *   completed step no longer rests on durable evidence.
 */
export function appendTaskCheckpointUpdate(
  authority: TaskAuthority,
  update: TaskCheckpointUpdate,
): TaskCheckpoint {
  const { session } = authority
  const checkpoint = parseCheckpoint(update.checkpoint, session.id)
  const prior = authority.checkpoint.tasks.find(task => task.taskId === checkpoint.taskId)
  if (prior === undefined) {
    throw new TaskContinuityError('TASK_NOT_FOUND', `task ${String(checkpoint.taskId)} has no durable revision to supersede`)
  }
  if (prior.revision !== update.expectedRevision) {
    throw new TaskContinuityError(
      'TASK_REVISION_STALE',
      `task ${String(checkpoint.taskId)} declared expected revision ${String(update.expectedRevision)}, but the durable revision is ${String(prior.revision)}`,
    )
  }
  const latestRunId = durableRun(session.id, update.latestTurn, authority.lastTurn, 'task latest run')
  if (checkpoint.latestRunId !== latestRunId) {
    throw new TaskContinuityError(
      'TASK_RUN_NOT_DURABLE',
      `task latestRunId "${String(checkpoint.latestRunId)}" is not the Run of committed turn ${String(update.latestTurn)}`,
    )
  }
  try {
    assertTaskCheckpointTransition(authority.checkpoint, checkpoint)
  } catch (error: unknown) {
    throw transitionFailure('TASK_TRANSITION_INVALID', error)
  }
  verifyCompletedEvidence(authority, checkpoint)
  verifyResultOrdering(authority, checkpoint)
  session.appendIgnorable('plugin:task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint })
  return checkpoint
}

/**
 * Commit one independently versioned result manifest.
 *
 * Manifests stay separate from Task progress: a result may advance many times
 * inside one Task revision, and a Task may cite several results. Revisions are
 * monotonic per output identity, so a re-publication can never move a cited
 * revision backwards.
 *
 * @param authority - durable facts read from the owning Session's projections.
 * @param candidate - the complete next manifest revision.
 * @param runTurn - the committed turn whose Run produced this revision.
 * @returns the committed manifest.
 * @throws TaskContinuityError when the Task is unknown, the producing Run is not
 *   durable, or the revision is not the next legal one for this output.
 */
export function publishResultManifest(
  authority: TaskAuthority,
  candidate: ResultManifest,
  runTurn: number,
): ResultManifest {
  const { session } = authority
  const manifest = resultManifestSchema.parse(candidate)
  if (!authority.checkpoint.tasks.some(task => task.taskId === manifest.taskId)) {
    throw new TaskContinuityError('TASK_NOT_FOUND', `result refers to unknown task ${String(manifest.taskId)}`)
  }
  durableRun(session.id, runTurn, authority.lastTurn, 'result run')
  if (manifest.runId !== runIdFor(session.id, runTurn)) {
    throw new TaskContinuityError(
      'TASK_RUN_NOT_DURABLE',
      `result runId "${String(manifest.runId)}" is not the Run of committed turn ${String(runTurn)}`,
    )
  }
  try {
    assertResultManifestTransition(authority.results, manifest)
  } catch (error: unknown) {
    throw transitionFailure('TASK_TRANSITION_INVALID', error)
  }
  session.appendIgnorable('plugin:task/result-manifest', { kind: 'task/result-manifest', version: 1, manifest })
  return manifest
}
/**
 * Record an admitted resume against the Run that actually started.
 *
 * This is the only place a Task adopts a new Run identity, and it can only run
 * after that Run exists: `turn` must name a committed `turn/start`, and the new
 * `latestRunId` and `resumeRecord.runId` are derived from it. The Task's
 * `originRunId` is never rewritten, because the fold treats it as immutable
 * identity — a Task that spans several Runs keeps the first one forever.
 *
 * The plan is the unfinished work only. A completed step is permanent unless
 * the historical contract explicitly reopens it, so a plan that reaches one is
 * rejected rather than silently trimmed: the caller's model of the Task is
 * wrong, and resuming from it would redo finished work.
 *
 * Calling this twice for the same Run is idempotent — the second call returns
 * the already-recorded revision unchanged — so a redelivered event or a retried
 * seam step cannot fork the Task's history.
 *
 * @param authority - durable facts read from the owning Session's projections.
 * @param input - the committed turn, Task identity, pending-only plan, and the
 *   structured budget of the context this Run was admitted with.
 * @returns the committed resume revision, or the existing one when this Run is
 *   already recorded.
 * @throws TaskContinuityError when the Task is unknown, the Run is not durable,
 *   or the plan is empty, unknown, or intersects completed work.
 */
export function recordAcceptedResume(
  authority: TaskAuthority,
  input: AcceptedResumeInput,
): TaskCheckpoint {
  const { session } = authority
  const prior = authority.checkpoint.tasks.find(task => task.taskId === input.taskId)
  if (prior === undefined) {
    throw new TaskContinuityError('TASK_NOT_FOUND', `task ${String(input.taskId)} has no durable revision to advance`)
  }
  const runId = durableRun(session.id, input.turn, authority.lastTurn, 'accepted resume')
  if (prior.latestResume?.runId === runId) return prior
  if (input.executionPlan.length === 0) {
    throw new TaskContinuityError('TASK_RESUME_PLAN_INVALID', 'an admitted resume plan must contain at least one step')
  }
  const pending = new Map(prior.pendingSteps.map(step => [step.id, step]))
  for (const stepId of input.executionPlan) {
    if (pending.has(stepId)) continue
    throw new TaskContinuityError(
      'TASK_RESUME_PLAN_INVALID',
      `resume plan names step ${String(stepId)}, which is not unfinished work of task ${String(prior.taskId)}`,
    )
  }
  if (new Set(input.executionPlan.map(String)).size !== input.executionPlan.length) {
    throw new TaskContinuityError('TASK_RESUME_PLAN_INVALID', 'an admitted resume plan must not repeat a step')
  }
  return appendTaskCheckpointUpdate(authority, {
    expectedRevision: prior.revision,
    latestTurn: input.turn,
    checkpoint: {
      ...prior,
      revision: prior.revision + 1,
      status: 'running',
      latestRunId: runId,
      latestExecution: input.latestExecution ?? prior.latestExecution,
      modelRelation: input.modelRelation ?? prior.modelRelation,
      lastActivityAt: Math.max(prior.lastActivityAt, input.requestedAt),
      latestResume: {
        requestedAt: input.requestedAt,
        runId,
        executionPlan: [...input.executionPlan],
        context: input.context,
      },
    },
  })
}
