/**
 * Client outlet: the `runDetails` wire contract, importable from client
 * aggregates without dragging the host-side fold (zod, the projection
 * definition, or the Cordis merge) into the browser bundle. The projection-key
 * declaration merges through {@link ./types}, so a client that imports this
 * module gets `useProjection('runDetails')` typed.
 *
 * @module @deepseek-ai/dsh-run-details/client
 */

export type * from './types.ts'
