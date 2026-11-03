/**
 * Task-aware compaction policy for the current upstream.
 *
 * The current source already owns compaction: `BasicCompactionEngine` decides
 * when to compact, selects the range, prices it, calls the model, validates
 * surface stability, and publishes the replacement. Stage 10 does not replace
 * one line of that executor. It mounts one candidate policy the executor may
 * consult, and the policy's whole contribution is to make three things true.
 *
 * **Durable authority survives.** The latest `TaskCheckpoint` is captured as a
 * protection root: task identity, revision, runs, status, executions, step
 * partition, resume context, failure and resume records, every evidence
 * identity, every exact referenced result revision, and every repair hazard.
 * That root is canonically serialized and hashed. The published replacement
 * carries a code-rendered block containing exactly that canonical value, and
 * deterministic validation re-parses the replacement and compares canonical
 * forms — so a reordered list, a duplicated string, or an edited fact all fail
 * rather than pass.
 *
 * **Publication is gated on live authority.** `assertPublishable` is
 * synchronous. It re-reads the projections, rebuilds the protection root, and
 * compares digests in the same uninterrupted block that commits the
 * replacement. A checkpoint revision, result manifest, evidence identity,
 * hazard set, or main-Run reasoning value that moved during summarization stops
 * the publication instead of being papered over by prose.
 *
 * **Nothing here becomes authority.** The policy appends no Session event,
 * writes no projection, creates no lock, retries nothing, and deletes nothing.
 * The protected block is derived from the append-only log, which keeps every
 * original event including the checkpoint and result manifests it was derived
 * from.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  CompactionAssessInput,
  CompactionBeginInput,
  CompactionCandidatePolicy,
  CompactionCandidateView,
  CompactionOwnedRecoveryCause,
  CompactionPolicyAdmission,
  CompactionPolicyAudit,
  CompactionPolicyTransaction,
  CompactionPolicyTrigger,
  CompactionPolicyVerdict,
  CompactionRequestDecoration,
  CompactionRequestDraft,
} from '@deepseek-ai/dsh-compaction'
import { reasoningCapabilityOf } from '@deepseek-ai/dsh-reasoning-policy'
import type { ReasoningCapability } from '@deepseek-ai/dsh-reasoning-policy'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import type { TaskAuthoritySnapshot } from '@deepseek-ai/dsh-task-checkpoint'
import { TaskAwarePolicyError } from './errors.ts'
import { admitTaskAware } from './eligibility.ts'
import type { TaskAwareAdmission, TaskAwareAdmissionBlock } from './eligibility.ts'
import { TaskAwareDiagnosticsStore } from './diagnostics.ts'
import {
  canonicalJson,
  manifestReferenceDigest,
  protectTaskAuthority,
  taskRepairHazards,
} from './protection.ts'
import { resolveAuxiliaryReasoning } from './reasoning.ts'
import {
  renderTaskProtectionBlock,
  taskProtectionContent,
  taskProtectionSupplement,
  usableInputTokens,
} from './context.ts'
import { validateTaskAwareCandidate } from './validation.ts'
import type { TaskCandidateValidationContext } from './validation.ts'
import type {
  TaskAwareCompactionDiagnostics,
  TaskAwareDiagnosticsListener,
  TaskAwareDiagnosticsSource,
  TaskProtection,
  TaskProtectionSnapshot,
} from './types.ts'
import { TASK_AWARE_POLICY_ID, TASK_AWARE_POLICY_VERSION } from './types.ts'

export * from './types.ts'
export { TaskAwarePolicyError, TaskCandidateRejectedError } from './errors.ts'
export {
  canonicalJson,
  manifestReferenceDigest,
  protectTaskAuthority,
  protectionDigest,
  taskRepairHazards,
  unknownOutcomeHazard,
} from './protection.ts'
export { admitTaskAware } from './eligibility.ts'
export type { TaskAwareAdmission, TaskAwareAdmissionBlock, TaskAwareAdmissionInput } from './eligibility.ts'
export {
  parseTaskProtectionBlocks,
  renderTaskProtectionBlock,
  taskProtectionContent,
  taskProtectionSupplement,
  textOfContent,
  usableInputTokens,
} from './context.ts'
export type { ParsedTaskProtectionBlock, ParsedTaskProtectionBlocks } from './context.ts'
export { validateTaskAwareCandidate } from './validation.ts'
export type { TaskCandidateValidationContext } from './validation.ts'
export { AUXILIARY_REASONING_LADDER, resolveAuxiliaryReasoning } from './reasoning.ts'
export type { AuxiliaryReasoningStep } from './reasoning.ts'
export { TaskAwareDiagnosticsStore } from './diagnostics.ts'
export type { TaskAwareDiagnosticsUpdate } from './diagnostics.ts'
export type { TaskAwareDiagnosticsListener, TaskAwareDiagnosticsSource } from './types.ts'

export const name = 'compactionTaskAwarePolicy'

/**
 * The services this policy reads. It resolves the routable route for auxiliary
 * reasoning, prices the protected context through the same meter the executor
 * uses, and reads durable authority through the projection registry.
 */
