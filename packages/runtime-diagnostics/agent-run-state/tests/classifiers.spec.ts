import { describe, expect, it } from 'vitest'
import { appendRunError, classifyRunError, classifyRunHealth } from '@deepseek-ai/dsh-agent-run-state'

const baseHealth = {
  now: 1_000,
  phase: 'prefill' as const,
  startedAt: 0,
  lastMeaningfulActivityAt: 999,
  processHealth: 'healthy' as const,
  modelHealth: 'healthy' as const,
  generationHealth: 'active' as const,
  slowAfterMs: 500,
  stalledAfterMs: 2_000,
}

describe('health classifier invariants', () => {
  it('keeps advancing prefill non-stalled even after a long first-token wait', () => {
    expect(classifyRunHealth({ ...baseHealth, now: 600_000, lastMeaningfulActivityAt: 598_000 })).toBe('slow')
  })

  it('classifies stopped activity as stalled and absence of evidence as unknown', () => {
    expect(classifyRunHealth({ ...baseHealth, now: 3_000, lastMeaningfulActivityAt: 1 })).toBe('stalled')
    const { lastMeaningfulActivityAt: _lastMeaningfulActivityAt, ...withoutActivity } = baseHealth
    expect(classifyRunHealth({
      ...withoutActivity,
      generationHealth: 'unknown',
      processHealth: 'healthy',
    })).toBe('unknown')
  })

  it('lets fatal generation health override healthy process health', () => {
    expect(classifyRunHealth({ ...baseHealth, generationHealth: 'fatal' })).toBe('fatal')
  })

  it('validates deployment thresholds', () => {
    expect(() => classifyRunHealth({ ...baseHealth, slowAfterMs: 0 })).toThrow(/slowAfterMs/)
    expect(() => classifyRunHealth({ ...baseHealth, stalledAfterMs: 500 })).toThrow(/greater/)
  })

  it.each([
    [{ primaryError: { code: 'WORKER_CRASH', message: 'x', severity: 'fatal', origin: 'backend', time: 1 } }, 'fatal'],
    [{ processHealth: 'fatal' }, 'fatal'],
    [{ modelHealth: 'fatal' }, 'fatal'],
    [{ generationHealth: 'stalled' }, 'stalled'],
    [{ processHealth: 'degraded' }, 'degraded'],
    [{ modelHealth: 'degraded' }, 'degraded'],
    [{ generationHealth: 'degraded' }, 'degraded'],
    [{ primaryError: { code: 'UNKNOWN', message: 'x', severity: 'degraded', origin: 'provider', time: 1 } }, 'degraded'],
    [{ phase: 'completed', generationHealth: 'unknown' }, 'healthy'],
    [{ phase: 'cancelled', generationHealth: 'unknown' }, 'degraded'],
    [{ phase: 'failed', generationHealth: 'unknown' }, 'degraded'],
    [{ phase: 'unknown', generationHealth: 'unknown' }, 'unknown'],
    [{ phase: 'generating', generationHealth: 'unknown', processHealth: 'unknown', modelHealth: 'unknown' }, 'slow'],
    [{ phase: 'generating', generationHealth: 'active' }, 'slow'],
  ] as const)('covers component and terminal precedence %#', (override, expected) => {
    expect(classifyRunHealth({ ...baseHealth, ...override })).toBe(expected)
  })

  it('clamps future activity to zero idle time', () => {
    expect(classifyRunHealth({ ...baseHealth, now: 10, startedAt: 0, lastMeaningfulActivityAt: 20 })).toBe('healthy')
  })
})

