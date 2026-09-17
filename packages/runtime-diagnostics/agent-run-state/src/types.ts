/** Pure public contracts for run-state projection and backend observation. */

import type { ProviderRequestId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AttemptId, BackendObserverId, RunControlObserverId, RunDiagnosticsObserverId, RunId } from './brand.ts'

export type { AttemptId, BackendObserverId, RunControlObserverId, RunDiagnosticsObserverId, RunId }

/** Fine-grained phase independent of the coarse `AgentStatus`. */
export type RunPhase =
  | 'unknown'
  | 'starting'
  | 'preparing_context'
  | 'prefill'
  | 'reasoning'
  | 'generating'
  | 'tool_wait'
  | 'waiting_retry'
  | 'compacting'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** Overall live health; lack of evidence is represented explicitly. */
export type RunHealth = 'unknown' | 'healthy' | 'slow' | 'stalled' | 'degraded' | 'fatal'

/** Independently observable backend component health. */
export type BackendComponentHealth = 'unknown' | 'healthy' | 'degraded' | 'fatal'

/** Generation health adds a positive activity state and a stalled state. */
export type GenerationHealth = 'unknown' | 'active' | 'stalled' | 'degraded' | 'fatal'

/** Stable source-independent error categories used by diagnostics and later policy. */
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

/** Layer that supplied an error signal; it does not by itself establish fatality. */
export type RunErrorOrigin = 'backend' | 'provider' | 'transport' | 'client' | 'tool' | 'session'

/** One classified failure. The first becomes primary; later failures remain secondary. */
export interface ClassifiedRunError {
  readonly code: RunErrorCode
  readonly message: string
  readonly severity: 'degraded' | 'fatal'
  readonly origin: RunErrorOrigin
  readonly time: number
  readonly providerRequestId?: ProviderRequestId
}

/** Requested, resolved, and backend-default reasoning are deliberately distinct. */
export interface ReasoningObservation {
  readonly requestedReasoning?: string
  /** Policy-level selection before one backend capability normalizes it. */
  readonly policySelected?: string
  readonly resolvedReasoning?: string
  /** Exact backend request value; absent means the observer does not know it. */
  readonly wireValue?: string
  readonly backendDefaultReasoning?: string
  /** Why the current policy decision won, or why it was normalized. */
  readonly source?: string
  /** Strength of the backend capability declaration used to normalize the decision. */
  readonly capabilityConfidence?: 'confirmed' | 'provisional' | 'unknown'
}

/** Read-only context facts; absent fields are unknown, not zero. */
export interface ContextPressureObservation {
  readonly contextWindow?: number
  readonly surfaceTokens?: number
  readonly projectedTokens?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  /** Next-request prompt estimate after the policy's token-meter read. */
  readonly projectedPromptTokens?: number
  /** Resume context estimate already represented in the current prompt surface, when known. */
  readonly resumeContextTokens?: number
  /** Policy reserve for expected visible and hidden output, not a provider fact. */
  readonly expectedOutputReserve?: number
  /** Configured protection against estimator and template error. */
  readonly providerSafetyMargin?: number
  /** Context window less the reserve and provider margin. */
  readonly effectivePromptBudget?: number
  /** Projected prompt divided by the effective prompt budget. */
  readonly pressureRatio?: number
  /** Read-only pressure classification; it never triggers compaction itself. */
  readonly pressureState?: 'unknown' | 'normal' | 'watch' | 'prepare' | 'compact' | 'critical'
}

/** A run-local request attempt. Retry changes `attemptId`, never `runId`. */
export interface AttemptState {
  readonly attemptId: AttemptId
  readonly step: number
  readonly ordinal: number
  readonly startedAt: number
  readonly settledAt?: number
  readonly providerRequestId?: ProviderRequestId
}

/** Backend prefill observation. Log-derived values remain provisional. */
export interface PrefillObservation {
  readonly current?: number
  readonly total?: number
  readonly speed?: number
  readonly source: 'backend-log' | 'callback' | 'metrics' | 'unknown'
  readonly confidence: 'provisional' | 'confirmed' | 'unknown'
}

/** Explicit generation presence; absence of a value remains unknown. */
export interface GenerationActivityObservation {
  readonly state: 'active' | 'inactive'
  readonly source: 'backend-log' | 'callback' | 'metrics' | 'unknown'
  readonly confidence: 'provisional' | 'confirmed' | 'unknown'
}

/** Attribution is explicit; observers never infer a request when evidence is insufficient. */
export type BackendAttribution =
  | {
    readonly kind: 'attempt'
    readonly attemptId: AttemptId
    readonly source?: 'explicit' | 'request-and-backend-lifecycle'
    readonly confidence?: 'confirmed' | 'provisional'
  }
  | {
    readonly kind: 'run'
    readonly runId: RunId
    readonly source?: 'explicit' | 'request-and-backend-lifecycle'
    readonly confidence?: 'confirmed' | 'provisional'
  }
  | { readonly kind: 'unknown' }

