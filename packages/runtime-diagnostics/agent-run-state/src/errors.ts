/** Source-neutral error classification with strict fatal-evidence rules. */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type {
  ClassifiedRunError,
  RunErrorCode,
  RunErrorOrigin,
  StrongBackendFailureKind,
} from './types.ts'

/** Evidence supplied by a durable event or a live observer. */
export interface RunErrorEvidence {
  readonly origin: RunErrorOrigin
  readonly error: unknown
  readonly time: number
  readonly kind?: StrongBackendFailureKind | 'stream-error' | 'cleanup'
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

function llmFailureOf(error: unknown): LlmFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as Partial<LlmFailure>
  if (typeof candidate.message !== 'string' || typeof candidate.code !== 'string') return undefined
  return candidate as LlmFailure
}

function normalizedCode(code: string): RunErrorCode | undefined {
  const value = code.toUpperCase().replaceAll('-', '_')
  switch (value) {
    case 'RESOURCE_LIMIT':
    case 'WORKER_CRASH':
    case 'MODEL_LOAD_FAILED':
    case 'INVALID_REASONING_PARAMETER':
    case 'INVALID_MODEL_CONFIG':
    case 'CONTEXT_OVERFLOW':
    case 'GENERATION_STALLED':
    case 'PROVIDER_TIMEOUT':
    case 'PROVIDER_UNAVAILABLE':
    case 'TRANSPORT':
    case 'TOOL_FAILED':
    case 'STREAM_DISCONNECTED':
    case 'CLIENT_CANCELLED':
    case 'BACKEND_RESTARTED':
    case 'BLOCKED':
    case 'MAX_TOKENS':
    case 'SESSION_INTERRUPTED':
    case 'RETRY_FAILED':
      return value
    case 'TIMEOUT': return 'PROVIDER_TIMEOUT'
    case 'SERVER':
    case 'RATE_LIMIT': return 'PROVIDER_UNAVAILABLE'
    case 'INVALID_CONFIG':
    case 'UNKNOWN_MODEL': return 'INVALID_MODEL_CONFIG'
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'CONTEXT_LENGTH_EXCEEDED': return 'CONTEXT_OVERFLOW'
    default:
      return undefined
  }
}

function strongBackendCode(kind: StrongBackendFailureKind): RunErrorCode {
  switch (kind) {
    case 'model-load-failure': return 'MODEL_LOAD_FAILED'
    case 'process-exit':
    case 'worker-uncaught-exception':
    case 'generation-worker-terminated': return 'WORKER_CRASH'
  }
}

/**
 * Classify one failure without deciding primary/secondary ordering.
 * Fatal is available only to structured backend evidence or recognized
 * backend resource-exhaustion signatures.
 * @param evidence - source, timestamp, error, and optional strong backend kind.
 * @returns stable error code, severity, origin, and retained provider identity.
 */
export function classifyRunError(evidence: RunErrorEvidence): ClassifiedRunError {
  const failure = llmFailureOf(evidence.error)
  const message = messageOf(evidence.error)
  const lower = message.toLowerCase()
  const providerRequestId = failure?.requestId
  const suppliedCode = normalizedCode(failure?.code ?? '')

  if (evidence.origin === 'backend'
    && (lower.includes('metal resource limit')
      || /\[metal::malloc\].*resource limit/.test(lower)
      || /(?:out of memory|\boom\b)/.test(lower))) {
    return {
      code: 'RESOURCE_LIMIT', message, severity: 'fatal', origin: evidence.origin, time: evidence.time,
      ...providerRequestId === undefined ? {} : { providerRequestId },
    }
  }

  if (evidence.origin === 'backend' && evidence.kind !== undefined
    && evidence.kind !== 'stream-error' && evidence.kind !== 'cleanup') {
    return {
      code: strongBackendCode(evidence.kind),
      message,
      severity: 'fatal',
      origin: evidence.origin,
      time: evidence.time,
      ...providerRequestId === undefined ? {} : { providerRequestId },
    }
  }

  if (suppliedCode === 'RESOURCE_LIMIT' || suppliedCode === 'WORKER_CRASH' || suppliedCode === 'MODEL_LOAD_FAILED') {
    return {
      code: suppliedCode, message, severity: 'fatal', origin: evidence.origin, time: evidence.time,
      ...providerRequestId === undefined ? {} : { providerRequestId },
    }
  }

  let code: RunErrorCode = suppliedCode ?? 'UNKNOWN'
  if (/broken\s*pipe|ePIPE/i.test(message)) code = 'STREAM_DISCONNECTED'
  else if (/cancel(?:led|ed)|abort(?:ed)?/i.test(message) && evidence.origin === 'client') code = 'CLIENT_CANCELLED'
  else if (/context.*(?:overflow|length|window)|too many tokens/i.test(message)) code = 'CONTEXT_OVERFLOW'
  else if (/timed?\s*out|timeout/i.test(message)) code = 'PROVIDER_TIMEOUT'
  else if (/reasoning/i.test(message) && /invalid|unsupported/i.test(message)) code = 'INVALID_REASONING_PARAMETER'

  return {
    code,
    message,
    severity: 'degraded',
    origin: evidence.origin,
    time: evidence.time,
    ...providerRequestId === undefined ? {} : { providerRequestId },
  }
}

/**
 * First failure remains primary; every later signal is retained in order.
 * @param current - accumulated primary and secondary errors.
 * @param error - newly observed classified error.
 * @returns a new accumulation without overwriting the original primary.
 */
export function appendRunError(
  current: Pick<{ primaryError?: ClassifiedRunError; secondaryErrors: readonly ClassifiedRunError[] }, 'primaryError' | 'secondaryErrors'>,
  error: ClassifiedRunError,
): { primaryError: ClassifiedRunError; secondaryErrors: readonly ClassifiedRunError[] } {
  if (current.primaryError === undefined) {
    return { primaryError: error, secondaryErrors: current.secondaryErrors }
  }
  return { primaryError: current.primaryError, secondaryErrors: [...current.secondaryErrors, error] }
}

/**
 * Build the canonical cancellation primary.
 * @param time - cancellation observation time.
 * @returns the stable client-cancelled diagnostic error.
 */
export function clientCancelledError(time: number): ClassifiedRunError {
  return {
    code: 'CLIENT_CANCELLED',
    message: 'The client cancelled the run.',
    severity: 'degraded',
    origin: 'client',
    time,
  }
}
