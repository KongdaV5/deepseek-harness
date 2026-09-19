/**
 * Task-aware admission: whether an operation may proceed at all.
 *
 * Admission runs before anything destructive, which is why it is a separate
 * decision from validation. A refusal here means the surface was never pruned,
 * truncated, or summarized for an operation that then declined — so a blocked
 * compaction leaves the Session exactly as it found it and the caller's own
 * failure path stays authoritative.
 *
 * A Session with no Task is not blocked. There is no authority to protect, so
 * the policy admits the operation and asks for no protected block; the executor
 * then behaves exactly as it does with no policy installed.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/eligibility
 */

import type { CompactionPolicyTrigger } from '@deepseek-ai/dsh-compaction'
import type { TaskRepairHazard } from '@deepseek-ai/dsh-task-checkpoint'
import type { TaskAwareBlockCode, TaskProtection } from './types.ts'
import { protectedContextExceedsCapacity } from './context.ts'
import { unknownOutcomeHazard } from './protection.ts'

/** Everything one admission decision reads. All of it is already priced. */
export interface TaskAwareAdmissionInput {
  /** Which compaction entry is asking. */
  readonly trigger: CompactionPolicyTrigger
  /** The protected Task's own repair hazards, in projection order. */
  readonly hazards: readonly TaskRepairHazard[]
  /** The captured protection root, absent when the Session tracks no Task. */
  readonly protection?: TaskProtection | undefined
  /** Priced size of the model-visible surface. */
  readonly beforeTokens: number
  /** Priced size of the code-rendered protected context. */
  readonly protectedTokens: number
  /**
   * The usable input budget of the post-compaction request, when the routed
   * route's capacity could be resolved. `undefined` means the policy makes no
   * capacity claim at all rather than asserting one it cannot prove.
   */
  readonly usableInputTokens?: number | undefined
}

/** One structured admission refusal. */
export interface TaskAwareAdmissionBlock {
  /** Stable machine code a caller can route on. */
  readonly code: TaskAwareBlockCode
  /** Human-readable detail; never parsed. */
  readonly detail: string
}

/** The admission outcome, including the protection the transaction will carry. */
export interface TaskAwareAdmission {
  /** Whether the operation may proceed. */
  readonly admitted: boolean
  /**
   * Whether the transaction will insert a code-rendered protected block.
   * `false` means the Session tracks no Task and the executor must behave as it
   * would with no policy installed.
   */
  readonly taskAware: boolean
  /** The captured protection root, present exactly when the transaction is task-aware. */
  readonly protection?: TaskProtection | undefined
  /** The protected Task's own repair hazards, in projection order. */
  readonly hazards: readonly TaskRepairHazard[]
  /** Why the operation was refused, when it was. */
  readonly block?: TaskAwareAdmissionBlock | undefined
}

/**
 * Decide whether this operation may proceed.
 *
 * Checks are ordered so the most authoritative obstacle decides first: an
 * unknown external side effect outranks a capacity problem, because refusing for
 * capacity would invite a caller to make room for a compaction that must not
 * happen at all.
 * @param input - the captured protection, the entry, and the priced facts.
 * @returns the admission outcome.
 */
export function admitTaskAware(input: TaskAwareAdmissionInput): TaskAwareAdmission {
  const protection = input.protection
  if (protection === undefined) {
    return { admitted: true, taskAware: false, hazards: [] }
  }

  // An unknown external side effect cannot be normalized by a model summary.
  // This restricts *automatic* recovery only: an explicit human request is a
  // decision that already carries the hazard knowingly, and a not-started tool
  // is not a hazard at all — nothing ran.
  if (input.trigger !== 'manual') {
    const unknown = unknownOutcomeHazard(input.hazards)
    if (unknown !== undefined) {
      return {
        admitted: false,
        taskAware: false,
        hazards: input.hazards,
        block: {
          code: 'TASK_REPAIR_HAZARD_OUTCOME_UNKNOWN',
          detail: `call "${unknown.callId}" recorded TOOL_OUTCOME_UNKNOWN at event ${String(unknown.eventSeq)}; an unknown external side effect cannot be normalized by a model summary`,
        },
      }
    }
  }

  if (input.usableInputTokens !== undefined
    && protectedContextExceedsCapacity(input.protectedTokens, input.usableInputTokens)) {
    return {
      admitted: false,
      taskAware: false,
      hazards: input.hazards,
      block: {
        code: 'TASK_PROTECTED_CONTEXT_OVER_CAPACITY',
        detail: `the protected task context prices at ${String(input.protectedTokens)} tokens against a usable budget of ${String(input.usableInputTokens)}; no protected field may be truncated to make it fit`,
      },
    }
  }

  return { admitted: true, taskAware: true, protection, hazards: input.hazards }
}
