/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }

/** Existing local-model manager profile identifiers exposed by DSH. */
export type LocalModelProfileId = 'huihui' | 'img21' | '38'

/** What kind of local model a manager profile serves. */
export type LocalModelModality = 'text' | 'image'

/** One inventoried profile from the user's local-model manager. */
export interface LocalModelRuntimeProfile {
  readonly id: LocalModelProfileId
  readonly name: string
  readonly modality: LocalModelModality
  /** Whether DSH may invoke this profile without legacy settings side effects. */
  readonly manageable: boolean
  /** Whether the profile's actual model files are present. */
  readonly available?: boolean
  readonly unavailableReason?: string
}

/** Runtime lifecycle phase, based on a fresh process + localhost health probe. */
export type LocalModelRuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/** Browser-safe local runtime snapshot. */
export interface LocalModelRuntimeSnapshot {
  readonly enabled: boolean
  readonly available: boolean
  readonly state: LocalModelRuntimeState
  /** True only when the verified local-model LaunchAgent can be safely stopped. */
  readonly canStop: boolean
  readonly profile: LocalModelProfileId | null
  readonly endpoint: string
  readonly profiles: readonly LocalModelRuntimeProfile[]
  readonly error?: string
}
