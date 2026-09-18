import { describe, expect, it } from 'vitest'
import {
  backendObserverId,
  classifyRunHealth,
  clientCancelledError,
  projectRuns,
  reachabilityObservation,
  runDiagnostics,
  unknownBackendObservation,
} from '@deepseek-ai/dsh-agent-run-state'
import type { ClassifiedRunError } from '@deepseek-ai/dsh-agent-run-state'
import { facts, session, seq, turnFact } from './fixtures.ts'

const observerId = backendObserverId('local-llama')
const thresholds = { slowAfterMs: 100, stalledAfterMs: 1_000 }

/** The full health input, with only the fields a case cares about overridden. */
function health(overrides: Partial<Parameters<typeof classifyRunHealth>[0]> = {}) {
  return classifyRunHealth({
    now: 100,
    phase: 'executing',
    startedAt: 100,
    lastMeaningfulActivityAt: 100,
    activity: 'unknown',
    directness: 'unavailable',
    slowAfterMs: 100,
    stalledAfterMs: 1_000,
    ...overrides,
  })
}

describe('health needs evidence, and Unknown is a real answer', () => {
  it('reports unknown when nothing supports a verdict', () => {
    expect(health()).toBe('unknown')
  })

  it('reports unknown for a run with no boundary evidence', () => {
    expect(health({ phase: 'unknown' })).toBe('unknown')
  })

  it('never reports healthy from reachability alone', () => {
    expect(health({ activity: 'unknown', directness: 'direct' })).toBe('unknown')
  })

  it('reports healthy only from a direct active reading', () => {
    expect(health({ activity: 'active', directness: 'direct' })).toBe('healthy')
  })

  it('reports unknown for a direct idle reading rather than assuming health', () => {
    expect(health({ activity: 'idle', directness: 'direct' })).toBe('unknown')
  })

  it('calls a long quiet run stalled without calling it fatal', () => {
    expect(health({ now: 5_000, lastMeaningfulActivityAt: 100, activity: 'active', directness: 'direct' }))
      .toBe('stalled')
  })

  it('reports a long run slow once its age passes the slow threshold', () => {
    expect(health({ now: 150, startedAt: 0, lastMeaningfulActivityAt: 150 })).toBe('slow')
  })

  it('prefers a directly observed active backend over the slow verdict', () => {
    expect(health({ now: 150, startedAt: 0, lastMeaningfulActivityAt: 150, activity: 'active', directness: 'direct' }))
      .toBe('healthy')
  })

  it('does not report slow before the threshold is reached', () => {
    expect(health({ now: 99, startedAt: 0, lastMeaningfulActivityAt: 99 })).toBe('unknown')
  })

  it('never reports a negative idle interval when the clock moves backwards', () => {
    expect(health({ now: 0, startedAt: 0, lastMeaningfulActivityAt: 500 })).toBe('unknown')
  })

  it.each([
    ['completed', 'healthy'],
    ['cancelled', 'degraded'],
    ['failed', 'degraded'],
  ] as const)('reports a %s run as %s', (phase, expected) => {
    expect(health({ phase })).toBe(expected)
  })

  it('reports degraded for a run carrying a degraded primary error', () => {
    expect(health({ primaryError: clientCancelledError(1) })).toBe('degraded')
  })

  it('reports fatal for a run carrying a fatal primary error', () => {
    const fatal: ClassifiedRunError = {
      code: 'MODEL_LOAD_FAILED',
      message: 'no weights',
      severity: 'fatal',
      origin: 'backend',
      time: 1,
    }
    expect(health({ primaryError: fatal })).toBe('fatal')
  })

  it('lets fatal evidence outrank a completed phase', () => {
    const fatal: ClassifiedRunError = {
      code: 'WORKER_CRASH',
      message: 'died',
      severity: 'fatal',
      origin: 'session',
      time: 1,
    }
    expect(health({ phase: 'completed', primaryError: fatal })).toBe('fatal')
  })

  it.each([
    ['slowAfterMs', { slowAfterMs: 0 }],
    ['stalledAfterMs', { stalledAfterMs: -1 }],
    ['stalledAfterMs', { stalledAfterMs: 1.5 }],
  ] as const)('rejects an invalid %s threshold', (_name, override) => {
    expect(() => health(override)).toThrow(TypeError)
  })

  it('requires the stalled threshold to exceed the slow threshold', () => {
    expect(() => health({ slowAfterMs: 100, stalledAfterMs: 100 })).toThrow(/greater than/)
  })
})

