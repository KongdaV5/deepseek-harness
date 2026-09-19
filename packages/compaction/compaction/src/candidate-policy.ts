/**
 * Generic candidate-policy seam for compaction backends.
 *
 * A compaction backend stays the sole executor: it decides *when* to compact,
 * selects the range, prices it, calls the model, and publishes the
 * replacement. This module adds one optional capability a backend may consult
 * — a *candidate policy* — and nothing else. The seam is deliberately small
 * because every method it exposes is a place a policy could otherwise acquire
 * power it must not have:
 *
 * - `assess` runs before any destructive model-context operation, so a policy
 *   can refuse an admission without the backend having already pruned or
 *   truncated anything.
 * - `decorateRequest` can only name an auxiliary reasoning effort and append
 *   supplemental messages. It cannot redirect the provider, the model, the
 *   session, the purpose, the tools, the generation cap, the cancellation
 *   signal, or the replayed source messages, because the returned value has no
 *   field for any of them.
 * - `validateCandidate` is deterministic and may accept, ask for one further
 *   candidate, or reject.
 * - `rebaseAfterOwnedRecovery` exists so a policy can follow the backend's own
 *   recovery mutation; it is never a channel for accepting an unrelated
 *   concurrent change.
 * - `assertPublishable` is **synchronous by type**. It runs after the backend's
 *   own stability validation and immediately before the publication, so a
 *   policy can re-read live authority in the same uninterrupted block that
 *   publishes, instead of racing an `await`.
 * - `audit` reports; it is not authority.
 *
 * A policy never publishes, never writes a Session event, and never retries.
 * The [`CompactionCandidatePolicy`] contract expresses that by omission: there
 * is no method that could do any of them.
 *
 * @module @deepseek-ai/dsh-compaction/candidate-policy
 */

import type { ContentBlock, Message, ReasoningEffortId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { CompactionId } from './brand.ts'
import type { CompactionTrigger } from './index.ts'

/**
 * Which compaction entry opened this transaction.
 *
 * `pressure` and `context-overflow` are the backend's automatic triggers;
 * `manual` is an explicit human request. A policy that restricts *automatic*
 * recovery can distinguish them, and nothing else changes.
 */
export type CompactionPolicyTrigger = CompactionTrigger | 'manual'

/** One structured reason a policy refused to let work continue. */
export interface CompactionPolicyBlock {
  /** Stable machine code a caller can route on. */
  readonly code: string
  /** Finer deterministic rule that produced this block, when the policy names one. */
  readonly reason?: string | undefined
  /** Human-readable detail; never parsed. */
  readonly detail: string
}

/** Whether a policy admits the operation, and why not when it does not. */
export type CompactionPolicyAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly block: CompactionPolicyBlock }

/** Everything `assess` may read. All of it is already-priced, read-only state. */
export interface CompactionAssessInput {
  /** The session whose model-visible surface would be compacted. */
  readonly session: Session
  /** The entry that is asking. */
  readonly trigger: CompactionPolicyTrigger
  /** Priced total of the current model-visible surface. */
  readonly beforeTokens: number
  /**
   * The routed model's usable context window, when the backend resolved one.
   * Absent for a trigger whose backend does not price capacity up front.
   */
  readonly contextWindow?: number
  /** The generation cap the summarization request would carry. */
  readonly maxTokens: number
  /** Cancellation for the operation this admission is part of. */
  readonly signal?: AbortSignal
}

/** Everything `begin` may read, all of it after the durable bracket opened. */
export interface CompactionBeginInput extends CompactionAssessInput {
  /** The durable bracket identity already committed by the backend. */
  readonly compactionId: CompactionId
  /** Inclusive first surface-node seq of the selected span. */
  readonly start: SessionSeq
  /** Inclusive last surface-node seq of the selected span. */
  readonly end: SessionSeq
  /** The selected surface nodes, in surface order. */
  readonly shadowedSeqs: readonly SessionSeq[]
  /** Priced size of the selected span. */
  readonly shadowedTokenCount: number
  /**
   * The exact provider/model route the backend will summarize on, already
   * resolved by the backend's own target policy. A policy prices auxiliary
   * reasoning against this route and never re-derives it.
   */
  readonly summarizationTarget: { readonly provider: string; readonly model: string }
}

