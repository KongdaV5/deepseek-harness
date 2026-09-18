/**
 * Durable-only Agent lifecycle facts.
 *
 * The adapter's value is its restraint, so these tests pin what it must NOT do
 * as much as what it derives: it never closes a turn or step the log left open,
 * never invents a run identity, and never exposes a durable model-attempt
 * identity, because upstream persists none. Alongside that it must read the
 * real durable evidence — turn and step boundaries, terminal reasons, the
 * after-the-fact `interrupted` repair closure, and retry chains keyed by their
 * durable `RetryId`.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session/types'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { isRepairClosure, lifecycleFactsFrom } from '@deepseek-ai/dsh-agent-lifecycle-facts'

/** Build one committed log-only event; `data` stays typed at the call site. */
function event<T extends SessionEventType>(type: T, seq: number, data: SessionEventMap[T]): SessionEvent {
  return { type, seq: SessionSeq(seq), time: seq, data } as unknown as SessionEvent
}

const failure = { message: 'provider unavailable', code: 'PROVIDER_UNAVAILABLE' }

const retryNormal = (seq: number, retry: number, retryId: string): SessionEvent =>
  event('llm/retry', seq, {
    retryId: RetryId(retryId),
    turn: 1,
    step: 1,
    provider: 'deepseek',
    mode: 'normal',
    policyKey: 'policy',
    retry,
    maxRetries: 3,
    delayMs: 100 * retry,
    failure,
  })

const retryAlways = (seq: number, retry: number, retryId: string): SessionEvent =>
  event('llm/retry', seq, {
    retryId: RetryId(retryId),
    turn: 1,
    step: 1,
    provider: 'deepseek',
    mode: 'always',
    policyKey: 'policy',
    retry,
    delayMs: 100 * retry,
    failure,
  })

const retryStarted = (seq: number, retry: number, retryId: string): SessionEvent =>
  event('llm/retry-started', seq, { retryId: RetryId(retryId), turn: 1, step: 1, retry })

describe('repair closure classification', () => {
  it('treats only the after-the-fact interrupted closer as a repair', () => {
    expect(isRepairClosure({ kind: 'interrupted' })).toBe(true)
    expect(isRepairClosure({ kind: 'completed' })).toBe(false)
  })
})

describe('empty and inert ranges', () => {
  it('reports no facts for an empty range', () => {
    expect(lifecycleFactsFrom([])).toEqual({
      seedBoundary: null,
      turns: [],
      retryChains: [],
      durableAttemptIdentity: null,
    })
  })

  it('ignores events that carry no lifecycle meaning', () => {
    const facts = lifecycleFactsFrom([
      event('assistant/attempt', 0, { turn: 1, step: 1, stream: [] }),
      event('turn/start', 1, { turn: 1 }),
    ])
    expect(facts.turns).toHaveLength(1)
  })

  it('is stateless across calls', () => {
    const range = [event('turn/start', 0, { turn: 1 })]
    const first = lifecycleFactsFrom(range)
    expect(lifecycleFactsFrom(range)).toEqual(first)
    expect(lifecycleFactsFrom(range)).not.toBe(first)
  })
})

describe('turn boundaries and terminal reasons', () => {
  it('leaves a turn open when the log has no closer', () => {
    const [turn] = lifecycleFactsFrom([event('turn/start', 0, { turn: 1 })]).turns
    expect(turn).toEqual({ turn: 1, startSeq: 0, repairClosure: false, steps: [] })
  })

  it('records a live terminal reason without marking it a repair', () => {
    const [turn] = lifecycleFactsFrom([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ]).turns
    expect(turn?.endSeq).toBe(1)
    expect(turn?.terminal).toBe('completed')
    expect(turn?.repairClosure).toBe(false)
  })

  it('marks the interrupted closer as a repair closure', () => {
    const [turn] = lifecycleFactsFrom([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'interrupted' } }),
    ]).turns
    expect(turn?.terminal).toBe('interrupted')
    expect(turn?.repairClosure).toBe(true)
  })

  it('keeps turns in log order and ignores a closer for an unknown turn', () => {
    const facts = lifecycleFactsFrom([
      event('turn/end', 0, { turn: 9, reason: { kind: 'completed' } }),
      event('turn/start', 1, { turn: 1 }),
      event('turn/start', 2, { turn: 2 }),
    ])
    expect(facts.turns.map(turn => turn.turn)).toEqual([1, 2])
    expect(facts.turns.every(turn => turn.endSeq === undefined)).toBe(true)
  })

  it('reopens a turn number only when the log starts it again', () => {
    const facts = lifecycleFactsFrom([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 2, { turn: 1 }),
    ])
    expect(facts.turns).toHaveLength(2)
    expect(facts.turns[1]?.endSeq).toBeUndefined()
  })
})

