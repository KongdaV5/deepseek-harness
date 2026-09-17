/** Pure health classification over explicit activity and component evidence. */

import type {
  BackendComponentHealth,
  ClassifiedRunError,
  GenerationHealth,
  RunHealth,
  RunPhase,
} from './types.ts'

/** Tunable thresholds supplied by deployment configuration, never hidden in the classifier. */
export interface HealthThresholds {
  readonly slowAfterMs: number
  readonly stalledAfterMs: number
}

/** Complete classifier input. Missing timestamps or component facts remain unknown. */
export interface HealthClassificationInput extends HealthThresholds {
  readonly now: number
  readonly phase: RunPhase
  readonly startedAt: number
  readonly lastMeaningfulActivityAt?: number
  readonly processHealth: BackendComponentHealth
  readonly modelHealth: BackendComponentHealth
  readonly generationHealth: GenerationHealth
  readonly primaryError?: ClassifiedRunError
}

const ACTIVE_PHASES: ReadonlySet<RunPhase> = new Set([
  'starting', 'preparing_context', 'prefill', 'reasoning', 'generating', 'tool_wait', 'waiting_retry', 'compacting',
])

function assertThreshold(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`)
  }
}

/**
 * Classify health with component evidence taking precedence over elapsed time.
 * A healthy HTTP process cannot mask a fatal generation worker, and a
 * continuously advancing prefill refreshes activity so it never stalls.
 * @param input - explicit thresholds, activity, phase, and component evidence.
 * @returns the overall health classification without triggering intervention.
 */
export function classifyRunHealth(input: HealthClassificationInput): RunHealth {
  assertThreshold('slowAfterMs', input.slowAfterMs)
  assertThreshold('stalledAfterMs', input.stalledAfterMs)
  if (input.stalledAfterMs <= input.slowAfterMs) {
    throw new TypeError('stalledAfterMs must be greater than slowAfterMs')
  }
  if (input.primaryError?.severity === 'fatal'
    || input.processHealth === 'fatal'
    || input.modelHealth === 'fatal'
    || input.generationHealth === 'fatal') return 'fatal'
  if (input.generationHealth === 'stalled') return 'stalled'
  if (input.processHealth === 'degraded'
    || input.modelHealth === 'degraded'
    || input.generationHealth === 'degraded'
    || input.primaryError?.severity === 'degraded') return 'degraded'
  if (input.phase === 'completed') return 'healthy'
  if (input.phase === 'cancelled' || input.phase === 'failed') return 'degraded'
  if (!ACTIVE_PHASES.has(input.phase)) return 'unknown'
  if (input.lastMeaningfulActivityAt === undefined) return 'unknown'

  const idleFor = Math.max(0, input.now - input.lastMeaningfulActivityAt)
  if (idleFor > input.stalledAfterMs) return 'stalled'
  if (Math.max(0, input.now - input.startedAt) >= input.slowAfterMs) return 'slow'
  if (input.generationHealth === 'active'
    || input.processHealth === 'healthy'
    || input.modelHealth === 'healthy') return 'healthy'
  return 'unknown'
}
