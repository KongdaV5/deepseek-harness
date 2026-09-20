/**
 * The `runDetails` projection unit: one read-only cut over facts other stages
 * already own, served through the session-projection seam.
 *
 * The fold is deliberately thin. It accumulates Stage 6 lifecycle facts through
 * that package's own stepwise fold, continues Stage 8's two durable Task folds
 * through *their* own stepwise functions, captures the latest `request/header`
 * and `compaction/summary` policy audit, and derives the cut with Stage 7's pure
 * projection, health classifier, and run identity plus Stage 8's pure
 * guarded-resume decision — so nothing here re-derives a run boundary, a phase,
 * an error code, a run id, a Task revision, or a resume decision.
 *
 * Three properties are load-bearing:
 *
 * - **No invention.** Every field comes from a committed event. Where no source
 *   proves a value, the field is absent or `null`; the backend dimension is
 *   always the `unknown` observation because this read-only path installs no
 *   observer, `unknown` is never rounded to a healthier answer, and an
 *   unreadable Task authority yields no decision instead of a guessed one.
 * - **No side effects.** The fold emits no Session event, calls no observer,
 *   arms no resume, and holds no subscription. An event the unit does not care
 *   about returns the same state reference, so the drive does zero downstream
 *   work.
 * - **No transient persistence.** Compaction progress lives in a process-local
 *   store by design; only the audit a `compaction/summary` committed travels
 *   here, so a status that was never durable is never shown as if it were.
 *
 * @module @deepseek-ai/dsh-run-details/projection
 */

import {
  applyLifecycleFacts,
  emptyLifecycleFacts,
} from '@deepseek-ai/dsh-agent-lifecycle-facts'
import type { LifecycleFacts } from '@deepseek-ai/dsh-agent-lifecycle-facts/types'
import {
  backendObserverId,
  classifyRunHealth,
  projectRuns,
  runIdFor,
  unknownBackendObservation,
} from '@deepseek-ai/dsh-agent-run-state'
import type { RunHealthThresholds } from '@deepseek-ai/dsh-agent-run-state/types'
import { reasoningMetadataFromHeader } from '@deepseek-ai/dsh-reasoning-policy'
import {
  applyResultManifestProjection,
  applyTaskCheckpointProjection,
  decideGuardedResume,
  emptyResultManifestProjection,
  emptyTaskCheckpointProjection,
} from '@deepseek-ai/dsh-task-checkpoint'
import type {
  ResultManifestProjectionState,
  TaskCheckpointProjectionState,
} from '@deepseek-ai/dsh-task-checkpoint'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: pulls the `compaction/summary` variant into SessionEventMap.
import type {} from '@deepseek-ai/dsh-compaction/types'
import { runDetailsStateSchema, runDetailsViewSchema } from './schema.ts'
import type {
  RunCompactionFacts,
  RunDetailsState,
  RunDetailsView,
  RunGuardedResumeFacts,
  RunReasoningFacts,
} from './types.ts'

export { runDetailsStateSchema, runDetailsViewSchema }

/** Identity of the observation seat this surface reports; it names no backend. */
const OBSERVER_ID = backendObserverId('run-details:none')

/**
 * Deployment-shaped elapsed-time thresholds, held here rather than inside the
 * classifier: Stage 7 refuses to own them.
 */
export const RUN_DETAILS_HEALTH_THRESHOLDS: RunHealthThresholds = {
  slowAfterMs: 30_000,
  stalledAfterMs: 120_000,
}

/** Empty fold state for a Session with no events yet. */
const EMPTY_STATE_FOR = (sessionId: SessionId): RunDetailsState => ({
  sessionId,
  lifecycle: emptyLifecycleFacts(),
  task: emptyTaskCheckpointProjection(),
  results: emptyResultManifestProjection(),
  reasoning: null,
  compaction: null,
  cut: { sessionId, hasRun: false },
})

/**
 * Compute Stage 8's guarded-resume decision for the Session's latest Task.
 *
 * The decision itself is Stage 8's: `decideGuardedResume` is called with exactly
 * the readings Stage 8's own `diagnostics()` builds — the latest checkpoint, every
 * durable result manifest, every projected hazard, the projected successful tool
 * results, the Session identity, and the turn boundary — and its answer is only
 * projected to the fields a panel renders. Nothing here arms, records, or
 * adopts a resume, so the value is a report about durable authority, not an
 * action on it.
 *
 * @param input - the folded Task authority, the Session identity, and its turn boundary.
 * @returns the projected decision, or `null` when there is no Task to decide
 * about or the authority did not fold into one consistent cut.
 */
