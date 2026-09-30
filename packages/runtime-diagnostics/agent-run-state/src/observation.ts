/**
 * Backend-neutral observation helpers.
 *
 * This module ships no provider adapter, because current upstream exposes no
 * health or status seam to read: the only reachability-adjacent call in the tree
 * is the configuration surface's user-triggered model-listing fetch, which needs
 * a draft route and credentials and is not a diagnostics cadence. Rather than
 * invent a probe, the contract below states what a deployment *may* report, and
 * every helper here can only produce a truthful value.
 *
 * @module @deepseek-ai/dsh-agent-run-state/observation
 */

import type {
  BackendActivity,
  BackendEvidenceSource,
  BackendObservation,
  BackendReachability,
  EvidenceDirectness,
  LocalBackendObserver,
} from './types.ts'
import type { BackendObserverId } from './brand.ts'

/** Fields a caller must supply to construct one validated observation. */
export interface BackendObservationInput {
  readonly observerId: BackendObserverId
  readonly observedAt: number
  readonly source: BackendEvidenceSource
  readonly directness: EvidenceDirectness
  readonly reachability: BackendReachability
  readonly activity: BackendActivity
}

/**
 * Build one observation, rejecting a combination that would overstate evidence.
 *
 * Two combinations are refused because each one asserts something the evidence
 * cannot support: an unavailable observation carrying values, and activity
 * reported for a backend that is unreachable.
 * @param input - the observation fields to validate.
 * @returns the validated observation.
 */
export function backendObservation(input: BackendObservationInput): BackendObservation {
  if (input.directness === 'unavailable'
    && (input.source !== 'none' || input.reachability !== 'unknown' || input.activity !== 'unknown')) {
    throw new TypeError('an unavailable observation must report no source, unknown reachability, and unknown activity')
  }
  if (input.reachability === 'unreachable' && input.activity !== 'unknown') {
    throw new TypeError('an unreachable backend cannot report observed activity')
  }
  return {
    observerId: input.observerId,
    observedAt: input.observedAt,
    source: input.source,
    directness: input.directness,
    reachability: input.reachability,
    activity: input.activity,
  }
}

/**
 * The truthful fallback when nothing could be observed.
 *
 * This is the answer for a deployment with no observer, and for an observer call
 * that failed. It never maps absence onto `reachable`, `idle`, or any health
 * verdict.
 * @param observerId - the observer that could not report, or the placeholder for none.
 * @param observedAt - when the absence was established.
 * @returns an explicitly unavailable observation.
 */
export function unknownBackendObservation(observerId: BackendObserverId, observedAt: number): BackendObservation {
  return backendObservation({
    observerId,
    observedAt,
    source: 'none',
    directness: 'unavailable',
    reachability: 'unknown',
    activity: 'unknown',
  })
}

/**
 * Report endpoint reachability and nothing more.
 *
 * This is the expected valid result for a local OpenAI-compatible server: the
 * endpoint answering proves reachability, and a GGUF server that exposes no
 * structured progress attribution leaves activity `unknown`. That is a complete
 * answer, not a degraded one.
 * @param observerId - the observer reporting reachability.
 * @param observedAt - when reachability was established.
 * @param reachability - the observed reachability.
 * @returns a direct reachability observation whose activity stays unknown.
 */
export function reachabilityObservation(
  observerId: BackendObserverId,
  observedAt: number,
  reachability: BackendReachability,
): BackendObservation {
  return backendObservation({
    observerId,
    observedAt,
    source: 'endpoint',
    directness: 'direct',
    reachability,
    activity: 'unknown',
  })
}

/**
 * Read one observer without letting its failure become a backend state.
 *
 * A thrown error is reported as an unavailable observation rather than being
 * converted into `unreachable`, `idle`, or a fatal condition: the observer
 * failing and the backend failing are different facts. An observation whose
 * identity does not match the observer that produced it is a programming error
 * and fails loudly.
 * @param observer - the observer to read.
 * @param observedAt - the timestamp to stamp on the result.
 * @returns the observer's evidence, or an unavailable observation if it failed.
 */
export function observeBackend(observer: LocalBackendObserver, observedAt: number): BackendObservation {
  let observed: BackendObservation
  try {
    observed = observer.observe()
  } catch {
    return unknownBackendObservation(observer.id, observedAt)
  }
  if (observed.observerId !== observer.id) {
    throw new Error('agent-run-state: backend observation identity does not match its registered observer')
  }
  return observed
}
