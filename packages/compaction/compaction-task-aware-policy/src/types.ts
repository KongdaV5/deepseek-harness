/**
 * Public vocabulary for the task-aware compaction policy.
 *
 * A *Task* is durable, append-only authority (`task/checkpoint`,
 * `task/result-manifest`) that no model output can regenerate. Compaction is a
 * model-mediated rewrite of the *model-visible* surface. Those two facts make
 * the boundary this module names: compaction may replace model context, but it
 * may never become, restate, or substitute for Task authority, and it may never
 * publish a replacement whose protected facts it cannot prove are still the
 * ones the durable log holds.
 *
 * The types here carry no behavior so a reader — and a later Stage 11 client —
 * can consume the vocabulary without loading the policy.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/types
 */

import type { CompactionPolicyTrigger } from '@deepseek-ai/dsh-compaction'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  CompletedTaskStep,
  ResultManifest,
  TaskCheckpoint,
  TaskExecutionMetadata,
  TaskFailureContext,
  TaskRepairHazard,
  TaskResumeRecord,
  SuccessfulTaskToolResult,
  TaskStep,
} from '@deepseek-ai/dsh-task-checkpoint'

/** Stable identity of this policy, recorded in every audit. */
export const TASK_AWARE_POLICY_ID = 'dsh-compaction-task-aware-policy'

/** Contract version of the protection graph and canonical block. */
export const TASK_AWARE_POLICY_VERSION = '1'

/** The `version` field of the canonical task-compaction block. */
export const TASK_COMPACTION_BLOCK_VERSION = 1

/** The `type` field of the canonical task-compaction block. */
export const TASK_COMPACTION_BLOCK_TYPE = 'task_compaction_context'

/**
 * Sentinel opening the code-rendered authority block.
 *
 * The block is delimited rather than merely present so validation can *parse*
 * it and compare reconstructed facts. Substring presence is never evidence of
 * correctness, because duplicate or reordered values would pass a search.
 */
export const TASK_COMPACTION_BLOCK_OPEN = '[[dsh-task-authority]]'

/** Sentinel closing the code-rendered authority block. */
export const TASK_COMPACTION_BLOCK_CLOSE = '[[/dsh-task-authority]]'

/**
 * Stable machine codes for an admission refusal.
 *
 * Every one of them fails *closed*: the compaction does not proceed, no
 * replacement is published, and the durable Task authority is untouched.
 */
export type TaskAwareBlockCode =
  /** The durable Task projections could not be read as one consistent cut. */
  | 'TASK_AUTHORITY_UNAVAILABLE'
  /** The protected task context alone cannot fit the usable model budget. */
  | 'TASK_PROTECTED_CONTEXT_OVER_CAPACITY'
  /** An unknown external side effect cannot be normalized by a model summary. */
  | 'TASK_REPAIR_HAZARD_OUTCOME_UNKNOWN'
  /** A completed step cites evidence the projection cannot resolve. */
  | 'TASK_CHECKPOINT_EVIDENCE_MISSING'
  /** A protected result revision no longer resolves in the durable manifests. */
  | 'TASK_RESULT_MANIFEST_REVISION_MISSING'
  /** A protected externally owned reference is absent or unresolvable. */
  | 'TASK_EXTERNAL_REFERENCE_UNRESOLVED'
  /** The auxiliary compaction reasoning effort this route offers is unsupported. */
  | 'TASK_AUXILIARY_REASONING_UNSUPPORTED'
  /** The produced candidate failed deterministic task-aware validation. */
  | 'TASK_CANDIDATE_INVALID'
  /** The final synchronous authority guard refused publication. */
  | 'TASK_PUBLICATION_GUARD_REJECTED'

/** Why one candidate failed deterministic task-aware validation. */
export type TaskCandidateRejectionCode =
  /** The authoritative block is absent from the replacement. */
  | 'authoritative-block-missing'
  /** The replacement carries the authoritative block more than once. */
  | 'authoritative-block-duplicated'
  /** The block's `type` or `version` is not the one this build renders. */
  | 'artifact-identity-mismatch'
  /** A protected fact differs from the captured snapshot. */
  | 'protected-facts-mismatch'
  /** The block's `protectionHash` is not the captured digest. */
  | 'protection-hash-mismatch'
  /** The replacement is not smaller than the span it shadows. */
  | 'not-smaller-than-shadowed'
  /** The post-compaction request cannot be proven to fit usable capacity. */
  | 'post-compaction-budget-exceeded'
  /** The model returned a truncated response. */
  | 'summary-truncated'
  /** The model returned non-text output where the summary must be text. */
  | 'summary-non-text'
  /** The narrative claims to replace authoritative task context. */
  | 'authority-claim-in-summary'
  /** The narrative leaked a hidden reasoning transcript. */
  | 'reasoning-transcript-in-summary'

