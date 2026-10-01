/**
 * Pure contracts for the Run Details transport: the ONE read-only cut the
 * current client renders, and the fold state that produces it.
 *
 * Two refusals define this module, and both are what let a client render the
 * panel without becoming a second authority:
 *
 * - **It computes nothing of its own.** Every field is a projection of a fact
 *   another stage already owns: Stage 6 lifecycle boundaries, Stage 7 run
 *   identity/phase/health/errors, Stage 8's guarded-resume decision, Stage 9
 *   reasoning metadata, Stage 10 compaction policy audit. A value no source
 *   proves is absent, never defaulted: an unobserved backend stays `unknown`,
 *   an unresolved run phase stays `unknown`, and an unreadable Task authority
 *   yields no decision rather than a guessed one.
 * - **It carries no controls.** The wire value is display-only. There is no
 *   retry, resume, cancel, or compact verb here, and no field a client could
 *   write back through, so the surface cannot mutate the run it describes.
 *
 * The cut is a discriminated union on {@link RunDetailsView.hasRun} because an
 * idle session is not "a run with null fields": there is no Run to describe,
 * and the client hides the panel instead of rendering a `Run: None` placeholder.
 *
 * @module @deepseek-ai/dsh-run-details/types
 */

import type { LifecycleFacts } from '@deepseek-ai/dsh-agent-lifecycle-facts/types'
import type {
  BackendObservation,
  ClassifiedRunError,
  RunErrorCode,
  RunHealth,
  RunId,
  RunPhase,
} from '@deepseek-ai/dsh-agent-run-state/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  GuardedResumeDecisionClass,
  GuardedResumeReason,
  ResultManifestProjectionState,
  TaskCheckpointProjectionState,
  TaskId,
  TaskRepairHazard,
} from '@deepseek-ai/dsh-task-checkpoint/client'

export type { BackendObservation, ClassifiedRunError, RunErrorCode, RunHealth, RunPhase }

/**
 * Reasoning facts for the MAIN run, read from the durable `request/header`.
 *
 * This is deliberately the only place run reasoning appears. A compaction's
 * auxiliary summarization request carries its own reasoning, and mixing the two
 * would let a reader believe the value describes the user's run.
 */
export interface RunReasoningFacts {
  /** The effort the caller asked for; absent when the durable header proves no request. */
  readonly requested?: string
  /** The effort actually carried by the request; absent when none was resolved. */
  readonly resolved?: string
  /**
   * Whether the resolved effort is the adapter's own default rather than a
   * caller request. Derived from Stage 9's header read: a header that resolves
   * without requesting proves the adapter materialized it.
   */
  readonly adapterMaterialized: boolean
  /** Seq of the `request/header` event these facts come from. */
  readonly atSeq: SessionSeq
  /** Epoch milliseconds of that event. */
  readonly at: number
}

/**
 * Durable compaction facts: the Stage 10 policy audit attached to the last
 * `compaction/summary`.
 *
 * Only what the committed event records travels here. In-progress compaction
 * diagnostics live in a process-local store by design, and this wire value is
 * persisted fold state, so a transient status is structurally absent rather
 * than snapshotted and later shown as if it were durable.
 */
export interface RunCompactionFacts {
  readonly policyId: string
  readonly policyVersion: string
  /** Why the compaction ran, verbatim from the audit. */
  readonly trigger: string
  readonly candidateAttempts: number
  /** The authority cut the policy protected, when it protected one. */
  readonly authorityAsOfSeq?: number
  /** The protection digest over that cut, when the policy computed one. */
  readonly protectionHash?: string
  /**
   * Reasoning of the AUXILIARY summarization request — never the main run's.
   * The panel renders these beside, and visually distinct from,
   * {@link RunReasoningFacts}.
   */
  readonly requestedReasoning?: string
  readonly resolvedReasoning?: string
  readonly reasoningSource?: string
  /** Seq of the `compaction/summary` event these facts come from. */
  readonly atSeq: SessionSeq
  /** Epoch milliseconds of that event. */
  readonly at: number
}

/**
 * Stage 8's guarded-resume decision, folded into this cut read-only.
 *
 * The decision is not made here. It is the return value of Stage 8's pure
 * `decideGuardedResume` over the durable Task authority this fold already
 * carries, projected to the fields a panel renders. Because nothing on this
 * path calls `armResume`, `recordAcceptedResume`, or any producer, the value
 * describes a possible continuation and never causes one: it is a diagnostic,
 * not an admission.
 */
