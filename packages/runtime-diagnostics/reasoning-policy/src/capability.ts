/**
 * Capability extraction from the current upstream model resolution.
 *
 * The policy owns no capability table. An adapter already resolves what one
 * exact provider/model route accepts — `LlmResolvedModelInfo.reasoning` carries
 * the selectable efforts in adapter-preferred order plus the adapter-configured
 * default — and that resolved object is the only input this module reads. A
 * route that publishes no reasoning block advertises no reasoning, which is a
 * negative capability rather than a missing one.
 *
 * @module @deepseek-ai/dsh-reasoning-policy/capability
 */

import type { LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ReasoningCapability } from './types.ts'

/**
 * Read one exact route's reasoning capability.
 *
 * @param model - resolved model metadata for one registered provider/model route.
 * @returns the advertised capability, or `undefined` when the route advertises none.
 */
export function reasoningCapabilityOf(model: LlmResolvedModelInfo): ReasoningCapability | undefined {
  const reasoning = model.reasoning
  if (reasoning === undefined) return undefined
  return reasoning
}

/**
 * Read the efforts one capability advertises, in adapter-preferred order.
 *
 * @param capability - the route's advertised capability, if any.
 * @returns the advertised effort ids, or an empty list when none are advertised.
 */
export function advertisedReasoningEfforts(
  capability: ReasoningCapability | undefined,
): readonly ReasoningEffortId[] {
  return capability?.efforts.map(effort => effort.id) ?? []
}

/**
 * Whether one capability advertises a specific effort.
 *
 * @param capability - the route's advertised capability, if any.
 * @param effort - the effort to look for.
 * @returns whether the exact route accepts that effort.
 */
export function advertisesReasoningEffort(
  capability: ReasoningCapability | undefined,
  effort: ReasoningEffortId,
): boolean {
  return capability?.efforts.some(candidate => candidate.id === effort) ?? false
}