describe('step boundaries', () => {
  it('closes a step at its durable end boundary', () => {
    const [turn] = lifecycleFactsFrom([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('step/end', 2, { turn: 1, step: 1 }),
    ]).turns
    expect(turn?.steps).toEqual([{ step: 1, startSeq: 1, endSeq: 2, open: false }])
  })

  it('leaves a step open when the log has no closer', () => {
    const [turn] = lifecycleFactsFrom([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('step/start', 2, { turn: 1, step: 2 }),
    ]).turns
    expect(turn?.steps).toEqual([
      { step: 1, startSeq: 1, open: true },
      { step: 2, startSeq: 2, open: true },
    ])
  })

  it('ignores step boundaries for an unknown turn or an unstarted step', () => {
    const facts = lifecycleFactsFrom([
      event('step/start', 0, { turn: 9, step: 1 }),
      event('step/end', 1, { turn: 9, step: 1 }),
      event('turn/start', 2, { turn: 1 }),
      event('step/end', 3, { turn: 1, step: 1 }),
    ])
    expect(facts.turns).toEqual([{ turn: 1, startSeq: 2, repairClosure: false, steps: [] }])
  })

  it('closes the newest open start when a step number repeats', () => {
    const [turn] = lifecycleFactsFrom([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('step/end', 3, { turn: 1, step: 1 }),
    ]).turns
    expect(turn?.steps).toEqual([
      { step: 1, startSeq: 1, open: true },
      { step: 1, startSeq: 2, endSeq: 3, open: false },
    ])
  })
})

describe('retry chains', () => {
  it('derives a bounded chain from the normal mode record', () => {
    const facts = lifecycleFactsFrom([retryNormal(0, 1, 'retry-1')])
    expect(facts.retryChains).toEqual([{
      retryId: 'retry-1',
      turn: 1,
      step: 1,
      provider: 'deepseek',
      mode: 'normal',
      policyKey: 'policy',
      attempts: [{ retry: 1, maxRetries: 3, delayMs: 100, failureCode: 'PROVIDER_UNAVAILABLE', scheduledSeq: 0 }],
    }])
  })

  it('omits the policy cap on an unbounded always mode record', () => {
    const [chain] = lifecycleFactsFrom([retryAlways(0, 1, 'retry-1')]).retryChains
    expect(chain?.mode).toBe('always')
    expect(chain?.attempts).toEqual([{
      retry: 1, delayMs: 100, failureCode: 'PROVIDER_UNAVAILABLE', scheduledSeq: 0,
    }])
    expect(chain?.attempts[0]?.maxRetries).toBeUndefined()
  })

  it('groups every attempt that shares one durable retry identity', () => {
    const facts = lifecycleFactsFrom([
      retryNormal(0, 1, 'retry-1'),
      retryStarted(1, 1, 'retry-1'),
      retryNormal(2, 2, 'retry-1'),
      retryStarted(3, 2, 'retry-1'),
    ])
    expect(facts.retryChains).toHaveLength(1)
    expect(facts.retryChains[0]?.attempts).toEqual([
      { retry: 1, maxRetries: 3, delayMs: 100, failureCode: 'PROVIDER_UNAVAILABLE', scheduledSeq: 0, startedSeq: 1 },
      { retry: 2, maxRetries: 3, delayMs: 200, failureCode: 'PROVIDER_UNAVAILABLE', scheduledSeq: 2, startedSeq: 3 },
    ])
  })

  it('keeps chains with different durable identities separate', () => {
    const facts = lifecycleFactsFrom([retryNormal(0, 1, 'retry-1'), retryNormal(1, 1, 'retry-2')])
    expect(facts.retryChains.map(chain => chain.retryId)).toEqual(['retry-1', 'retry-2'])
  })

  it('ignores a start transition with no scheduled attempt to mark', () => {
    const unknownChain = lifecycleFactsFrom([retryStarted(0, 1, 'retry-1')])
    expect(unknownChain.retryChains).toEqual([])

    const unknownOrdinal = lifecycleFactsFrom([retryNormal(0, 1, 'retry-1'), retryStarted(1, 2, 'retry-1')])
    expect(unknownOrdinal.retryChains[0]?.attempts).toEqual([
      { retry: 1, maxRetries: 3, delayMs: 100, failureCode: 'PROVIDER_UNAVAILABLE', scheduledSeq: 0 },
    ])
  })
})

describe('seed boundary', () => {
  it('records an ordinary lifecycle boundary as not inherited', () => {
    expect(lifecycleFactsFrom([event('session/end-seed', 0, {})]).seedBoundary).toEqual({ seq: 0, inherited: false })
  })

  it('records a fork cut as inherited', () => {
    expect(lifecycleFactsFrom([event('session/end-seed', 0, { inherited: true })]).seedBoundary)
      .toEqual({ seq: 0, inherited: true })
  })

  it('keeps only the last boundary in the range', () => {
    const facts = lifecycleFactsFrom([
      event('session/end-seed', 0, { inherited: true }),
      event('session/end-seed', 4, {}),
    ])
    expect(facts.seedBoundary).toEqual({ seq: 4, inherited: false })
  })
})

describe('absent durable attempt identity', () => {
  it('never surfaces a durable attempt identity', () => {
    expect(lifecycleFactsFrom([]).durableAttemptIdentity).toBeNull()
    expect(lifecycleFactsFrom([retryNormal(0, 1, 'retry-1'), retryStarted(1, 1, 'retry-1')]).durableAttemptIdentity)
      .toBeNull()
  })
})
