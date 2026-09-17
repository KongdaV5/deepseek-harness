/** Stable JSON-compatible developer view over merged Agent Run State diagnostics. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentRunDiagnostics, ClassifiedRunError } from './types.ts'

/** Read-only fields emitted by the developer diagnostics command. */
export interface AgentRunDiagnosticsView {
  readonly session_id: string
  readonly run_id: string | null
  readonly attempt_id: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly phase: string
  readonly health: string
  readonly processHealth: string
  readonly modelHealth: string
  readonly generationHealth: string
  readonly lastActivityAt: number | null
  readonly lastMeaningfulActivityAt: number | null
  readonly lastBackendActivityAt: number | null
  readonly staleThresholdMs: number
  readonly retry: {
    readonly current: number
    readonly max: number | null
    readonly reason: string | null
  }
  readonly cancellation: {
    readonly status: 'unknown' | 'requested' | 'confirmed' | 'unconfirmed'
    readonly requestedAt: number | null
    readonly resolvedAt: number | null
  }
  readonly reasoning: {
    readonly requested: string | null
    readonly policySelected: string | null
    readonly resolved: string | null
    readonly wireValue: string | null
    readonly backendDefault: string | null
    readonly source: string | null
    readonly capabilityConfidence: string
  }
  readonly context: {
    readonly contextWindow: number | null
    readonly projectedPromptTokens: number | null
    readonly resumeContextTokens: number | null
    readonly expectedOutputReserve: number | null
    readonly providerSafetyMargin: number | null
    readonly effectivePromptBudget: number | null
    readonly pressureRatio: number | null
    readonly pressureState: string
  }
  readonly prefill: {
    readonly processed: number | null
    readonly total: number | null
    readonly speed: number | null
    readonly source: string
    readonly confidence: string
  } | null
  readonly primaryError: ClassifiedRunError | null
  readonly secondaryErrors: readonly ClassifiedRunError[]
  readonly unattributedBackendObservations: AgentRunDiagnostics['unattributedBackendObservations']
}

/**
 * Convert merged diagnostics into a JSON-compatible developer view with explicit unknown values.
 * @param sessionId - Session identity retained even before the first Run starts.
 * @param diagnostics - detached service snapshot.
 * @returns complete diagnostic fields with unavailable scalar values represented by null or `unknown`.
 */
export function agentRunDiagnosticsView(
  sessionId: SessionId,
  diagnostics: AgentRunDiagnostics,
): AgentRunDiagnosticsView {
  const run = diagnostics.run
  const prefill = run?.backend.prefill
  return {
    session_id: String(sessionId),
    run_id: run === null ? null : String(run.runId),
    attempt_id: run?.attempt === undefined ? null : String(run.attempt.attemptId),
    provider: run?.provider ?? null,
    model: run?.model ?? null,
    phase: run?.phase ?? 'unknown',
    health: run?.health ?? 'unknown',
    processHealth: run?.backend.processHealth ?? 'unknown',
    modelHealth: run?.backend.modelHealth ?? 'unknown',
    generationHealth: run?.backend.generationHealth ?? 'unknown',
    lastActivityAt: run?.lastActivityAt ?? null,
    lastMeaningfulActivityAt: run?.lastMeaningfulActivityAt ?? null,
    lastBackendActivityAt: run?.lastBackendActivityAt ?? null,
    staleThresholdMs: diagnostics.staleThresholdMs,
    retry: {
      current: run?.retryCount ?? 0,
      max: run?.maxRetryCount ?? null,
      reason: run?.retryReason ?? null,
    },
    cancellation: {
      status: run?.cancellation?.status ?? 'unknown',
      requestedAt: run?.cancellation?.requestedAt ?? null,
      resolvedAt: run?.cancellation !== undefined && run.cancellation.status !== 'requested'
        ? run.cancellation.resolvedAt
        : null,
    },
    reasoning: {
      requested: run?.reasoning.requestedReasoning ?? null,
      policySelected: run?.reasoning.policySelected ?? null,
      resolved: run?.reasoning.resolvedReasoning ?? null,
      wireValue: run?.reasoning.wireValue ?? null,
      backendDefault: run?.reasoning.backendDefaultReasoning ?? null,
      source: run?.reasoning.source ?? null,
      capabilityConfidence: run?.reasoning.capabilityConfidence ?? 'unknown',
    },
    context: {
      contextWindow: run?.context.contextWindow ?? null,
      projectedPromptTokens: run?.context.projectedPromptTokens ?? run?.context.projectedTokens ?? null,
      resumeContextTokens: run?.context.resumeContextTokens ?? null,
      expectedOutputReserve: run?.context.expectedOutputReserve ?? null,
      providerSafetyMargin: run?.context.providerSafetyMargin ?? null,
      effectivePromptBudget: run?.context.effectivePromptBudget ?? null,
      pressureRatio: run?.context.pressureRatio ?? null,
      pressureState: run?.context.pressureState ?? 'unknown',
    },
    prefill: prefill === undefined
      ? null
      : {
        processed: prefill.current ?? null,
        total: prefill.total ?? null,
        speed: prefill.speed ?? null,
        source: prefill.source,
        confidence: prefill.confidence,
      },
    primaryError: run?.primaryError ?? null,
    secondaryErrors: run?.secondaryErrors ?? [],
    unattributedBackendObservations: diagnostics.unattributedBackendObservations,
  }
}
