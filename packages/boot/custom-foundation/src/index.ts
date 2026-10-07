/** Custom profile configuration; no runtime driver, scheduler, authentication or inference. */
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-config-editor'
export { importLegacyCustomSettings, translateLegacyCustomSettings } from './legacy.ts'
export { customLocalPatches, initializeCustomProfile } from './profile.ts'

/** Local manager inventory persisted independently of live runtime observations. */
export interface LocalProfile {
  /** Stable manager profile identity. */
  id: string
  /** User-facing model name. */
  name: string
  /** Model modality, without runtime availability inference. */
  modality: 'text' | 'image'
  /** Loader for newly registered profiles; built-in legacy rows infer it. */
  engine?: 'llama.cpp' | 'mflux-qwen21'
  /** Exact provider model identity. */
  modelId: string
}
/** Custom-owned configuration; model-provider credentials and routing remain owned by llm-pi-ai. */
export interface Config {
  /** Persisted manager inventory; live health is owned by the runtime. */
  localProfiles: Volatile<LocalProfile[]>
  /** Selected manager profile; model routing is separately owned by agent-default-model. */
  selectedLocalProfile: Volatile<string>
  /** User intent to expose Local controls; it does not start a process. */
  localModelRuntime: Volatile<boolean>
  /** User intent to expose Codex controls; it does not authenticate. */
  codexSubscription: Volatile<boolean>
  /** Completed import identity retained for interruption recovery. */
  legacyImportDigest?: string
}
/** Read-only foundation used by M2 Local and Desktop consumers. */
export class CustomFoundation extends Service {
  static inject = ['configEditor']
  static Config = z.object({
    localProfiles: z.array(z.object({ id: z.string().required(), name: z.string().required(), modality: z.union(['text', 'image']).required(), modelId: z.string().required(), engine: z.union(['llama.cpp', 'mflux-qwen21']) })).default([]).volatile(),
    selectedLocalProfile: z.string().default('huihui').volatile(),
    localModelRuntime: z.boolean().default(true).volatile(),
    codexSubscription: z.boolean().default(true).volatile(),
    legacyImportDigest: z.string(),
  })
  /** Mount the sole reader of Custom product configuration.
   * @param ownerContext Plugin lifetime context.
   * @param config Live canonical Config fields.
   */
  constructor(private readonly ownerContext: Context, private readonly config: Config) { super(ownerContext, 'customFoundation') }
  /** Persist only an explicitly selected, healthy manager profile through the canonical editor.
   * @param profile The exact inventory identity confirmed by the runtime.
   * @returns Atomic profile publication and live reconciliation completion.
   */
  async saveSelectedProfile(profile: string): Promise<void> {
    if (!this.snapshot().profiles.some(row => row.id === profile)) throw new Error('Unknown Local profile')
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) throw new Error('Local intent requires a profile-owned entry')
    await this.ownerContext.configEditor.edit(entry, current => ({ ...current, selectedLocalProfile: profile }))
  }
  /** Register one user-installed model with the active Custom profile.
   * @param profile Exact local model identity and supported runtime.
   */
  async addLocalProfile(profile: LocalProfile): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) throw new Error('Local profile requires a profile-owned entry')
    await this.ownerContext.configEditor.edit(entry, (current) => {
      const profiles = Array.isArray(current.localProfiles) ? current.localProfiles as LocalProfile[] : []
      if (profiles.some(row => row.id === profile.id)) throw new Error(`Local profile "${profile.id}" already exists`)
      return { ...current, localProfiles: [...profiles, {
        id: profile.id, name: profile.name, modality: profile.modality, modelId: profile.modelId,
        ...(profile.engine === undefined ? {} : { engine: profile.engine }),
      }] }
    })
  }
  /** Remove a user-installed model from the active Custom profile.
   * @param id Exact local profile identity.
   */
  async removeLocalProfile(id: string): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) throw new Error('Local profile requires a profile-owned entry')
    await this.ownerContext.configEditor.edit(entry, (current) => {
      const profiles = Array.isArray(current.localProfiles) ? current.localProfiles as LocalProfile[] : []
      return { ...current, localProfiles: profiles.filter(row => row.id !== id) }
    })
  }
  /** Read persistent Local profile intent without inspecting user files or starting runtime work.
   * @returns Detached inventory and user preferences.
   */
  snapshot(): { profiles: readonly LocalProfile[]; selectedProfile: string; localModelRuntime: boolean; codexSubscription: boolean } {
    return {
      profiles: structuredClone(this.config.localProfiles.get()), selectedProfile: this.config.selectedLocalProfile.get(),
      localModelRuntime: this.config.localModelRuntime.get(), codexSubscription: this.config.codexSubscription.get(),
    }
  }
}
export default CustomFoundation

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Custom-owned configuration reader; execution belongs to the M2 runtime. */
    customFoundation: CustomFoundation
  }
}

export { LocalModelRuntimeController } from './local-runtime.ts'
