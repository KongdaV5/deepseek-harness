/**
 * Applying a resolution, and failing closed on one that does not exist.
 *
 * Applying is a pure, total function over the caller's own request
 * configuration: the resulting configuration carries exactly the effort the
 * resolution named, and carries no effort at all when the resolution resolved
 * to omission. It cannot be called with an unsupported outcome, because an
 * unsupported request has no resolution to apply — that is the type-level half
 * of the guarantee that an unsupported parameter is never sent.
 *
 * @module @deepseek-ai/dsh-reasoning-policy/apply
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ReasoningPolicyError, UNSUPPORTED_REASONING_EFFORT_CODE } from './errors.ts'
import type { ReasoningResolution, ResolvedReasoning } from './types.ts'

/** The one request field this policy owns. */
export interface ReasoningConfigCarrier {
  /** Adapter-owned reasoning effort the request will carry. */
  readonly reasoningEffort?: ReasoningEffortId
}

/**
 * Return one request configuration carrying the resolved effort.
 *
 * Any effort already present on the configuration is replaced, so the result
 * cannot carry a stale proposal alongside the resolved value.
 *
 * @param config - the caller's request configuration.
 * @param resolution - a resolution the exact route accepts.
 * @returns a configuration whose `reasoningEffort` is the resolved value, or which omits it.
 */
export function applyReasoningResolution<T extends ReasoningConfigCarrier>(
  config: T,
  resolution: ResolvedReasoning,
): T {
  const { reasoningEffort: _replaced, ...rest } = config
  return (resolution.resolved === undefined
    ? rest
    : { ...rest, reasoningEffort: resolution.resolved }) as T
}

/**
 * Demand a resolution, or fail before any provider request is formed.
 *
 * A caller that cannot proceed without a supported reasoning configuration uses
 * this instead of inspecting the outcome, so an unsupported request can never
 * reach transport and can never be retried as if it were transient.
 *
 * @param resolution - the outcome of {@link resolveReasoning}.
 * @returns the resolution when the route accepts it.
 * @throws ReasoningPolicyError with code `UNSUPPORTED_REASONING_EFFORT` otherwise.
 */
export function requireResolvedReasoning(resolution: ReasoningResolution): ResolvedReasoning {
  if (resolution.kind === 'resolved') return resolution
  const advertised = resolution.capability?.efforts.map(effort => effort.id).join(', ')
  throw new ReasoningPolicyError(
    UNSUPPORTED_REASONING_EFFORT_CODE,
    `${resolution.provider}/${resolution.model} does not support reasoning effort `
    + `"${resolution.requested}" (${resolution.reason}`
    + `${advertised === undefined || advertised.length === 0 ? '' : `; advertised: ${advertised}`})`,
  )
}