/** One exact protected identity, as captured and as re-read. */
export interface ProtectedReference {
  /** Which durable vocabulary owns the reference. */
  readonly kind: 'tool-result' | 'result-validation' | 'runtime-validation'
  /** The owning step, so a mismatch names the step that lost protection. */
  readonly stepId: string
  /** Exact event seq for a tool-result reference, when that is the identity. */
  readonly eventSeq?: SessionSeq
  /** Exact call id for a tool-result reference, when that is the identity. */
  readonly callId?: string
  /** Exact output id for a result-validation reference, when that is the identity. */
  readonly outputId?: string
  /** Exact manifest revision for a result-validation reference, when that is the identity. */
  readonly manifestRevision?: number
  /** The validator name for a runtime-validation reference, when that is the identity. */
  readonly validator?: string
  /** The opaque external reference a runtime-validation citation retains. */
  readonly reference?: string
}

/** One exact referenced result revision, paired with the facts that may not move. */
export interface ProtectedManifestReference {
  /** The referenced output identity. */
  readonly outputId: string
  /** The exact revision the checkpoint cites. */
  readonly revision: number
  /** The durable lifecycle status at capture time. */
  readonly status: ResultManifest['status']
  /** The validation status at capture time. */
  readonly validation: ResultManifest['validation']['status']
  /** The content checksum at capture time, when the durable value carries one. */
  readonly checksum?: string
}

/**
 * The complete, canonical, JSON-compatible protected fact value.
 *
 * This is the value that is canonically serialized and hashed. Its field names
 * are the durable Task vocabulary's own, so a reader can diff it against a
 * `TaskCheckpoint` without a translation table, and so no *new* authority is
 * introduced by the protected view.
 */
export interface TaskProtectionValue {
  /** Blocker identity of this protection value. */
  readonly type: 'task_protection'
  /** Version of the protection value's own shape. */
  readonly version: number
  /** The protected Task identity. */
  readonly taskId: string
  /** The exact checkpoint revision this protection is rooted at. */
  readonly checkpointRevision: number
  /** The durable task type. */
  readonly taskType: string
  /** The owning Session. */
  readonly sessionId: string
  /** The Run that first owned the Task; immutable. */
  readonly originRunId: string
  /** The Run that last owned the Task. */
  readonly latestRunId: string
  /** The durable task lifecycle status. */
  readonly status: string
  /** The execution recorded for the original run. */
  readonly originalExecution: TaskExecutionMetadata
  /** The execution recorded for the latest run. */
  readonly latestExecution: TaskExecutionMetadata
  /** Whether the latest run kept or changed the original model. */
  readonly modelRelation: string
  /** Completed steps with their exact evidence, in durable order. */
  readonly completedSteps: readonly CompletedTaskStep[]
  /** The step in progress, when the durable value names one. */
  readonly currentStep: TaskStep | null
  /** Pending steps, in durable order. */
  readonly pendingSteps: readonly TaskStep[]
  /** The durable objective. */
  readonly objective: string
  /** The durable constraints, order preserved. */
  readonly constraints: readonly string[]
  /** The durable decisions, order preserved. */
  readonly decisions: readonly string[]
  /** The durable critical context, order preserved; never truncated. */
  readonly criticalContext: readonly string[]
  /** The durable failure context, when the value carries one. */
  readonly failureContext: TaskFailureContext | null
  /** The latest accepted resume record, when the value carries one. */
  readonly resumeRecord: TaskResumeRecord | null
  /** The durable output identities. */
  readonly outputs: readonly string[]
  /** Every protected evidence identity, in durable order. */
  readonly evidence: readonly ProtectedReference[]
  /** Every exact referenced result revision with its protected facts. */
  readonly manifestReferences: readonly ProtectedManifestReference[]
  /** Every repair hazard owned by this Task, in projection order. */
  readonly repairHazards: readonly TaskRepairHazard[]
  /** Every successful tool result the evidence graph may resolve against. */
  readonly successfulToolResults: readonly SuccessfulTaskToolResult[]
  /** The authority cut this protection value was taken at. */
  readonly authorityAsOfSeq: number
}

/** A captured protection root: the canonical value, its serialization, and its digest. */
export interface TaskProtection {
  /** The canonical protected fact value. */
  readonly value: TaskProtectionValue
  /** The deterministic canonical serialization of {@link TaskProtection.value}. */
  readonly canonical: string
  /** The SHA-256 digest of {@link TaskProtection.canonical}, lowercase hex. */
  readonly digest: string
  /** The one-line canonical JSON the code-rendered block embeds. */
  readonly payload: string
}

