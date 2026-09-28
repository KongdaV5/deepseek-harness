/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isIP } from 'node:net'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** Stored and composed default model selection. */
export interface AgentDefaultModelSettings {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/** Composition entry for the default model selection. */
export interface Config {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Prefer an explicitly configured OpenAI-compatible loopback route for Custom deployments. */
  localFirst?: boolean
}

/** Route used until a loopback model is configured; it is deliberately unregistered. */
export const LOCAL_MODEL_UNCONFIGURED_PROVIDER = 'dsh-local-unconfigured'
/** Model marker paired with {@link LOCAL_MODEL_UNCONFIGURED_PROVIDER}. */
export const LOCAL_MODEL_UNCONFIGURED_ID = 'select-local-model'
const HOSTED_DEEPSEEK_ROUTES = new Set(['deepseek-official'])

interface PiAiModelView {
  readonly id?: unknown
  readonly input?: unknown
}

interface PiAiProfileView {
  readonly baseURL?: unknown
  readonly api?: unknown
  readonly models?: unknown
  readonly defaultInput?: unknown
}

interface PiAiSettingsView {
  readonly providers?: unknown
}

/** Pick the first configured text model whose endpoint is unambiguously loopback. */
export function localModelSelection(descriptor: SettingsDescriptor | undefined): ModelSelection | undefined {
  if (descriptor === undefined || typeof descriptor.value !== 'object' || descriptor.value === null) return undefined
  const providers = (descriptor.value as PiAiSettingsView).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return undefined
  for (const [provider, candidate] of Object.entries(providers)) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const profile = candidate as PiAiProfileView
    if (typeof profile.baseURL !== 'string' || !isLoopbackUrl(profile.baseURL)) continue
    if (profile.api !== 'openai-completions' && profile.api !== 'openai-responses') continue
    if (!Array.isArray(profile.models)) continue
    const model = profile.models.find((entry: unknown): entry is PiAiModelView => {
      if (typeof entry !== 'object' || entry === null || typeof (entry as PiAiModelView).id !== 'string') return false
      const modelInput = (entry as PiAiModelView).input
      const input = Array.isArray(modelInput) && modelInput.length > 0 ? modelInput : profile.defaultInput
      // An omitted modality follows the OpenAI-compatible text default. An
      // explicit image-only claim must never become a text Agent default.
      return !Array.isArray(input) || input.length === 0 || input.includes('text')
    })
    if (model !== undefined && typeof model.id === 'string') return { provider, model: model.id }
  }
  return undefined
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username !== '' || url.password !== '') return false
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    return host === 'localhost' || host.endsWith('.localhost') || (isIP(host) === 4 && host.startsWith('127.')) || host === '::1'
  } catch {
    return false
  }
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: AgentDefaultModelSettings): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    localFirst: z.boolean().default(false),
  })

  private source: () => AgentDefaultModelSettings
  private readonly localFirst: boolean

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentDefaultModel')
    const entry: AgentDefaultModelSettings = { provider: config.provider, model: config.model }
    this.localFirst = config.localFirst === true
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
        setSource: (current) => { this.source = current },
        // Every consumer reads through currentSelection(), so no registration-level fact
        // needs rebuilding when the settings document changes.
        onChange: () => {},
      })
    })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const current = selection(this.source())
    if (!this.localFirst || (this.hasUserSelection() && !HOSTED_DEEPSEEK_ROUTES.has(current.provider))) return current
    const local = localModelSelection(this.ctx.get('settings')?.describe().find(({ ns }) => ns === 'llm-pi-ai'))
    return local ?? {
      provider: LOCAL_MODEL_UNCONFIGURED_PROVIDER,
      model: LOCAL_MODEL_UNCONFIGURED_ID,
    }
  }

  private hasUserSelection(): boolean {
    const user = this.ctx.get('settings')?.describe()
      .find(({ ns }) => ns === AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE)?.user
    if (typeof user !== 'object' || user === null) return false
    return typeof Reflect.get(user, 'provider') === 'string' || typeof Reflect.get(user, 'model') === 'string'
  }

  /**
   * Save the complete default model selection. A deployment without a settings
   * provider keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    await this.ctx.get('settings')?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      provider: next.provider,
      model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    })
  }
}

export default AgentDefaultModelConfig