/** The auxiliary request the backend has already decided to send. */
export interface CompactionRequestDraft {
  /** Provider of the resolved summarization route. */
  readonly provider: string
  /** Model of the resolved summarization route. */
  readonly model: string
  /** The replayed conversation prefix, in surface order. */
  readonly messages: readonly Message[]
  /** Tool schemas reused for prefix-cache alignment, when the request carried any. */
  readonly tools?: readonly ToolSchema[]
  /** The generation cap this request carries. */
  readonly maxTokens: number
  /** The session the request is attributed to. */
  readonly sessionId: string
  /** Zero-based ordinal of the candidate this draft belongs to. */
  readonly candidateAttempt: number
}

/**
 * The only changes a policy may make to an auxiliary request or to the
 * replacement the backend publishes.
 *
 * There is intentionally no field for provider, model, `sessionId`, purpose,
 * tools, `maxTokens`, cancellation, or the replayed messages: a policy that
 * wanted to change one of them would have to change this type first.
 */
export interface CompactionRequestDecoration {
  /** Explicit compaction-only reasoning request, already proven supported. */
  readonly reasoningEffort?: ReasoningEffortId
  /**
   * Supplemental messages to insert immediately before the backend's fixed
   * final instruction, so the cacheable conversation prefix stays intact.
   */
  readonly supplementalMessages?: readonly Message[]
  /**
   * Content the backend appends verbatim to the published replacement, after
   * the model's narrative and inside the same replacement message.
   *
   * A policy that must survive its own compaction has no other channel: the
   * replacement is the only durable surface the backend writes, and
   * {@link CompactionPolicyTransaction.validateCandidate} is the only proof the
   * backend asks for. Content named here is code-authored by construction — it
   * is never model output — which is what makes that proof meaningful.
   */
  readonly replacementContent?: readonly ContentBlock[]
}

/**
 * The refusal a backend raises when an installed policy declines work.
 *
 * It carries the policy's own structured block so a caller can route on the
 * refusal without depending on the policy implementation, and it is raised both
 * for an inadmissible assessment and for a candidate the policy would not
 * accept. A backend never interprets the block; it only reports it.
 */
export class CompactionPolicyRejectionError extends Error {
  override readonly name = 'CompactionPolicyRejectionError'

  /**
   * @param policyId - stable identity of the refusing policy.
   * @param block - the policy's structured refusal reason.
   */
  constructor(
    readonly policyId: string,
    readonly block: CompactionPolicyBlock,
  ) {
    super(`compaction policy "${policyId}" refused the operation (${block.code}): ${block.detail}`)
  }
}

/** One candidate the backend produced, as a policy sees it. */
export interface CompactionCandidateView {
  /** The model's text-only summary blocks, before framing. */
  readonly summary: readonly ContentBlock[]
  /** Everything the model returned, before the text-only projection. */
  readonly rawOutput: readonly ContentBlock[]
  /** Whether the provider ended the candidate at its generation cap. */
  readonly truncated: boolean
  /** The framed replacement content the backend would publish. */
  readonly checkpointContent: readonly ContentBlock[]
  /** Priced size of the framed replacement. */
  readonly framedTokenCount: number
  /** Priced size of the span the replacement shadows. */
  readonly shadowedRouteTokenCount: number
  /** Zero-based ordinal of this candidate within the transaction. */
  readonly candidateAttempt: number
}

/** A policy's verdict on one candidate. */
export type CompactionPolicyVerdict =
  | { readonly kind: 'accept' }
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'reject'; readonly block: CompactionPolicyBlock }

/** The backend's own recovery mutation a policy may follow. */
export type CompactionOwnedRecoveryCause = 'summary-error-recovery'

