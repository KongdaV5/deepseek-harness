import { describe, expect, it } from 'vitest'
import { activeRun, isTerminalPhase, projectRuns, terminalRun } from '@deepseek-ai/dsh-agent-run-state'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { facts, retryAttempt, retryChain, session, seq, stepFact, turnFact } from './fixtures.ts'

/** A closed turn whose terminal kind and payload a test chooses. */
function closed(turn: number, reason: TurnEndReason, startTime = 1, endTime = 20) {
  return turnFact({
    turn,
    startTime,
    endSeq: seq(turn * 10),
    endTime,
    terminal: reason.kind,
    terminalReason: reason,
    repairClosure: reason.kind === 'interrupted',
  })
}

describe('the active run exists only while a durable turn is open', () => {
  it('reports no run at all when the fact set carries no turn', () => {
    const state = projectRuns(session('s-1'), facts([]))
    expect(state.active).toBeNull()
    expect(state.terminal).toBeNull()
    expect(activeRun(state)).toBeNull()
    expect(terminalRun(state)).toBeNull()
    expect(state.sessionId).toBe('s-1')
  })

  it('opens an active run from a turn with no durable closer', () => {
    const state = projectRuns(session('s-1'), facts([turnFact({ turn: 1, startTime: 4 })]))
    expect(state.active?.phase).toBe('starting')
    expect(state.active?.turn).toBe(1)
    expect(state.active?.startedAt).toBe(4)
    expect(state.active?.completedAt).toBeUndefined()
    expect(state.terminal).toBeNull()
  })

  it('keeps the run active and in the same identity while its steps advance', () => {
    const state = projectRuns(session('s-1'), facts([turnFact({
      turn: 1,
      steps: [
        stepFact({ step: 1, startSeq: seq(1), endSeq: seq(2), startTime: 10, endTime: 11 }),
        stepFact({ step: 2, startSeq: seq(3), startTime: 12 }),
      ],
    })]))
    expect(state.active?.phase).toBe('executing')
    expect(state.active?.lastStep).toBe(2)
    expect(state.active?.openStep).toBe(2)
    expect(state.active?.stepCount).toBe(2)
    expect(state.active?.steps[0]?.endSeq).toBe(2)
  })

  it('tracks a closed step without a pending open one', () => {
    const state = projectRuns(session('s-1'), facts([turnFact({
      steps: [stepFact({ step: 1, startSeq: seq(1), endSeq: seq(2), startTime: 10, endTime: 11 })],
    })]))
    expect(state.active?.openStep).toBeNull()
    expect(state.active?.phase).toBe('executing')
  })

  it('reports a pending retry wait only while the retry has not started', () => {
    const pending = projectRuns(session('s-1'), facts([turnFact()], [
      retryChain({ attempts: [retryAttempt()] }),
    ]))
    expect(pending.active?.phase).toBe('waiting_retry')

    const started = projectRuns(session('s-1'), facts([turnFact()], [
      retryChain({ attempts: [retryAttempt({ startedSeq: seq(4), startedTime: 40 })] }),
    ]))
    expect(started.active?.phase).toBe('starting')
  })

  it('ignores a retry chain that belongs to another turn', () => {
    const state = projectRuns(session('s-1'), facts([turnFact({ turn: 2 })], [
      retryChain({ turn: 1, attempts: [retryAttempt({ retry: 4 })] }),
    ]))
    expect(state.active?.retryCount).toBe(0)
    expect(state.active?.retryReason).toBeUndefined()
  })

  it('treats a chain with no recorded attempt as nothing to wait for', () => {
    const state = projectRuns(session('s-1'), facts([turnFact()], [retryChain({ attempts: [] })]))
    expect(state.active?.phase).toBe('starting')
    expect(state.active?.retryCount).toBe(0)
  })
})

describe('terminal runs are retained as history and never stay active', () => {
  it('moves the run out of active when the turn closes', () => {
    const state = projectRuns(session('s-1'), facts([closed(1, { kind: 'completed' })]))
    expect(state.active).toBeNull()
    expect(state.terminal?.phase).toBe('completed')
    expect(state.terminal?.completedAt).toBe(20)
    expect(state.terminal?.primaryError).toBeUndefined()
    expect(terminalRun(state)?.turn).toBe(1)
  })

  it('keeps a terminal run terminal across every later turn', () => {
    const state = projectRuns(session('s-1'), facts([
      closed(1, { kind: 'completed' }),
      closed(2, { kind: 'error', error: { message: 'boom', code: 'PROVIDER_TIMEOUT' } }, 21, 30),
      turnFact({ turn: 3, startTime: 31 }),
    ]))
    expect(state.active?.turn).toBe(3)
    expect(state.terminal?.turn).toBe(2)
    expect(state.terminal?.phase).toBe('failed')
    for (const run of [state.active, state.terminal]) {
      expect(run?.runId).not.toBe(projectRuns(session('s-1'), facts([closed(1, { kind: 'completed' })])).terminal?.runId)
    }
  })

  it('is a pure function of the facts, so re-folding cannot demote a terminal run', () => {
    const range = facts([closed(1, { kind: 'aborted', reason: { kind: 'user' } })])
    const once = projectRuns(session('s-1'), range)
    const twice = projectRuns(session('s-1'), range)
    expect(once.terminal?.phase).toBe('cancelled')
    expect(twice.active).toBeNull()
    expect(twice.terminal).toEqual(once.terminal)
  })

  it('reports a turn left open before a later turn as neither active nor terminal', () => {
    // Upstream appends `turn/end` before the next `turn/start`, so this shape is
    // unreachable there; the fold must still refuse to invent a live run.
    const state = projectRuns(session('s-1'), facts([
      turnFact({ turn: 1, startTime: 1 }),
      turnFact({ turn: 2, startTime: 5 }),
    ]))
    expect(state.active?.turn).toBe(2)
    expect(state.terminal).toBeNull()
  })
})

