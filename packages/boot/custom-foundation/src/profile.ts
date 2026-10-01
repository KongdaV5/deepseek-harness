/** Custom profile bootstrap over official composition and profile files. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
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
    { id: 'llm-pi-ai', config: { providers: { 'dsh-local-huihui': { displayName: 'Local Huihui Qwen', api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', models: [{ id: model, name: 'Huihui Qwen3.8 27B', contextWindow: 32768, maxTokens: 8192 }, { id: join(userHome, 'Models', 'Qwen3.8-27B-GSQ-RCO-GGUF', 'Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'), name: 'Original Qwen3.8 27B', contextWindow: 32768, maxTokens: 8192 }] } } } },
    { id: 'custom-foundation', config: { localProfiles: [{ id: 'huihui', name: 'Huihui Qwen3.8 27B', modality: 'text', modelId: model }, { id: 'img21', name: 'Qwen Image 2.1', modality: 'image', modelId: join(userHome, 'Models', 'Qwen-Image-2.1-mflux-8bit') }, { id: '38', name: 'Original Qwen3.8 27B', modality: 'text', modelId: join(userHome, 'Models', 'Qwen3.8-27B-GSQ-RCO-GGUF', 'Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf') }], selectedLocalProfile: 'huihui', localModelRuntime: true, codexSubscription: true } },
  ]
}

/** Initialize the reserved Custom composition and translate the legacy document before Loader mounts Settings.
 * @param home Explicit Custom data root; never inferred from the official home.
 * @param userHome Explicit model-path home, separately owned from Harness data.
 * @returns The Custom profile directory after recoverable legacy import.
 */
export async function initializeCustomProfile(home: string, userHome: string): Promise<string> {
  const dir = join(home, 'profiles', 'desktop-custom')
  initProfile(dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-custom'])
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
        if (row.id === 'llm-pi-ai') {
          const providerDefaults = z.record(z.string(), z.unknown()).parse(defaults['providers'])
          const providers = {
            ...providerDefaults, ...z.record(z.string(), z.unknown()).parse(current['providers'] ?? {}),
          }
          const local = providers['dsh-local-huihui']
          const standard = providerDefaults['dsh-local-huihui']
          const routeSchema = z.object({
            api: z.string(), baseURL: z.string(), models: z.array(z.object({ id: z.string() }).loose()),
          }).loose()
          const old = routeSchema.safeParse(local)
          const target = routeSchema.parse(standard)
          // Upgrade only the exact one-model M1 Custom route. Modified routes and inventories keep their owner values.
          if (old.success && old.data.api === target.api && old.data.baseURL === target.baseURL
            && old.data.models.length === 1 && old.data.models[0]?.id === target.models[0]?.id) {
            providers['dsh-local-huihui'] = { ...old.data, models: [...old.data.models, ...target.models.slice(1)] }
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
