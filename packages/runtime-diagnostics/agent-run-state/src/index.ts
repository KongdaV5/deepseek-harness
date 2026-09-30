/**
 * DS Harness run state: durable run identity, lifecycle, and error diagnostics,
 * with backend observation as a separate dimension.
 *
 * The domain has one authority, the durable upstream Session facts of a single
 * turn, and three refusals that define it:
 *
 * - It invents no run identity. A Run *is* one durable turn, so its id is a pure
 *   function of `(SessionId, turn)` and there is no constructor that could mint
 *   one from a process-local counter or a random value.
 * - It persists no attempt identity. Upstream's `LlmAttemptId` is minted in
 *   memory and repeats after resume, so the run state carries step position and
 *   never an attempt id.
 * - It lets no backend observation become run authority. Observation is a
 *   separate dimension that can neither create a run nor terminate one, and
 *   `Unknown` stays `Unknown` instead of being rounded to `Idle` or `Healthy`.
 *
 * It is a **library**: it registers no Cordis service, mounts no composition
 * entry, emits no Session event, and adds no durable vocabulary. A later stage
 * that needs a live projection cache can register one over these pure functions.
 *
 * @module @deepseek-ai/dsh-agent-run-state
 */

export { backendObserverId, runIdFor } from './brand.ts'
export type { BackendObserverId, RunId } from './brand.ts'
export { runDiagnostics } from './diagnostics.ts'
export type { RunDiagnosticsInput } from './diagnostics.ts'
export {
  classifyRunError,
  clientCancelledError,
  providerErrorCode,
  selectPrimaryError,
} from './errors.ts'
export type { RankedRunError, RunErrorSelection } from './errors.ts'
export { classifyRunHealth } from './health.ts'
export type { HealthClassificationInput } from './health.ts'
export {
  backendObservation,
  observeBackend,
  reachabilityObservation,
  unknownBackendObservation,
} from './observation.ts'
export type { BackendObservationInput } from './observation.ts'
export { isTerminalPhase } from './phase.ts'
export { activeRun, projectRuns, terminalRun } from './projection.ts'
export type * from './types.ts'