describe('the interrupted repair closure is a terminal fact, not a live failure', () => {
  it('closes the repaired turn and leaves no active run', () => {
    const state = projectRuns(session('s-1'), facts([closed(1, { kind: 'interrupted' })]))
    expect(state.active).toBeNull()
    expect(state.terminal?.phase).toBe('failed')
    expect(state.terminal?.repairClosure).toBe(true)
    expect(state.terminal?.terminalReason).toEqual({ kind: 'interrupted' })
    expect(state.terminal?.primaryError?.code).toBe('SESSION_INTERRUPTED')
    expect(state.terminal?.primaryError?.severity).toBe('degraded')
    expect(state.terminal?.primaryError?.origin).toBe('session')
  })

  it('marks a live decision as no repair closure', () => {
    const state = projectRuns(session('s-1'), facts([closed(1, { kind: 'blocked' })]))
    expect(state.terminal?.repairClosure).toBe(false)
    expect(state.terminal?.primaryError?.code).toBe('BLOCKED')
  })

  it('does not let an interrupted repair turn regress into a live run', () => {
    const repaired = projectRuns(session('s-1'), facts([closed(1, { kind: 'interrupted' })]))
    const afterResume = projectRuns(session('s-1'), facts([
      closed(1, { kind: 'interrupted' }),
      turnFact({ turn: 2, startTime: 50 }),
    ]))
    expect(repaired.active).toBeNull()
    expect(afterResume.active?.turn).toBe(2)
    expect(afterResume.terminal?.turn).toBe(1)
  })
})

describe('terminal mapping retains the source reason', () => {
  it.each([
    ['completed', 'completed'],
    ['aborted', 'cancelled'],
    ['blocked', 'failed'],
    ['max-tokens', 'failed'],
    ['interrupted', 'failed'],
  ] as const)('maps %s to the %s phase', (kind, phase) => {
    const reason = kind === 'aborted'
      ? { kind, reason: { kind: 'user' } } as const
      : { kind } as const
    const state = projectRuns(session('s-1'), facts([closed(1, reason)]))
    expect(state.terminal?.phase).toBe(phase)
    expect(state.terminal?.terminalReason?.kind).toBe(kind)
  })

  it('retains a structured turn failure verbatim and classifies it without string matching', () => {
    const state = projectRuns(session('s-1'), facts([closed(1, {
      kind: 'error',
      error: { message: 'prompt exceeds the window', code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 },
    })]))
    const error = state.terminal?.primaryError
    expect(error?.code).toBe('CONTEXT_OVERFLOW')
    expect(error?.origin).toBe('provider')
    expect(error?.severity).toBe('degraded')
    expect(error?.message).toBe('prompt exceeds the window')
  })

  it('classifies an error and a max-tokens close with their own categories', () => {
    const errored = projectRuns(session('s-1'), facts([closed(1, {
      kind: 'error',
      error: { message: 'worker died', code: 'worker-crash' },
    })]))
    expect(errored.terminal?.primaryError?.code).toBe('WORKER_CRASH')
    expect(errored.terminal?.primaryError?.severity).toBe('fatal')

    const tokens = projectRuns(session('s-1'), facts([closed(1, { kind: 'max-tokens' })]))
    expect(tokens.terminal?.primaryError?.code).toBe('MAX_TOKENS')
  })

  it('cancels without a fault when the turn was aborted', () => {
    const state = projectRuns(session('s-1'), facts([closed(1, { kind: 'aborted', reason: { kind: 'user' } })]))
    expect(state.terminal?.primaryError).toEqual({
      code: 'CLIENT_CANCELLED',
      message: 'The client cancelled the run.',
      severity: 'degraded',
      origin: 'client',
      time: 20,
    })
  })

  it('falls back to an unclassified failure for a terminal kind this build does not know', () => {
    const unknown = { kind: 'evicted-by-a-plugin' } as unknown as TurnEndReason
    const state = projectRuns(session('s-1'), facts([closed(1, unknown)]))
    expect(state.terminal?.phase).toBe('failed')
    expect(state.terminal?.primaryError?.code).toBe('UNKNOWN')
    expect(state.terminal?.primaryError?.message).toMatch(/does not classify/)
  })

  it('fails a closed turn that carries no terminal reason at all', () => {
    const state = projectRuns(session('s-1'), facts([turnFact({ turn: 1, endSeq: seq(9), endTime: 12 })]))
    expect(state.terminal?.phase).toBe('failed')
    expect(state.terminal?.primaryError).toBeUndefined()
    expect(state.terminal?.terminalReason).toBeUndefined()
  })
})