function composeGuardedResume(input: {
  sessionId: SessionId
  task: TaskCheckpointProjectionState
  results: ResultManifestProjectionState
  lastTurn: number
  openRun: boolean
}): RunGuardedResumeFacts | null {
  // A retained fold failure means the log holds a value this build cannot
  // interpret. Stage 8 fails closed on that (`TASK_AUTHORITY_UNAVAILABLE`) and
  // so does this surface: no decision beats a decision over a poisoned cut.
  if (input.task.failure !== null || input.results.failure !== null) return null
  const taskId = input.task.latestTaskId
  if (taskId === undefined) return null
  const checkpoint = input.task.tasks.find(candidate => candidate.taskId === taskId)
  if (checkpoint === undefined) return null
  const decision = decideGuardedResume({
    checkpoint,
    results: input.results.manifests,
    hazards: input.task.repairHazards,
    successfulToolResults: input.task.successfulToolResults,
    sessionId: input.sessionId,
    lastTurn: input.lastTurn,
    openRun: input.openRun,
  })
  return {
    decision: decision.decision,
    reason: decision.reason,
    detail: decision.detail,
    ...decision.taskId === undefined ? {} : { taskId: decision.taskId },
    ...decision.checkpointRevision === undefined ? {} : { checkpointRevision: decision.checkpointRevision },
    pendingStepCount: decision.pendingSteps.length,
    hazardCodes: decision.hazards.map(hazard => hazard.code),
    planStepCount: decision.plan.length,
  }
}

/**
 * Derive the whole cut from the accumulated facts.
 *
 * `now` is the folded event's own timestamp, not a wall-clock read: the
 * classifier's verdict is then a pure function of the log, so a replayed fold
 * reaches the same answer it reached live.
 */
function composeRunDetails(input: {
  sessionId: RunDetailsState['sessionId']
  lifecycle: LifecycleFacts
  task: TaskCheckpointProjectionState
  results: ResultManifestProjectionState
  reasoning: RunReasoningFacts | null
  compaction: RunCompactionFacts | null
  now: number
  thresholds: RunHealthThresholds
}): RunDetailsView {
  const runs = projectRuns(input.sessionId, input.lifecycle)
  // The panel describes the Run in flight, or the last terminal one so an idle
  // session still shows how its last Run ended. An empty log has neither, and
  // that absence is `hasRun: false` — never a Run with null fields.
  const run = runs.active ?? runs.terminal
  if (run === null) return { sessionId: input.sessionId, hasRun: false }
  // No observer is registered on this read-only path, so the observation is a
  // standing fact rather than a reading: it reports as of the Run's own start,
  // because there is no later moment at which a backend was actually observed
  // and a moving clock would fabricate one.
  const backend = unknownBackendObservation(OBSERVER_ID, run.startedAt)
  const health = classifyRunHealth({
    slowAfterMs: input.thresholds.slowAfterMs,
    stalledAfterMs: input.thresholds.stalledAfterMs,
    now: input.now,
    phase: run.phase,
    startedAt: run.startedAt,
    lastMeaningfulActivityAt: run.lastMeaningfulActivityAt,
    activity: backend.activity,
    directness: backend.directness,
    ...run.primaryError === undefined ? {} : { primaryError: run.primaryError },
  })
  // The turn boundary Stage 8's authority reads is `turnBoundary`, which takes
  // `lastTurn` from the last `turn/start` and clears the open marker on
  // `turn/end`. Stage 6's turn facts carry exactly those two facts, so they are
  // read here rather than re-derived: a decision computed over a different
  // boundary would not be the decision Stage 8 computes for this log.
  const lastTurnFact = input.lifecycle.turns.at(-1)
  return {
    sessionId: input.sessionId,
    hasRun: true,
    runId: runIdFor(input.sessionId, run.turn),
    turn: run.turn,
    active: runs.active !== null,
    phase: run.phase,
    health,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    lastActivityAt: run.lastActivityAt,
    ...run.completedAt === undefined ? {} : { completedAt: run.completedAt },
    ...run.terminalReason === undefined ? {} : { terminalReason: run.terminalReason.kind },
    repairClosure: run.repairClosure,
    stepCount: run.stepCount,
    openStep: run.openStep,
    retryCount: run.retryCount,
    ...run.maxRetryCount === undefined ? {} : { maxRetryCount: run.maxRetryCount },
    ...run.retryReason === undefined ? {} : { retryReason: run.retryReason },
    ...run.primaryError === undefined ? {} : { primaryError: run.primaryError },
    secondaryErrors: run.secondaryErrors,
    backend,
    reasoning: input.reasoning,
    compaction: input.compaction,
    guardedResume: composeGuardedResume({
      sessionId: input.sessionId,
      task: input.task,
      results: input.results,
      lastTurn: lastTurnFact?.turn ?? 0,
      openRun: lastTurnFact !== undefined && lastTurnFact.endSeq === undefined,
    }),
  }
}

/**
 * Structural equality over the served cut.
 *
 * The cut carries time-derived health, so a later event can legitimately change
 * it while the Run's own facts stay put. Comparing structurally lets the fold
 * keep the *previous* value's identity when an event reports nothing new, which
 * is what keeps the projection change feed quiet between real changes.
 */
function sameCut(left: RunDetailsView, right: RunDetailsView): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Capture the main-run reasoning facts a committed request header proves.
 * @returns the captured facts, `null` when the header proves no reasoning, or
 * the previous value for any other event.
 */
