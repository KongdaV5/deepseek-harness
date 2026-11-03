/**
 * Phase vocabulary helpers.
 *
 * Terminality is a property of the phase set alone, so it lives in one place
 * instead of being re-derived by each consumer that needs to know whether a run
 * may still advance.
 *
 * @module @deepseek-ai/dsh-agent-run-state/phase
 */

import type { RunPhase, TerminalRunPhase } from './types.ts'

/** The phases a Run can never leave. */
const TERMINAL: ReadonlySet<RunPhase> = new Set<RunPhase>(['completed', 'cancelled', 'failed'])

/**
 * Whether one phase is terminal.
 * @param phase - the phase to test.
 * @returns whether a run in this phase can no longer advance.
 */
export function isTerminalPhase(phase: RunPhase): phase is TerminalRunPhase {
  return TERMINAL.has(phase)
}
