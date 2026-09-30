/** Codex configuration and durable mapping foundation; execution is supplied by M2. */
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-config-editor'
import { codexSubscriptionProjection } from './projection.ts'
import type { CodexRuntimePreference } from './types.ts'
export { codexSubscriptionProjection, mappingSchema, EMPTY_CODEX_MAPPING, codexMappingRecovery } from './projection.ts'
export type * from './types.ts'

/** Persisted non-secret authentication transaction; configuration edits never advance it. */
export interface AuthTransitionRecord {
  /** Stable pending transaction identity. */
  readonly id: string
  /** Explicit lifecycle operation whose completion belongs to the runtime. */
  readonly kind: 'login' | 'logout' | 'invalidated'
}
/** Plugin-owned preference and non-secret lifecycle facts. */
export interface Config {
  /** Runtime selection preference; edits retain authentication authority. */
  preference: Volatile<CodexRuntimePreference>
  /** Non-secret account/thread binding; only the auth transaction owner may advance it. */
  authGeneration: Volatile<string | undefined>
  /** Pending auth transaction marker; Config migration never completes it. */
  authTransition: Volatile<AuthTransitionRecord | null | undefined>
}
/** M1 owner of Codex Config and Session projection, without a process or dispatch capability. */
export class CodexFoundation extends Service {
  static inject = ['sessionProjections', 'configEditor']
  static Config = z.object({
    preference: z.union(['auto', 'system', 'bundled']).default('auto').volatile(),
    authGeneration: z.string().min(1).volatile().hidden(),
    authTransition: z.union([z.object({ id: z.string().min(1).required(), kind: z.union(['login', 'logout', 'invalidated']).required() }), z.const(null)]).volatile().hidden(),
  })
  /** Mount the Config reader and projection for this plugin lifetime.
   * @param ownerContext Profile-owned plugin context.
   * @param config Live canonical Config fields.
   */
  constructor(private readonly ownerContext: Context, private readonly config: Config) {
    super(ownerContext, 'codexFoundation')
    ownerContext.sessionProjections.register(codexSubscriptionProjection)
  }
  /** Read non-secret persisted facts without starting auth or creating a generation.
   * @returns Detached configuration for the M2 runtime owner.
   */
  snapshot(): { preference: CodexRuntimePreference; authGeneration?: string; authTransition?: AuthTransitionRecord | null } {
    const generation = this.config.authGeneration.get()
    const transition = this.config.authTransition.get()
    return {
      preference: this.config.preference.get(),
      ...generation === undefined ? {} : { authGeneration: generation },
      ...transition === undefined ? {} : { authTransition: structuredClone(transition) },
    }
  }
  /** Save a runtime preference through the profile editor, preserving lifecycle facts.
   * @param preference Explicit runtime selection.
   * @returns Fulfillment after the profile patch is reconciled.
   */
  async savePreference(preference: CodexRuntimePreference): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) throw new Error('Codex preference requires a profile-owned entry')
    await this.ownerContext.configEditor.edit(entry, current => ({ ...current, preference }))
  }
}
export default CodexFoundation

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Custom-owned configuration reader; execution belongs to the M2 runtime. */
    codexFoundation: CodexFoundation
  }
}
