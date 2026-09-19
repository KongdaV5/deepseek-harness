/**
 * The bounded in-run retry decision.
 *
 * This is policy, not execution. The decision says only whether the *existing*
 * retry mechanism may handle a failed attempt; it never schedules, delays,
 * waits, streams, or writes. The current executor still owns retry identity,
 * the durable `llm/retry` and `llm/retry-started` events, backoff, stream
 * settlement, and the turn/step association.
 *
 * Checks are ordered so the most authoritative structured fact decides first,
 * and every check fails closed. A cancellation is never overridden by a
 * retryable code; a fatal category is never overridden by an eligible policy; an
 * exhausted budget is never overridden by always-mode's blanket declaration. And
 * a failure that no current contract names retryable is denied rather than
 * rounded to "probably transient".
 *
 * @module @deepseek-ai/dsh-agent-run-policy/policy
 */

import { classifyRunError } from '@deepseek-ai/dsh-agent-run-state'
import type { RunErrorCode } from '@deepseek-ai/dsh-agent-run-state'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { RetryDecision, RetryDecisionInput } from './types.ts'

/**
 * Failure classes this policy never retries automatically, whatever the
 * provider's own declaration says.
 *
 * Each entry is a structured category, never message text. Cancellation, a
 * blocked run, a context overflow Stage 10 must address, a reached max-token
 * limit, an invalid reasoning or model configuration, a tool-semantics failure,
 * a generation that provably stalled, a Session interruption that needs guarded
 * resume, and a failed retry chain itself all describe a condition that
 * repeating the identical request cannot fix.
 *
 * `STREAM_DISCONNECTED` is deliberately absent: a disconnected stream is a
 * transport condition, and the current contract treats transport failures as
 * retryable.
 */
const NEVER_RETRY_CATEGORIES: ReadonlySet<RunErrorCode> = new Set<RunErrorCode>([
  'RESOURCE_LIMIT',
  'WORKER_CRASH',
  'MODEL_LOAD_FAILED',
  'INVALID_MODEL_CONFIG',
  'INVALID_REASONING_PARAMETER',
  'CONTEXT_OVERFLOW',
  'MAX_TOKENS',
  'CLIENT_CANCELLED',
  'BLOCKED',
  'SESSION_INTERRUPTED',
  'TOOL_FAILED',
  'GENERATION_STALLED',
  'RETRY_FAILED',
])

/**
 * The transient codes the current upstream contract names by default.
 *
 * Read out of the live contract — `resolveRetryPolicy` with no provider
 * configuration — instead of being restated here, so this policy can never
 * drift from the set the adapters actually retry. It is consulted only to keep
 * an always-mode deployment's documented transient behaviour intact; it is not
 * an allow list this package owns.
 */
const UPSTREAM_DEFAULT_TRANSIENT_CODES: ReadonlySet<string> = new Set(defaultUpstreamRetryableCodes())

/**
 * The code set the current upstream contract names when no provider configuration
 * is supplied.
 *
 * The default is a `normal` policy, so it names explicit codes; an `always`
 * default would name none, and the empty result then leaves the always-branch
 * decision to the structured category alone rather than inventing a code set.
 * @returns the default transient codes, or none when the default names no set.
 */
function defaultUpstreamRetryableCodes(): readonly string[] {
  const policy = resolveRetryPolicy(
    undefined,
    'dsh-agent-run-policy: current upstream default retryable codes',
  )
  return policy.mode === 'normal' ? policy.retryableCodes : []
}

/**
 * Whether the current structured contracts name this failure retryable.
 *
 * A normal policy names an explicit code set, and membership is the whole
 * answer. An always policy declares every model-request failure retryable,
 * which is structured evidence in its own right — but this policy refuses to
 * extend a blanket declaration to a failure no current contract can name at
 * all, because "unclassified" is not a transient condition.
 * @param input - the failed attempt and its captured provider policy.
 * @param category - the Stage 7 category for the failure.
 * @returns whether structured evidence names this failure retryable.
 */
function structuredRetryability(input: RetryDecisionInput, category: RunErrorCode): boolean {
  const policy = input.retryPolicy
  if (policy === undefined) return false
  if (policy.mode === 'normal') return policy.retryableCodes.includes(input.failure.code)
  return category !== 'UNKNOWN' || UPSTREAM_DEFAULT_TRANSIENT_CODES.has(input.failure.code)
}

/**
 * Decide whether the existing retry mechanism may handle one failed attempt.
 *
 * @param input - failure, captured policy, durable retry count, cancellation, run validity, and cap.
 * @returns a stable decision a consumer can explain without re-deriving anything.
 */
export function decideBoundedRetry(input: RetryDecisionInput): RetryDecision {
  const classified = classifyRunError({
    origin: 'provider',
    error: input.failure,
    time: input.time,
    authority: 'execution',
  })
  const base = {
    category: classified.code,
    severity: classified.severity,
    retryCount: input.retryCount,
    maxRetryCount: input.maxRetryCount,
  }

  // A user ending a run is an outcome, not a transient condition.
  if (input.signalAborted) return { ...base, kind: 'deny', reason: 'CANCELLED' }

  // Stage 7 owns severity; this policy only consumes it. A fatal failure gets
  // zero automatic retries and keeps its primary structured error.
  if (classified.severity === 'fatal' || input.runPrimaryError?.severity === 'fatal') {
    return { ...base, kind: 'deny', reason: 'FATAL_FAILURE' }
  }

  // An in-run retry needs an open turn to run inside; anything else is a
  // cross-run question that guarded resume, not retry, owns.
  if (!input.runOpen) return { ...base, kind: 'deny', reason: 'RUN_NOT_RETRYABLE' }

  if (NEVER_RETRY_CATEGORIES.has(classified.code)) {
    return { ...base, kind: 'deny', reason: 'NO_RETRY_CATEGORY' }
  }

  // Fail closed on a failure no current contract names: UNKNOWN stays UNKNOWN
  // rather than being promoted to "transient" on a guess.
  if (!structuredRetryability(input, classified.code)) {
    return { ...base, kind: 'deny', reason: 'NO_STRUCTURED_RETRYABILITY' }
  }

  if (input.retryCount >= input.maxRetryCount) {
    return { ...base, kind: 'deny', reason: 'RETRY_BUDGET_EXHAUSTED' }
  }

  return { ...base, kind: 'delegate', reason: 'UPSTREAM_RETRYABLE', nextAttempt: input.retryCount + 1 }
}
