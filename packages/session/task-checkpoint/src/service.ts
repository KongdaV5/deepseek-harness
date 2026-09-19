/**
 * Stage 8 guarded task continuity: durable producers, the resume decision
 * transport, and the one seam that adopts a new Run.
 *
 * The service owns no storage. It reads durable facts from the Session
 * projections the repository already requires for post-resume state — never
 * from synchronous history, which the deprecated-reader decision forbids — and
 * writes through the same single `Session` writer the Session itself uses.
 *
 * ## The post-turn-start seam
 *
 * A new Run exists only after the AgentLoop commits `turn/start`
 * (`agent-loop`'s `turn()`, which appends it before the turn's first step). At
 * that instant the turn number is a committed fact, so `runIdFor(sessionId,
 * turn)` derives the Run that really started. The seam therefore observes the
 * delivered `turn/start` event and never names a turn in advance.
 *
 * Observing is not writing: the Session sets its append-in-progress latch
 * before it publishes, so an observer that appended would be refused as
 * reentrant. The latch is cleared in the same synchronous block that invokes
 * the observers, so deferring the write by one microtask is sufficient and
 * minimal — no timer, no queue, and still one writer. The deferred step
 * re-reads the projections so that a newer Task revision always wins over the
 * outcome it was computed from.
 *
 * @module @deepseek-ai/dsh-task-checkpoint
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { TaskContinuityError } from './errors.ts'
import { readableTaskAuthority, taskAuthoritySnapshot } from './authority.ts'
import type { TaskAuthoritySnapshot, TaskAuthoritySnapshotOptions } from './authority.ts'
import { resultManifestProjectionDefinition, taskCheckpointProjectionDefinition } from './projection.ts'
import {
  appendTaskCheckpointUpdate,
  createTaskCheckpoint,
  publishResultManifest,
  recordAcceptedResume,
} from './producer.ts'
import type {
  AcceptedResumeInput,
  CreateTaskCheckpointInput,
  TaskAuthority,
  TaskCheckpointUpdate,
} from './producer.ts'
import { decideGuardedResume } from './resume.ts'
import type { GuardedResumeDecision } from './resume.ts'
import type {
  ResultManifest,
  TaskCheckpoint,
  TaskExecutionMetadata,
  TaskId,
  TaskModelRelation,
  TaskRepairHazard,
  TaskResumeContextBudget,
  TaskStepId,
} from './types.ts'

/** One process-local admission of a guarded resume, awaiting the Run it owns. */
interface PendingResume {
  readonly taskId: TaskId
  readonly requestedAt: number
  readonly executionPlan: readonly TaskStepId[]
  readonly context: TaskResumeContextBudget
  readonly latestExecution?: TaskExecutionMetadata
  readonly modelRelation?: TaskModelRelation
}

/** Explicit request to continue one Task's unfinished work in a new Run. */
export interface TaskResumeRequest {
  readonly taskId: TaskId
  /** When the user authorized the resume; defaults to the admission instant. */
  readonly requestedAt?: number
  /** The structured budget of the context this Run is admitted with. */
  readonly context: TaskResumeContextBudget
  /** The execution the caller proposes; a model change requires confirmation instead. */
  readonly requestedExecution?: TaskExecutionMetadata
}

/** Outcome of one admission attempt; an unarmed attempt has no side effect. */
export interface TaskResumeAdmission {
  readonly decision: GuardedResumeDecision
  /** Whether the seam now awaits the next committed turn for this Session. */
  readonly armed: boolean
}

/** Read-only Task continuity diagnostics for one Session. */
export interface TaskDiagnostics {
  /** The addressed Task revision, when the Session tracks one. */
  readonly task?: TaskCheckpoint
  /** The classified resume decision and the evidence behind it. */
  readonly decision: GuardedResumeDecision
  /** Every durable result manifest revision in the Session. */
  readonly results: readonly ResultManifest[]
  /** Projected repair hazards, including those belonging to other Tasks. */
  readonly hazards: readonly TaskRepairHazard[]
}

/**
 * Cordis service for durable Task authority and guarded continuation.
 *
 * Installing it registers the two task projections and the resume seam. It is
 * deliberately not part of any composition marker: Stage 8 exposes the
 * capability, and mounting it is a separate ownership decision.
 */
export default class TaskCheckpointService extends Service {
  /** Service name for dependency injection. */
  static override readonly name = 'taskCheckpoints'
  /** The projection registry owns the durable folds this writer validates against. */
  static readonly inject = ['sessionProjections']

  /** Sessions with an admitted resume that the next committed turn will own. */
  private readonly pending = new WeakMap<Session, PendingResume>()

