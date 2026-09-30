/**
 * Durable-only Agent lifecycle facts.
 *
 * The adapter is a pure fold over committed Session events. It exists so a
 * consumer can ask about turn boundaries, terminal reasons, crash repair, and
 * retry chains without depending on the exact payload of every upstream event,
 * and without inventing the run identity that upstream does not have.
 *
 * It deliberately owns no live state, no subscription, no Cordis service, and
 * no persisted projection: it observes durable evidence only, so the transient
 * `LlmAttemptId` a live stream carries never enters this surface.
 *
 * The fold is published in both shapes a consumer can need, and they are the
 * same fold: {@link lifecycleFactsFrom} folds one finished event range, and
 * {@link applyLifecycleFacts} is its one-event step over a previous result.
 * The step exists so a Session projection can accumulate these facts the way
 * every other projection accumulates state — one committed event at a time —
 * instead of reimplementing this normalization beside it. {@link lifecycleFactsFrom}
 * is the repeated step, so the two can never disagree.
 *
 * Every result is detached from the working state that produced it, so a caller
 * can neither observe nor disturb the accumulation of an earlier call.
 *
 * @module @deepseek-ai/dsh-agent-lifecycle-facts
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { LlmRetryEventData, LlmRetryStartedEventData } from '@deepseek-ai/dsh-llm-retry'
import type {
  LifecycleFacts,
  RetryAttemptFact,
  RetryChainFact,
  SeedBoundaryFact,
  StepLifecycleFact,
  TurnLifecycleFact,
} from './types.ts'

export type {
  DurableRetryMode,
  DurableTerminalReason,
  LifecycleFacts,
  RetryAttemptFact,
  RetryChainFact,
  SeedBoundaryFact,
  StepLifecycleFact,
  TurnLifecycleFact,
} from './types.ts'

/**
 * Whether one terminal reason is an after-the-fact crash repair.
 * @param reason - the durable terminal reason recorded by `turn/end`.
 * @returns whether the reason is the `interrupted` repair closer.
 */
export function isRepairClosure(reason: TurnEndReason): boolean {
  return reason.kind === 'interrupted'
}

/**
 * The fact set of an empty event range.
 *
 * The starting point of both fold shapes: a consumer that accumulates facts one
 * event at a time begins here and passes every committed event through
 * {@link applyLifecycleFacts}.
 *
 * @returns the empty fact set, with no turn, chain, or seed boundary.
 */
export function emptyLifecycleFacts(): LifecycleFacts {
  return { seedBoundary: null, turns: [], retryChains: [], durableAttemptIdentity: null }
}

/** Replace one element of a tuple array, leaving the rest shared. */
function replaceAt<T>(values: readonly T[], index: number, next: T): readonly T[] {
  const copy = values.slice()
  copy[index] = next
  return copy
}

/** One scheduled retry attempt from its durable `llm/retry` payload. */
function scheduledAttempt(seq: SessionSeq, time: number, data: LlmRetryEventData): RetryAttemptFact {
  const base: RetryAttemptFact = {
    retry: data.retry,
    delayMs: data.delayMs,
    failureCode: data.failure.code,
    scheduledSeq: seq,
    scheduledTime: time,
  }
  // `maxRetries` exists only on the bounded `normal` mode record.
  return data.mode === 'normal' ? { ...base, maxRetries: data.maxRetries } : base
}

/**
 * Advance one fact set by one committed event.
 *
 * The step is deliberately total and reference-preserving: an event this
 * adapter does not track — or one that names a turn, chain, or attempt the fact
 * set does not contain — returns the *same* fact set, which is what lets a
 * projection registry treat an uninterested event as no work at all.
 *
 * @param state - the facts covering every event before this one.
 * @param event - the next committed Session event.
 * @returns the facts covering this event too, or `state` when it contributes none.
 */
