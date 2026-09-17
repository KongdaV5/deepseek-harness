/**
 * Mount the capability-owned diagnostics namespace before a UI contribution
 * requests it. This package is composed only by the development Desktop layer;
 * it does not select a model, mutate a Run, or create an alternate transport.
 */

import type { Context } from '@deepseek-ai/cordis'
import desktopRunDiagnosticsRemote from '@deepseek-ai/dsh-desktop-run-diagnostics/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-desktop-run-diagnostics/remote'

/** Ensure the versioned, read-only namespace is available to later UI entries. */
export const inject = ['remote']

/** Mount the generated namespace with the existing Desktop Host connection. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await ctx.remote.$mount(desktopRunDiagnosticsRemote)
}
