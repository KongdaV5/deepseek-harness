/**
 * Deterministic, capability-aware reasoning resolution.
 *
 * Four rules define the policy, and each one exists to stop a specific untruth:
 *
 * - An effort the route does not advertise is never resolved. It cannot become
 *   a wire parameter, because there is no resolution to apply.
 * - A request that names an advertised effort is used unchanged. The policy
 *   never escalates above what was asked for, and never quietly substitutes a
 *   different level.
 * - A request that names nothing resolves to the route's declared default when
 *   it has one, labelled `provider-default` so no caller mistakes an adapter
 *   setting for its own.
 * - A request that names nothing on a route with no declared default resolves to
 *   omission, which is the truthful answer: the provider's own behaviour is in
 *   force and this policy claims no level.
 *
 * A capability that advertises a default it does not also advertise as
 * selectable contradicts itself, and no truthful resolution exists for it, so
 * the policy fails closed instead of guessing which half is right.
 *
 * @module @deepseek-ai/dsh-reasoning-policy/resolve
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { advertisesReasoningEffort } from './capability.ts'
import { ReasoningPolicyError } from './errors.ts'
import type {
  ReasoningPolicyInput,
  ReasoningResolution,
  ResolvedReasoning,
  UnsupportedReasoning,
} from './types.ts'

/** A resolution that asks the route for no reasoning preference at all. */
function omitted(input: ReasoningPolicyInput): ResolvedReasoning {
  return {
    kind: 'resolved',
    source: 'omitted',
    provider: input.provider,
    model: input.model,
    ...input.capability === undefined ? {} : { capability: input.capability },
  }
}

/** A requested effort the exact route cannot accept. */
function unsupported(
  input: ReasoningPolicyInput,
  requested: ReasoningEffortId,
  reason: UnsupportedReasoning['reason'],
): UnsupportedReasoning {
  return {
    kind: 'unsupported',
    requested,
    reason,
    provider: input.provider,
    model: input.model,
    ...input.capability === undefined ? {} : { capability: input.capability },
  }
}

/**
 * Resolve what one exact provider/model route will actually be asked for.
 *
 * @param input - exact route, what the caller requested, and the route's capability.
 * @returns a resolution the route accepts, or the unsupported outcome naming why not.
 * @throws ReasoningPolicyError with code `INVALID_CAPABILITY` when the supplied
 *   capability advertises a default it does not also advertise as selectable.
 */
export function resolveReasoning(input: ReasoningPolicyInput): ReasoningResolution {
  const { capability, requested } = input
  if (capability === undefined) {
    return requested === undefined
      ? omitted(input)
      : unsupported(input, requested, 'route-declares-no-reasoning')
  }

  const defaultEffort = capability.defaultEffort
  if (defaultEffort !== undefined && !advertisesReasoningEffort(capability, defaultEffort)) {
    throw new ReasoningPolicyError(
      'INVALID_CAPABILITY',
      `${input.provider}/${input.model} advertises default reasoning effort "${defaultEffort}" `
      + 'that it does not also advertise as selectable',
    )
  }

  if (requested === undefined) {
    if (defaultEffort === undefined) return omitted(input)
    return {
      kind: 'resolved',
      resolved: defaultEffort,
      source: 'provider-default',
      provider: input.provider,
      model: input.model,
      capability,
    }
  }

  if (!advertisesReasoningEffort(capability, requested)) {
    return unsupported(input, requested, 'effort-not-offered')
  }

  return {
    kind: 'resolved',
    requested,
    resolved: requested,
    source: 'request',
    provider: input.provider,
    model: input.model,
    capability,
  }
}
