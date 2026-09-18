/**
 * Persisted Final Product v1 correlation identities, preserved for read
 * compatibility with legacy `task/checkpoint` and `task/result-manifest` payloads.
 *
 * The Final Product imported `RunId` and `AttemptId` from
 * `@deepseek-ai/dsh-agent-run-state`, a run-state subsystem that the current
 * upstream no longer ships. Stage 6 restores only the serialized representation
 * and validation behavior of those values; it does not restore the subsystem.
 *
 * These identities are **opaque legacy values**. They carry no current
 * upstream Run authority: nothing here allocates, derives, or interprets them,
 * and this module deliberately exposes no constructor outside the package.
 * The logical DS Harness `RunId` is a Stage 7 decision, and the current
 * process-local `LlmAttemptId` is a different, non-durable identity.
 *
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
