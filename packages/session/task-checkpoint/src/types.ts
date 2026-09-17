/**
 * Pure task-checkpoint, result-manifest, and resume-safety contracts. Host
 * behavior and Session event ownership live in the package root; this module
 * is safe for projection clients.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AttemptId, ClassifiedRunError, RunId } from '@deepseek-ai/dsh-agent-run-state/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Stable identity for one recoverable task, including runs resumed later. */
export type TaskId = Branded<'TaskId'>

/** Stable identity for one task step. */
export type TaskStepId = Branded<'TaskStepId'>

/** Stable identity for one task-owned deliverable. */
export type TaskOutputId = Branded<'TaskOutputId'>

/** Compare-and-set reference to one exact checkpoint revision. */
export interface TaskCheckpointRef {
  readonly taskId: TaskId
  readonly revision: number
}

/** Durable task lifecycle; it does not imply that a Run is still live. */
export type TaskStatus = 'running' | 'paused' | 'blocked' | 'completed' | 'partial' | 'failed' | 'cancelled'

/** Provider selection recorded for the original or latest task run. */
export interface TaskExecutionMetadata {
  readonly provider: string
  readonly model: string
  readonly backend?: string
  readonly requestedReasoning?: string
  readonly resolvedReasoning?: string
}

/** Whether the latest task run kept or changed the original model. */
export type TaskModelRelation = 'same-model' | 'model-changed'

/** One ordered, independently resumable unit of task work. */
export interface TaskStep {
  readonly id: TaskStepId
  readonly title: string
}

/** Runtime evidence accepted at a safe step-completion boundary. */
export type TaskStepCompletionEvidence =
  | {
    readonly kind: 'tool-result'
    readonly eventSeq: SessionSeq
    readonly callId: string
  }
  | {
    readonly kind: 'result-validation'
    readonly outputId: TaskOutputId
    readonly manifestRevision: number
  }
  | {
    readonly kind: 'runtime-validation'
    readonly validator: string
    readonly reference: string
  }

/** A step advanced by runtime evidence rather than model prose. */
export interface CompletedTaskStep extends TaskStep {
  readonly completedAt: number
  readonly evidence: TaskStepCompletionEvidence
}

/** Minimal structured facts from which a later runtime can build a resume prompt. */
export interface TaskResumeContext {
  readonly objective: string
  readonly constraints: readonly string[]
  readonly decisions: readonly string[]
  readonly criticalContext: readonly string[]
}

/** Auditable size and section selection for one model-visible resume context. */
export interface TaskResumeContextBudget {
  readonly estimatedTokens: number
  readonly maxTokens: number
  readonly includedSections: readonly string[]
  readonly omittedSections: readonly string[]
}

/** Durable fact that an explicit resume was admitted and queued for one new Run. */
export interface TaskResumeRecord {
  readonly requestedAt: number
  readonly runId: RunId
  readonly executionPlan: readonly TaskStepId[]
  readonly context: TaskResumeContextBudget
}

/** Root failure retained without marking the current step complete. */
export interface TaskFailureContext {
  readonly primaryError: ClassifiedRunError
  readonly failedAt: number
  readonly failedAttemptId?: AttemptId
  readonly currentStepId?: TaskStepId
}

/**
 * Complete durable task progress snapshot. Every revision is a whole value;
 * high-frequency token or backend activity never belongs here.
 */
export interface TaskCheckpoint extends TaskCheckpointRef {
  readonly version: 1
  readonly taskType: string
  readonly sessionId: SessionId
  readonly originRunId: RunId
  readonly latestRunId: RunId
  readonly status: TaskStatus
  readonly originalExecution: TaskExecutionMetadata
  readonly latestExecution: TaskExecutionMetadata
  readonly modelRelation: TaskModelRelation
  readonly completedSteps: readonly CompletedTaskStep[]
  readonly currentStep?: TaskStep
  readonly pendingSteps: readonly TaskStep[]
  readonly createdAt: number
  readonly lastSuccessAt?: number
  readonly lastActivityAt: number
  readonly resumeContext: TaskResumeContext
  readonly outputs: readonly TaskOutputId[]
  readonly failureContext?: TaskFailureContext
  readonly latestResume?: TaskResumeRecord
}

/** Repair evidence relevant to one task's next side-effect decision. */
export interface TaskRepairHazard {
  readonly taskId: TaskId
  readonly callId: string
  readonly code: 'TOOL_NOT_STARTED' | 'TOOL_OUTCOME_UNKNOWN'
  readonly eventSeq: SessionSeq
}

/** Compact projected proof that one durable tool result succeeded. */
export interface SuccessfulTaskToolResult {
  readonly eventSeq: SessionSeq
  readonly callId: string
}

/** Internal checkpoint fold state; plain JSON for projection-cache safety. */
export interface TaskCheckpointProjectionState {
  readonly tasks: readonly TaskCheckpoint[]
  readonly latestTaskId?: TaskId
  readonly repairHazards: readonly TaskRepairHazard[]
  readonly successfulToolResults: readonly SuccessfulTaskToolResult[]
  readonly failure: string | null
}

