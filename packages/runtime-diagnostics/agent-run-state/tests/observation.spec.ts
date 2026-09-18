import { describe, expect, it } from 'vitest'
import {
  backendObservation,
  backendObserverId,
  observeBackend,
  reachabilityObservation,
  unknownBackendObservation,
} from '@deepseek-ai/dsh-agent-run-state'
import type { BackendObservation, LocalBackendObserver } from '@deepseek-ai/dsh-agent-run-state'

const observerId = backendObserverId('local-llama')

describe('no evidence is reported as Unknown, never as a state', () => {
  it('builds the unavailable fallback with nothing asserted', () => {
    expect(unknownBackendObservation(observerId, 12)).toEqual({
      observerId: 'local-llama',
      observedAt: 12,
      source: 'none',
      directness: 'unavailable',
      reachability: 'unknown',
      activity: 'unknown',
    })
  })

  it('never turns an explicit absence into reachable, idle, or healthy', () => {
    const observation = unknownBackendObservation(observerId, 0)
    expect(observation.reachability).toBe('unknown')
    expect(observation.activity).toBe('unknown')
    expect(observation.directness).toBe('unavailable')
  })
})

describe('reachability says nothing about activity', () => {
  it('reports a reachable endpoint with activity left unknown', () => {
    const observation = reachabilityObservation(observerId, 3, 'reachable')
    expect(observation.reachability).toBe('reachable')
    expect(observation.activity).toBe('unknown')
    expect(observation.directness).toBe('direct')
    expect(observation.source).toBe('endpoint')
  })

  it('reports an unreachable endpoint with activity left unknown', () => {
    const observation = reachabilityObservation(observerId, 4, 'unreachable')
    expect(observation.reachability).toBe('unreachable')
    expect(observation.activity).toBe('unknown')
  })

  it('accepts an unknown reachability as a direct-but-uninformative reading', () => {
    const observation = reachabilityObservation(observerId, 5, 'unknown')
    expect(observation.reachability).toBe('unknown')
    expect(observation.activity).toBe('unknown')
  })
})

describe('the constructor refuses a combination that overstates evidence', () => {
  it('accepts a direct active reading', () => {
    const observation = backendObservation({
      observerId,
      observedAt: 1,
      source: 'metrics',
      directness: 'direct',
      reachability: 'reachable',
      activity: 'active',
    })
    expect(observation.activity).toBe('active')
  })

  it('accepts a direct idle reading', () => {
    const observation = backendObservation({
      observerId,
      observedAt: 1,
      source: 'process',
      directness: 'direct',
      reachability: 'reachable',
      activity: 'idle',
    })
    expect(observation.activity).toBe('idle')
  })

  it('rejects an unavailable reading that still carries values', () => {
    expect(() => backendObservation({
      observerId,
      observedAt: 1,
      source: 'endpoint',
      directness: 'unavailable',
      reachability: 'reachable',
      activity: 'unknown',
    })).toThrow(TypeError)
  })

  it('rejects an unavailable reading that claims a source', () => {
    expect(() => backendObservation({
      observerId,
      observedAt: 1,
      source: 'metrics',
      directness: 'unavailable',
      reachability: 'unknown',
      activity: 'unknown',
    })).toThrow(TypeError)
  })

  it('rejects activity reported for an unreachable backend', () => {
    expect(() => backendObservation({
      observerId,
      observedAt: 1,
      source: 'metrics',
      directness: 'direct',
      reachability: 'unreachable',
      activity: 'active',
    })).toThrow(TypeError)
  })
})

describe('an observer failure is not a backend state', () => {
  it('returns the observer reading when it succeeds', () => {
    const observer: LocalBackendObserver = {
      id: observerId,
      observe: () => reachabilityObservation(observerId, 8, 'reachable'),
    }
    expect(observeBackend(observer, 99)).toEqual(reachabilityObservation(observerId, 8, 'reachable'))
  })

  it('reports an unavailable reading when the observer throws, without asserting a backend state', () => {
    const observer: LocalBackendObserver = {
      id: observerId,
      observe: () => {
        throw new Error('probe exploded')
      },
    }
    const observation = observeBackend(observer, 42)
    expect(observation).toEqual(unknownBackendObservation(observerId, 42))
    expect(observation.reachability).toBe('unknown')
  })

  it('fails loudly when an observation claims a different observer identity', () => {
    const foreign: BackendObservation = reachabilityObservation(backendObserverId('someone-else'), 1, 'reachable')
    const observer: LocalBackendObserver = { id: observerId, observe: () => foreign }
    expect(() => observeBackend(observer, 1)).toThrow(/does not match/)
  })
})
