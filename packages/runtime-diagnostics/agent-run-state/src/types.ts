/**
 * Pure public contracts for DS Harness run state and backend observation.
 *
 * The domain has exactly one authority: the durable upstream Session facts of a
 * single turn. Backend observation is a *separate* diagnostic dimension that
 * shares no identity with it, so nothing here lets a reachable endpoint, a busy
 * worker, or a missing progress metric create, advance, or terminate a Run.
 *
 * Two absences are load-bearing:
 *
 * - There is no durable attempt identity. Upstream's `LlmAttemptId` is minted
 *   from a process-local counter and is never persisted, so a run state that
 *   carried it would present a value that repeats across lifecycles as if it
 *   were stable. {@link RunState} therefore carries step *position*, not an
 *   attempt id.
 * - There is no "idle Run". {@link RunProjectionState.active} is `null` whenever
 *   no durable turn is open, which is what stops an idle consumer from being
 *   handed a synthesized Run object.
 *
 * @module @deepseek-ai/dsh-agent-run-state/types
 */

import type { SessionId, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { BackendObserverId, RunId } from './brand.ts'

export type { BackendObserverId, RunId }

/**
 * Fine-grained run phase, limited to what durable boundaries can prove.
 *
 * There is deliberately no `prefill`, `reasoning`, or `generating` member: those
 * would claim a decode position that the durable event set does not carry, and
 * an invented progress phase is exactly the fabrication this contract refuses.
 */
export type RunPhase =
  | 'unknown'
  | 'starting'
  | 'executing'
  | 'waiting_retry'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** The phases a Run can never leave. */
export type TerminalRunPhase = Extract<RunPhase, 'completed' | 'cancelled' | 'failed'>

/**
 * Overall run health. `unknown` is a first-class answer, not a missing value:
 * an unobserved run is not healthy, idle, or failed.
 */
export type RunHealth = 'unknown' | 'healthy' | 'slow' | 'stalled' | 'degraded' | 'fatal'

/** Deployment-owned elapsed-time thresholds; never hidden inside a classifier. */
export interface RunHealthThresholds {
  /** Run age after which continuing activity is classified as slow. */
  readonly slowAfterMs: number
  /** Inactivity duration after which an active run is classified as stalled. */
  readonly stalledAfterMs: number
}

/** Stable source-independent error categories, shared with the v1 task contract. */
export type RunErrorCode =
  | 'RESOURCE_LIMIT'
  | 'WORKER_CRASH'
  | 'MODEL_LOAD_FAILED'
  | 'INVALID_REASONING_PARAMETER'
  | 'INVALID_MODEL_CONFIG'
  | 'CONTEXT_OVERFLOW'
  | 'GENERATION_STALLED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSPORT'
  | 'TOOL_FAILED'
  | 'STREAM_DISCONNECTED'
  | 'CLIENT_CANCELLED'
  | 'BACKEND_RESTARTED'
  | 'BLOCKED'
  | 'MAX_TOKENS'
  | 'SESSION_INTERRUPTED'
  | 'RETRY_FAILED'
  | 'UNKNOWN'

/** Layer that supplied an error signal; it does not by itself establish strength. */
export type RunErrorOrigin = 'backend' | 'provider' | 'transport' | 'client' | 'tool' | 'session'

/**
 * How strong the evidence behind one error signal is. Lower rank wins, so a
 * durable terminal fact always outranks a transient observer report.
 */
export type RunErrorAuthority = 'terminal' | 'execution' | 'client' | 'observer'

/**
 * One classified failure.
 *
 * The field set is byte-compatible with the durable v1 `classifiedError`
 * contract, so a later producer can persist a selected primary error without
 * projecting strength or any other run-state-only concept into storage.
 */
export interface ClassifiedRunError {
  readonly code: RunErrorCode
  readonly message: string
  readonly severity: 'degraded' | 'fatal'
  readonly origin: RunErrorOrigin
  readonly time: number
  readonly providerRequestId?: string
}

/** Structured fatal evidence; free-form text alone is never enough. */
export type StrongBackendFailureKind =
  | 'process-exit'
  | 'worker-uncaught-exception'
  | 'generation-worker-terminated'
  | 'model-load-failure'

/** One error signal plus the strength of the evidence that produced it. */
export interface RunErrorEvidence {
  readonly origin: RunErrorOrigin
  readonly error: unknown
  readonly time: number
  readonly authority: RunErrorAuthority
  readonly kind?: StrongBackendFailureKind
}

/** What a backend observer can say about reachability. */
export type BackendReachability = 'unknown' | 'reachable' | 'unreachable'

/**
 * What a backend observer can say about activity.
 *
 * `idle` requires direct evidence of inactivity. Not observing progress is not
 * evidence of idleness, so an observer that cannot read activity reports
 * `unknown`.
 */
export type BackendActivity = 'unknown' | 'idle' | 'active'

/** Where a backend observation's values came from. */
export type BackendEvidenceSource = 'endpoint' | 'process' | 'metrics' | 'none'

/** Whether the observation's values are directly observed or explicitly unavailable. */
export type EvidenceDirectness = 'direct' | 'unavailable'

/**
 * Finite backend-neutral evidence about one backend.
 *
 * The shape answers what was observed, from which source, when, and whether it
 * is direct — the provenance a consumer needs to avoid over-reading it.
 */
export interface BackendObservation {
  readonly observerId: BackendObserverId
  readonly observedAt: number
  readonly source: BackendEvidenceSource
  readonly directness: EvidenceDirectness
  readonly reachability: BackendReachability
  readonly activity: BackendActivity
}

/**
 * Replaceable backend observer seam.
 *
 * It is pull-based on purpose: there is no subscription and no interval here,
 * so adopting this contract cannot install a background scheduler. A caller
 * decides when to ask, and a deployment that has no reliable signal registers
 * no observer at all.
 */
export interface LocalBackendObserver {
  readonly id: BackendObserverId
  /**
   * Read the evidence available right now.
   * @returns the current observation; never a guess.
   */
  observe(): BackendObservation
}

/** One durable step boundary within a run's turn. */
export interface RunStepFact {
  readonly step: number
  readonly startSeq: SessionSeq
  readonly endSeq?: SessionSeq
  /** Whether the step has no durable `step/end` in the folded range. */
  readonly open: boolean
}

/**
 * One Run's durable facts.
 *
 * `turn` is the run boundary, so every field here belongs to exactly one
 * upstream turn. A terminal run keeps its `terminalReason` as the source fact;
 * the normalized `phase` never replaces it.
 */
export interface RunState {
  readonly sessionId: SessionId
  readonly runId: RunId
  /** The durable upstream turn this run is. */
  readonly turn: number
  readonly phase: RunPhase
  readonly startedAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly lastActivityAt: number
  readonly lastMeaningfulActivityAt: number
  /** The full durable `turn/end` reason, retained verbatim as the source fact. */
  readonly terminalReason?: TurnEndReason
  /** Whether the turn was closed by after-the-fact crash repair. */
  readonly repairClosure: boolean
  readonly steps: readonly RunStepFact[]
  readonly stepCount: number
  /** The highest step number seen, or `null` before the first step. */
  readonly lastStep: number | null
  /** The step left open by the folded range, or `null` when none is open. */
  readonly openStep: number | null
  readonly retryCount: number
  readonly maxRetryCount?: number
  readonly retryReason?: RunErrorCode
  /**
   * The strongest error evidence attached so far, present on a live run as soon
   * as execution produces it and on a terminal run once `turn/end` does. Its
   * presence never makes a run terminal: terminality is decided by the durable
   * `turn/end` fact alone.
   */
  readonly primaryError?: ClassifiedRunError
  /** Retained diagnostic evidence; never replaces {@link primaryError}. */
  readonly secondaryErrors: readonly ClassifiedRunError[]
}

/**
 * The durable run projection.
 *
 * `active` is `null` whenever no durable turn is open. A terminal run is
 * retained separately as history so a consumer can still read the last outcome
 * without mistaking it for current work.
 */
export interface RunProjectionState {
  readonly sessionId: SessionId
  readonly active: RunState | null
  readonly terminal: RunState | null
}

/**
 * A read-only diagnostic cut: durable authority plus the separate backend
 * dimension. Backend evidence appears here and nowhere else.
 */
export interface RunDiagnostics {
  readonly active: RunState | null
  readonly terminal: RunState | null
  readonly backend: BackendObservation
  readonly health: RunHealth
  readonly primaryError?: ClassifiedRunError
  readonly secondaryErrors: readonly ClassifiedRunError[]
}