describe('retry stays inside one run and never allocates another', () => {
  it('attaches every attempt of one chain to the run and reports the policy cap', () => {
    const state = projectRuns(session('s-1'), facts([turnFact()], [
      retryChain({
        attempts: [
          retryAttempt({ retry: 1, maxRetries: 3, failureCode: 'PROVIDER_TIMEOUT', scheduledTime: 30 }),
          retryAttempt({ retry: 2, startedSeq: seq(5), startedTime: 50, failureCode: 'PROVIDER_UNAVAILABLE' }),
        ],
      }),
    ]))
    expect(state.active?.retryCount).toBe(2)
    expect(state.active?.maxRetryCount).toBe(3)
    expect(state.active?.retryReason).toBe('PROVIDER_UNAVAILABLE')
    expect(state.active?.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(state.active?.secondaryErrors.map(error => error.code)).toEqual(['PROVIDER_UNAVAILABLE'])
    expect(state.active?.lastMeaningfulActivityAt).toBe(50)
  })

  it('keeps the highest ordinal when attempts are recorded out of order', () => {
    const state = projectRuns(session('s-1'), facts([turnFact()], [
      retryChain({
        attempts: [
          retryAttempt({ retry: 3, scheduledTime: 30 }),
          retryAttempt({ retry: 2, scheduledTime: 40 }),
        ],
      }),
    ]))
    expect(state.active?.retryCount).toBe(3)
    expect(state.active?.retryReason).toBe('PROVIDER_TIMEOUT')
  })

  it('records an unsupported provider code as UNKNOWN instead of guessing', () => {
    const state = projectRuns(session('s-1'), facts([turnFact()], [
      retryChain({ attempts: [retryAttempt({ failureCode: 'TEAPOT_OVERFLOW' })] }),
    ]))
    expect(state.active?.retryReason).toBe('UNKNOWN')
    expect(state.active?.primaryError?.code).toBe('UNKNOWN')
    expect(state.active?.secondaryErrors).toEqual([])
  })

  it('leaves the policy cap absent when the durable record carries none', () => {
    const state = projectRuns(session('s-1'), facts([turnFact()], [
      retryChain({ mode: 'always', attempts: [retryAttempt()] }),
    ]))
    expect(state.active?.maxRetryCount).toBeUndefined()
  })

  it('keeps retry evidence secondary to the durable terminal fact', () => {
    const state = projectRuns(session('s-1'), facts(
      [closed(1, { kind: 'error', error: { message: 'hard stop', code: 'MODEL_LOAD_FAILED' } })],
      [retryChain({ attempts: [retryAttempt({ failureCode: 'PROVIDER_TIMEOUT' })] })],
    ))
    expect(state.terminal?.primaryError?.code).toBe('MODEL_LOAD_FAILED')
    expect(state.terminal?.primaryError?.severity).toBe('fatal')
    expect(state.terminal?.secondaryErrors.map(error => error.code)).toEqual(['PROVIDER_TIMEOUT'])
  })
})

describe('no durable attempt identity is invented', () => {
  it('carries step position and never an attempt id', () => {
    const state = projectRuns(session('s-1'), facts([turnFact({
      steps: [stepFact({ step: 3, startSeq: seq(2) })],
    })], [retryChain({ attempts: [retryAttempt({ retry: 2 })] })]))
    const run = state.active
    expect(run).not.toBeNull()
    const keys = Object.keys(run as object)
    expect(keys).not.toContain('attempt')
    expect(keys).not.toContain('attemptId')
    expect(keys).not.toContain('failedAttemptId')
    expect(run?.lastStep).toBe(3)
    expect(run?.retryCount).toBe(2)
  })

  it('does not derive a run from an attempt-like value', () => {
    const state = projectRuns(session('s-1'), facts([turnFact({ turn: 9 })]))
    expect(state.active?.runId).toBe('run:v1:3:s-1:9')
  })
})

describe('terminal phases are exactly the phases that cannot advance', () => {
  it.each([
    ['completed', true],
    ['cancelled', true],
    ['failed', true],
    ['starting', false],
    ['executing', false],
    ['waiting_retry', false],
    ['unknown', false],
  ] as const)('reports %s terminal=%s', (phase, terminal) => {
    expect(isTerminalPhase(phase)).toBe(terminal)
  })
})