export const inject = ['sessionProjections', 'taskCheckpoints', 'llm', 'tokenMeter']

/** The main-Run reasoning facts a transaction must prove it did not change. */
interface MainReasoningFingerprint {
  /** The routed request's own reasoning effort, when it named one. */
  readonly requestEffort: string | undefined
  /** The adapter-materialized reasoning marker for that request, when one applied. */
  readonly adapterDefault: boolean | undefined
  /** The protected Task's recorded original-execution reasoning, when known. */
  readonly originalExecution: string | undefined
  /** The protected Task's recorded latest-execution reasoning, when known. */
  readonly latestExecution: string | undefined
}

/**
 * Read the main Run's reasoning facts without mutating anything.
 *
 * The Task's own recorded executions are part of the same fingerprint because
 * they are the durable half of the same claim: the auxiliary request may not
 * become, or cause, a change to what the main Run is recorded as having asked
 * for or resolved.
 */
function mainReasoningFingerprint(
  session: Session,
  protection: TaskProtection | undefined,
): MainReasoningFingerprint {
  const header = session.requestHeader()
  return {
    requestEffort: header?.config.reasoningEffort,
    adapterDefault: header?.adapterDefaults?.reasoningEffort,
    originalExecution: protection?.value.originalExecution.resolvedReasoning,
    latestExecution: protection?.value.latestExecution.resolvedReasoning,
  }
}

/** Whether two fingerprints describe the same main-Run reasoning state. */
function sameMainReasoning(
  left: MainReasoningFingerprint,
  right: MainReasoningFingerprint,
): boolean {
  return left.requestEffort === right.requestEffort
    && left.adapterDefault === right.adapterDefault
    && left.originalExecution === right.originalExecution
    && left.latestExecution === right.latestExecution
}

/** The live transaction one admitted, task-aware compaction runs inside. */
class TaskAwareTransaction implements CompactionPolicyTransaction {
  private candidateAttempts = 0
  private lastReasoning: { requested: string; resolved?: string; source: string } | undefined
  private readonly supplemental: readonly import('@deepseek-ai/dsh-llm').RequestUserInput[]
  private readonly replacement: readonly ContentBlock[]

  /**
   * @param policy - the owning policy, for diagnostics and authority reads.
   * @param session - the Session the transaction belongs to.
   * @param trigger - the entry that opened it.
   * @param snapshot - the protection captured at `begin`.
   * @param usableInput - the resolved usable input budget, when capacity was proven.
   * @param capability - the summarization route's published reasoning capability.
   * @param summarizationTarget - the exact route the executor declared.
   * @param beforeTokens - the surface's priced size at capture.
   * @param mainReasoning - the main Run's reasoning facts at capture.
   */
  constructor(
    private readonly policy: TaskAwareCompactionPolicy,
    private readonly session: Session,
    private readonly trigger: CompactionPolicyTrigger,
    private readonly snapshot: TaskProtectionSnapshot,
    private readonly usableInput: number | undefined,
    private readonly capability: ReasoningCapability | undefined,
    private readonly summarizationTarget: { readonly provider: string; readonly model: string },
    private readonly beforeTokens: number,
    private readonly mainReasoning: MainReasoningFingerprint,
  ) {
    this.supplemental = [taskProtectionSupplement(snapshot.protection)]
    this.replacement = taskProtectionContent(snapshot.protection)
  }

