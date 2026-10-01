/**
 * Public contracts for capability-aware reasoning resolution.
 *
 * The vocabulary here is deliberately borrowed rather than invented: an effort
 * is the current upstream {@link ReasoningEffortId} brand, and a capability is
 * the current upstream {@link LlmModelReasoningInfo} an adapter publishes for
 * one exact provider/model route. There is no second capability database and no
 * repository-owned reasoning level enum, because the current source already
 * owns both facts — the adapter that will actually serialize the request.
 *
 * The one distinction this module exists to keep is *requested* versus
 * *resolved*. A requested effort is what a task, profile, or caller asked for.
 * A resolved effort is what the exact route can accept and what the request
 * will actually carry. A resolution never reports a level as resolved merely
 * because it was requested.
 *
 * @module @deepseek-ai/dsh-reasoning-policy/types
 */

import type { LlmModelReasoningInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * The selectable reasoning efforts one exact provider/model route advertises.
 *
 * This is the current upstream capability contract, re-exported under a policy
 * name. It is not a copy and carries no additional capability knowledge: the
 * only authority on what a route accepts is the adapter that serves it.
 */
export type ReasoningCapability = LlmModelReasoningInfo

/**
 * Who supplied the effort a request will carry.
 *
 * A caller must be able to see this, because `resolved` alone cannot say
 * whether the value came from its own request, from an adapter-configured
 * route default, or from nothing at all.
 */
export type ReasoningResolutionSource =
  /** The request named an effort the route advertises; it is used unchanged. */
  | 'request'
  /** The request named no effort, so the route's declared default is used. */
  | 'provider-default'
  /** The request named no effort and the route declares no default, so the request omits reasoning. */
  | 'omitted'

/** Why a requested effort could not become a resolution. */
export type ReasoningUnsupportedReason =
  /** The route advertises no reasoning capability at all. */
  | 'route-declares-no-reasoning'
  /** The route advertises reasoning, but not the requested effort. */
  | 'effort-not-offered'

/**
 * A resolution the route accepts.
 *
 * `resolved` is the value the request will carry, or absent when the request
 * omits reasoning entirely. Absence is a real answer, not a missing one: a route
 * that declares no default legitimately asks for no reasoning preference, and
 * reporting that as one would claim a setting the provider never received.
 */
export interface ResolvedReasoning {
  readonly kind: 'resolved'
  /** What the caller asked for, exactly as asked; absent when it asked for nothing. */
  readonly requested?: ReasoningEffortId
  /** What the request will carry; absent when the request omits reasoning. */
  readonly resolved?: ReasoningEffortId
  /** Who supplied {@link resolved}. */
  readonly source: ReasoningResolutionSource
  /** The exact route this resolution was computed against. */
  readonly provider: string
  /** The exact model this resolution was computed against. */
  readonly model: string
  /**
   * Every effort the route advertises, retained so a caller can explain a
   * provider-default substitution without re-reading the registry. Present only
   * when the route advertises reasoning.
   */
  readonly capability?: ReasoningCapability
}

/**
 * A requested effort the route cannot accept.
 *
 * This is a terminal policy outcome, not an error to recover from: no request
 * is formed, nothing is downgraded, and the caller keeps both the value it
 * asked for and the set the route does advertise.
 */
export interface UnsupportedReasoning {
  readonly kind: 'unsupported'
  /** The effort the caller asked for, preserved unchanged. */
  readonly requested: ReasoningEffortId
  readonly reason: ReasoningUnsupportedReason
  readonly provider: string
  readonly model: string
  /** Every effort the route advertises; absent when it advertises none. */
  readonly capability?: ReasoningCapability
}

/** One complete reasoning-policy outcome. */
export type ReasoningResolution = ResolvedReasoning | UnsupportedReasoning

/**
 * One resolution request.
 *
 * There is deliberately no observation, health, or backend field: reasoning
 * resolution reads the exact route's declared capability and nothing else, so
 * it cannot depend on a signal this build has no truthful adapter for.
 */
export interface ReasoningPolicyInput {
  /** Registered provider route the request will use. */
  readonly provider: string
  /** Provider-owned model id the request will use. */
  readonly model: string
  /** What the task, profile, or caller requested; absent means nothing was requested. */
  readonly requested?: ReasoningEffortId | undefined
  /**
   * The route's capability, from the current upstream resolved model info.
   * Absent means the route advertises no reasoning at all.
   *
   * An explicit `undefined` is accepted as the same absence, because a caller
   * holds the value {@link reasoningCapabilityOf} returned and that result is
   * itself `T | undefined`.
   */
  readonly capability?: ReasoningCapability | undefined
}

/**
 * The two reasoning facts a durable task execution record can carry truthfully.
 *
 * Field names and optionality match the restored v1 `TaskExecutionMetadata`
 * contract exactly, so a producer spreads this without translation and without
 * a parallel reasoning metadata shape.
 */
export interface TaskReasoningMetadata {
  /** The policy value a caller requested, recorded where the schema supports it. */
  readonly requestedReasoning?: string
  /** The provider/model value actually resolved, recorded truthfully. */
  readonly resolvedReasoning?: string
}
