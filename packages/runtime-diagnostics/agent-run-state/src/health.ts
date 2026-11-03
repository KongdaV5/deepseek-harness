/**
 * Pure health classification over explicit evidence and elapsed time.
 *
 * Health answers a narrower question than the durable run state: how is the
 * current execution doing, given what was actually observed? Two rules keep it
 * truthful. Component evidence outranks elapsed time, so a live activity signal
 * cannot be called stalled while it is still advancing. And reachability alone
 * never produces `healthy`: that an endpoint answers says nothing about whether
 * work is progressing, so `active` activity is required for a positive verdict
 * and everything else stays `unknown`.
 *
 * @module @deepseek-ai/dsh-agent-run-state/health
 */

import { isTerminalPhase } from './phase.ts'
import type {
  BackendActivity,
  ClassifiedRunError,
  EvidenceDirectness,
  RunHealth,
  RunHealthThresholds,
  RunPhase,
} from './types.ts'

/**
 * Complete health-classifier input. Absent evidence is expressed, never assumed.
 *
 * Reachability is deliberately absent. Whether an endpoint answers is a separate
 * diagnostic dimension, so it is reported beside health rather than folded into
 * it: an unreachable backend is not a degraded run, and a reachable one is not a
 * healthy run.
 */
export interface HealthClassificationInput extends RunHealthThresholds {
  readonly now: number
  readonly phase: RunPhase
  readonly startedAt: number
  readonly lastMeaningfulActivityAt: number
  readonly activity: BackendActivity
  readonly directness: EvidenceDirectness
  readonly primaryError?: ClassifiedRunError
}

function assertThreshold(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`)
  }
}

/**
 * Classify run health without triggering any intervention.
 *
 * `unknown` is returned whenever the evidence does not support a verdict, which
 * is the common and correct answer for a backend that exposes no activity
 * signal. A stalled classification is never fatal: an unseen progress metric is
 * not proof that execution cannot continue.
 * @param input - thresholds, phase, elapsed-time facts, and separate backend evidence.
 * @returns the overall health classification.
 */
export function classifyRunHealth(input: HealthClassificationInput): RunHealth {
  assertThreshold('slowAfterMs', input.slowAfterMs)
  assertThreshold('stalledAfterMs', input.stalledAfterMs)
  if (input.stalledAfterMs <= input.slowAfterMs) {
    throw new TypeError('stalledAfterMs must be greater than slowAfterMs')
  }
  // Structured fatal evidence is the only path to `fatal`.
  if (input.primaryError?.severity === 'fatal') return 'fatal'
  if (isTerminalPhase(input.phase)) return input.phase === 'completed' ? 'healthy' : 'degraded'
  if (input.primaryError !== undefined) return 'degraded'
  if (input.phase === 'unknown') return 'unknown'

  const idleFor = Math.max(0, input.now - input.lastMeaningfulActivityAt)
  if (idleFor > input.stalledAfterMs) return 'stalled'
  // A directly observed active backend is positive evidence, so it outranks a
  // conclusion drawn only from how long the run has been alive. Reachability is
  // still never enough: only `active` activity supports `healthy`.
  if (input.directness === 'direct' && input.activity === 'active') return 'healthy'
  // This is the negative case: the run is old and nothing observed says it is
  // making progress, which is worth reporting but is not a liveness verdict.
  if (Math.max(0, input.now - input.startedAt) >= input.slowAfterMs) return 'slow'
  return 'unknown'
}
