/**
 * Fail-closed failures specific to task-aware compaction.
 *
 * Every failure here is a refusal. None of them is recoverable by retrying the
 * same request, and none of them leaves a published replacement behind: the
 * compaction executor's own bracket closes with the error recorded, and the
 * durable Task authority is never touched.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/errors
 */

import type { TaskAwareBlockCode, TaskCandidateRejectionCode } from './types.ts'

/**
 * A structured task-aware refusal.
 *
 * The code is the contract; the message is a diagnostic and is never parsed.
 */
export class TaskAwarePolicyError extends Error {
  /**
   * @param code - the stable block code this refusal reports.
   * @param message - human-readable detail.
   * @param options - optional original failure.
   */
  constructor(
    readonly code: TaskAwareBlockCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'TaskAwarePolicyError'
  }
}

/**
 * A produced candidate that failed deterministic task-aware validation.
 *
 * Carries the finer {@link TaskCandidateRejectionCode} so a caller can explain
 * the rejection, while `code` stays {@link TaskAwareBlockCode} for consumers
 * that route on the coarse contract.
 */
export class TaskCandidateRejectedError extends TaskAwarePolicyError {
  /**
   * @param reason - the deterministic rule the candidate failed.
   * @param message - human-readable detail naming the mismatching fact.
   */
  constructor(
    readonly reason: TaskCandidateRejectionCode,
    message: string,
  ) {
    super('TASK_CANDIDATE_INVALID', message)
    this.name = 'TaskCandidateRejectedError'
  }
}
