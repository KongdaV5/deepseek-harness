/**
 * Run Details transport plugin, host half: registers the `runDetails`
 * projection unit so the current client can render one read-only Run cut
 * through the session-projection seam.
 *
 * The plugin owns only the fold. Delivery — registry snapshot, change feed, and
 * every projection carrier — is the seam's.
 *
 * @module @deepseek-ai/dsh-run-details
 */

import type { Context } from '@deepseek-ai/cordis'
import { runDetailsProjectionDefinition } from './projection.ts'

export type * from './types.ts'
export {
  createRunDetailsProjection,
  emptyRunDetailsState,
  runDetailsProjectionDefinition,
  RUN_DETAILS_HEALTH_THRESHOLDS,
} from './projection.ts'
export type { RunDetailsProjection } from './projection.ts'
export { runDetailsStateSchema, runDetailsViewSchema } from './schema.ts'

/** Cordis plugin name. */
export const name = 'run-details'
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Register the `runDetails` unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(runDetailsProjectionDefinition)
}