describe('backend observation is a separate dimension of the diagnostic cut', () => {
  it('reports no run and unknown health when no durable turn is open', () => {
    const cut = runDiagnostics({
      projection: projectRuns(session('s-1'), facts([])),
      observation: reachabilityObservation(observerId, 1, 'reachable'),
      now: 1,
      ...thresholds,
    })
    expect(cut.active).toBeNull()
    expect(cut.terminal).toBeNull()
    expect(cut.health).toBe('unknown')
    expect(cut.primaryError).toBeUndefined()
    expect(cut.backend.reachability).toBe('reachable')
  })

  it('does not create an active run merely because a backend answered', () => {
    const cut = runDiagnostics({
      projection: projectRuns(session('s-1'), facts([])),
      observation: reachabilityObservation(observerId, 1, 'reachable'),
      now: 1,
      ...thresholds,
    })
    expect(cut.active).toBeNull()
  })

  it('never converts an absent observation into a positive verdict', () => {
    const projection = projectRuns(session('s-1'), facts([turnFact({ turn: 1, startTime: 0 })]))
    const cut = runDiagnostics({
      projection,
      observation: unknownBackendObservation(observerId, 1),
      now: 1_500,
      ...thresholds,
    })
    expect(cut.backend.directness).toBe('unavailable')
    expect(cut.health).toBe('stalled')
  })

  it('reports unknown for a live run whose endpoint answered but whose activity is unknown', () => {
    const projection = projectRuns(session('s-1'), facts([turnFact({ turn: 1, startTime: 0 })]))
    const cut = runDiagnostics({
      projection,
      observation: reachabilityObservation(observerId, 5, 'reachable'),
      now: 5,
      ...thresholds,
    })
    expect(cut.health).toBe('unknown')
    expect(cut.active?.turn).toBe(1)
  })

  it('keeps the durable terminal error primary over an observer fatality', () => {
    const projection = projectRuns(session('s-1'), facts([turnFact({
      turn: 1,
      endSeq: seq(9),
      endTime: 10,
      terminal: 'aborted',
      terminalReason: { kind: 'aborted', reason: { kind: 'user' } },
    })]))
    const cut = runDiagnostics({
      projection,
      observation: reachabilityObservation(observerId, 11, 'unreachable'),
      now: 11,
      observerErrors: [{
        error: {
          code: 'WORKER_CRASH',
          message: 'worker died',
          severity: 'fatal',
          origin: 'backend',
          time: 11,
        },
        authority: 'observer',
      }],
      ...thresholds,
    })
    expect(cut.primaryError?.code).toBe('CLIENT_CANCELLED')
    expect(cut.primaryError?.severity).toBe('degraded')
    expect(cut.secondaryErrors.map(entry => entry.code)).toEqual(['WORKER_CRASH'])
    expect(cut.terminal?.phase).toBe('cancelled')
  })

  it('reports observer evidence when the durable run has none', () => {
    const projection = projectRuns(session('s-1'), facts([turnFact({ turn: 1, startTime: 0 })]))
    const cut = runDiagnostics({
      projection,
      observation: reachabilityObservation(observerId, 3, 'unreachable'),
      now: 3,
      observerErrors: [{
        error: { code: 'PROVIDER_TIMEOUT', message: 'probe timed out', severity: 'degraded', origin: 'backend', time: 3 },
        authority: 'observer',
      }],
      ...thresholds,
    })
    expect(cut.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(cut.health).toBe('degraded')
  })

  it('retains the run secondary evidence beside observer evidence', () => {
    const projection = projectRuns(session('s-1'), facts([turnFact({
      turn: 1,
      endSeq: seq(9),
      endTime: 10,
      terminal: 'error',
      terminalReason: { kind: 'error', error: { message: 'timed out', code: 'PROVIDER_TIMEOUT' } },
    })]))
    const cut = runDiagnostics({
      projection,
      observation: unknownBackendObservation(observerId, 1),
      now: 10,
      ...thresholds,
    })
    expect(cut.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(cut.secondaryErrors).toEqual([])
    expect(cut.terminal?.primaryError?.code).toBe('PROVIDER_TIMEOUT')
  })
})