/** Structured fatal evidence; free-form text alone is not enough except recognized backend signatures. */
export type StrongBackendFailureKind =
  | 'process-exit'
  | 'worker-uncaught-exception'
  | 'generation-worker-terminated'
  | 'model-load-failure'

/** Finite backend-neutral output produced by any LocalBackendObserver implementation. */
export interface BackendObservation {
  readonly observerId: BackendObserverId
  readonly attribution: BackendAttribution
  readonly observedAt: number
  readonly lastActivityAt?: number
  readonly activity?: 'model-loading' | 'prefill' | 'generation' | 'heartbeat'
  readonly processHealth: BackendComponentHealth
  readonly modelHealth: BackendComponentHealth
  readonly generationHealth: GenerationHealth
  readonly generationActivity?: GenerationActivityObservation
  readonly prefill?: PrefillObservation
  readonly failure?: {
    readonly error: unknown
    readonly kind?: StrongBackendFailureKind
  }
}

/** Replaceable observer seam. Providers publish observations and own no Run State. */
export interface LocalBackendObserver {
  readonly id: BackendObserverId
  subscribe(listener: (observation: BackendObservation) => void): () => void
  /** Refresh immediately available evidence before a policy decision. */
  probe?(): Promise<void>
}

/** Transient cancellation acknowledgement derived by a run-control policy. */
export type CancellationObservation =
  | { readonly status: 'requested'; readonly requestedAt: number }
  | { readonly status: 'confirmed'; readonly requestedAt: number; readonly resolvedAt: number }
  | { readonly status: 'unconfirmed'; readonly requestedAt: number; readonly resolvedAt: number }

/** Complete transient policy facts for one Run. */
export interface RunControlObservation {
  readonly observerId: RunControlObserverId
  readonly runId: RunId
  readonly observedAt: number
  readonly retry?: {
    readonly maxRetryCount: number
    readonly reason: RunErrorCode
  }
  readonly cancellation?: CancellationObservation
}

/** Replaceable run-control observer; it reports policy facts but cannot mutate Run State. */
export interface LocalRunControlObserver {
  readonly id: RunControlObserverId
  subscribe(listener: (observation: RunControlObservation) => void): () => void
}

/** One transient, read-only diagnostics fact owned by an external capability. */
export interface RunDiagnosticsObservation {
  readonly observerId: RunDiagnosticsObserverId
  readonly runId: RunId
  readonly observedAt: number
  readonly reasoning?: ReasoningObservation
  readonly context?: ContextPressureObservation
}

/**
 * Replaceable read-only diagnostics seam. Observers cannot change lifecycle,
 * health, retry, cancellation, Session events, or any model request.
 */
export interface LocalRunDiagnosticsObserver {
  readonly id: RunDiagnosticsObserverId
  subscribe(listener: (observation: RunDiagnosticsObservation) => void): () => void
}

/** Durable lifecycle projection plus optional transient activity overlay. */
export interface AgentRunState {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly phase: RunPhase
  readonly health: RunHealth
  readonly startedAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly lastActivityAt: number
  readonly lastMeaningfulActivityAt: number
  readonly lastBackendActivityAt?: number
  readonly provider?: string
  readonly model?: string
  readonly attempt?: AttemptState
  readonly retryCount: number
  readonly maxRetryCount?: number
  readonly retryReason?: RunErrorCode
  readonly cancellation?: CancellationObservation
  readonly currentTool?: { readonly callId: string; readonly name: string }
  readonly reasoning: ReasoningObservation
  readonly context: ContextPressureObservation
  readonly backend: {
    readonly attribution: BackendAttribution
    readonly processHealth: BackendComponentHealth
    readonly modelHealth: BackendComponentHealth
    readonly generationHealth: GenerationHealth
    readonly generationActivity?: GenerationActivityObservation
    readonly prefill?: PrefillObservation
  }
  readonly primaryError?: ClassifiedRunError
  readonly secondaryErrors: readonly ClassifiedRunError[]
}

/** Read-only diagnostic cut: one run plus backend observations that could not be attributed. */
export interface AgentRunDiagnostics {
  readonly run: AgentRunState | null
  readonly staleThresholdMs: number
  readonly unattributedBackendObservations: readonly BackendObservation[]
}

/** Host fold state keeps immutable Session identity beside the nullable latest run. */
export interface AgentRunProjectionState {
  readonly sessionId: SessionId
  readonly run: AgentRunState | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Latest run's durable state; transient backend/stream activity is served by `ctx.agentRunState`. */
    agentRunState: AgentRunState | null
  }

  interface SessionProjectionStateMap {
    agentRunState: AgentRunProjectionState
  }
}
