/** Default Agent model settings layered over a real settings provider. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig, {
  AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE,
  LOCAL_MODEL_UNCONFIGURED_ID,
  LOCAL_MODEL_UNCONFIGURED_PROVIDER,
} from '../src/index.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(localFirst = false): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  defaultModel: AgentDefaultModelConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    localFirst,
  })
  return { ctx, settingsFiber, defaultModel: ctx.agentDefaultModel }
}

describe('AgentDefaultModelConfig', () => {
  it('resolves the user layer over the composition entry', async () => {
    const bench = await boot()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })

    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: 'high',
    })
    await bench.ctx.fiber.dispose()
  })

  it('clears a stored effort when the saved selection has none', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-plain' })
    expect(bench.defaultModel.currentSelection()).toEqual({ provider: 'acme-gateway', model: 'acme-plain' })
    await bench.ctx.fiber.dispose()
  })

  it('layers a hand-written partial section over the entry', async () => {
    const bench = await boot()
    await bench.settingsFiber.ctx.settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      model: 'deepseek-reasoner',
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-reasoner',
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-large' })
    expect(bench.defaultModel.currentSelection().provider).toBe('acme-gateway')
    await bench.settingsFiber.dispose()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    await ctx.agentDefaultModel.saveSelection({ provider: 'other', model: 'other' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'p', model: 'm' })
    await ctx.fiber.dispose()
  })

  it('uses an explicitly configured loopback route for new local-first agents', async () => {
    const bench = await boot(true)
    const PiAiSettings = Schema.object({
      providers: Schema.dict(Schema.object({
        api: Schema.string(),
        baseURL: Schema.string(),
        defaultInput: Schema.array(Schema.string()),
        models: Schema.array(Schema.object({ id: Schema.string(), input: Schema.array(Schema.string()) })),
      })),
    })
    bench.ctx.settings.register('llm-pi-ai', PiAiSettings, {
      base: {
        providers: {
          local: {
            api: 'openai-completions',
            baseURL: 'http://127.0.0.1:8080/v1',
            defaultInput: ['text'],
            models: [
              { id: 'qwen-image', input: ['image'] },
              { id: 'huihui-qwen', input: ['text'] },
            ],
          },
          hosted: {
            api: 'openai-completions',
            baseURL: 'https://api.example/v1',
            defaultInput: ['text'],
            models: [{ id: 'hosted-model', input: ['text'] }],
          },
        },
      },
    })
    expect(bench.defaultModel.currentSelection()).toEqual({ provider: 'local', model: 'huihui-qwen' })
    await bench.ctx.fiber.dispose()
  })

  it('does not choose a loopback image-only model as a text Agent default', async () => {
    const bench = await boot(true)
    const PiAiSettings = Schema.object({
      providers: Schema.dict(Schema.object({
        api: Schema.string(),
        baseURL: Schema.string(),
        defaultInput: Schema.array(Schema.string()),
        models: Schema.array(Schema.object({ id: Schema.string(), input: Schema.array(Schema.string()) })),
      })),
    })
    bench.ctx.settings.register('llm-pi-ai', PiAiSettings, {
      base: {
        providers: {
          image: {
            api: 'openai-completions',
            baseURL: 'http://127.0.0.1:8080/v1',
            defaultInput: ['image'],
            models: [{ id: 'qwen-image', input: ['image'] }],
          },
        },
      },
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: LOCAL_MODEL_UNCONFIGURED_PROVIDER,
      model: LOCAL_MODEL_UNCONFIGURED_ID,
    })
    await bench.ctx.fiber.dispose()
  })

  it('fails closed when no configured loopback model exists', async () => {
    const bench = await boot(true)
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: LOCAL_MODEL_UNCONFIGURED_PROVIDER,
      model: LOCAL_MODEL_UNCONFIGURED_ID,
    })
    await bench.ctx.fiber.dispose()
  })

  it('does not reuse a previously selected DeepSeek route as the local-first default', async () => {
    const bench = await boot(true)
    await bench.defaultModel.saveSelection({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: LOCAL_MODEL_UNCONFIGURED_PROVIDER,
      model: LOCAL_MODEL_UNCONFIGURED_ID,
    })
    await bench.ctx.fiber.dispose()
  })

  it('preserves an explicit user choice for another provider', async () => {
    const bench = await boot(true)
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-large' })
    expect(bench.defaultModel.currentSelection()).toEqual({ provider: 'acme-gateway', model: 'acme-large' })
    await bench.ctx.fiber.dispose()
  })
})
