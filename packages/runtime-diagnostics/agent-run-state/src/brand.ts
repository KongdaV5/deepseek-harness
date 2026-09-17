/** Opaque correlation identities owned by the run-state domain. */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One complete user-triggered work unit inside a Session. */
export type RunId = Branded<'RunId'>

/** One actual model request inside a run. */
export type AttemptId = Branded<'AttemptId'>

/** Stable observer registration identity. */
export type BackendObserverId = Branded<'BackendObserverId'>

/** Stable run-control observer registration identity. */
export type RunControlObserverId = Branded<'RunControlObserverId'>

/** Stable registration identity for a read-only run-diagnostics overlay. */
export type RunDiagnosticsObserverId = Branded<'RunDiagnosticsObserverId'>

/**
 * Brand a validated external run-id string.
 * @param value - externally validated run identity.
 * @returns the supplied value with the Run-id brand.
 */
export function RunId(value: string): RunId {
  return brandString<RunId>(value)
}

/**
 * Brand a validated external attempt-id string.
 * @param value - externally validated attempt identity.
 * @returns the supplied value with the Attempt-id brand.
 */
export function AttemptId(value: string): AttemptId {
  return brandString<AttemptId>(value)
}

/**
 * Brand a validated backend-observer id.
 * @param value - externally validated observer identity.
 * @returns the supplied value with the Backend-observer-id brand.
 */
export function BackendObserverId(value: string): BackendObserverId {
  return brandString<BackendObserverId>(value)
}

/**
 * Brand a validated run-control observer id.
 * @param value - externally validated observer identity.
 * @returns the supplied value with the Run-control-observer-id brand.
 */
export function RunControlObserverId(value: string): RunControlObserverId {
  return brandString<RunControlObserverId>(value)
}

/**
 * Brand a validated diagnostics-overlay observer identity.
 * @param value - externally validated observer identity.
 * @returns the supplied value with the diagnostics-observer-id brand.
 */
export function RunDiagnosticsObserverId(value: string): RunDiagnosticsObserverId {
  return brandString<RunDiagnosticsObserverId>(value)
}

/**
 * Deterministically derive the run owned by one positive Session turn.
 * @param sessionId - durable conversation identity.
 * @param turn - positive user-triggered turn number.
 * @returns the stable run identity for that Session turn.
 */
export function runIdFor(sessionId: SessionId, turn: number): RunId {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new TypeError(`run turn must be a positive safe integer, got ${String(turn)}`)
  }
  const raw = String(sessionId)
  return RunId(`run:v1:${raw.length}:${raw}:${turn}`)
}

/**
 * Deterministically derive one request attempt within a run and step.
 * @param runId - complete user-triggered work-unit identity.
 * @param step - positive agent step number.
 * @param ordinal - positive request ordinal within the step.
 * @returns the stable identity for that actual model request.
 */
export function attemptIdFor(runId: RunId, step: number, ordinal: number): AttemptId {
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new TypeError(`attempt step must be a positive safe integer, got ${String(step)}`)
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new TypeError(`attempt ordinal must be a positive safe integer, got ${String(ordinal)}`)
  }
  const raw = String(runId)
  return AttemptId(`attempt:v1:${raw.length}:${raw}:${step}:${ordinal}`)
}
