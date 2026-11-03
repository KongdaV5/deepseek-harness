/**
 * Fail-closed reasoning-policy errors.
 *
 * These are raised only when the *inputs* to the policy are unusable — a
 * capability that contradicts itself, or a caller that demanded a resolution
 * for an effort the route cannot accept. An unsupported request is not an
 * error; it is the {@link UnsupportedReasoning} outcome, because a caller must
 * be able to read the requested and advertised values before deciding what to
 * do.
 *
 * @module @deepseek-ai/dsh-reasoning-policy/errors
 */

/**
 * Canonical provider-neutral code for a model request whose reasoning effort
 * the exact route cannot accept.
 *
 * The spelling mirrors the code the current upstream `llm` service raises from
 * `prepareCall` for the same condition, so a caller sees one vocabulary whether
 * the rejection came from this policy or from the transport-side authority.
 */
export const UNSUPPORTED_REASONING_EFFORT_CODE = 'UNSUPPORTED_REASONING_EFFORT'

/** Stable machine-routable classes this policy can fail with. */
export type ReasoningPolicyErrorCode =
  | typeof UNSUPPORTED_REASONING_EFFORT_CODE
  /** The supplied capability contradicts itself, so no truthful resolution exists. */
  | 'INVALID_CAPABILITY'

/**
 * Failure raised before an unsupported reasoning value can reach a provider.
 *
 * Carries the same stable `code` convention as the rest of the harness, so it
 * routes on `code` and never on `message` text.
 */
export class ReasoningPolicyError extends Error {
  /** Stable machine-routable failure class. */
  readonly code: ReasoningPolicyErrorCode

  /**
   * @param code - stable machine-routable failure class.
   * @param message - human-readable failure summary.
   */
  constructor(code: ReasoningPolicyErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ReasoningPolicyError'
  }
}
