/** Serialized task correlation brands retained without changing their string value.
 * Current Run producers derive identities from committed Session turns through
 * agent-run-state. Older opaque Run and Attempt values remain readable; the
 * guarded-resume policy requires canonical Run evidence before admission.
 * A serialized AttemptId is distinct from a process-local LlmAttemptId.
 * @module @deepseek-ai/dsh-task-checkpoint/legacy-identity
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** One complete user-triggered work unit inside a Final Product Session. */
export type RunId = Branded<'RunId'>

/** One model request inside a Final Product run. */
export type AttemptId = Branded<'AttemptId'>

/**
 * Apply the preserved `RunId` brand without changing the value.
 *
 * The Final Product applied no validation of its own here: the durable schema's
 * normalized-string refinement admitted the value first, and the brand changed
 * only the static type. Preserving that split keeps a legacy payload byte-exact
 * through a read.
 * @param value - string already admitted by the owning durable schema.
 * @returns the same string carrying the legacy `RunId` brand.
 */
export function brandLegacyRunId(value: string): RunId {
  return brandString<RunId>(value)
}

/**
 * Apply the preserved `AttemptId` brand without changing the value.
 * @param value - string already admitted by the owning durable schema.
 * @returns the same string carrying the legacy `AttemptId` brand.
 */
export function brandLegacyAttemptId(value: string): AttemptId {
  return brandString<AttemptId>(value)
}
