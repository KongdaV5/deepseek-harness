/**
 * The slice of the Client Remote this package calls: the generated
 * `runtimeDiagnostics` namespace by name, the typed contribution mount, and the
 * contribution's runtime value, so the plugin and its provider are testable
 * against a scripted face.
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
// Merges the generated `runtimeDiagnostics` namespace into the Remote face.
import type {} from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/remote'
import type { RuntimeDiagnosticsFollowRequest, RuntimeDiagnosticsFrame } from '../types.ts'

/** The `runtimeDiagnostics` namespace methods this package calls. */
export type RuntimeDiagnosticsNamespace = Pick<ClientRemote['runtimeDiagnostics'], 'follow'>

/** The Client Remote as this package sees it. */
export interface RuntimeDiagnosticsRemote extends Pick<ClientRemote, '$stream'> {
  /**
   * Mount one generated Remote contribution for the caller's lifetime.
   * @param contribution - the generated contribution to mount.
   * @returns the release of that mount.
   */
  $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
  /** The `runtimeDiagnostics` namespace. */
  readonly runtimeDiagnostics: RuntimeDiagnosticsNamespace
}

/** The generated contribution value this package mounts. */
export type RuntimeDiagnosticsContribution = TypertRemoteContribution

export type { RuntimeDiagnosticsFollowRequest, RuntimeDiagnosticsFrame }
