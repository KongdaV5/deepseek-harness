/**
 * Source-neutral error classification with deterministic precedence.
 *
 * Classification reads structured evidence only. A provider's `LlmFailure`
 * carries a machine code, an HTTP status, and a request id; when that structure
 * is present it decides the category outright. Message text is used for the
 * human-readable message and for nothing else, because a category guessed from
 * prose is indistinguishable from a category that was actually observed. A
 * signal with no structured code is reported as `UNKNOWN` rather than inferred.
 *
 * @module @deepseek-ai/dsh-agent-run-state/errors
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type {
  ClassifiedRunError,
  RunErrorAuthority,
  RunErrorCode,
  RunErrorEvidence,
  StrongBackendFailureKind,
} from './types.ts'

/** One classified error paired with the strength of the evidence behind it. */
export interface RankedRunError {
  readonly error: ClassifiedRunError
  readonly authority: RunErrorAuthority
}

/** The selected primary error plus the retained diagnostics. */
export interface RunErrorSelection {
  readonly primaryError?: ClassifiedRunError
  readonly secondaryErrors: readonly ClassifiedRunError[]
}

/**
 * Evidence strength, strongest first. A durable terminal fact outranks any live
 * report, and a structured execution failure outranks a generic observer.
 */
const AUTHORITY_RANK: Readonly<Record<RunErrorAuthority, number>> = {
  terminal: 0,
  execution: 1,
  client: 2,
  observer: 3,
}

/** Categories whose structured evidence means execution cannot safely continue. */
const FATAL_CODES: ReadonlySet<RunErrorCode> = new Set<RunErrorCode>([
  'RESOURCE_LIMIT',
  'WORKER_CRASH',
  'MODEL_LOAD_FAILED',
])

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

/**
 * Map one structured provider-neutral machine code onto a run error category.
 *
 * Only near-synonymous renames are admitted. A generic code such as `SERVER` or
 * `RATE_LIMIT` has no single trustworthy category here, so it stays `UNKNOWN`
 * instead of being rounded to the nearest plausible one.
 * @param code - the structured `LlmFailure.code`, or an empty string when absent.
 * @returns the matching category, or `undefined` when the code maps to nothing.
 */
function normalizedCode(code: string): RunErrorCode | undefined {
  switch (code.toUpperCase().replaceAll('-', '_')) {
    case 'RESOURCE_LIMIT':
      return 'RESOURCE_LIMIT'
    case 'WORKER_CRASH':
      return 'WORKER_CRASH'
    case 'MODEL_LOAD_FAILED':
      return 'MODEL_LOAD_FAILED'
    case 'INVALID_REASONING_PARAMETER':
      return 'INVALID_REASONING_PARAMETER'
    case 'INVALID_MODEL_CONFIG':
    case 'INVALID_CONFIG':
    case 'UNKNOWN_MODEL':
      return 'INVALID_MODEL_CONFIG'
    case 'CONTEXT_OVERFLOW':
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'CONTEXT_LENGTH_EXCEEDED':
      return 'CONTEXT_OVERFLOW'
    case 'GENERATION_STALLED':
      return 'GENERATION_STALLED'
    case 'PROVIDER_TIMEOUT':
    case 'TIMEOUT':
      return 'PROVIDER_TIMEOUT'
    case 'PROVIDER_UNAVAILABLE':
      return 'PROVIDER_UNAVAILABLE'
    case 'TRANSPORT':
      return 'TRANSPORT'
    case 'TOOL_FAILED':
      return 'TOOL_FAILED'
    case 'STREAM_DISCONNECTED':
      return 'STREAM_DISCONNECTED'
    case 'CLIENT_CANCELLED':
      return 'CLIENT_CANCELLED'
    case 'BACKEND_RESTARTED':
      return 'BACKEND_RESTARTED'
    case 'BLOCKED':
      return 'BLOCKED'
    case 'MAX_TOKENS':
      return 'MAX_TOKENS'
    case 'SESSION_INTERRUPTED':
      return 'SESSION_INTERRUPTED'
    case 'RETRY_FAILED':
      return 'RETRY_FAILED'
    default:
      return undefined
  }
}

/** The category a structured backend failure kind proves. */
function strongBackendCode(kind: StrongBackendFailureKind): RunErrorCode {
  return kind === 'model-load-failure' ? 'MODEL_LOAD_FAILED' : 'WORKER_CRASH'
}

/**
 * Map one durable provider-neutral failure code onto a run error category.
 *
 * Retry facts retain the code but not the surrounding `LlmFailure`, so this is
 * the entry a consumer uses to categorize retry evidence. A code with no
 * trustworthy category maps to `UNKNOWN` instead of the nearest plausible one.
 * @param code - a durable `LlmFailure.code`.
 * @returns the matching category, or `UNKNOWN`.
 */
export function providerErrorCode(code: string): RunErrorCode {
  return normalizedCode(code) ?? 'UNKNOWN'
}

/**
 * Classify one failure signal.
 *
 * Fatal is available only to evidence that says execution cannot safely
 * continue: a structured strong backend failure kind, or a structured provider
 * code naming a resource limit, a worker crash, or a model-load failure. A
 * timeout, a transport error, a stalled generation, a retry, or an observer that
 * returned nothing are all `degraded`, and `UNKNOWN` when there is no structured
 * code to read.
 * @param evidence - origin, error, time, evidence strength, and optional strong backend kind.
 * @returns the classified error, byte-compatible with the durable v1 contract.
 */
export function classifyRunError(evidence: RunErrorEvidence): ClassifiedRunError {
  const failure = llmFailureOf(evidence.error)
  const message = messageOf(evidence.error)
  const providerRequestId = failure?.requestId

  let code: RunErrorCode
  let severity: 'degraded' | 'fatal'
  if (evidence.kind === undefined) {
    code = normalizedCode(failure?.code ?? '') ?? 'UNKNOWN'
    severity = FATAL_CODES.has(code) ? 'fatal' : 'degraded'
  } else {
    code = strongBackendCode(evidence.kind)
    severity = 'fatal'
  }
  // An explicit cancellation is a client decision, so it is never fatal even
  // when the signal it arrived on would otherwise prove a stronger condition.
  if (evidence.authority === 'client') severity = 'degraded'

  return {
    code,
    message,
    severity,
    origin: evidence.origin,
    time: evidence.time,
    ...providerRequestId === undefined ? {} : { providerRequestId },
  }
}

/**
 * Build the canonical cancellation error.
 *
 * A cancellation is recorded as `degraded` because the user ending a run is an
 * outcome, not a fault, and because a later observer failure must not be able to
 * reclassify it as a backend fatality.
 * @param time - when the cancellation terminal fact was recorded.
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

/**
 * Choose the primary error and order the diagnostics.
 *
 * Ordering is total and independent of arrival order: strongest evidence first,
 * then earliest time. That makes the selected primary a function of the evidence
 * set alone, so a late observer update cannot oscillate the run's outcome.
 * @param errors - every classified error with its evidence strength.
 * @returns the primary error and the retained secondary diagnostics.
 */
export function selectPrimaryError(errors: readonly RankedRunError[]): RunErrorSelection {
  const ranked = [...errors].sort((left, right) => {
    const byAuthority = AUTHORITY_RANK[left.authority] - AUTHORITY_RANK[right.authority]
    return byAuthority === 0 ? left.error.time - right.error.time : byAuthority
  })
  const [primary, ...rest] = ranked
  if (primary === undefined) return { secondaryErrors: [] }
  return {
    primaryError: primary.error,
    secondaryErrors: rest.map(entry => entry.error).sort((left, right) => left.time - right.time),
  }
}