export function applyLifecycleFacts(state: LifecycleFacts, event: SessionEvent): LifecycleFacts {
  switch (event.type) {
    case 'turn/start': {
      const turn: TurnLifecycleFact = {
        turn: event.data.turn,
        startSeq: event.seq,
        startTime: event.time,
        repairClosure: false,
        steps: [],
      }
      return { ...state, turns: [...state.turns, turn] }
    }
    case 'turn/end': {
      // The newest turn carrying this number owns the close, matching the
      // number-keyed index the whole-range fold uses.
      const index = state.turns.findLastIndex(candidate => candidate.turn === event.data.turn)
      if (index < 0) return state
      const previous = state.turns[index] as TurnLifecycleFact
      const closed: TurnLifecycleFact = {
        ...previous,
        endSeq: event.seq,
        endTime: event.time,
        terminal: event.data.reason.kind,
        terminalReason: event.data.reason,
        repairClosure: isRepairClosure(event.data.reason),
      }
      return { ...state, turns: replaceAt(state.turns, index, closed) }
    }
    case 'step/start': {
      const index = state.turns.findLastIndex(candidate => candidate.turn === event.data.turn)
      if (index < 0) return state
      const turn = state.turns[index] as TurnLifecycleFact
      const step: StepLifecycleFact = {
        step: event.data.step,
        startSeq: event.seq,
        startTime: event.time,
        open: true,
      }
      return { ...state, turns: replaceAt(state.turns, index, { ...turn, steps: [...turn.steps, step] }) }
    }
    case 'step/end': {
      const index = state.turns.findLastIndex(candidate => candidate.turn === event.data.turn)
      if (index < 0) return state
      const turn = state.turns[index] as TurnLifecycleFact
      // The newest still-open start matches a repeated step number.
      const stepIndex = turn.steps.findLastIndex(candidate => candidate.step === event.data.step && candidate.open)
      if (stepIndex < 0) return state
      const step = turn.steps[stepIndex] as StepLifecycleFact
      const closed: StepLifecycleFact = { ...step, endSeq: event.seq, endTime: event.time, open: false }
      return {
        ...state,
        turns: replaceAt(state.turns, index, { ...turn, steps: replaceAt(turn.steps, stepIndex, closed) }),
      }
    }
    case 'llm/retry': {
      const data: LlmRetryEventData = event.data
      const attempt = scheduledAttempt(event.seq, event.time, data)
      const index = state.retryChains.findIndex(chain => String(chain.retryId) === String(data.retryId))
      if (index < 0) {
        const chain: RetryChainFact = {
          retryId: data.retryId,
          turn: data.turn,
          step: data.step,
          provider: data.provider,
          mode: data.mode,
          policyKey: data.policyKey,
          attempts: [attempt],
        }
        return { ...state, retryChains: [...state.retryChains, chain] }
      }
      const chain = state.retryChains[index] as RetryChainFact
      return {
        ...state,
        retryChains: replaceAt(state.retryChains, index, { ...chain, attempts: [...chain.attempts, attempt] }),
      }
    }
    case 'llm/retry-started': {
      const data: LlmRetryStartedEventData = event.data
      const index = state.retryChains.findIndex(chain => String(chain.retryId) === String(data.retryId))
      if (index < 0) return state
      const chain = state.retryChains[index] as RetryChainFact
      const attemptIndex = chain.attempts.findIndex(candidate => candidate.retry === data.retry)
      if (attemptIndex < 0) return state
      const attempt = chain.attempts[attemptIndex] as RetryAttemptFact
      const started: RetryAttemptFact = { ...attempt, startedSeq: event.seq, startedTime: event.time }
      return {
        ...state,
        retryChains: replaceAt(
          state.retryChains,
          index,
          { ...chain, attempts: replaceAt(chain.attempts, attemptIndex, started) },
        ),
      }
    }
    case 'session/end-seed': {
      const seedBoundary: SeedBoundaryFact = {
        seq: event.seq,
        time: event.time,
        inherited: event.data.inherited === true,
      }
      return { ...state, seedBoundary }
    }
    default:
      return state
  }
}

/**
 * Read the durable lifecycle facts of one event range.
 *
 * Processes events in the order given: pass a Session log or a replay range in
 * ascending sequence order. The fold synthesizes nothing — a turn or step with
 * no durable closer stays `open`, because closing a crash-orphaned turn is
 * upstream repair work that appends real events, not an adapter's inference.
 *
 * It is exactly {@link applyLifecycleFacts} repeated over the range, so the
 * whole-range and stepwise shapes can never disagree.
 *
 * @param events - committed Session events, in ascending sequence order.
 * @returns every normalized turn, retry-chain, and seed-boundary fact.
 */
export function lifecycleFactsFrom(events: readonly SessionEvent[]): LifecycleFacts {
  let facts = emptyLifecycleFacts()
  for (const event of events) facts = applyLifecycleFacts(facts, event)
  return facts
}
