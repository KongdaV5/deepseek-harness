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
 * The fold accumulates through private mutable views and returns the public
 * contracts detached from them, so a caller can neither observe nor disturb the
 * working state of an earlier call.
 *
 * @module @deepseek-ai/dsh-agent-lifecycle-facts
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { LlmRetryEventData, LlmRetryStartedEventData, RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {
  DurableRetryMode,
  DurableTerminalReason,
  LifecycleFacts,
  SeedBoundaryFact,
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

/** Accumulation view of one turn while the fold is still running. */
interface MutableStep {
  step: number
  startSeq: SessionSeq
  endSeq?: SessionSeq
  open: boolean
}

/** Accumulation view of one turn while the fold is still running. */
interface MutableTurn {
  turn: number
  startSeq: SessionSeq
  endSeq?: SessionSeq
  terminal?: DurableTerminalReason
  repairClosure: boolean
  steps: MutableStep[]
}

/** Accumulation view of one retry chain while the fold is still running. */
interface MutableChain {
  retryId: RetryId
  turn: number
  step: number
  provider: string
  mode: DurableRetryMode
  policyKey: string
  attempts: MutableAttempt[]
}

/** Accumulation view of one scheduled retry attempt while the fold is running. */
interface MutableAttempt {
  retry: number
  maxRetries?: number
  delayMs: number
  failureCode: string
  scheduledSeq: SessionSeq
  startedSeq?: SessionSeq
}

/**
 * Whether one terminal reason is an after-the-fact crash repair.
 * @param reason - the durable terminal reason recorded by `turn/end`.
 * @returns whether the reason is the `interrupted` repair closer.
 */
export function isRepairClosure(reason: TurnEndReason): boolean {
  return reason.kind === 'interrupted'
}

/**
 * Read the durable lifecycle facts of one event range.
 *
 * Processes events in the order given: pass a Session log or a replay range in
 * ascending sequence order. The fold synthesizes nothing — a turn or step with
 * no durable closer stays `open`, because closing a crash-orphaned turn is
 * upstream repair work that appends real events, not an adapter's inference.
 *
 * @param events - committed Session events, in ascending sequence order.
 * @returns every normalized turn, retry-chain, and seed-boundary fact.
 */
export function lifecycleFactsFrom(events: readonly SessionEvent[]): LifecycleFacts {
  const turns: MutableTurn[] = []
  const turnByNumber = new Map<number, MutableTurn>()
  const chains: MutableChain[] = []
  const chainById = new Map<string, MutableChain>()
  let seedBoundary: SeedBoundaryFact | null = null

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        const turn: MutableTurn = {
          turn: event.data.turn,
          startSeq: event.seq,
          repairClosure: false,
          steps: [],
        }
        turns.push(turn)
        turnByNumber.set(turn.turn, turn)
        break
      }
      case 'turn/end': {
        const turn = turnByNumber.get(event.data.turn)
        if (turn === undefined) break
        turn.endSeq = event.seq
        turn.terminal = event.data.reason.kind
        turn.repairClosure = isRepairClosure(event.data.reason)
        break
      }
      case 'step/start': {
        const turn = turnByNumber.get(event.data.turn)
        if (turn === undefined) break
        turn.steps.push({ step: event.data.step, startSeq: event.seq, open: true })
        break
      }
      case 'step/end': {
        const turn = turnByNumber.get(event.data.turn)
        if (turn === undefined) break
        // The newest still-open start matches a repeated step number.
        const step = turn.steps.findLast(candidate => candidate.step === event.data.step && candidate.open)
        if (step === undefined) break
        step.endSeq = event.seq
        step.open = false
        break
      }
      case 'llm/retry': {
        const data: LlmRetryEventData = event.data
        const key = String(data.retryId)
        let chain = chainById.get(key)
        if (chain === undefined) {
          chain = {
            retryId: data.retryId,
            turn: data.turn,
            step: data.step,
            provider: data.provider,
            mode: data.mode,
            policyKey: data.policyKey,
            attempts: [],
          }
          chains.push(chain)
          chainById.set(key, chain)
        }
        chain.attempts.push(scheduledAttempt(event.seq, data))
        break
      }
      case 'llm/retry-started': {
        const data: LlmRetryStartedEventData = event.data
        const chain = chainById.get(String(data.retryId))
        if (chain === undefined) break
        const attempt = chain.attempts.find(candidate => candidate.retry === data.retry)
        if (attempt === undefined) break
        attempt.startedSeq = event.seq
        break
      }
      case 'session/end-seed': {
        seedBoundary = { seq: event.seq, inherited: event.data.inherited === true }
        break
      }
      default:
        break
    }
  }

  return {
    seedBoundary,
    turns: turns.map(turn => ({ ...turn, steps: turn.steps.map(step => ({ ...step })) })),
    retryChains: chains.map(chain => ({ ...chain, attempts: chain.attempts.map(attempt => ({ ...attempt })) })),
    durableAttemptIdentity: null,
  }
}

/** Record one scheduled retry attempt from its durable payload. */
function scheduledAttempt(seq: SessionSeq, data: LlmRetryEventData): MutableAttempt {
  const base: MutableAttempt = {
    retry: data.retry,
    delayMs: data.delayMs,
    failureCode: data.failure.code,
    scheduledSeq: seq,
  }
  // `maxRetries` exists only on the bounded `normal` mode record.
  return data.mode === 'normal' ? { ...base, maxRetries: data.maxRetries } : base
}