/** Everything the policy captured at `begin` and must still be able to prove. */
export interface TaskProtectionSnapshot {
  /** The protected Task revision, at capture time. */
  readonly task: TaskCheckpoint
  /** The protection root and its digest. */
  readonly protection: TaskProtection
  /** The authority cut the snapshot was taken at. */
  readonly asOfSeq: SessionSeq
}

/** Read-only, task-aware lifecycle of one compaction attempt. Diagnostics only. */
export interface TaskAwareCompactionDiagnostics {
  /** Where the policy is in its own lifecycle. */
  readonly status: 'idle' | 'assessing' | 'summarizing' | 'validating' | 'applied' | 'blocked' | 'failed'
  /** The durable bracket identity, once one exists. */
  readonly compactionId?: string
  /** The entry that opened the transaction. */
  readonly trigger?: CompactionPolicyTrigger
  /** The protected Task identity. */
  readonly taskId?: string
  /** The exact protected checkpoint revision. */
  readonly checkpointRevision?: number
  /** The authority cut the protection was taken at. */
  readonly authorityAsOfSeq?: number
  /** The protection digest. */
  readonly protectionHash?: string
  /** The exact referenced result revisions. */
  readonly resultManifestRevisions?: readonly { readonly outputId: string; readonly revision: number }[]
  /** How many evidence identities the protection graph carries. */
  readonly protectedEvidenceCount: number
  /** The repair hazards owned by the protected Task. */
  readonly repairHazards?: readonly TaskRepairHazard[]
  /** The routed model's usable context window, when one was resolved. */
  readonly contextWindow?: number
  /** Priced size of the code-rendered protected context. */
  readonly protectedTokens?: number
  /** Priced size of the surface before the transaction. */
  readonly beforeTokens?: number
  /** Priced size of the surface after an applied replacement. */
  readonly afterTokens?: number
  /** Priced size of the span the replacement shadows. */
  readonly shadowedTokens?: number
  /** Zero-based ordinal of the candidate the status refers to. */
  readonly candidateAttempt?: number
  /** The auxiliary effort the compaction request asked for. */
  readonly requestedReasoning?: string
  /** The effort the route resolved for that request. */
  readonly resolvedReasoning?: string
  /** Which of request, provider default, or omission produced it. */
  readonly reasoningSource?: string
  /** The validation outcome for the last candidate. */
  readonly validation?: string
  /** The structured block code when {@link TaskAwareCompactionDiagnostics.status} is `blocked`. */
  readonly blockCode?: string
  /** The failure message when {@link TaskAwareCompactionDiagnostics.status} is `failed`. */
  readonly error?: string
  /**
   * Whether the main Run's reasoning state was observed unchanged.
   *
   * Auxiliary compaction reasoning is isolated from the main Run; this field is
   * the read-only proof a Stage 11 client can display, not a mutation.
   */
  readonly mainRunReasoningUnchanged: boolean
}

/** A protected Task revision paired with the session it was read from. */
export interface ResolvedTaskProtection {
  /** The protected checkpoint. */
  readonly task: TaskCheckpoint
  /** The manifest revisions the checkpoint's evidence depends on. */
  readonly manifests: readonly ResultManifest[]
}

/**
 * One observer of a Session's latest transient compaction diagnostics.
 *
 * The listener is called with the *complete* replacement observation, or with
 * `undefined` when the Session no longer holds one (a `clear`, or the Session
 * being evicted). It is an observer and never a participant: it is notified
 * after the owner has already committed, and a listener that throws is reported
 * and dropped rather than allowed to fail the write or the compaction.
 */
export type TaskAwareDiagnosticsListener = (
  diagnostics: TaskAwareCompactionDiagnostics | undefined,
) => void

/**
 * The read-only observation surface Stage 11 transports.
 *
 * This is the whole seam a transport may bind to: it can read the current
 * observation and observe replacements, and it can do nothing else. It exposes
 * no compaction verb, no phase authority, and no writer, so a transport built on
 * it cannot become a second owner of transient state.
 */
export interface TaskAwareDiagnosticsSource {
  /**
   * Read the most recent observation for one Session.
   * @param sessionId - the Session identity.
   * @returns the observation, or `undefined` when the policy has not run for it.
   */
  diagnostics(sessionId: string): TaskAwareCompactionDiagnostics | undefined
  /**
   * Observe one Session's observations until the returned disposer is called.
   * @param sessionId - the Session identity to observe.
   * @param listener - receives each complete replacement, or `undefined` on removal.
   * @returns an idempotent disposer that stops future notifications.
   */
  subscribeDiagnostics(sessionId: string, listener: TaskAwareDiagnosticsListener): () => void
}
