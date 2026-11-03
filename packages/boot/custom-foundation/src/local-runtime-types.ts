/** Browser-safe Local process observations; persistent inventory is owned by Custom Config. */
/** Local-model manager profile identifiers are user-owned and configurable. */
export type LocalModelProfileId = string

/** Launch contract understood by the bundled Local model manager. */
export type LocalModelRuntimeEngine = 'llama.cpp' | 'mflux-qwen21'

/** What kind of local model a manager profile serves. */
export type LocalModelModality = 'text' | 'image'

/** Minimal user-entered facts for registering an installed local model. */
export interface LocalModelProfileDraft {
  readonly id: string
  readonly name: string
  readonly modality: LocalModelModality
  /** Absolute GGUF file path or MFlux model directory. */
  readonly modelId: string
}

/** One inventoried profile from the user's local-model manager. */
export interface LocalModelRuntimeProfile {
  readonly id: LocalModelProfileId
  readonly name: string
  readonly modality: LocalModelModality
  /** Runtime used to load this profile; old built-ins infer it from modality. */
  readonly engine?: LocalModelRuntimeEngine
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
