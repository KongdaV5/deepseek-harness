/** Custom profile configuration; no runtime driver, scheduler, authentication or inference. */
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
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
  static Config = z.object({
    localProfiles: z.array(z.object({ id: z.string().required(), name: z.string().required(), modality: z.union(['text', 'image']).required(), modelId: z.string().required() })).default([]).volatile(),
    selectedLocalProfile: z.string().default('huihui').volatile(),
    localModelRuntime: z.boolean().default(true).volatile(),
    codexSubscription: z.boolean().default(true).volatile(),
    legacyImportDigest: z.string(),
  })
  /** Mount the sole reader of Custom product configuration.
   * @param ctx Plugin lifetime context.
   * @param config Live canonical Config fields.
   */
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'customFoundation') }
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
