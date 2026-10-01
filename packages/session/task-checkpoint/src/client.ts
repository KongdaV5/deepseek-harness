/**
 * Client outlet: the durable task-checkpoint contracts, importable from client
 * aggregates without dragging the host-side fold (zod, the projection
 * definitions, or the Cordis merge) into the browser bundle. The projection-key
 * declarations merge through {@link ./types}, so a client that imports this
 * module gets `useProjection('taskCheckpoint')` and `useProjection('taskResults')`
 * typed.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/client
 */

export type * from './types.ts'

export type { GuardedResumeDecisionClass, GuardedResumeReason } from './resume.ts'