  /** The exact code rendering of the protected block this transaction publishes. */
  get blockText(): string {
    return renderTaskProtectionBlock(this.snapshot.protection)
  }

  /**
   * Name the compaction-only changes for one candidate.
   *
   * The route is re-checked against the one `begin` was told about: a request
   * built for a different route would make every capability proof meaningless,
   * so it fails closed rather than decorating a route nobody priced.
   */
  decorateRequest(draft: CompactionRequestDraft): CompactionRequestDecoration {
    if (draft.provider !== this.summarizationTarget.provider
      || draft.model !== this.summarizationTarget.model) {
      throw new TaskAwarePolicyError(
        'TASK_AUXILIARY_REASONING_UNSUPPORTED',
        `compaction auxiliary request targets ${draft.provider}/${draft.model}, but this transaction priced reasoning for ${this.summarizationTarget.provider}/${this.summarizationTarget.model}`,
      )
    }
    const step = resolveAuxiliaryReasoning(
      draft.provider,
      draft.model,
      this.capability,
      draft.candidateAttempt,
    )
    this.lastReasoning = {
      requested: step.label,
      ...step.resolution.resolved === undefined ? {} : { resolved: step.resolution.resolved },
      source: step.resolution.source,
    }
    this.policy.recordDiagnostics(this.session.id, {
      status: 'summarizing',
      candidateAttempt: draft.candidateAttempt,
      requestedReasoning: step.label,
      ...step.resolution.resolved === undefined ? {} : { resolvedReasoning: step.resolution.resolved },
      reasoningSource: step.resolution.source,
    })
    return {
      ...step.resolution.resolved === undefined
        ? {}
        : { reasoningEffort: step.resolution.resolved },
      supplementalMessages: this.supplemental,
      // The executor appends this to the published replacement verbatim. The
      // model is shown the same facts as background, but never as this block:
      // the block is code-rendered, so `validateCandidate` has exactly one
      // correct answer to compare the replacement against.
      replacementContent: this.replacement,
    }
  }

  /** Judge one candidate deterministically. */
  validateCandidate(candidate: CompactionCandidateView): CompactionPolicyVerdict {
    this.candidateAttempts = Math.max(this.candidateAttempts, candidate.candidateAttempt + 1)
    const validation: TaskCandidateValidationContext = {
      protection: this.snapshot.protection,
      expectedBlockText: this.blockText,
      beforeTokens: this.beforeTokens,
      ...this.usableInput === undefined ? {} : { usableInputTokens: this.usableInput },
      retryAvailable: candidate.candidateAttempt === 0,
    }
    const verdict = validateTaskAwareCandidate(candidate, validation)
    this.policy.recordDiagnostics(this.session.id, {
      status: verdict.kind === 'reject' ? 'failed' : 'validating',
      candidateAttempt: candidate.candidateAttempt,
      validation: verdict.kind,
      ...verdict.kind === 'reject' ? { blockCode: verdict.block.code, error: verdict.block.detail } : {},
    })
    return verdict
  }

  /**
   * Follow the executor's own recovery mutation.
   *
   * Only a task-authority-stable recovery is admitted. The executor's recovery
   * seam is its own (`compaction/summary-error`), and the digest re-check below
   * is what keeps a rebase from becoming a way to accept an unrelated
   * concurrent change: if the recovery moved task authority, this refuses.
   */
  rebaseAfterOwnedRecovery(cause: CompactionOwnedRecoveryCause): void {
    const current = this.policy.captureProtection(this.session)
    if (current.protection.digest !== this.snapshot.protection.digest) {
      throw new TaskAwarePolicyError(
        'TASK_PUBLICATION_GUARD_REJECTED',
        `the executor-owned ${cause} recovery changed protected task authority (${this.snapshot.protection.digest} -> ${current.protection.digest}); refusing to rebase onto moved authority`,
      )
    }
    this.policy.recordDiagnostics(this.session.id, { status: 'summarizing' })
  }

