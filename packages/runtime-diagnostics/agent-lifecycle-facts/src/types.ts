/**
 * Pure contracts for durable Agent lifecycle facts.
 *
 * Every fact here is derived from a committed Session v3 event, so a consumer
 * can reason about turn and step boundaries, terminal reasons, crash repair,
 * and retry chains without reinterpreting raw upstream payloads. Nothing in
 * this module is live state and nothing is persisted.
 *
 * Two deliberate absences define the contract:
 *
 * - There is no run identity. Current upstream has no authoritative main-Agent
 *   `RunId`, and this module does not infer one from a turn number, a step
 *   number, a retry counter, a process-local `LlmAttemptId`, or a guessed
 *   lifecycle span.
 * - There is no durable model-attempt identity. Upstream persists no attempt id
 *   in any Session event, so the field is a literal `null` rather than an
 *   optional value a consumer could mistake for missing data.
 *
 * @module @deepseek-ai/dsh-agent-lifecycle-facts/types
 */

import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type { SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session/types'

/**
 * How a turn ended, exactly as the durable log records it.
 *
 * Alias of the upstream merge-extensible discriminator, so a variant upstream
 * adds later reaches consumers without a change here. A consumer must treat it
 * as an open union and ignore kinds it does not know.
 */
export type DurableTerminalReason = TurnEndReason['kind']

/** Durable provider-routed retry modes, as the retry events record them. */
export type DurableRetryMode = 'normal' | 'always'

/** One step's durable boundaries within a turn. */
export interface StepLifecycleFact {
  readonly step: number
  readonly startSeq: SessionSeq
  readonly endSeq?: SessionSeq
  /** Epoch milliseconds of the `step/start` event. */
  readonly startTime: number
  /** Epoch milliseconds of the closing `step/end` event, when one exists. */
  readonly endTime?: number
  /** Whether the step has no durable `step/end` in this event range. */
  readonly open: boolean
}

/** One turn's durable boundaries, terminal reason, and steps. */
export interface TurnLifecycleFact {
  readonly turn: number
  readonly startSeq: SessionSeq
  readonly endSeq?: SessionSeq
  /** Epoch milliseconds of the opening `turn/start` event. */
  readonly startTime: number
  /** Epoch milliseconds of the closing `turn/end` event, when one exists. */
  readonly endTime?: number
  /** Absent while the turn has no durable `turn/end` in this event range. */
  readonly terminal?: DurableTerminalReason
  /**
   * The full structured `turn/end` reason, present exactly when {@link terminal}
   * is. {@link terminal} carries only the discriminant; a consumer that must
   * classify a failure from structured evidence reads the payload here instead
   * of matching on message text.
   *
   * `{ kind: 'error' }` retains upstream's `LlmFailure` verbatim, so the
   * provider-neutral code, HTTP status, and request id survive the fold.
   */
  readonly terminalReason?: TurnEndReason
  /**
   * Whether this terminal reason is an after-the-fact crash repair rather than
   * a live decision. Upstream never emits `interrupted` live: resume and a cold
   * read append it to close a turn whose process died.
   */
  readonly repairClosure: boolean
  readonly steps: readonly StepLifecycleFact[]
}

/** One scheduled retry attempt within a retry chain. */
export interface RetryAttemptFact {
  /** One-based attempt ordinal within the chain, as the retry policy counted it. */
  readonly retry: number
  /** The policy's own cap, present only for the `normal` mode record. */
  readonly maxRetries?: number
  readonly delayMs: number
  /** Upstream provider-neutral failure code that triggered this retry. */
  readonly failureCode: string
  readonly scheduledSeq: SessionSeq
  /** Epoch milliseconds of the `llm/retry` event that scheduled this attempt. */
  readonly scheduledTime: number
  /** Present once the retry wait completed and the next attempt started. */
  readonly startedSeq?: SessionSeq
  /** Epoch milliseconds of the `llm/retry-started` transition, when it happened. */
  readonly startedTime?: number
}

/**
 * One retry chain: every attempt that shares one durable `RetryId` and one
 * turn/step position. A retry never starts a new chain, so chain identity is
 * the durable evidence that a retry belongs to the same logical work.
 */
export interface RetryChainFact {
  readonly retryId: RetryId
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly mode: DurableRetryMode
  readonly policyKey: string
  readonly attempts: readonly RetryAttemptFact[]
}

/** The last constructor-seed boundary in an event range. */
export interface SeedBoundaryFact {
  readonly seq: SessionSeq
  /** Epoch milliseconds of the `session/end-seed` event. */
  readonly time: number
  /** Whether the marker is a fork cut rather than an ordinary lifecycle end. */
  readonly inherited: boolean
}

/** Every durable lifecycle fact one event range yields. */
export interface LifecycleFacts {
  /** Absent when the range carries no `session/end-seed` marker at all. */
  readonly seedBoundary: SeedBoundaryFact | null
  readonly turns: readonly TurnLifecycleFact[]
  readonly retryChains: readonly RetryChainFact[]
  /**
   * Always `null`: upstream persists no durable model-attempt identity.
   *
   * The live `LlmAttemptId` is process-local (it is built from an in-memory
   * counter and is not restored on resume), so the same value can recur in one
   * Session across lifecycles and it never appears in a committed event. A
   * consumer that needs durable attempt correlation must derive it from
   * {@link RetryChainFact} membership and turn/step position instead.
   */
  readonly durableAttemptIdentity: null
}
