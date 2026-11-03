import { describe, expect, it } from 'vitest'
import { backendObserverId, projectRuns, runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { retryChain, facts, session, seq, stepFact, turnFact } from './fixtures.ts'

describe('deterministic run identity', () => {
  it('derives the same identity for the same Session and turn', () => {
    expect(runIdFor(session('s-1'), 3)).toBe(runIdFor(session('s-1'), 3))
  })

  it('derives a different identity for a different turn of the same Session', () => {
    expect(runIdFor(session('s-1'), 3)).not.toBe(runIdFor(session('s-1'), 4))
  })

  it('derives a different identity for the same turn of a different Session', () => {
    expect(runIdFor(session('s-1'), 3)).not.toBe(runIdFor(session('s-2'), 3))
  })

  it('stays injective when a Session id contains the separator and digits', () => {
    const ambiguous = [runIdFor(session('a:1:1'), 1), runIdFor(session('a'), 1)]
    expect(new Set(ambiguous).size).toBe(2)
  })

  it('reads as an opaque versioned string that admits no allocation counter', () => {
    expect(runIdFor(session('s-1'), 7)).toBe('run:v1:3:s-1:7')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s as a turn',
    (turn) => {
      expect(() => runIdFor(session('s-1'), turn)).toThrow(TypeError)
    },
  )

  it('is the only way to obtain a RunId, so no random or process-local value can exist', async () => {
    const module = await import('@deepseek-ai/dsh-agent-run-state')
    const exported = module as Record<string, unknown>
    expect(exported.RunId).toBeUndefined()
    expect(typeof exported.runIdFor).toBe('function')
  })
})

describe('run identity comes from the turn boundary, nothing else', () => {
  it('keeps one identity across steps of the same turn', () => {
    const started = projectRuns(session('s-1'), facts([turnFact({ turn: 5 })]))
    const withSteps = projectRuns(session('s-1'), facts([turnFact({
      turn: 5,
      steps: [
        stepFact({ step: 1, startSeq: seq(1), endSeq: seq(2), startTime: 10, endTime: 11 }),
        stepFact({ step: 2, startSeq: seq(3), startTime: 12 }),
      ],
    })]))
    expect(withSteps.active?.runId).toBe(started.active?.runId)
    expect(withSteps.active?.stepCount).toBe(2)
  })

  it('allocates a new identity for a turn opened after a terminal turn', () => {
    const firstTerminal = projectRuns(session('s-1'), facts([turnFact({
      turn: 1,
      endSeq: seq(4),
      endTime: 20,
      terminal: 'completed',
      terminalReason: { kind: 'completed' },
    })]))
    const later = projectRuns(session('s-1'), facts([turnFact({
      turn: 2,
      startSeq: seq(5),
      startTime: 21,
    })]))
    expect(firstTerminal.terminal?.runId).toBe(runIdFor(session('s-1'), 1))
    expect(later.active?.runId).toBe(runIdFor(session('s-1'), 2))
    expect(later.active?.runId).not.toBe(firstTerminal.terminal?.runId)
  })

  it('does not change the identity when a retry is scheduled inside the turn', () => {
    const plain = projectRuns(session('s-1'), facts([turnFact({ turn: 1 })]))
    const retried = projectRuns(session('s-1'), facts([turnFact({ turn: 1 })], [retryChain({ turn: 1 })]))
    expect(retried.active?.runId).toBe(plain.active?.runId)
    expect(retried.active?.retryCount).toBe(1)
  })
})

describe('backend observer identity', () => {
  it('accepts a normalized non-empty identity', () => {
    expect(backendObserverId('local-llama')).toBe('local-llama')
  })

  it.each(['', ' spaced ', '\tleading'])('rejects %j as an observer id', (value) => {
    expect(() => backendObserverId(value)).toThrow(TypeError)
  })
})