  /**
   * Refuse publication when protected authority moved after acceptance.
   *
   * Synchronous by construction: every read here — the projections, the
   * protection rebuild, the canonical serialization, the digest — is a
   * computation over already-folded state. The executor calls this immediately
   * before it appends the replacement, so no `await` separates the proof from
   * the publication.
   */
  assertPublishable(): void {
    const current = this.policy.captureProtection(this.session)
    const captured = this.snapshot.protection
    const fresh = current.protection
    if (current.task.taskId !== this.snapshot.task.taskId
      || current.task.revision !== this.snapshot.task.revision) {
      throw new TaskAwarePolicyError(
        'TASK_PUBLICATION_GUARD_REJECTED',
        `the protected task moved from revision ${String(this.snapshot.task.revision)} to "${String(current.task.taskId)}" revision ${String(current.task.revision)} during summarization`,
      )
    }
    if (fresh.value.authorityAsOfSeq < captured.value.authorityAsOfSeq) {
      throw new TaskAwarePolicyError(
        'TASK_PUBLICATION_GUARD_REJECTED',
        `the authority cut regressed from seq ${String(captured.value.authorityAsOfSeq)} to ${String(fresh.value.authorityAsOfSeq)} during summarization`,
      )
    }
    if (fresh.digest !== captured.digest) {
      throw new TaskAwarePolicyError(
        'TASK_PUBLICATION_GUARD_REJECTED',
        `protected task authority changed during summarization (${captured.digest} -> ${fresh.digest})`,
      )
    }
    const capturedManifests = manifestReferenceDigest(captured.value.manifestReferences)
    const freshManifests = manifestReferenceDigest(fresh.value.manifestReferences)
    if (capturedManifests !== freshManifests) {
      throw new TaskAwarePolicyError(
        'TASK_PUBLICATION_GUARD_REJECTED',
        `the exact referenced result revision set changed during summarization (${capturedManifests} -> ${freshManifests})`,
      )
    }
    if (canonicalJson(fresh.value.repairHazards) !== canonicalJson(captured.value.repairHazards)) {
      throw new TaskAwarePolicyError(
        'TASK_PUBLICATION_GUARD_REJECTED',
        'the repair hazard set changed during summarization',
      )
    }
    if (!sameMainReasoning(mainReasoningFingerprint(this.session, fresh), this.mainReasoning)) {
      throw new TaskAwarePolicyError(
        'TASK_PUBLICATION_GUARD_REJECTED',
        'the main Run reasoning state changed during auxiliary compaction reasoning',
      )
    }
  }

  /** Report the transaction's audit. The executor calls this once, after a commit. */
  audit(): CompactionPolicyAudit {
    return {
      policyId: TASK_AWARE_POLICY_ID,
      policyVersion: TASK_AWARE_POLICY_VERSION,
      trigger: this.trigger,
      candidateAttempts: this.candidateAttempts,
      authorityAsOfSeq: this.snapshot.asOfSeq,
      protectionHash: this.snapshot.protection.digest,
      ...this.lastReasoning === undefined ? {} : { auxiliaryReasoning: this.lastReasoning },
    }
  }
}

/**
 * The transaction for a Session that tracks no Task.
 *
 * There is no authority to protect, so this policy protects none and asks for
 * no changes: the executor behaves exactly as it does with no policy installed.
 * It still counts candidates, because the audit a reader sees should not depend
 * on whether a Task happened to exist.
 */
class UnprotectedTransaction implements CompactionPolicyTransaction {
  private candidateAttempts = 0

