/**
 * Pure task-checkpoint, result-manifest, and repair-hazard contracts restored
 * from the Final Product v1 serialized schema.
 *
 * This module is the type-only outlet: it declares no behavior, imports no
 * runtime module beyond type-only imports, and is safe to consume from any
 * aggregate that only needs the durable value contracts. Event ownership lives
 * in `./domain.ts`; validation lives in `./schema.ts`; folding lives in
 * `./projection.ts`.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ProviderRequestId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { AttemptId, RunId } from './legacy-identity.ts'

export type { AttemptId, RunId }

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

/** Stable source-independent error categories recorded by the Final Product. */
export type RunErrorCode =
  | 'RESOURCE_LIMIT'
  | 'WORKER_CRASH'
  | 'MODEL_LOAD_FAILED'
  | 'INVALID_REASONING_PARAMETER'
  | 'INVALID_MODEL_CONFIG'
  | 'CONTEXT_OVERFLOW'
  | 'GENERATION_STALLED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSPORT'
  | 'TOOL_FAILED'
  | 'STREAM_DISCONNECTED'
  | 'CLIENT_CANCELLED'
  | 'BACKEND_RESTARTED'
  | 'BLOCKED'
  | 'MAX_TOKENS'
  | 'SESSION_INTERRUPTED'
  | 'RETRY_FAILED'
  | 'UNKNOWN'

/** Layer that supplied an error signal; it does not by itself establish fatality. */
export type RunErrorOrigin = 'backend' | 'provider' | 'transport' | 'client' | 'tool' | 'session'

/** One classified Final Product failure retained verbatim inside a checkpoint. */
export interface ClassifiedRunError {
  readonly code: RunErrorCode
  readonly message: string
  readonly severity: 'degraded' | 'fatal'
  readonly origin: RunErrorOrigin
  readonly time: number
  readonly providerRequestId?: ProviderRequestId
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

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    taskCheckpoint: TaskCheckpointProjectionState
    taskResults: ResultManifestProjectionState
  }
  interface SessionProjectionMap {
    /** Durable task progress and crash-repair hazards, kept for later resume orchestration. */
    taskCheckpoint: TaskCheckpointProjection
    /** Durable result manifests, kept separate from task-progress snapshots. */
    taskResults: readonly ResultManifest[]
  }
}
