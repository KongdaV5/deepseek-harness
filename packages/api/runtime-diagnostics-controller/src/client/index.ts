/**
 * The `./client` entry: the one place this package binds the generated
 * Host-for-Client artifact, which exists only in `lib` after a build.
 *
 * Everything with behavior lives in {@link ./mount.ts} so the source lane covers
 * it; this module only supplies the artifact the composition selected.
 *
 * @module @deepseek-ai/dsh-api-runtime-diagnostics-controller/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import contribution from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/remote'
import { mountRuntimeDiagnostics } from './mount.ts'

export {
  createRuntimeDiagnosticsProvider,
  inject,
  mountRuntimeDiagnostics,
  parseRuntimeDiagnosticsAddress,
  RUNTIME_DIAGNOSTICS_PROTOCOL,
  RuntimeDiagnosticsTopics,
  runtimeDiagnosticsAddress,
} from './mount.ts'
export type { RuntimeDiagnosticsSchema } from './mount.ts'

/**
 * Mount this package's generated contribution and register its provider.
 * @param ctx - client root context carrying `remote` and `resources`.
 * @returns the release of the contribution mount.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountRuntimeDiagnostics(ctx, contribution)
}
