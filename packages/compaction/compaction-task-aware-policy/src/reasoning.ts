/**
 * Auxiliary compaction reasoning: an isolated, capability-proven ladder.
 *
 * A compaction request is an auxiliary model call whose *only* job is to
 * produce a textual condensation. It is not the main Run, it does not inherit
 * the main Run's reasoning setting, and it must not change it. Keeping the two
 * apart is what lets a cheap first candidate be safe: the worst case is that the
 * cheap candidate is rejected and a second, slightly stronger one is asked for,
 * and neither outcome reaches the main Run's own reasoning state.
 *
 * The ladder is exactly `low` then `medium`, and it stops there. There is no
 * third rung and no fallback to the main Run's effort: a compaction that needs
 * the main Run's reasoning to succeed is a compaction whose result nobody could
 * distinguish from a task answer, which is precisely the confusion the
 * protection graph exists to prevent.
 *
 * An effort the selected route does not advertise is never requested. The
 * upstream contract rejects such a request, so asking anyway would turn a policy
 * question into a provider error; the policy fails closed instead.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/reasoning
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { resolveReasoning } from '@deepseek-ai/dsh-reasoning-policy'
import type { ReasoningCapability, ResolvedReasoning } from '@deepseek-ai/dsh-reasoning-policy'
import { TaskAwarePolicyError } from './errors.ts'

/**
 * The auxiliary reasoning ladder, cheapest first.
 *
 * Exactly two rungs. The first is the default for candidate one; the second is
 * requested only after candidate one failed deterministic validation.
 */
export const AUXILIARY_REASONING_LADDER: readonly string[] = ['low', 'medium']

/** One resolved rung of the auxiliary ladder. */
export interface AuxiliaryReasoningStep {
  /** Zero-based rung index, which is also the candidate ordinal it serves. */
  readonly attempt: number
  /** The ladder label requested, `low` or `medium`. */
  readonly label: string
  /** The truthful resolution, including whether the route supplied a default. */
  readonly resolution: ResolvedReasoning
}

/**
 * Resolve one rung of the auxiliary ladder for one exact route.
 *
 * @param provider - the resolved summarization route's provider.
 * @param model - the resolved summarization route's model.
 * @param capability - that route's published reasoning capability, when it has one.
 * @param attempt - the candidate ordinal whose rung is being resolved.
 * @returns the resolved step, whose effort is proven advertised.
 * @throws TaskAwarePolicyError with `TASK_AUXILIARY_REASONING_UNSUPPORTED` when the
 *   route does not advertise this rung, or when the ladder has no such rung.
 */
export function resolveAuxiliaryReasoning(
  provider: string,
  model: string,
  capability: ReasoningCapability | undefined,
  attempt: number,
): AuxiliaryReasoningStep {
  const label = AUXILIARY_REASONING_LADDER[attempt]
  if (label === undefined) {
    throw new TaskAwarePolicyError(
      'TASK_AUXILIARY_REASONING_UNSUPPORTED',
      `compaction auxiliary reasoning has no rung ${String(attempt)}; the ladder is ${AUXILIARY_REASONING_LADDER.join(' -> ')}`,
    )
  }
  const resolution = resolveReasoning({
    provider,
    model,
    requested: ReasoningEffortId(label),
    ...capability === undefined ? {} : { capability },
  })
  if (resolution.kind !== 'resolved') {
    throw new TaskAwarePolicyError(
      'TASK_AUXILIARY_REASONING_UNSUPPORTED',
      `compaction auxiliary reasoning requested "${label}" on ${provider}/${model}, which the route does not advertise (${resolution.reason}); refusing to send an unsupported reasoning value`,
    )
  }
  return { attempt, label, resolution }
}

/** A resumable view of the auxiliary reasoning state, for diagnostics and audit. */
export interface AuxiliaryReasoningRecord {
  /** Which rung was requested. */
  readonly requested: string
  /** What the request actually resolves to on the wire. */
  readonly resolved?: string
  /** Whether the resolved value came from the request, a provider default, or omission. */
  readonly source: string
}
