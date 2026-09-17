/** Pure deterministic context-pressure classification and output-reserve policy. */

import type {
  CanonicalReasoningLevel,
  ContextPressureConfig,
  ContextPressureDecision,
  ReasoningTaskClass,
} from './types.ts'

/** Resolve a bounded expected-output reserve without treating maxTokens as an always-spent reservation. */
export function expectedOutputReserve(
  config: ContextPressureConfig,
  input: {
    readonly resolvedReasoning: CanonicalReasoningLevel
    readonly taskClass: ReasoningTaskClass
    readonly policySelected: CanonicalReasoningLevel
  },
): number {
  const base = config.reserve[input.resolvedReasoning]
  const complexity = input.taskClass === 'complex' || input.policySelected === 'high'
    ? config.complexReserve
    : 0
  const longOutput = input.taskClass === 'long-output' ? config.longOutputIncrement : 0
  return Math.min(config.maxReserve, base + complexity + longOutput)
}

/** Classify a projected next prompt against the prompt budget, without scheduling any action. */
export function classifyContextPressure(
  config: ContextPressureConfig,
  input: {
    readonly contextWindow?: number
    readonly projectedPromptTokens?: number
    readonly resumeContextTokens?: number
    readonly expectedOutputReserve: number
  },
): ContextPressureDecision {
  const base: Omit<ContextPressureDecision, 'effectivePromptBudget' | 'pressureRatio' | 'pressureState'> = {
    ...input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow },
    ...input.projectedPromptTokens === undefined ? {} : { projectedPromptTokens: input.projectedPromptTokens },
    ...input.resumeContextTokens === undefined ? {} : { resumeContextTokens: input.resumeContextTokens },
    expectedOutputReserve: input.expectedOutputReserve,
    providerSafetyMargin: config.providerSafetyMargin,
  }
  if (input.contextWindow === undefined || input.projectedPromptTokens === undefined) {
    return { ...base, pressureState: 'unknown' }
  }
  const effectivePromptBudget = input.contextWindow - input.expectedOutputReserve - config.providerSafetyMargin
  if (effectivePromptBudget <= 0) {
    return { ...base, effectivePromptBudget, pressureState: 'critical' }
  }
  const pressureRatio = input.projectedPromptTokens / effectivePromptBudget
  const { watch, prepare, compact, critical } = config.thresholds
  const pressureState = pressureRatio >= critical
    ? 'critical'
    : pressureRatio >= compact
      ? 'compact'
      : pressureRatio >= prepare
        ? 'prepare'
        : pressureRatio >= watch
          ? 'watch'
          : 'normal'
  return { ...base, effectivePromptBudget, pressureRatio, pressureState }
}
