/** Browser-safe Local process observations; persistent inventory is owned by Custom Config. */
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
