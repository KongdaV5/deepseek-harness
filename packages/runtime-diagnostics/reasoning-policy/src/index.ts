/**
 * Capability-aware reasoning policy for the current upstream.
 *
 * This package answers one question with evidence rather than intention: for
 * this exact provider/model route, what reasoning setting will the request
 * actually carry, and what did the caller ask for? The answer is a structured
 * resolution that keeps *requested* and *resolved* distinct, never names a
 * level the route does not advertise, and never promotes a requested level to a
 * stronger one.
 *
 * It owns no execution. Upstream's `resolveCallWithInfo` still materializes
 * adapter defaults, still rejects an unsupported explicit effort with
 * `UNSUPPORTED_REASONING_EFFORT`, and still decides what reaches the adapter's
 * wire serializer. This package supplies the policy that answers the question
 * *before* the request is proposed, so an invalid configuration fails closed at
 * the policy boundary instead of depending on a backend's rejection.
 *
 * It is a **library**: it registers no Cordis service, mounts no composition
 * entry, emits no Session event, and adds no durable vocabulary. Its capability
 * input is the current upstream `LlmResolvedModelInfo.reasoning`, so there is no
 * second capability database to keep in sync with the adapters.
 *
 * @module @deepseek-ai/dsh-reasoning-policy
 */

export {
  advertisedReasoningEfforts,
  advertisesReasoningEffort,
  reasoningCapabilityOf,
} from './capability.ts'

export { applyReasoningResolution, requireResolvedReasoning } from './apply.ts'
export type { ReasoningConfigCarrier } from './apply.ts'

export { ReasoningPolicyError, UNSUPPORTED_REASONING_EFFORT_CODE } from './errors.ts'
export type { ReasoningPolicyErrorCode } from './errors.ts'

export { reasoningMetadataFromHeader, taskReasoningMetadata } from './metadata.ts'

export { resolveReasoning } from './resolve.ts'

export type {
  ReasoningCapability,
  ReasoningPolicyInput,
  ReasoningResolution,
  ReasoningResolutionSource,
  ReasoningUnsupportedReason,
  ResolvedReasoning,
  TaskReasoningMetadata,
  UnsupportedReasoning,
} from './types.ts'
