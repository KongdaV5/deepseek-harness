/**
 * Synthetic lifecycle-fact builders.
 *
 * Stage 6 facts are plain immutable data, so a spec can state the exact durable
 * evidence under test instead of staging a Session log for every case. The
 * builders below keep every field explicit so a test that changes one fact
 * cannot silently change another.
 */

import type { LifecycleFacts, RetryAttemptFact, RetryChainFact, StepLifecycleFact, TurnLifecycleFact } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Brand a synthetic sequence number. */
export function seq(value: number): SessionSeq {
  return value as SessionSeq
}

/** Brand a synthetic Session identity. */
export function session(value: string): SessionId {
  return value as SessionId
}

/** One step fact; `open: true` unless an end sequence is supplied. */
export function stepFact(overrides: Partial<StepLifecycleFact> = {}): StepLifecycleFact {
  return {
    step: 1,
    startSeq: seq(1),
    startTime: 10,
    ...overrides,
    open: overrides.open ?? overrides.endSeq === undefined,
  }
}

/**
 * One turn fact.
 *
 * The terminal kind and its structured payload are supplied by the caller, so a
 * test can assert the fold's behavior for a combination upstream cannot produce.
 */
export function turnFact(overrides: Partial<TurnLifecycleFact> = {}): TurnLifecycleFact {
  return {
    turn: 1,
    startSeq: seq(0),
    startTime: 1,
    repairClosure: false,
    steps: [],
    ...overrides,
  }
}

/** One retry attempt fact. */
export function retryAttempt(overrides: Partial<RetryAttemptFact> = {}): RetryAttemptFact {
  return {
    retry: 1,
    delayMs: 100,
    failureCode: 'PROVIDER_TIMEOUT',
    scheduledSeq: seq(3),
    scheduledTime: 30,
    ...overrides,
  }
}

/** One retry chain fact, attributed to turn 1 step 1 by default. */
export function retryChain(overrides: Partial<RetryChainFact> = {}): RetryChainFact {
  return {
    retryId: 'retry-1' as RetryChainFact['retryId'],
    turn: 1,
    step: 1,
    provider: 'local-qwen',
    mode: 'normal',
    policyKey: 'default',
    attempts: [retryAttempt()],
    ...overrides,
  }
}

/** A complete fact set from the given turns and chains. */
export function facts(
  turns: readonly TurnLifecycleFact[],
  retryChains: readonly RetryChainFact[] = [],
): LifecycleFacts {
  return { seedBoundary: null, turns, retryChains, durableAttemptIdentity: null }
}
