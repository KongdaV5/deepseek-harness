/**
 * Read-only diagnostic cut over durable run authority and separate backend
 * evidence.
 *
 * The two dimensions are merged here and nowhere else, and they merge one way:
 * durable run facts are returned unchanged, and observer evidence is added
 * beside them without ever being able to create, advance, or terminate a run.
 * A projection with no durable turn open therefore yields `active: null` and no
 * synthesized object, no matter how much a backend has to say.
 *
 * @module @deepseek-ai/dsh-agent-run-state/diagnostics
 */

import { selectPrimaryError } from './errors.ts'
import type { RankedRunError } from './errors.ts'
import { classifyRunHealth } from './health.ts'
import type { ClassifiedRunError, RunDiagnostics, RunHealthThresholds, RunProjectionState } from './types.ts'
import type { BackendObservation } from './types.ts'

/** Everything a diagnostic cut is computed from. */
export interface RunDiagnosticsInput extends RunHealthThresholds {
  readonly projection: RunProjectionState
  /** The separate backend dimension; an explicit absence is a valid value. */
  readonly observation: BackendObservation
  readonly now: number
  /** Failures the observation layer classified; observer strength at most. */
  readonly observerErrors?: readonly RankedRunError[]
}

/**
 * Build the merged diagnostic cut.
 *
 * The durable run state has already selected its own primary using the full
 * evidence strengths available at fold time, so this merge never re-derives
 * them: it keeps that selection and appends observer diagnostics after it. A
 * first observer timeout therefore cannot displace a durable execution failure,
 * and no later observer update can move the reported result. When no durable
 * turn is open the cut still reports the backend dimension, with health
 * `unknown`, because the absence of a run is not a run state.
 * @param input - projection, backend evidence, elapsed-time thresholds, and observer errors.
 * @returns durable authority plus the separate backend dimension and a merged health verdict.
 */
export function runDiagnostics(input: RunDiagnosticsInput): RunDiagnostics {
  const run = input.projection.active ?? input.projection.terminal
  const observed = selectPrimaryError(input.observerErrors ?? [])
  const primaryError: ClassifiedRunError | undefined = run?.primaryError ?? observed.primaryError

  const health = run === null
    ? 'unknown'
    : classifyRunHealth({
      now: input.now,
      phase: run.phase,
      startedAt: run.startedAt,
      lastMeaningfulActivityAt: run.lastMeaningfulActivityAt,
      activity: input.observation.activity,
      directness: input.observation.directness,
      ...primaryError === undefined ? {} : { primaryError },
      slowAfterMs: input.slowAfterMs,
      stalledAfterMs: input.stalledAfterMs,
    })

  return {
    active: input.projection.active,
    terminal: input.projection.terminal,
    backend: input.observation,
    health,
    ...primaryError === undefined ? {} : { primaryError },
    secondaryErrors: [
      ...run?.secondaryErrors ?? [],
      ...observed.primaryError === undefined ? [] : [observed.primaryError],
      ...observed.secondaryErrors,
    ],
  }
}