export interface RunGuardedResumeFacts {
  /** Stage 8's four semantic classes: allowed, requires_confirmation, blocked, not_applicable. */
  readonly decision: GuardedResumeDecisionClass
  /** The structured reason code the class was reached for, verbatim from Stage 8. */
  readonly reason: GuardedResumeReason
  /** Stage 8's one-sentence explanation, computed from durable facts and never from model prose. */
  readonly detail: string
  /** The Task the decision addressed, when one exists. */
  readonly taskId?: TaskId
  /** The exact checkpoint revision the decision was computed over. */
  readonly checkpointRevision?: number
  /** How many unfinished steps the checkpoint records. */
  readonly pendingStepCount: number
  /**
   * The Task-scoped repair hazard codes behind the decision, in Task order and
   * not de-duplicated. They are carried so a reader can tell "the tool never
   * started" from "the tool's outcome is unknown" even when both classes agree.
   */
  readonly hazardCodes: readonly TaskRepairHazard['code'][]
  /** How many unfinished steps an `allowed` decision would admit; `0` for every other class. */
  readonly planStepCount: number
}

/** The cut when no durable turn has ever been observed; the client hides the panel. */
export interface RunDetailsIdleView {
  readonly sessionId: SessionId
  /** `false`: there is no Run, so no placeholder fields follow. */
  readonly hasRun: false
}

/** The cut for one Run: the active run, or the last terminal one when none is open. */
export interface RunDetailsRunView {
  readonly sessionId: SessionId
  /** `true`: a durable turn exists and every field below is proven by it. */
  readonly hasRun: true
  /** Stage 7's `runIdFor(sessionId, turn)`: never minted here. */
  readonly runId: RunId
  /** The durable upstream turn this Run is. */
  readonly turn: number
  /** `true` while the turn has no durable `turn/end`. */
  readonly active: boolean
  readonly phase: RunPhase
  readonly health: RunHealth
  readonly startedAt: number
  readonly updatedAt: number
  readonly lastActivityAt: number
  readonly completedAt?: number
  /** Discriminant of the durable `turn/end` reason; absent while the run is open. */
  readonly terminalReason?: string
  /** Whether the turn was closed by after-the-fact crash repair. */
  readonly repairClosure: boolean
  readonly stepCount: number
  /** The step left open by the log, or `null` when none is open. */
  readonly openStep: number | null
  readonly retryCount: number
  readonly maxRetryCount?: number
  readonly retryReason?: RunErrorCode
  readonly primaryError?: ClassifiedRunError
  readonly secondaryErrors: readonly ClassifiedRunError[]
  /**
   * Backend evidence, a dimension separate from the run itself. No observer is
   * registered on this read-only path, so every field answers `unknown` — an
   * unobserved backend is never rounded to reachable, idle, or healthy.
   */
  readonly backend: BackendObservation
  /** Main-run reasoning, or `null` before any `request/header`. */
  readonly reasoning: RunReasoningFacts | null
  /** Last durable compaction audit, or `null` when none has been written. */
  readonly compaction: RunCompactionFacts | null
  /**
   * Stage 8's guarded-resume decision over the Session's latest durable Task, or
   * `null` when there is no Task to decide about or its authority could not be
   * read as one consistent cut. `null` is capability absence: the client renders
   * no row instead of an "unknown" decision.
   */
  readonly guardedResume: RunGuardedResumeFacts | null
}

/** The whole client-visible Run Details cut. */
export type RunDetailsView = RunDetailsIdleView | RunDetailsRunView

/**
 * Fold state: the Stage 6 lifecycle facts this fold continues, Stage 8's two
 * durable Task folds, the two non-lifecycle captures, and the derived cut.
 *
 * The cut is stored rather than recomputed on read so the wire value keeps one
 * identity between changes, which is what keeps the projection change feed
 * quiet. It is a shortcut only: a `stateVersion` bump or a schema rejection
 * discards it and the fold replays from the log.
 *
 * The Task folds are continued through Stage 8's own exported step functions,
 * not reimplemented, so this unit reads the very normalization that produced the
 * Task authority rather than a second copy of it. `lastTurn` and `openRun` come
 * from the Stage 6 turn facts the same way upstream's `turnBoundary` unit
 * derives them, so the decision this fold computes is the decision Stage 8
 * computes for the same log.
 */
export interface RunDetailsState {
  readonly sessionId: SessionId
  readonly lifecycle: LifecycleFacts
  readonly task: TaskCheckpointProjectionState
  readonly results: ResultManifestProjectionState
  readonly reasoning: RunReasoningFacts | null
  readonly compaction: RunCompactionFacts | null
  readonly cut: RunDetailsView
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Read-only Run Details fold state (lifecycle and Task facts plus the derived cut). */
    runDetails: RunDetailsState
  }
  interface SessionProjectionMap {
    /** The whole read-only Run Details cut; `hasRun: false` means the client hides the panel. */
    runDetails: RunDetailsView
  }
}
