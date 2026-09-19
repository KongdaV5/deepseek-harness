/**
 * Truthful reasoning facts for the task-execution record.
 *
 * Two sources feed the same two durable fields, and neither can overstate what
 * happened:
 *
 * - {@link taskReasoningMetadata} reads a *policy* input — what a caller
 *   requested and what the exact route would accept — for a record written
 *   before a provider request exists.
 * - {@link reasoningMetadataFromHeader} reads the *durable* record after the
 *   fact: the committed request header says both what the caller proposed and
 *   whether the adapter, rather than the caller, materialized the effort.
 *
 * The durable field names and optionality are the restored v1
 * `TaskExecutionMetadata` contract's own, so a producer spreads this result
 * without a parallel reasoning shape.
 *
 * @module @deepseek-ai/dsh-reasoning-policy/metadata
 */

import type { EpochHeader } from '@deepseek-ai/dsh-session/types'
import type { ReasoningResolution, TaskReasoningMetadata } from './types.ts'

/**
 * Project one policy resolution onto the durable reasoning fields.
 *
 * An unsupported outcome carries only `requestedReasoning`: nothing was
 * resolved, and recording a value there would claim a setting no request ever
 * carried.
 *
 * @param resolution - the outcome of `resolveReasoning`.
 * @returns the two reasoning facts, each present only when it is known.
 */
export function taskReasoningMetadata(resolution: ReasoningResolution): TaskReasoningMetadata {
  if (resolution.kind === 'unsupported') {
    return { requestedReasoning: resolution.requested }
  }
  return {
    ...resolution.requested === undefined ? {} : { requestedReasoning: resolution.requested },
    ...resolution.resolved === undefined ? {} : { resolvedReasoning: resolution.resolved },
  }
}

/**
 * Read the reasoning facts a committed request header already records.
 *
 * The header distinguishes the two cases structurally: an effort the adapter
 * materialized is flagged in `adapterDefaults`, so a caller that proposed
 * nothing is never reported as having requested the adapter's default.
 *
 * @param header - the durable request header in force, if any.
 * @returns the two reasoning facts, each present only when the log proves it.
 */
export function reasoningMetadataFromHeader(header: EpochHeader | undefined): TaskReasoningMetadata {
  const effort = header?.config.reasoningEffort
  if (effort === undefined) return {}
  return header?.adapterDefaults?.reasoningEffort === true
    ? { resolvedReasoning: effort }
    : { requestedReasoning: effort, resolvedReasoning: effort }
}
