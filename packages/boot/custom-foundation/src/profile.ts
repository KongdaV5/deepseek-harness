/** Custom profile bootstrap over official composition and profile files. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { parse, stringify } from 'yaml'
import { importLegacyCustomSettings } from './legacy.ts'

/** Resolve explicit Local-first configuration with the qualified Huihui model identity.
 * @param userHome OS home supplied by the caller; tests supply an isolated fixture home.
 * @returns Profile patches sharing one exact Local model identity.
 */
export function customLocalPatches(userHome: string): PatchOptions[] {
  const model = join(userHome, 'Models', 'Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-GSQ-RCO-IQ3_S.gguf')
  return [
    { id: 'agent-default-model', config: { provider: 'dsh-local-huihui', model } },
    { id: 'llm-pi-ai', config: { providers: { 'dsh-local-huihui': { displayName: 'Local Huihui Qwen', api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', headers: { Authorization: 'Bearer local' }, llamaCppContextAdmission: { safetyMarginTokens: 4096, minimumOutputTokens: 1024 }, models: [{ id: model, name: 'Huihui Qwen3.8 27B', contextWindow: 65536, maxTokens: 8192 }, { id: join(userHome, 'Models', 'Qwen3.8-27B-GSQ-RCO-GGUF', 'Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'), name: 'Original Qwen3.8 27B', contextWindow: 32768, maxTokens: 8192 }] } } } },
    { id: 'custom-foundation', config: { localProfiles: [{ id: 'huihui', name: 'Huihui Qwen3.8 27B', modality: 'text', modelId: model }, { id: 'img21', name: 'Qwen Image 2.1', modality: 'image', modelId: join(userHome, 'Models', 'Qwen-Image-2.1-mflux-8bit') }, { id: '38', name: 'Original Qwen3.8 27B', modality: 'text', modelId: join(userHome, 'Models', 'Qwen3.8-27B-GSQ-RCO-GGUF', 'Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf') }], selectedLocalProfile: 'huihui', localModelRuntime: true, codexSubscription: true } },
    { id: 'local-model-runtime', config: { machineResourceHome: userHome } },
    { id: 'compaction-basic', config: { modelPolicies: [model, join(userHome, 'Models', 'Qwen3.8-27B-GSQ-RCO-GGUF', 'Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf')].map(model => ({ provider: 'dsh-local-huihui', model, headroomTokens: 4096, maxTokens: 8192 })) } },
  ]
}

/** Initialize the reserved Custom composition and translate the legacy document before Loader mounts Settings.
 * @param home Explicit Custom data root; never inferred from the official home.
 * @param userHome Explicit model-path home, separately owned from Harness data.
 * @returns The Custom profile directory after recoverable legacy import.
 */
export async function initializeCustomProfile(home: string, userHome: string): Promise<string> {
  const dir = join(home, 'profiles', 'desktop-custom')
  const template = PROFILE_TEMPLATES['desktop-custom']
  if (template === undefined) throw new Error('Custom desktop profile template is missing')
  initProfile(dir, template.bundles)
  await importLegacyCustomSettings(home, dir)
  await withFileLock(join(dir, 'package.json'), async () => {
    const path = join(dir, 'cordis.patch.yml')
    const before = await readFile(path, 'utf8')
    const imported = z.array(z.object({
      id: z.string(), config: z.record(z.string(), z.unknown()).optional(),
    }).loose()).parse(parse(before))
    const defaults = customLocalPatches(userHome)
    for (const row of defaults) {
      const existing = imported.findLast(value => value.id === row.id)
      if (row.id === undefined) throw new Error('Custom defaults require an explicit plugin row ID')
      if (existing === undefined) imported.push({ id: row.id, config: row.config as Record<string, unknown> })
      else {
        const defaults = row.config as Record<string, unknown>
        const current = existing.config ?? {}
        existing.config = { ...defaults, ...current }
        // Launcher-owned machine resources cannot be redirected by a stale profile value.
        if (row.id === 'local-model-runtime') existing.config['machineResourceHome'] = userHome
        if (row.id === 'llm-pi-ai') {
          const providerDefaults = z.record(z.string(), z.unknown()).parse(defaults['providers'])
          const providers = {
            ...providerDefaults, ...z.record(z.string(), z.unknown()).parse(current['providers'] ?? {}),
          }
          const local = providers['dsh-local-huihui']
          const standard = providerDefaults['dsh-local-huihui']
          const routeSchema = z.object({
            api: z.string(),
            baseURL: z.string(),
            headers: z.record(z.string(), z.string()).optional(),
            models: z.array(z.object({ id: z.string() }).loose()),
          }).loose()
          const old = routeSchema.safeParse(local)
          const target = routeSchema.parse(standard)
          // The generated pre-0.2 Local alias lacks deployment headers and capacity.
          // Recognize its complete value, never overwrite a user-edited route.
          const legacy = {
            displayName: 'Local Huihui Qwen', api: target.api, baseURL: target.baseURL,
            models: target.models.map((model, index) => ({ id: model.id,
              name: index === 0 ? 'Huihui Qwen3.8 27B (Local)' : 'Qwen3.8 27B IQ3_S (Original, Local profile 38)' })),
          }
          if (isDeepStrictEqual(providers['local-huihui-qwen'], legacy)) {
            // Retain the alias for stored Session selections; new Sessions use the canonical owner.
            providers['local-huihui-qwen'] = { ...target }
            const selection = imported.findLast(value => value.id === 'agent-default-model')
            if (selection?.config?.['provider'] === 'local-huihui-qwen'
              && isDeepStrictEqual(local, standard)
              && target.models.some(model => model.id === selection.config?.['model'])) {
              selection.config['provider'] = 'dsh-local-huihui'
            }
          }
          // Normalize only the exact built-in Local route. Modified routes and inventories keep their owner values.
          if (old.success && old.data.api === target.api && old.data.baseURL === target.baseURL) {
            const isExactM1 = old.data.models.length === 1 && old.data.models[0]?.id === target.models[0]?.id
            const isExactCurrent = old.data.models.length === target.models.length
              && old.data.models.every((value, index) => value.id === target.models[index]?.id)
            if (isExactM1 || isExactCurrent) {
              providers['dsh-local-huihui'] = {
                ...target,
                ...old.data,
                headers: old.data.headers ?? target.headers,
                models: (isExactM1 ? [...old.data.models, ...target.models.slice(1)] : old.data.models).map((value, index) => {
                  const standard = target.models[index]
                  // Upgrade the unchanged generated Huihui declaration; explicit user capacities retain ownership.
                  if (standard !== undefined && Object.keys(value).length === 4 && index === 0 && value['contextWindow'] === 32768 && value['maxTokens'] === 8192
                    && value['name'] === standard['name']) return { ...value, contextWindow: standard['contextWindow'] }
                  return value
                }),
              }
            }
          }
          existing.config['providers'] = providers
        }
      }
    }
    const next = stringify(imported)
    if (next !== before) await writeFileAtomic(path, next, { mode: 0o600 })
  })
  return dir
}
