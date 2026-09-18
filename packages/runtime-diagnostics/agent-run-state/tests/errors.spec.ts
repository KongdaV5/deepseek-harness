import { describe, expect, it } from 'vitest'
import {
  classifyRunError,
  clientCancelledError,
  providerErrorCode,
  selectPrimaryError,
} from '@deepseek-ai/dsh-agent-run-state'
import type { ClassifiedRunError, RunErrorCode } from '@deepseek-ai/dsh-agent-run-state'

/** Build a classified error for precedence tests. */
function error(code: RunErrorCode, origin: ClassifiedRunError['origin'], time: number): ClassifiedRunError {
  return { code, message: `${code} at ${String(time)}`, severity: 'degraded', origin, time }
}

describe('classification reads structure rather than prose', () => {
  it('uses the structured provider code even when the prose suggests otherwise', () => {
    const classified = classifyRunError({
      origin: 'provider',
      error: { message: 'context length exceeded, timed out, connection reset', code: 'TRANSPORT' },
      time: 5,
      authority: 'execution',
    })
    expect(classified.code).toBe('TRANSPORT')
    expect(classified.message).toBe('context length exceeded, timed out, connection reset')
  })

  it('reports UNKNOWN when there is no structured code to read', () => {
    const classified = classifyRunError({
      origin: 'transport',
      error: 'socket closed unexpectedly',
      time: 7,
      authority: 'execution',
    })
    expect(classified.code).toBe('UNKNOWN')
    expect(classified.severity).toBe('degraded')
  })

  it.each([
    ['RESOURCE_LIMIT', 'RESOURCE_LIMIT', 'fatal'],
    ['resource-limit', 'RESOURCE_LIMIT', 'fatal'],
    ['worker_crash', 'WORKER_CRASH', 'fatal'],
    ['MODEL_LOAD_FAILED', 'MODEL_LOAD_FAILED', 'fatal'],
    ['INVALID_REASONING_PARAMETER', 'INVALID_REASONING_PARAMETER', 'degraded'],
    ['INVALID_CONFIG', 'INVALID_MODEL_CONFIG', 'degraded'],
    ['unknown-model', 'INVALID_MODEL_CONFIG', 'degraded'],
    ['CONTEXT_OVERFLOW', 'CONTEXT_OVERFLOW', 'degraded'],
    ['context-length-exceeded', 'CONTEXT_OVERFLOW', 'degraded'],
    ['GENERATION_STALLED', 'GENERATION_STALLED', 'degraded'],
    ['TIMEOUT', 'PROVIDER_TIMEOUT', 'degraded'],
    ['PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'degraded'],
    ['TOOL_FAILED', 'TOOL_FAILED', 'degraded'],
    ['STREAM_DISCONNECTED', 'STREAM_DISCONNECTED', 'degraded'],
    ['CLIENT_CANCELLED', 'CLIENT_CANCELLED', 'degraded'],
    ['BACKEND_RESTARTED', 'BACKEND_RESTARTED', 'degraded'],
    ['BLOCKED', 'BLOCKED', 'degraded'],
    ['MAX_TOKENS', 'MAX_TOKENS', 'degraded'],
    ['SESSION_INTERRUPTED', 'SESSION_INTERRUPTED', 'degraded'],
    ['RETRY_FAILED', 'RETRY_FAILED', 'degraded'],
    ['SERVER', 'UNKNOWN', 'degraded'],
    ['RATE_LIMIT', 'UNKNOWN', 'degraded'],
  ] as const)('maps the structured code %s to %s', (code, expected, severity) => {
    const classified = classifyRunError({
      origin: 'provider',
      error: { message: 'x', code },
      time: 1,
      authority: 'execution',
    })
    expect(classified.code).toBe(expected)
    expect(classified.severity).toBe(severity)
  })

  it('keeps the provider request id when the failure carries one', () => {
    const classified = classifyRunError({
      origin: 'provider',
      error: { message: 'x', code: 'PROVIDER_TIMEOUT', requestId: 'req-9' },
      time: 1,
      authority: 'execution',
    })
    expect(classified.providerRequestId).toBe('req-9')
  })

  it.each([
    [undefined, 'undefined'],
    [null, 'null'],
    [42, '42'],
    [{ code: 'TRANSPORT' }, '[object Object]'],
  ] as const)('treats %j as no structured failure', (thrown, expected) => {
    const classified = classifyRunError({ origin: 'transport', error: thrown, time: 1, authority: 'execution' })
    expect(classified.code).toBe('UNKNOWN')
    expect(classified.message).toBe(expected)
  })

  it('reads a bare message without treating it as a structured failure', () => {
    const classified = classifyRunError({
      origin: 'transport',
      error: { message: 'x' },
      time: 1,
      authority: 'execution',
    })
    expect(classified.code).toBe('UNKNOWN')
    expect(classified.message).toBe('x')
  })

  it('reads the message of an Error instance', () => {
    const classified = classifyRunError({ origin: 'transport', error: new Error('boom'), time: 1, authority: 'execution' })
    expect(classified.message).toBe('boom')
  })
})

describe('fatal requires evidence that execution cannot continue', () => {
  it('takes a strong backend failure kind as fatal', () => {
    const classified = classifyRunError({
      origin: 'backend',
      error: 'worker gone',
      time: 3,
      authority: 'observer',
      kind: 'worker-uncaught-exception',
    })
    expect(classified.code).toBe('WORKER_CRASH')
    expect(classified.severity).toBe('fatal')
  })

  it('maps a model load failure to its own fatal category', () => {
    const classified = classifyRunError({
      origin: 'backend',
      error: 'load failed',
      time: 3,
      authority: 'observer',
      kind: 'model-load-failure',
    })
    expect(classified.code).toBe('MODEL_LOAD_FAILED')
    expect(classified.severity).toBe('fatal')
  })

  it.each(['process-exit', 'generation-worker-terminated'] as const)('treats %s as a fatal worker crash', (kind) => {
    const classified = classifyRunError({ origin: 'backend', error: 'died', time: 1, authority: 'observer', kind })
    expect(classified.code).toBe('WORKER_CRASH')
    expect(classified.severity).toBe('fatal')
  })

  it.each(['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'GENERATION_STALLED', 'TRANSPORT', 'RETRY_FAILED', 'UNKNOWN'])(
    'never calls %s fatal',
    (code) => {
      const classified = classifyRunError({
        origin: 'provider',
        error: { message: 'x', code },
        time: 1,
        authority: 'execution',
      })
      expect(classified.severity).toBe('degraded')
    },
  )

  it('demotes a fatal signal that arrived as a client cancellation', () => {
    const classified = classifyRunError({
      origin: 'client',
      error: { message: 'cancelled', code: 'WORKER_CRASH' },
      time: 1,
      authority: 'client',
    })
    expect(classified.code).toBe('WORKER_CRASH')
    expect(classified.severity).toBe('degraded')
  })

  it('builds the canonical cancellation error as degraded and client-owned', () => {
    expect(clientCancelledError(11)).toEqual({
      code: 'CLIENT_CANCELLED',
      message: 'The client cancelled the run.',
      severity: 'degraded',
      origin: 'client',
      time: 11,
    })
  })
})

describe('precedence is deterministic and independent of arrival order', () => {
  it('returns nothing to report for an empty evidence set', () => {
    expect(selectPrimaryError([])).toEqual({ secondaryErrors: [] })
  })

  it('ranks a durable terminal fact above an observer failure, whatever the times', () => {
    const terminal = { error: error('PROVIDER_TIMEOUT', 'provider', 90), authority: 'terminal' } as const
    const observer = { error: error('WORKER_CRASH', 'backend', 1), authority: 'observer' } as const
    const forward = selectPrimaryError([terminal, observer])
    const reversed = selectPrimaryError([observer, terminal])
    expect(forward.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(reversed.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(forward.secondaryErrors.map(entry => entry.code)).toEqual(['WORKER_CRASH'])
    expect(reversed).toEqual(forward)
  })

  it('ranks a structured execution failure above a generic observer failure', () => {
    const selection = selectPrimaryError([
      { error: error('PROVIDER_TIMEOUT', 'backend', 1), authority: 'observer' },
      { error: error('TRANSPORT', 'transport', 50), authority: 'execution' },
    ])
    expect(selection.primaryError?.code).toBe('TRANSPORT')
    expect(selection.secondaryErrors.map(entry => entry.code)).toEqual(['PROVIDER_TIMEOUT'])
  })

  it('breaks a same-strength tie by earliest time', () => {
    const selection = selectPrimaryError([
      { error: error('PROVIDER_UNAVAILABLE', 'provider', 40), authority: 'execution' },
      { error: error('PROVIDER_TIMEOUT', 'provider', 10), authority: 'execution' },
    ])
    expect(selection.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(selection.secondaryErrors.map(entry => entry.code)).toEqual(['PROVIDER_UNAVAILABLE'])
  })

  it('keeps a client cancellation from being replaced by a later backend fatality', () => {
    const selection = selectPrimaryError([
      { error: clientCancelledError(1), authority: 'client' },
      {
        error: classifyRunError({
          origin: 'backend',
          error: 'worker died',
          time: 2,
          authority: 'observer',
          kind: 'worker-uncaught-exception',
        }),
        authority: 'observer',
      },
    ])
    expect(selection.primaryError?.code).toBe('CLIENT_CANCELLED')
    expect(selection.primaryError?.severity).toBe('degraded')
  })

  it('lets a stronger authority win over an earlier weaker observation', () => {
    const selection = selectPrimaryError([
      { error: error('WORKER_CRASH', 'backend', 1), authority: 'observer' },
      { error: error('PROVIDER_TIMEOUT', 'provider', 9), authority: 'execution' },
      { error: error('SESSION_INTERRUPTED', 'session', 99), authority: 'terminal' },
    ])
    expect(selection.primaryError?.code).toBe('SESSION_INTERRUPTED')
    // Secondaries keep chronological order, which is a diagnostic timeline
    // rather than a second ranking.
    expect(selection.secondaryErrors.map(entry => entry.code)).toEqual(['WORKER_CRASH', 'PROVIDER_TIMEOUT'])
  })

  it('retains every secondary diagnostic without dropping or reordering it by strength', () => {
    const selection = selectPrimaryError([
      { error: error('PROVIDER_UNAVAILABLE', 'provider', 30), authority: 'execution' },
      { error: error('PROVIDER_TIMEOUT', 'provider', 10), authority: 'execution' },
      { error: error('TRANSPORT', 'transport', 20), authority: 'execution' },
    ])
    expect(selection.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(selection.secondaryErrors.map(entry => entry.code))
      .toEqual(['TRANSPORT', 'PROVIDER_UNAVAILABLE'])
    expect(selection.secondaryErrors.map(entry => entry.time)).toEqual([20, 30])
  })
})

describe('durable retry codes map through the same table', () => {
  it.each([
    ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'],
    ['timeout', 'PROVIDER_TIMEOUT'],
    ['CONTEXT_LENGTH_EXCEEDED', 'CONTEXT_OVERFLOW'],
    ['unmapped-provider-code', 'UNKNOWN'],
  ] as const)('maps %s to %s', (code, expected) => {
    expect(providerErrorCode(code)).toBe(expected)
  })

  // Every synonym a durable code may arrive under has to reach the same
  // category, because the retry facts keep the provider's own spelling.
  it.each([
    ['RESOURCE_LIMIT', 'RESOURCE_LIMIT'],
    ['WORKER_CRASH', 'WORKER_CRASH'],
    ['MODEL_LOAD_FAILED', 'MODEL_LOAD_FAILED'],
    ['INVALID_REASONING_PARAMETER', 'INVALID_REASONING_PARAMETER'],
    ['INVALID_MODEL_CONFIG', 'INVALID_MODEL_CONFIG'],
    ['INVALID_CONFIG', 'INVALID_MODEL_CONFIG'],
    ['UNKNOWN_MODEL', 'INVALID_MODEL_CONFIG'],
    ['CONTEXT_OVERFLOW', 'CONTEXT_OVERFLOW'],
    ['CONTEXT_WINDOW_EXCEEDED', 'CONTEXT_OVERFLOW'],
    ['CONTEXT_LENGTH_EXCEEDED', 'CONTEXT_OVERFLOW'],
    ['GENERATION_STALLED', 'GENERATION_STALLED'],
    ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'],
    ['TIMEOUT', 'PROVIDER_TIMEOUT'],
    ['PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
    ['TRANSPORT', 'TRANSPORT'],
    ['TOOL_FAILED', 'TOOL_FAILED'],
    ['STREAM_DISCONNECTED', 'STREAM_DISCONNECTED'],
    ['CLIENT_CANCELLED', 'CLIENT_CANCELLED'],
    ['BACKEND_RESTARTED', 'BACKEND_RESTARTED'],
    ['BLOCKED', 'BLOCKED'],
    ['MAX_TOKENS', 'MAX_TOKENS'],
    ['SESSION_INTERRUPTED', 'SESSION_INTERRUPTED'],
    ['RETRY_FAILED', 'RETRY_FAILED'],
  ] as const)('maps the durable code %s to %s', (code, expected) => {
    expect(providerErrorCode(code)).toBe(expected)
  })
})