/** Client-facing whole task-checkpoint projection. */
export interface TaskCheckpointProjection {
  readonly tasks: readonly TaskCheckpoint[]
  readonly latestTaskId?: TaskId
  readonly repairHazards: readonly TaskRepairHazard[]
}

/** Result artifact lifecycle, deliberately independent from task progress. */
export type ResultManifestStatus = 'running' | 'partial' | 'completed' | 'failed' | 'cancelled'

/** One deterministic structural or content validation result. */
export interface ResultValidationCheck {
  readonly id: string
  readonly status: 'passed' | 'failed'
  readonly message?: string
}

/** Aggregate validation facts for a result revision. */
export interface ResultValidation {
  readonly status: 'pending' | 'passed' | 'failed'
  readonly checks: readonly ResultValidationCheck[]
}

/** Cryptographic identity of a non-empty published result. */
export interface ResultChecksum {
  readonly algorithm: 'sha256'
  readonly value: string
}

/** Complete durable description of one task output revision. */
export interface ResultManifest {
  readonly version: 1
  readonly outputId: TaskOutputId
  readonly revision: number
  readonly taskId: TaskId
  readonly runId: RunId
  readonly path: string
  readonly status: ResultManifestStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly size?: number
  readonly checksum?: ResultChecksum
  readonly execution: TaskExecutionMetadata
  readonly validation: ResultValidation
}

/** Internal result-manifest fold state; plain JSON for projection-cache safety. */
export interface ResultManifestProjectionState {
  readonly manifests: readonly ResultManifest[]
  readonly failure: string | null
}

/** Finite resume-safety classifications; unknown tool side effects have their own blocking result. */
export type ResumeEligibility =
  | 'SAFE_TO_RESUME'
  | 'NEEDS_VALIDATION'
  | 'BLOCKED_UNKNOWN_SIDE_EFFECT'
  | 'COMPLETED'
  | 'NOT_RESUMABLE'

/** Read-only resume decision and the exact pending work it would admit. */
export interface ResumeDecision {
  readonly eligibility: ResumeEligibility
  readonly reason: string
  readonly pendingSteps: readonly TaskStep[]
  readonly modelRelation: TaskModelRelation
}

/** File-system verification issue found immediately before resume execution. */
export interface TaskOutputVerificationIssue {
  readonly outputId: TaskOutputId
  readonly code: 'MISSING_MANIFEST' | 'MISSING_FILE' | 'SIZE_CHANGED' | 'CHECKSUM_CHANGED' | 'INVALID_MANIFEST_STATE'
  readonly message: string
}

/** Model-visible context prepared without replaying historical reasoning or raw logs. */
export interface MinimalResumeContext {
  readonly text: string
  readonly budget: TaskResumeContextBudget
}

/** Explicit request to continue one Task in the supplied live Agent. */
export interface TaskResumeRequest {
  readonly taskId: TaskId
  readonly maxContextTokens: number
  readonly requestedAt?: number
  /** Optional host-resolved execution facts; provider/model must match the live Agent options. */
  readonly execution?: TaskExecutionMetadata
}

/** Result of an explicit resume request; refusal never queues model work. */
export type TaskResumeExecutionResult =
  | {
    readonly status: 'started'
    readonly taskId: TaskId
    readonly runId: RunId
    readonly checkpointRevision: number
    readonly context: TaskResumeContextBudget
    readonly pendingSteps: readonly TaskStep[]
  }
  | {
    readonly status: 'refused'
    readonly taskId: TaskId
    readonly decision: ResumeDecision
    readonly outputIssues: readonly TaskOutputVerificationIssue[]
    readonly context?: TaskResumeContextBudget
  }

/** Read-only task diagnostics, independent from any UI. */
export interface TaskDiagnostics {
  readonly task?: TaskCheckpoint
  readonly checkpoint?: {
    readonly revision: number
    readonly completedSteps: readonly CompletedTaskStep[]
    readonly currentStep?: TaskStep
    readonly pendingSteps: readonly TaskStep[]
    readonly lastSuccessAt?: number
  }
  readonly resume: ResumeDecision & {
    readonly requested: boolean
    readonly started: boolean
    readonly runId?: RunId
    readonly requestedAt?: number
    readonly startedAt?: number
    readonly contextEstimatedTokens?: number
    readonly contextIncludedSections?: readonly string[]
    readonly contextOmittedSections?: readonly string[]
  }
  readonly outputs: readonly ResultManifest[]
  readonly repairHazards: readonly TaskRepairHazard[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    taskCheckpoint: TaskCheckpointProjectionState
    taskResults: ResultManifestProjectionState
  }
  interface SessionProjectionMap {
    /** Durable task progress and crash-repair hazards for diagnostics and future resume orchestration. */
    taskCheckpoint: TaskCheckpointProjection
    /** Durable result manifests, kept separate from task-progress snapshots. */
    taskResults: readonly ResultManifest[]
  }
}