/** Structured, optional policy audit attached to a committed compaction. */
export interface CompactionPolicyAudit {
  /** Stable policy identity. */
  readonly policyId: string
  /** Policy contract version. */
  readonly policyVersion: string
  /** The entry that opened the transaction. */
  readonly trigger: CompactionPolicyTrigger
  /** How many candidate calls were made. */
  readonly candidateAttempts: number
  /**
   * The authority cut the policy protected, when it protects authority at all.
   * Present so a reader can reconstruct the protected snapshot without the
   * policy's own process-local state.
   */
  readonly authorityAsOfSeq?: number
  /** The protection digest over that cut, when a policy computes one. */
  readonly protectionHash?: string
  /** The auxiliary reasoning actually requested and resolved for the last candidate. */
  readonly auxiliaryReasoning?: {
    readonly requested?: string
    readonly resolved?: string
    readonly source?: string
  }
  /**
   * The supplemental messages actually inserted, so the auxiliary request can
   * be reconstructed exactly rather than inferred from a digest.
   */
  readonly supplementalMessages?: readonly Message[]
}

/**
 * One live compaction transaction.
 *
 * The backend calls {@link CompactionPolicyTransaction.decorateRequest} once per
 * candidate, {@link CompactionPolicyTransaction.validateCandidate} once per
 * produced candidate, {@link CompactionPolicyTransaction.rebaseAfterOwnedRecovery}
 * only when its own recovery mutated the source, and
 * {@link CompactionPolicyTransaction.assertPublishable} exactly once, immediately
 * before publication.
 */
export interface CompactionPolicyTransaction {
  /**
   * Name the compaction-only request changes for one candidate.
   * @param draft - the request the backend is about to send.
   * @returns the two permitted changes, or an empty decoration.
   * @throws when the policy cannot legally decorate this request (for example an
   *   auxiliary effort the route does not advertise), which fails the compaction
   *   closed instead of sending an unsupported wire value.
   */
  decorateRequest(draft: CompactionRequestDraft): CompactionRequestDecoration
  /**
   * Judge one produced candidate. Deterministic and synchronous.
   * @param candidate - the candidate and its priced facts.
   * @returns accept, one permitted further candidate, or a rejection.
   */
  validateCandidate(candidate: CompactionCandidateView): CompactionPolicyVerdict
  /**
   * Follow the backend's own recovery mutation of the source surface.
   * @param cause - which owned recovery happened.
   */
  rebaseAfterOwnedRecovery(cause: CompactionOwnedRecoveryCause): void
  /**
   * Re-read live authority and refuse publication when it moved.
   *
   * Synchronous by contract: the backend calls this in the same uninterrupted
   * block that publishes, so there is no `await` between the final authority
   * read and the replacement append.
   * @throws when protected authority is stale, absent, or unresolvable.
   */
  assertPublishable(): void
  /** Report the transaction's structured audit. Never authority. */
  audit(): CompactionPolicyAudit
}

/**
 * An optional, task-agnostic policy a compaction backend may consult.
 *
 * A backend that finds no registered policy behaves exactly as it did before
 * this seam existed. A backend that finds one still owns selection, pricing,
 * summarization, stability validation, and publication; the policy only
 * advises and gates.
 */
export interface CompactionCandidatePolicy {
  /** Stable policy identity recorded in the audit. */
  readonly id: string
  /** Policy contract version recorded in the audit. */
  readonly version: string
  /**
   * Decide whether this operation may proceed, before anything destructive.
   *
   * Runs before any tool-result pruning or truncation, so a refusal never
   * leaves the surface already narrowed for an operation that then declined.
   * @param input - the session, the entry, and already-priced read-only facts.
   * @returns the admission decision.
   */
  assess(input: CompactionAssessInput): CompactionPolicyAdmission | Promise<CompactionPolicyAdmission>
  /**
   * Open the policy transaction for an admitted operation.
   *
   * Runs after the backend's durable bracket exists and before the first
   * summarization request, so the policy can capture exactly the authority it
   * will later re-check at publication.
   * @param input - the admitted operation and its selected span.
   * @returns the live transaction.
   * @throws when the authority the policy would protect cannot be read, which
   *   fails the compaction closed before any model call.
   */
  begin(input: CompactionBeginInput): CompactionPolicyTransaction | Promise<CompactionPolicyTransaction>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional compaction candidate policy. Absent when no deployment mounted
     * one, which is the upstream default.
     */
    compactionCandidatePolicy: CompactionCandidatePolicy
  }
}