  /**
   * @param ctx - the owning context; its fiber owns the projections and the seam.
   */
  constructor(ctx: Context) {
    super(ctx, 'taskCheckpoints')
    ctx.sessionProjections.register(taskCheckpointProjectionDefinition)
    ctx.sessionProjections.register(resultManifestProjectionDefinition)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/start') return
      if (!this.pending.has(session)) return
      // A Session observer runs inside the publication stack, where a nested
      // append is refused. The latch clears synchronously once the observers
      // return, so one microtask reaches a fresh, legal append.
      queueMicrotask(() => { this.settleResume(session, event.data.turn) })
    })
  }

  /** The durable facts one write validates against, or a fail-closed rejection. */
  private authority(session: Session): TaskAuthority {
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (boundary === undefined) {
      throw new TaskContinuityError(
        'TASK_AUTHORITY_UNAVAILABLE',
        'task continuity requires the turnBoundary session projection to know which turns have committed',
      )
    }
    const checkpoint = this.ctx.sessionProjections.stateOf(session, 'taskCheckpoint')
    const results = this.ctx.sessionProjections.stateOf(session, 'taskResults')
    if (checkpoint === undefined || results === undefined) {
      throw new TaskContinuityError('TASK_AUTHORITY_UNAVAILABLE', 'the task projections are not registered')
    }
    if (checkpoint.failure !== null) {
      throw new TaskContinuityError('TASK_AUTHORITY_UNAVAILABLE', checkpoint.failure)
    }
    if (results.failure !== null) {
      throw new TaskContinuityError('TASK_AUTHORITY_UNAVAILABLE', results.failure)
    }
    return { session, lastTurn: boundary.lastTurn, openRun: boundary.openTurnStartSeq !== null, checkpoint, results }
  }

  /**
   * Commit the first durable revision of one Task.
   * @param session - the Session that owns the durable Task.
   * @param input - explicit Task identity, origin turn, plan, and resume facts.
   * @returns the committed checkpoint at revision 1.
   * @throws TaskContinuityError when the Session has no readable durable authority
   *   or the candidate is not a legal first revision.
   */
  createCheckpoint(session: Session, input: CreateTaskCheckpointInput): TaskCheckpoint {
    return createTaskCheckpoint(this.authority(session), input)
  }

  /**
   * Commit the next durable revision of an existing Task.
   * @param session - the Session that owns the durable Task.
   * @param update - superseded revision, committed latest turn, and successor value.
   * @returns the committed successor revision.
   * @throws TaskContinuityError when the declared revision is stale or the
   *   successor is not a legal next revision.
   */
  advanceCheckpoint(session: Session, update: TaskCheckpointUpdate): TaskCheckpoint {
    return appendTaskCheckpointUpdate(this.authority(session), update)
  }

  /**
   * Commit one independently versioned result manifest.
   * @param session - the Session that owns the durable Task and result.
   * @param candidate - the complete next manifest revision.
   * @param runTurn - the committed turn whose Run produced this revision.
   * @returns the committed manifest.
   * @throws TaskContinuityError when the Task is unknown or the producing Run
   *   has not committed.
   */
  publishResultManifest(session: Session, candidate: ResultManifest, runTurn: number): ResultManifest {
    return publishResultManifest(this.authority(session), candidate, runTurn)
  }

  /**
   * Record an admitted resume against a turn that has already committed.
   *
   * Exposed so a caller that drives its own seam can record the same durable
   * fact; the built-in seam calls exactly this method. `turn` must be committed,
   * so the Run identity it derives is real rather than predicted.
   * @param session - the Session that owns the durable Task.
   * @param input - committed turn, Task identity, pending-only plan, and budget.
   * @returns the committed resume revision, or the existing one for a repeat call.
   * @throws TaskContinuityError when the turn is not durable or the plan is invalid.
   */
  recordAcceptedResume(session: Session, input: AcceptedResumeInput): TaskCheckpoint {
    return recordAcceptedResume(this.authority(session), input)
  }

  /**
   * Read one consistent, detached cut of this Session's durable Task authority.
   *
   * Every registered projection is materialized at the Session cursor in one
   * synchronous pass, so the returned Task revision, result manifests, repair
   * hazards, and successful tool results all describe the same log position.
   * The value is a reader: it appends nothing, mutates nothing, and exposes no
   * writer capability. Callers must re-read rather than retain it as authority
   * across a later mutation.
   *
   * @param session - the Session whose durable Task authority is read.
   * @param options - the Task to address; defaults to the latest tracked Task.
   * @returns the detached snapshot at the current commit cursor.
   * @throws TaskContinuityError with `TASK_AUTHORITY_UNAVAILABLE` when a required
   *   projection is unregistered or holds a failed fold.
   */
  authoritySnapshot(
    session: Session,
    options: TaskAuthoritySnapshotOptions = {},
  ): TaskAuthoritySnapshot {
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    return taskAuthoritySnapshot(readableTaskAuthority({
      sessionId: session.id,
      checkpoint: this.ctx.sessionProjections.stateOf(session, 'taskCheckpoint'),
      results: this.ctx.sessionProjections.stateOf(session, 'taskResults'),
      sequence: session.seq,
      lastTurn: boundary?.lastTurn ?? 0,
      openRun: boundary !== undefined && boundary.openTurnStartSeq !== null,
    }), options)
  }

  /**
   * Read the durable Task continuity diagnostics for one Session.
   * @param session - the Session whose durable Task state is read.
   * @param options - optional Task selection, proposed execution, and context budget.
   * @returns the Task revision, its classified decision, and the evidence behind it.
   * @throws TaskContinuityError when the Session has no readable durable authority.
   */
  diagnostics(
    session: Session,
    options: {
      readonly taskId?: TaskId
      readonly requestedExecution?: TaskExecutionMetadata
      readonly context?: TaskResumeContextBudget
    } = {},
  ): TaskDiagnostics {
    const authority = this.authority(session)
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    const taskId = options.taskId ?? authority.checkpoint.latestTaskId
    const task = taskId === undefined
      ? undefined
      : authority.checkpoint.tasks.find(candidate => candidate.taskId === taskId)
    const results = task === undefined
      ? authority.results.manifests
      : authority.results.manifests.filter(manifest => manifest.taskId === task.taskId)
    const decision = decideGuardedResume({
      ...task === undefined ? {} : { checkpoint: task },
      results: authority.results.manifests,
      hazards: authority.checkpoint.repairHazards,
      successfulToolResults: authority.checkpoint.successfulToolResults,
      sessionId: session.id,
      lastTurn: authority.lastTurn,
      openRun: boundary?.openTurnStartSeq !== null && boundary !== undefined,
      ...options.requestedExecution === undefined ? {} : { requestedExecution: options.requestedExecution },
      ...options.context === undefined ? {} : { context: options.context },
    })
    return {
      ...task === undefined ? {} : { task },
      decision,
      results,
      hazards: authority.checkpoint.repairHazards,
    }
  }

  /**
   * Classify one resume request and, when it is allowed, adopt the next Run.
   *
   * Admission is a process-local promise, not a durable write: a durable
   * "resume requested" record would have to name the Run it is waiting for,
   * which is exactly the prediction this design forbids. Nothing is written
   * until the Run exists, so a crash between admission and the turn simply
   * leaves the Task at its last durable revision.
   *
   * @param session - the Session that owns the durable Task.
   * @param request - Task identity, structured budget, and optional execution.
   * @returns the decision and whether the seam now awaits the next committed turn.
   * @throws TaskContinuityError when the caller supplies no budget for a decision that needs one.
   */
  armResume(session: Session, request: TaskResumeRequest): TaskResumeAdmission {
    const diagnostics = this.diagnostics(session, {
      taskId: request.taskId,
      context: request.context,
      ...request.requestedExecution === undefined ? {} : { requestedExecution: request.requestedExecution },
    })
    if (diagnostics.decision.decision !== 'allowed') {
      return { decision: diagnostics.decision, armed: false }
    }
    const pending: PendingResume = {
      taskId: request.taskId,
      requestedAt: request.requestedAt ?? Date.now(),
      executionPlan: diagnostics.decision.plan,
      context: request.context,
      ...request.requestedExecution === undefined ? {} : { latestExecution: request.requestedExecution },
      ...request.requestedExecution === undefined ? {} : { modelRelation: 'same-model' as const },
    }
    this.pending.set(session, pending)
    return { decision: diagnostics.decision, armed: true }
  }

  /**
   * Drop an admitted resume that has not been adopted by a Run yet.
   *
   * A caller whose wake lost to other input disarms the admission rather than
   * letting the seam attribute an unrelated turn to the Task.
   * @param session - the Session whose admission is withdrawn.
   * @returns whether an admission was pending.
   */
  disarmResume(session: Session): boolean {
    return this.pending.delete(session)
  }

  /** Adopt one committed turn as the Run of the admitted resume, outside the append stack. */
  private settleResume(session: Session, turn: number): void {
    const pending = this.pending.get(session)
    if (pending === undefined) return
    // Claim before writing: a rejected record must not be retried forever.
    this.pending.delete(session)
    try {
      this.recordAcceptedResume(session, {
        turn,
        taskId: pending.taskId,
        requestedAt: pending.requestedAt,
        executionPlan: pending.executionPlan,
        context: pending.context,
        ...pending.latestExecution === undefined ? {} : { latestExecution: pending.latestExecution },
        ...pending.modelRelation === undefined ? {} : { modelRelation: pending.modelRelation },
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`session "${session.id}": task resume was not recorded: ${String(error)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Task authority and guarded continuation for one Session. */
    taskCheckpoints: TaskCheckpointService
  }
}
