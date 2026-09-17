/** Public configuration and deterministic timing inputs for Agent Run policy. */

import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { AgentRunState, RunErrorCode } from '@deepseek-ai/dsh-agent-run-state/types'

/** Decision input for one failed model-request attempt. */
export interface RetryDecisionInput {
  readonly failure: LlmFailure
  readonly retryCount: number
  readonly maxRetryCount: number
  readonly signalAborted: boolean
  readonly run: AgentRunState
}

/** Policy result; delegation lets the existing retry executor schedule the retry. */
export interface RetryDecision {
  readonly kind: 'delegate' | 'deny'
  readonly reason: RunErrorCode
}

/** Minimal rearmable clock used by cancellation acknowledgement. */
export interface RunPolicyClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** Non-serializable test hooks. */
export interface RunPolicyInternals {
  readonly clock?: RunPolicyClock
}
