/** Official Codex App Server integration for DSH external turns.
 *
 * @module @deepseek-ai/dsh-agent-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import { apply as applyCodex } from './runtime.ts'

export { CodexSubscriptionRuntime, name } from './runtime.ts'
export type { CodexRuntimeInternals } from './runtime.ts'
export { codexRuntimePackageVersion, codexServerArgv } from './app-server.ts'
export type {
  CodexAccountState,
  CodexLoginStartResult,
  CodexRuntimePreference,
  CodexRuntimeSource,
  CodexRuntimeState,
  CodexSessionMappingState,
  CodexSubscriptionStatus,
  CodexUsageStatus,
  CodexUsageWindow,
} from './types.ts'
export { codexSubscriptionProjection, EMPTY_CODEX_MAPPING } from './projection.ts'

/** Cordis composition entry. Keep the declaration visible to package tooling. */
// Catalog and login status can mount before any workspace is selected. Runtime
// capabilities are resolved only at the operation that needs them; in
// particular, workspace registration is a turn-time requirement, not a reason
// to hide the Settings card or model directory.
export const inject = ['sessionProjections', 'sessions']

/** Mount the subscription runtime into a host composition. */
export function apply(ctx: Context): void {
  applyCodex(ctx)
}
