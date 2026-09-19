/**
 * Public contracts for the bounded in-run retry policy.
 *
 * A *Run* is one durable upstream turn. A retry is an in-run mechanism: it
 * re-runs the failed step inside the same open turn, over the same durable
 * history, under the same `RunId`. A resume is a cross-run continuation. The
 * types here exist to keep that boundary visible, so no caller can mistake a
 * permitted retry for permission to open a new Run, a new turn, or a
 * guarded-resume record.
 *
 * @module @deepseek-ai/dsh-agent-run-policy/types
 */

import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ClassifiedRunError, RunErrorCode } from '@deepseek-ai/dsh-agent-run-state'

/**
 * The absolute ceiling on automatic in-run retries after the initial attempt.
 *
 * `initial attempt + retry 1 + retry 2` is the largest automatic chain this
 * policy permits, so the largest number of model/provider attempts for one
 * retry chain is `MAX_AUTOMATIC_ATTEMPTS`. The cap counts *retries*, not
 * attempts: two retries is three attempts, never two.
 */
export const MAX_AUTOMATIC_RETRIES = 2

/** The largest automatic model/provider attempt count for one retry chain. */
export const MAX_AUTOMATIC_ATTEMPTS = MAX_AUTOMATIC_RETRIES + 1

/**
 * One failed model-request attempt, as the current upstream presents it.
 *
 * Every field is structured evidence. There is deliberately no message-text
 * field and no backend reachability field: this policy routes on codes, and a
 * local backend that cannot be observed must not change whether a retry is
 * permitted.
 */
export interface RetryDecisionInput {
  /** The structured failure the provider or transport reported. */
  readonly failure: LlmFailure
  /**
   * The retry policy captured with the adapter registration that served the
   * failed request. `undefined` means the failure had no provider policy at
   * all, which is no structured retryability evidence.
   */
  readonly retryPolicy: ResolvedRetryPolicy | undefined
  /** Automatic retries already recorded durably for this exact step. */
  readonly retryCount: number
  /** The configured cap, never greater than {@link MAX_AUTOMATIC_RETRIES}. */
  readonly maxRetryCount: number
  /** Whether the execution was explicitly cancelled. */
  readonly signalAborted: boolean
  /**
   * Whether the durable turn that owns this step is still open and is the turn
   * the failed step belongs to. A closed or mismatched turn is not a valid
   * target for an in-run retry.
   */
  readonly runOpen: boolean
  /**
   * The strongest error already attached to the run, when the run authority has
   * produced one. A run whose recorded primary error is fatal never retries,
   * even if this failure alone looks transient.
   */
  readonly runPrimaryError?: ClassifiedRunError
  /** Observation time used for the classified error's `time` field. */
  readonly time: number
}

/** Why this policy refused to let the upstream retry mechanism schedule an attempt. */
export type RetryDenyReason =
  /** Execution was explicitly cancelled; a user ending a run is an outcome, not a fault. */
  | 'CANCELLED'
  /** The failure itself, or the run's recorded primary error, is fatal. */
  | 'FATAL_FAILURE'
  /** No durable turn is open for this step, so there is nothing to retry inside. */
  | 'RUN_NOT_RETRYABLE'
  /** The failure class is one this policy never retries automatically. */
  | 'NO_RETRY_CATEGORY'
  /** No current structured contract names this failure retryable. */
  | 'NO_STRUCTURED_RETRYABILITY'
  /** The bounded automatic retry budget for this step is exhausted. */
  | 'RETRY_BUDGET_EXHAUSTED'

/** Why this policy let the upstream retry mechanism decide. */
export type RetryPermitReason = 'UPSTREAM_RETRYABLE'

/** Fields every decision carries, so a consumer can explain any outcome. */
interface RetryDecisionBase {
  /** Structured category of the failure, from the Stage 7 authority. */
  readonly category: RunErrorCode
  /** Severity the Stage 7 authority assigned to that category. */
  readonly severity: 'degraded' | 'fatal'
  /** Automatic retries already recorded for this step. */
  readonly retryCount: number
  /** The configured cap this decision was made under. */
  readonly maxRetryCount: number
}

/**
 * The upstream retry mechanism may handle this failure.
 *
 * Delegation is permission, not a retry: the existing executor still applies
 * its own policy, its own budget, its own backoff, and its own durable events.
 */
export interface RetryPermitted extends RetryDecisionBase {
  readonly kind: 'delegate'
  readonly reason: RetryPermitReason
  /** The retry ordinal this attempt would become, for diagnostics. */
  readonly nextAttempt: number
}

/** This policy refused; no attempt is scheduled and no retry event is written. */
export interface RetryDenied extends RetryDecisionBase {
  readonly kind: 'deny'
  readonly reason: RetryDenyReason
}

/** One complete bounded-retry decision. */
export type RetryDecision = RetryPermitted | RetryDenied
