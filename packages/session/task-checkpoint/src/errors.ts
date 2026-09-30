/**
 * Stable failure codes from the canonical task-continuity write boundary.
 *
 * The producer rejects a candidate before it reaches the Session log, so every
 * closed failure mode is addressable by code rather than by message. A
 * projection replay rejection keeps its own `failure` string in the fold; this
 * type covers only what a writer decides.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/errors
 */

/** Machine-readable rejection codes from the durable Task write boundary. */
export type TaskContinuityErrorCode =
  /** The candidate belongs to a different Session than the writer owns. */
  | 'TASK_SESSION_MISMATCH'
  /** Another Task is still open in this Session and would be silently abandoned. */
  | 'TASK_ALREADY_ACTIVE'
  /** The addressed Task has no durable revision to supersede. */
  | 'TASK_NOT_FOUND'
  /** The candidate does not supersede the revision the caller declared. */
  | 'TASK_REVISION_STALE'
  /** The candidate is not the next legal revision of this Task or output. */
  | 'TASK_TRANSITION_INVALID'
  /** The candidate names a Run that no durable turn/start has backed yet. */
  | 'TASK_RUN_NOT_DURABLE'
  /** A completed step cites evidence that is absent or not durably successful. */
  | 'TASK_EVIDENCE_INVALID'
  /** The Task or result cannot reach the requested state under current durable facts. */
  | 'TASK_RESULT_INVALID'
  /** A resume plan is empty, unknown, or reaches into already-completed work. */
  | 'TASK_RESUME_PLAN_INVALID'
  /** The Session projection this writer validates against is not available. */
  | 'TASK_AUTHORITY_UNAVAILABLE'

/** Write rejection carrying a stable machine-readable code. */
export class TaskContinuityError extends Error {
  /**
   * @param code - stable rejection code.
   * @param message - human-readable detail; never the recovery contract.
   * @param options - optional `cause` retaining the projection/transition rejection.
   */
  constructor(
    readonly code: TaskContinuityErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'TaskContinuityError'
  }
}