  /**
   * @param trigger - the entry that opened it.
   */
  constructor(private readonly trigger: CompactionPolicyTrigger) {}

  /** Ask for nothing: no reasoning change, no supplement, no replacement content. */
  decorateRequest(): CompactionRequestDecoration {
    return {}
  }

  /** Accept whatever the executor produced; this policy has nothing to prove. */
  validateCandidate(candidate: CompactionCandidateView): CompactionPolicyVerdict {
    this.candidateAttempts = Math.max(this.candidateAttempts, candidate.candidateAttempt + 1)
    return { kind: 'accept' }
  }

  /** Nothing is protected, so no recovery can move it. */
  rebaseAfterOwnedRecovery(): void {}

  /** Nothing is protected, so there is nothing to re-check before publication. */
  assertPublishable(): void {}

  /** Report the transaction as unprotected, which is a fact worth recording. */
  audit(): CompactionPolicyAudit {
    return {
      policyId: TASK_AWARE_POLICY_ID,
      policyVersion: TASK_AWARE_POLICY_VERSION,
      trigger: this.trigger,
      candidateAttempts: this.candidateAttempts,
    }
  }
}

/**
 * Cordis service implementing the optional compaction candidate policy.
 *
 * Mounting it is a deployment decision: the official profile does not, so its
 * compaction behaves exactly as the current upstream does.
 */
export default class TaskAwareCompactionPolicy extends Service implements CompactionCandidatePolicy, TaskAwareDiagnosticsSource {
  /** Service name the executor resolves. */
  static override readonly name = 'compactionCandidatePolicy'

  /** The services and projections this policy reads. */
  static readonly inject = inject

  /** Stable policy identity recorded in every audit. */
  readonly id = TASK_AWARE_POLICY_ID

  /** Policy contract version recorded in every audit. */
  readonly version = TASK_AWARE_POLICY_VERSION

  private readonly diagnosticsStore: TaskAwareDiagnosticsStore