describe('error classifier invariants', () => {
  it('requires backend evidence for message-derived Metal/OOM fatal classification', () => {
    const message = '[metal::malloc] Resource limit (499000) exceeded'
    expect(classifyRunError({ origin: 'backend', error: message, time: 1 }))
      .toMatchObject({ code: 'RESOURCE_LIMIT', severity: 'fatal' })
    expect(classifyRunError({ origin: 'transport', error: message, time: 1 }).severity).toBe('degraded')
  })

  it('accepts structured worker termination as strong fatal evidence', () => {
    expect(classifyRunError({
      origin: 'backend', error: new Error('worker stopped'), time: 1, kind: 'generation-worker-terminated',
    })).toMatchObject({ code: 'WORKER_CRASH', severity: 'fatal' })
  })

  it('keeps a recognized resource limit more specific than generic worker termination', () => {
    expect(classifyRunError({
      origin: 'backend',
      error: 'RuntimeError: [metal::malloc] Resource limit (499000) exceeded.',
      time: 1,
      kind: 'generation-worker-terminated',
    })).toMatchObject({ code: 'RESOURCE_LIMIT', severity: 'fatal' })
  })

  it.each([
    ['model-load-failure', 'MODEL_LOAD_FAILED'],
    ['process-exit', 'WORKER_CRASH'],
    ['worker-uncaught-exception', 'WORKER_CRASH'],
  ] as const)('maps structured backend failure %s', (kind, code) => {
    expect(classifyRunError({ origin: 'backend', error: { message: 'boom' }, time: 1, kind }))
      .toMatchObject({ code, severity: 'fatal' })
  })

  it.each([
    'RESOURCE_LIMIT', 'WORKER_CRASH', 'MODEL_LOAD_FAILED', 'INVALID_REASONING_PARAMETER',
    'INVALID_MODEL_CONFIG', 'CONTEXT_OVERFLOW', 'GENERATION_STALLED', 'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE', 'TRANSPORT', 'TOOL_FAILED', 'STREAM_DISCONNECTED',
    'CLIENT_CANCELLED', 'BACKEND_RESTARTED', 'BLOCKED', 'MAX_TOKENS',
    'SESSION_INTERRUPTED', 'RETRY_FAILED',
  ] as const)('accepts stable structured code %s', (code) => {
    const classified = classifyRunError({ origin: 'provider', error: { code, message: 'structured' }, time: 1 })
    expect(classified.code).toBe(code)
    expect(classified.severity).toBe(['RESOURCE_LIMIT', 'WORKER_CRASH', 'MODEL_LOAD_FAILED'].includes(code) ? 'fatal' : 'degraded')
  })

  it.each([
    ['context window exceeded', 'CONTEXT_OVERFLOW'],
    ['request timed out', 'PROVIDER_TIMEOUT'],
    ['unsupported reasoning value', 'INVALID_REASONING_PARAMETER'],
    ['opaque failure', 'UNKNOWN'],
  ])('classifies fallback message %s', (message, code) => {
    expect(classifyRunError({ origin: 'provider', error: message, time: 1 }).code).toBe(code)
  })

  it.each([
    ['TIMEOUT', 'PROVIDER_TIMEOUT'],
    ['SERVER', 'PROVIDER_UNAVAILABLE'],
    ['RATE_LIMIT', 'PROVIDER_UNAVAILABLE'],
    ['TRANSPORT', 'TRANSPORT'],
    ['INVALID_CONFIG', 'INVALID_MODEL_CONFIG'],
    ['CONTEXT_WINDOW_EXCEEDED', 'CONTEXT_OVERFLOW'],
  ])('normalizes provider code %s to %s', (supplied, expected) => {
    expect(classifyRunError({ origin: 'provider', error: { code: supplied, message: 'x' }, time: 1 }).code)
      .toBe(expected)
  })

  it('preserves provider request identity and handles Error and primitive messages', () => {
    const requestId = 'provider-request' as never
    expect(classifyRunError({
      origin: 'provider', error: { code: 'SERVER', message: 'opaque', requestId }, time: 1,
    }).providerRequestId).toBe(requestId)
    expect(classifyRunError({ origin: 'provider', error: new Error('opaque'), time: 1 }).message).toBe('opaque')
    expect(classifyRunError({ origin: 'provider', error: 42, time: 1 }).message).toBe('42')
  })

  it.each([
    [{ origin: 'backend', error: { code: 'SERVER', message: 'worker', requestId: 'r' }, kind: 'process-exit' }, 'WORKER_CRASH'],
    [{ origin: 'backend', error: { code: 'SERVER', message: 'Metal resource limit', requestId: 'r' } }, 'RESOURCE_LIMIT'],
    [{ origin: 'provider', error: { code: 'RESOURCE_LIMIT', message: 'limit', requestId: 'r' } }, 'RESOURCE_LIMIT'],
  ] as const)('retains request identity on fatal path %#', (evidence, code) => {
    expect(classifyRunError({ ...evidence, time: 1 }))
      .toMatchObject({ code, providerRequestId: 'r' })
  })

  it('does not promote cleanup or stream labels to strong backend evidence', () => {
    expect(classifyRunError({ origin: 'backend', error: 'cleanup', time: 1, kind: 'cleanup' }).severity).toBe('degraded')
    expect(classifyRunError({ origin: 'backend', error: 'stream', time: 1, kind: 'stream-error' }).severity).toBe('degraded')
  })

  it('classifies BrokenPipe as a secondary-capable stream error without making it fatal', () => {
    const primary = classifyRunError({ origin: 'client', error: 'cancelled', time: 1 })
    const brokenPipe = classifyRunError({ origin: 'transport', error: 'BrokenPipe while writing', time: 2 })
    expect(appendRunError(appendRunError({ secondaryErrors: [] }, primary), brokenPipe)).toEqual({
      primaryError: primary,
      secondaryErrors: [brokenPipe],
    })
    expect(brokenPipe).toMatchObject({ code: 'STREAM_DISCONNECTED', severity: 'degraded' })
  })

  it('keeps a fatal root cause primary through disconnect and retry-failure signals', () => {
    const resource = classifyRunError({
      origin: 'backend', error: '[metal::malloc] Resource limit exceeded', time: 1,
    })
    const disconnected = classifyRunError({
      origin: 'transport', error: { code: 'STREAM_DISCONNECTED', message: 'BrokenPipe' }, time: 2,
    })
    const retryFailed = classifyRunError({
      origin: 'session', error: { code: 'RETRY_FAILED', message: 'retry executor failed' }, time: 3,
    })
    const result = appendRunError(
      appendRunError(appendRunError({ secondaryErrors: [] }, resource), disconnected),
      retryFailed,
    )
    expect(result).toEqual({ primaryError: resource, secondaryErrors: [disconnected, retryFailed] })
  })
})
