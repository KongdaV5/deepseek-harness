/** Exact-capability reasoning normalization with explicit alias and fallback facts. */

import type {
  CanonicalReasoningLevel,
  ModelReasoningCapability,
  ReasoningDecisionSource,
  ReasoningLevel,
  ResolvedReasoningDecision,
} from './types.ts'

/** Failure raised before a bad reasoning wire value can reach a backend. */
export class ReasoningPolicyError extends Error {
  constructor(readonly code: 'UNKNOWN_CAPABILITY' | 'UNSUPPORTED_REASONING' | 'BENCHMARK_LOCK_UNSUPPORTED' | 'BENCHMARK_ROUTE_MISMATCH', message: string) {
    super(message)
  }
}

/** Normalize one selection over one exact audited backend capability. */
export function normalizeReasoning(
  capability: ModelReasoningCapability,
  input: {
    readonly selected: ReasoningLevel
    readonly requested?: ReasoningLevel
    readonly selectionSource: ReasoningDecisionSource
    readonly benchmarkLocked?: boolean
  },
): ResolvedReasoningDecision {
  if (!capability.requestOverrideSupported) {
    throw new ReasoningPolicyError('UNSUPPORTED_REASONING', `reasoning override is unavailable for ${capability.provider}/${capability.model}`)
  }
  const alias = capability.aliases?.[input.selected]
  const policySelected = (alias ?? input.selected) as CanonicalReasoningLevel
  const fallback = capability.fallbacks?.[policySelected]
  if (input.benchmarkLocked && fallback !== undefined) {
    throw new ReasoningPolicyError('BENCHMARK_LOCK_UNSUPPORTED', `benchmark lock ${policySelected} is unsupported by ${capability.provider}/${capability.model}`)
  }
  const resolved = fallback ?? policySelected
  if (!capability.supported.includes(resolved)) {
    throw new ReasoningPolicyError('UNSUPPORTED_REASONING', `reasoning ${resolved} is unsupported by ${capability.provider}/${capability.model}`)
  }
  const wireValue = capability.wireValues[resolved]
  if (wireValue === undefined || wireValue.length === 0) {
    throw new ReasoningPolicyError('UNKNOWN_CAPABILITY', `reasoning ${resolved} has no audited wire value for ${capability.provider}/${capability.model}`)
  }
  const source = alias !== undefined
    ? 'gguf-alias-normalization'
    : fallback !== undefined
      ? 'gguf-backend-capability-fallback'
      : input.selectionSource
  return {
    ...input.requested === undefined ? {} : { requested: input.requested },
    policySelected,
    resolved,
    wireValue,
    ...capability.backendDefault === undefined ? {} : { backendDefault: capability.backendDefault },
    source,
    capabilityConfidence: capability.confidence,
    capabilitySource: capability.source,
  }
}