  /**
   * @param ctx - the owning context; its fiber owns the service registration.
   */
  constructor(ctx: Context) {
    super(ctx, 'compactionCandidatePolicy')
    // An observer failure is reported, never rethrown: it belongs to the
    // listener, and a compaction must not fail because a reader of its
    // diagnostics did.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/end') return
      const observation = this.diagnostics(session.id)
      if (observation?.compactionId !== event.data.compactionId) return
      this.recordDiagnostics(session.id, event.data.error === undefined
        ? { status: 'applied' }
        : { status: 'failed', error: 'Compaction transaction did not publish cleanly' })
    })
    this.diagnosticsStore = new TaskAwareDiagnosticsStore((sessionId, error) => {
      ctx.logger.warn(
        `compaction diagnostics observer failed for session ${sessionId}: `
        + (error instanceof Error ? error.message : String(error)),
      )
    })
  }

  /**
   * Read the most recent task-aware observation for one Session.
   * @param sessionId - the Session identity.
   * @returns the transient observation, or `undefined` when none was recorded.
   */
  diagnostics(sessionId: string): TaskAwareCompactionDiagnostics | undefined {
    return this.diagnosticsStore.read(sessionId)
  }

  /**
   * Observe one Session's task-aware observations until the disposer runs.
   *
   * This is the read-only seam a transport binds to. It delivers replacement
   * observations and nothing else: it never triggers a compaction, never
   * records a diagnostic, and delivers no value on registration, so a caller
   * can subscribe and then read with nothing in between.
   * @param sessionId - the Session identity to observe.
   * @param listener - receives each complete replacement, or `undefined` on removal.
   * @returns an idempotent disposer that stops future notifications.
   */
  subscribeDiagnostics(sessionId: string, listener: TaskAwareDiagnosticsListener): () => void {
    return this.diagnosticsStore.subscribe(sessionId, listener)
  }

  /**
   * Merge one diagnostics patch over the Session's current observation.
   * @param sessionId - the Session identity to record against.
   * @param patch - the observation fields to merge over the current ones.
   */
  recordDiagnostics(
    sessionId: string,
    patch: Partial<TaskAwareCompactionDiagnostics>,
  ): void {
    const previous = this.diagnosticsStore.read(sessionId)
    this.diagnosticsStore.write(sessionId, {
      ...previous,
      status: patch.status ?? previous?.status ?? 'idle',
      protectedEvidenceCount: patch.protectedEvidenceCount
        ?? previous?.protectedEvidenceCount
        ?? 0,
      mainRunReasoningUnchanged: patch.mainRunReasoningUnchanged
        ?? previous?.mainRunReasoningUnchanged
        ?? true,
      ...patch,
    })
  }

  /** Read one consistent, detached authority cut for a Session. */
  private authorityOf(session: Session): TaskAuthoritySnapshot {
    return this.ctx.taskCheckpoints.authoritySnapshot(session)
  }

  /**
   * Capture the protection root for a Session, or refuse.
   * @param session - the Session whose authority is captured.
   * @returns the protection and the addressed Task revision.
   * @throws TaskAwarePolicyError when no Task exists or a protected fact cannot be resolved.
   */
  captureProtection(session: Session): TaskProtectionSnapshot {
    const snapshot = this.authorityOf(session)
    const task = snapshot.task
    if (task === undefined) {
      throw new TaskAwarePolicyError(
        'TASK_AUTHORITY_UNAVAILABLE',
        `session "${session.id}" tracks no Task to protect`,
      )
    }
    return { task, protection: protectTaskAuthority(snapshot), asOfSeq: snapshot.asOfSeq }
  }

  /** Price the code-rendered protected block through the executor's own meter. */
  private protectionTokens(protection: TaskProtection): number {
    return this.ctx.tokenMeter.estimateMessage(createUserMessage({
      content: [...taskProtectionContent(protection)],
      source: { kind: 'user' },
    }))
  }

  /** The routed main request's context window, when the route advertises one. */
  private async mainContextWindow(
    session: Session,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const config = session.requestHeader()?.config
    if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
      return undefined
    }
    try {
      const info = await this.ctx.llm.resolveModelInfo(config.provider, config.model, signal)
      return info.context?.contextWindow
    } catch {
      // An unresolvable capacity is not a refusal: it means the policy makes no
      // capacity claim, and the executor's own capacity error stays the owner of
      // that failure mode.
      return undefined
    }
  }

  /**
   * Decide whether one compaction operation may proceed.
   * @param input - the Session, the entry, and already-priced read-only facts.
   * @returns the admission decision.
   */
  async assess(input: CompactionAssessInput): Promise<CompactionPolicyAdmission> {
    let admission: TaskAwareAdmission
    let protection: TaskProtection | undefined
    let protectedTokens = 0
    let contextWindow = input.contextWindow
    try {
      const snapshot = this.authorityOf(input.session)
      if (snapshot.task !== undefined) {
        protection = protectTaskAuthority(snapshot)
        protectedTokens = this.protectionTokens(protection)
        contextWindow ??= await this.mainContextWindow(input.session, input.signal)
      }
      const usable = contextWindow === undefined
        ? undefined
        : usableInputTokens(contextWindow, input.maxTokens)
      admission = admitTaskAware({
        trigger: input.trigger,
        protection,
        hazards: protection === undefined
          ? []
          : taskRepairHazards(snapshot, protection.value.taskId),
        beforeTokens: input.beforeTokens,
        protectedTokens,
        ...usable === undefined ? {} : { usableInputTokens: usable },
      })
    } catch (error: unknown) {
      admission = {
        admitted: false,
        taskAware: false,
        hazards: [],
        block: {
          code: 'TASK_AUTHORITY_UNAVAILABLE',
          detail: error instanceof Error ? error.message : String(error),
        },
      }
    }

    this.recordDiagnostics(input.session.id, {
      status: admission.admitted ? (admission.taskAware ? 'assessing' : 'idle') : 'blocked',
      trigger: input.trigger,
      beforeTokens: input.beforeTokens,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...protection === undefined ? {} : {
        taskId: protection.value.taskId,
        checkpointRevision: protection.value.checkpointRevision,
        authorityAsOfSeq: protection.value.authorityAsOfSeq,
        protectionHash: protection.digest,
        protectedTokens,
        protectedEvidenceCount: protection.value.evidence.length,
        resultManifestRevisions: protection.value.manifestReferences.map(reference => ({
          outputId: reference.outputId,
          revision: reference.revision,
        })),
        repairHazards: protection.value.repairHazards,
      },
      ...admission.admitted ? {} : {
        blockCode: refusalBlock(admission).code,
        error: refusalBlock(admission).detail,
      },
    })

    if (!admission.admitted) return { admitted: false, block: refusalBlock(admission) }
    return { admitted: true }
  }

  /**
   * Open the transaction for an admitted, task-aware compaction.
   * @param input - the admitted operation and its selected span.
   * @returns the live transaction.
   * @throws TaskAwarePolicyError when authority cannot be captured or the route
   *   cannot honor the auxiliary reasoning ladder.
   */
  async begin(input: CompactionBeginInput): Promise<CompactionPolicyTransaction> {
    const lookahead = this.authorityOf(input.session)
    if (lookahead.task === undefined) {
      this.recordDiagnostics(input.session.id, {
        status: 'idle',
        trigger: input.trigger,
        compactionId: input.compactionId,
        shadowedTokens: input.shadowedTokenCount,
      })
      return new UnprotectedTransaction(input.trigger)
    }
    const snapshot = this.captureProtection(input.session)
    const capability = await this.routeCapability(input)
    // Fail closed before any auxiliary model call: the first rung must be
    // advertisable on this exact route, or no truthful request exists.
    resolveAuxiliaryReasoning(
      input.summarizationTarget.provider,
      input.summarizationTarget.model,
      capability,
      0,
    )
    const protectedTokens = this.protectionTokens(snapshot.protection)
    const contextWindow = input.contextWindow
      ?? await this.mainContextWindow(input.session, input.signal)
    const usable = contextWindow === undefined
      ? undefined
      : usableInputTokens(contextWindow, input.maxTokens)
    const hazards = taskRepairHazards(
      this.authorityOf(input.session),
      snapshot.protection.value.taskId,
    )

    this.recordDiagnostics(input.session.id, {
      status: 'summarizing',
      trigger: input.trigger,
      compactionId: input.compactionId,
      taskId: snapshot.protection.value.taskId,
      checkpointRevision: snapshot.task.revision,
      authorityAsOfSeq: snapshot.asOfSeq,
      protectionHash: snapshot.protection.digest,
      protectedTokens,
      protectedEvidenceCount: snapshot.protection.value.evidence.length,
      shadowedTokens: input.shadowedTokenCount,
      repairHazards: hazards,
      ...contextWindow === undefined ? {} : { contextWindow },
    })

    return new TaskAwareTransaction(
      this,
      input.session,
      input.trigger,
      snapshot,
      usable,
      capability,
      input.summarizationTarget,
      input.beforeTokens,
      mainReasoningFingerprint(input.session, snapshot.protection),
    )
  }

  /** The exact route's published reasoning capability, when it advertises one. */
  private async routeCapability(
    input: CompactionBeginInput,
  ): Promise<ReasoningCapability | undefined> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(
        input.summarizationTarget.provider,
        input.summarizationTarget.model,
        input.signal,
      )
      return reasoningCapabilityOf(info)
    } catch {
      return undefined
    }
  }
}

/** The structured refusal an inadmissible assessment carries. */
function refusalBlock(admission: TaskAwareAdmission): TaskAwareAdmissionBlock {
  /* v8 ignore next -- every inadmissible outcome is built with a block */
  return admission.block ?? {
    code: 'TASK_AUTHORITY_UNAVAILABLE',
    detail: 'task-aware compaction refused without a structured reason',
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional task-aware compaction policy, when a deployment mounted one. */
    compactionCandidatePolicy: CompactionCandidatePolicy
  }
}