function captureReasoning(
  previous: RunReasoningFacts | null,
  event: SessionEvent,
): RunReasoningFacts | null {
  if (event.type !== 'request/header') return previous
  const meta = reasoningMetadataFromHeader(event.data.header)
  const requested = meta.requestedReasoning
  const resolved = meta.resolvedReasoning
  if (requested === undefined && resolved === undefined) return previous
  return {
    ...requested === undefined ? {} : { requested },
    ...resolved === undefined ? {} : { resolved },
    // A header that resolves an effort it never records as requested is the
    // adapter's own default, not a caller request.
    adapterMaterialized: requested === undefined,
    atSeq: event.seq,
    at: event.time,
  }
}

/**
 * Capture the durable compaction audit a committed summary proves.
 * @returns the captured facts, or the previous value for any other event.
 */
function captureCompaction(
  previous: RunCompactionFacts | null,
  event: SessionEvent,
): RunCompactionFacts | null {
  if (event.type !== 'compaction/summary') return previous
  const audit = event.data.policyAudit
  if (audit === undefined) return previous
  const auxiliary = audit.auxiliaryReasoning
  return {
    policyId: audit.policyId,
    policyVersion: audit.policyVersion,
    trigger: audit.trigger,
    candidateAttempts: audit.candidateAttempts,
    ...audit.authorityAsOfSeq === undefined ? {} : { authorityAsOfSeq: audit.authorityAsOfSeq },
    ...audit.protectionHash === undefined ? {} : { protectionHash: audit.protectionHash },
    ...auxiliary?.requested === undefined ? {} : { requestedReasoning: auxiliary.requested },
    ...auxiliary?.resolved === undefined ? {} : { resolvedReasoning: auxiliary.resolved },
    ...auxiliary?.source === undefined ? {} : { reasoningSource: auxiliary.source },
    atSeq: event.seq,
    at: event.time,
  }
}

/** The `runDetails` unit's shape: a definition whose client view is always present. */
export type RunDetailsProjection = ProjectionDefinition<'runDetails', RunDetailsState>
  & { wire: NonNullable<ProjectionDefinition<'runDetails', RunDetailsState>['wire']> }

/**
 * Build the `runDetails` unit.
 * @param thresholds - elapsed-time thresholds for the health classifier.
 * @returns the projection definition, registered by its consumer.
 */
export function createRunDetailsProjection(
  thresholds: RunHealthThresholds = RUN_DETAILS_HEALTH_THRESHOLDS,
): RunDetailsProjection {
  return {
    key: 'runDetails',
    // Version 2 added the two Task folds and the guarded-resume decision, so a
    // row written at version 1 is discarded and refolded rather than seeded.
    stateVersion: 2,
    stateSchema: runDetailsStateSchema,
    init: (header: SessionHeader) => EMPTY_STATE_FOR(header.id),
    apply: (state, event) => {
      const lifecycle = applyLifecycleFacts(state.lifecycle, event)
      const task = applyTaskCheckpointProjection(state.task, event)
      const results = applyResultManifestProjection(state.results, event)
      const reasoning = captureReasoning(state.reasoning, event)
      const compaction = captureCompaction(state.compaction, event)
      // The cut is derived on every event, not only on tracked ones: health is
      // elapsed-time derived, so freezing it at the last tracked event would
      // report a Run that has since gone quiet as if it were still current.
      const cut = composeRunDetails({
        sessionId: state.sessionId,
        lifecycle,
        task,
        results,
        reasoning,
        compaction,
        now: event.time,
        thresholds,
      })
      if (sameCut(cut, state.cut)) {
        // Nothing the panel reports changed, so the whole state — and with it
        // the served value's identity — stays put: the drive's identity gate
        // then produces zero downstream work.
        if (lifecycle === state.lifecycle && task === state.task && results === state.results
          && reasoning === state.reasoning && compaction === state.compaction) {
          return state
        }
        return {
          sessionId: state.sessionId,
          lifecycle,
          task,
          results,
          reasoning,
          compaction,
          cut: state.cut,
        }
      }
      return { sessionId: state.sessionId, lifecycle, task, results, reasoning, compaction, cut }
    },
    wire: {
      viewSchema: runDetailsViewSchema,
      // The stored cut is returned by reference, so a fold step that leaves the
      // cut identical keeps the change feed quiet.
      view: state => state.cut,
    },
  } satisfies ProjectionDefinition<'runDetails', RunDetailsState>
}

/** The `runDetails` unit with the default health thresholds. */
export const runDetailsProjectionDefinition = createRunDetailsProjection()

/**
 * Empty fold state for tests and diagnostics.
 * @param sessionId - the Session the fold state belongs to.
 * @returns the state an empty log produces: no lifecycle or Task facts and no Run.
 */
export function emptyRunDetailsState(sessionId: SessionId): RunDetailsState {
  return EMPTY_STATE_FOR(sessionId)
}
