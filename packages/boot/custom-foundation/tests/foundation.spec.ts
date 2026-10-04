/** Isolated real profile edits, one-way imports, and Local-first composition. */
import { readFile, writeFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { boot, initProfile, readProfilePatches, composeEntries, loadOptionalPatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Projections from '@deepseek-ai/dsh-session-projection'
import { CodexFoundation as Codex } from '@deepseek-ai/dsh-agent-codex'
import Custom, { customLocalPatches, initializeCustomProfile, importLegacyCustomSettings, translateLegacyCustomSettings } from '../src/index.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-m1-config-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, 'profiles', 'desktop-custom')
  initProfile(dir, ['test-bundle'])
  await writeFile(join(home, 'package.json'), '{}\n')
  const bundle = join(dir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'session-projection', name: 'cordis:projections' },
    { id: 'agent-codex', name: 'cordis:codex', config: { authGeneration: 'account-generation', authTransition: { id: 'pending-auth', kind: 'login' } } },
    { id: 'custom-foundation', name: 'cordis:custom' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'desktop-custom', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), startedBundles: ['test-bundle'], overlays: [], telemetryDisabledEnv: undefined }
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
      ctx.provide('profileContext', profile)
      Object.assign(ctx.loader.builtins, {
        editor: ConfigEditor, settings: Settings, projections: Projections, codex: Codex, custom: Custom,
      })
    })
    onTestFinished(() => ctx.fiber.dispose())
    return ctx
  }
  return { home, dir, start, legacy: join(home, 'settings.yaml'), patch: join(dir, 'cordis.patch.yml') }
}

it('edits live preference through ConfigEditor without replacing auth authority or plugin lifetime', async () => {
  const f = await fixture(); const ctx = await f.start()
  const owner = ctx.codexFoundation
  const lifetime = ctx.configEditor.entries().find(entry => entry.options.id === 'agent-codex')?.fiber?.uid
  expect(lifetime).toBeTruthy()
  await owner.savePreference('system')
  expect(ctx.configEditor.entries().find(entry => entry.options.id === 'agent-codex')?.fiber?.uid).toBe(lifetime)
  expect(ctx.codexFoundation.snapshot()).toEqual(owner.snapshot())
  expect(owner.snapshot()).toEqual({ preference: 'system', authGeneration: 'account-generation', authTransition: { id: 'pending-auth', kind: 'login' } })
  await ctx.fiber.dispose()
  const restarted = await f.start()
  expect(restarted.codexFoundation.snapshot()).toEqual(owner.snapshot())
})

it('has one Config owner for Local inventory and updates it live', async () => {
  const f = await fixture(); const ctx = await f.start(); const owner = ctx.customFoundation
  await ctx.settings.update('custom-foundation', { localProfiles: [{ id: 'huihui', name: 'Huihui', modality: 'text', modelId: '/fixture/model' }], selectedLocalProfile: 'huihui' })
  expect(ctx.customFoundation.snapshot()).toEqual(owner.snapshot())
  expect(owner.snapshot().profiles[0]?.modelId).toBe('/fixture/model')
})

it('imports valid Custom values once and retains exact non-secret auth transaction', async () => {
  const f = await fixture()
  const source = stringify({ 'openai-codex-runtime': { preference: 'system', authGeneration: 'epoch-7', authTransition: { id: 'pending', kind: 'logout' } }, 'custom-foundation': { selectedLocalProfile: 'huihui' }, 'ui-theme': { preference: 'dark', fontSize: 16 } })
  await writeFile(f.legacy, source)
  expect((await importLegacyCustomSettings(f.home, f.dir)).status).toBe('imported')
  expect(await readFile(`${f.legacy}.imported`, 'utf8')).toBe(source)
  const before = await readFile(f.patch, 'utf8')
  expect((await importLegacyCustomSettings(f.home, f.dir)).status).toBe('already-imported')
  expect(await readFile(f.patch, 'utf8')).toBe(before)
  expect(parse(before)).toContainEqual({ id: 'agent-codex', config: { preference: 'system', authGeneration: 'epoch-7', authTransition: { id: 'pending', kind: 'logout' } } })
})

it.each([{}, { 'openai-codex-runtime': { preference: 'bundled' } }, { 'settings-controller': { localModelRuntime: false } }])('imports partial settings safely: %j', async (source) => {
  const f = await fixture(); await writeFile(f.legacy, stringify(source))
  expect((await importLegacyCustomSettings(f.home, f.dir)).status).toBe('imported')
})

it('archives unknown sections without inventing a configuration owner', async () => {
  const f = await fixture(); await writeFile(f.legacy, 'unknown-feature:\n  intent: retained\n')
  expect((await importLegacyCustomSettings(f.home, f.dir)).unknownSections).toEqual(['unknown-feature'])
  expect(await readFile(`${f.legacy}.imported`, 'utf8')).toContain('retained')
  expect(await readFile(f.patch, 'utf8')).not.toContain('unknown-feature')
})

it.each([{ 'openai-codex-runtime': { preference: 'other' } }, { 'custom-foundation': { selectedLocalProfile: 42 } }, { 'llm-pi-ai': { providers: [] } }])('refuses invalid sections before changing canonical state: %j', async (source) => {
  const f = await fixture(); await writeFile(f.legacy, stringify(source)); const before = await readFile(f.patch, 'utf8')
  await expect(importLegacyCustomSettings(f.home, f.dir)).rejects.toThrow()
  expect(await readFile(f.patch, 'utf8')).toBe(before)
  expect(await readFile(f.legacy, 'utf8')).toBe(stringify(source))
})

it('recovers publication-before-archive interruption without overwriting newer profile edits', async () => {
  const f = await fixture(); const source = 'openai-codex-runtime:\n  preference: system\n'
  await writeFile(f.legacy, source); await importLegacyCustomSettings(f.home, f.dir)
  await rename(`${f.legacy}.imported`, f.legacy)
  const rows = parse(await readFile(f.patch, 'utf8')) as Array<{ id: string; config: Record<string, unknown> }>
  const codex = rows.find(row => row.id === 'agent-codex')!; codex.config['preference'] = 'bundled'
  await writeFile(f.patch, stringify(rows)); const before = await readFile(f.patch, 'utf8')
  expect((await importLegacyCustomSettings(f.home, f.dir)).status).toBe('already-imported')
  expect(await readFile(f.patch, 'utf8')).toBe(before)
})

it('recovers a legacy partial import whose source was already archived', async () => {
  const f = await fixture(); await writeFile(`${f.legacy}.imported`, 'openai-codex-runtime:\n  preference: system\n  authGeneration: preserved\n')
  await writeFile(f.patch, stringify([{ id: 'agent-codex', config: { preference: 'bundled' } }]))
  await importLegacyCustomSettings(f.home, f.dir)
  expect(parse(await readFile(f.patch, 'utf8'))).toContainEqual({ id: 'agent-codex', config: { preference: 'bundled', authGeneration: 'preserved' } })
})

it('refuses competing authentication authority without replacing either value', async () => {
  const f = await fixture(); await writeFile(f.patch, stringify([{ id: 'agent-codex', config: { authGeneration: 'current' } }]))
  await writeFile(f.legacy, 'openai-codex-runtime:\n  authGeneration: competing\n'); const before = await readFile(f.patch, 'utf8')
  await expect(importLegacyCustomSettings(f.home, f.dir)).rejects.toThrow('authentication authority')
  expect(await readFile(f.patch, 'utf8')).toBe(before)
})

it('initializes Local Huihui and excludes the inherited hosted default without probing a model', async () => {
  const f = await fixture(); await writeFile(f.legacy, 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n')
  const dir = await initializeCustomProfile(f.home, f.home)
  const rows = parse(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: Record<string, unknown> }>
  const choice = rows.find(row => row.id === 'agent-default-model')!
  expect(choice.config['provider']).toBe('dsh-local-huihui')
  expect(choice.config['model']).toContain('Huihui-Qwen')
  expect(customLocalPatches(f.home)).toEqual(customLocalPatches(f.home))
})

it('refreshes the launcher resource home while preserving explicitly configured Local model identities', async () => {
  const f = await fixture()
  await initializeCustomProfile(f.home, f.home)
  const rows = parse(await readFile(f.patch, 'utf8')) as Array<{ id: string; config: Record<string, unknown> }>
  const choice = rows.find(row => row.id === 'agent-default-model')!
  choice.config['model'] = '/user-selected/custom-model.gguf'
  const runtime = rows.find(row => row.id === 'local-model-runtime')!
  runtime.config = { machineResourceHome: '/stale/home', driver: 'owned-process', endpoint: 'http://127.0.0.1:18080/v1' }
  await writeFile(f.patch, stringify(rows))
  await initializeCustomProfile(f.home, f.home)
  const output = parse(await readFile(f.patch, 'utf8')) as Array<{ id: string; config: Record<string, unknown> }>
  expect(output.find(row => row.id === 'agent-default-model')?.config['model']).toBe('/user-selected/custom-model.gguf')
  expect(output.find(row => row.id === 'local-model-runtime')?.config).toEqual({ machineResourceHome: f.home, driver: 'owned-process', endpoint: 'http://127.0.0.1:18080/v1' })
})

it('translates required UI preferences to their official plugin owners', () => {
  expect(translateLegacyCustomSettings({ 'ui-onboarding': { welcomeNoticeVersion: '1' }, 'ui-developer-tools': { enabled: false } }).rows).toEqual([
    { id: 'ui-settings-general', config: { welcomeNoticeVersion: '1' } }, { id: 'ui-settings', config: { enabled: false } },
  ])
})


it('refuses a competing legacy archive before publishing any profile change', async () => {
  const f = await fixture()
  await writeFile(f.legacy, 'openai-codex-runtime:\n  preference: system\n')
  await writeFile(`${f.legacy}.imported`, 'unknown: preserved\n')
  const before = await readFile(f.patch, 'utf8')
  await expect(importLegacyCustomSettings(f.home, f.dir)).rejects.toThrow('archive conflicts')
  expect(await readFile(f.patch, 'utf8')).toBe(before)
  expect(await readFile(`${f.legacy}.imported`, 'utf8')).toBe('unknown: preserved\n')
})

it('retains imported providers while supplying the exact Local-first route and repeatable defaults', async () => {
  const f = await fixture()
  await writeFile(f.legacy, stringify({ 'llm-pi-ai': { providers: { custom: { api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', models: [{ id: 'other-local', name: 'Other Local' }] } } } }))
  await initializeCustomProfile(f.home, f.home)
  const before = await readFile(f.patch, 'utf8')
  const rows = parse(before) as Array<{ id: string; config: Record<string, unknown> }>
  const providers = rows.find(row => row.id === 'llm-pi-ai')!.config['providers']
  expect(providers).toHaveProperty('custom')
  expect(providers).toHaveProperty('dsh-local-huihui')
  await initializeCustomProfile(f.home, f.home)
  expect(await readFile(f.patch, 'utf8')).toBe(before)
})

it('composes the explicit official Schedule bundle with Custom while keeping cloud defaults and Computer Use off', () => {
  const layers = ['bundle/base', 'bundle/web-app', 'experimental/schedule-bundle', 'bundle/desktop-custom'].map(name => loadOptionalPatches('test', fileURLToPath(new URL(`../../../../packages/${name}/cordis.patch.yml`, import.meta.url))) ?? [])
  const entries = composeEntries([...layers, customLocalPatches('/fixture')])
  const enabled = entries.filter(entry => entry.disabled !== true)
  for (const id of ['deepseek-account', 'llm-deepseek', 'timer', 'session-title-llm']) expect(enabled.some(entry => entry.id === id)).toBe(false)
  for (const name of ['@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-schedule', '@deepseek-ai/dsh-client-ui-schedule']) {
    expect(enabled.some(entry => entry.name === name)).toBe(true)
  }
  expect(enabled.map(entry => entry.name).some(name => /computer-use|cua-driver/i.test(name ?? ''))).toBe(false)
  expect(enabled.find(entry => entry.id === 'agent-default-model')?.config).toMatchObject({ provider: 'dsh-local-huihui' })
  for (const id of ['custom-foundation', 'agent-codex', 'task-checkpoint', 'config-editor']) expect(enabled.some(entry => entry.id === id)).toBe(true)
})


it('excludes lifecycle facts from generic Settings edits and retains them across replacement', async () => {
  const f = await fixture(); const ctx = await f.start()
  const before = ctx.codexFoundation.snapshot()
  const form = ctx.settings.describe().find(row => row.ns === 'agent-codex')!
  expect(form.value).toEqual({ preference: 'auto' })
  await expect(ctx.settings.update('agent-codex', { authGeneration: 'forged' })).rejects.toThrow('not volatile')
  await expect(ctx.settings.mutate('agent-codex', [{ op: 'set', path: ['authTransition'], value: null }])).rejects.toThrow('not volatile')
  await ctx.settings.replace('agent-codex', { preference: 'bundled' })
  expect(ctx.codexFoundation.snapshot()).toEqual({ ...before, preference: 'bundled' })
  await ctx.codexFoundation.writeLifecycle({ authTransition: null })
  expect(ctx.codexFoundation.snapshot()).toEqual({ ...before, preference: 'bundled', authTransition: null })
  await ctx.fiber.dispose()
  const restarted = await f.start()
  expect(restarted.codexFoundation.snapshot()).toEqual({ ...before, preference: 'bundled', authTransition: null })
})

it('persists healthy Local selection through the same live owner and restart', async () => {
  const f = await fixture(); const ctx = await f.start()
  await ctx.settings.update('custom-foundation', { localProfiles: [{ id: '38', name: 'Original', modality: 'text', modelId: '/fixture/original' }] })
  const owner = ctx.customFoundation
  await owner.saveSelectedProfile('38')
  expect(ctx.customFoundation.snapshot()).toEqual(owner.snapshot())
  expect(owner.snapshot().selectedProfile).toBe('38')
  await expect(owner.saveSelectedProfile('unknown')).rejects.toThrow('Unknown Local profile')
  await ctx.fiber.dispose()
  const restarted = await f.start()
  expect(restarted.customFoundation.snapshot().selectedProfile).toBe('38')
})


it('upgrades only the exact M1 text catalog while preserving Local-first routing and custom provider values', async () => {
  const f = await fixture()
  const rows = customLocalPatches(f.home)
  const llm = rows.find(row => row.id === 'llm-pi-ai')!.config as {
    providers: Record<string, { models: unknown[]; headers?: Record<string, string>; apiKeyEnv?: string }>
  }
  llm.providers['dsh-local-huihui']!.models = llm.providers['dsh-local-huihui']!.models.slice(0, 1)
  delete llm.providers['dsh-local-huihui']!.headers
  await writeFile(f.patch, stringify(rows))
  await initializeCustomProfile(f.home, f.home)
  const output = parse(await readFile(f.patch, 'utf8')) as typeof rows
  const actual = output.find(row => row.id === 'llm-pi-ai')?.config as typeof llm
  expect(actual.providers['dsh-local-huihui']?.models).toHaveLength(2)
  expect(actual.providers['dsh-local-huihui']?.headers).toEqual({ Authorization: 'Bearer local' })
  expect(actual.providers['dsh-local-huihui']?.apiKeyEnv).toBeUndefined()
  expect(output.find(row => row.id === 'agent-default-model')?.config).toEqual(rows[0]?.config)
  const before = await readFile(f.patch, 'utf8'); await initializeCustomProfile(f.home, f.home)
  expect(await readFile(f.patch, 'utf8')).toBe(before)
})

it('normalizes only the generated legacy Local alias and preserves stored route identity', async () => {
  const f = await fixture()
  const rows = customLocalPatches(f.home)
  const llm = rows.find(row => row.id === 'llm-pi-ai')!.config as { providers: Record<string, { displayName: string; api: string; baseURL: string; models: { id: string; name: string }[]; headers?: Record<string, string> }> }
  const canonical = llm.providers['dsh-local-huihui']!
  llm.providers['local-huihui-qwen'] = { displayName: 'Local Huihui Qwen', api: canonical.api, baseURL: canonical.baseURL,
    models: canonical.models.map((model, index) => ({ id: model.id, name: index === 0 ? 'Huihui Qwen3.8 27B (Local)' : 'Qwen3.8 27B IQ3_S (Original, Local profile 38)' })) }
  rows[0]!.config = { provider: 'local-huihui-qwen', model: canonical.models[0]!.id }
  await writeFile(f.patch, stringify(rows))
  await initializeCustomProfile(f.home, f.home)
  const output = parse(await readFile(f.patch, 'utf8')) as typeof rows
  const actual = output.find(row => row.id === 'llm-pi-ai')!.config as typeof llm
  expect(actual.providers['local-huihui-qwen']).toEqual(actual.providers['dsh-local-huihui'])
  expect(actual.providers['local-huihui-qwen']?.headers).toEqual({ Authorization: 'Bearer local' })
  expect(output[0]!.config).toEqual({ provider: 'dsh-local-huihui', model: canonical.models[0]!.id })
  const once = await readFile(f.patch, 'utf8'); await initializeCustomProfile(f.home, f.home)
  expect(await readFile(f.patch, 'utf8')).toBe(once)
  // A separately customized canonical route cannot capture the legacy loopback default.
  const customRows = customLocalPatches(f.home)
  const customLlm = customRows.find(row => row.id === 'llm-pi-ai')!.config as typeof llm
  customLlm.providers['local-huihui-qwen'] = { displayName: 'Local Huihui Qwen', api: canonical.api, baseURL: canonical.baseURL,
    models: canonical.models.map((model, index) => ({ id: model.id, name: index === 0 ? 'Huihui Qwen3.8 27B (Local)' : 'Qwen3.8 27B IQ3_S (Original, Local profile 38)' })) }
  customLlm.providers['dsh-local-huihui']!.baseURL = 'http://127.0.0.1:9080/v1'
  customRows[0]!.config = { provider: 'local-huihui-qwen', model: canonical.models[0]!.id }
  await writeFile(f.patch, stringify(customRows)); await initializeCustomProfile(f.home, f.home)
  const customOutput = parse(await readFile(f.patch, 'utf8')) as typeof rows
  expect(customOutput[0]!.config).toEqual(customRows[0]!.config)
  expect((customOutput.find(row => row.id === 'llm-pi-ai')!.config as typeof llm).providers['local-huihui-qwen']?.baseURL).toBe(canonical.baseURL)
})

it('preserves an explicitly edited legacy Local route and its default selection', async () => {
  const f = await fixture()
  const rows = customLocalPatches(f.home)
  const llm = rows.find(row => row.id === 'llm-pi-ai')!.config as { providers: Record<string, unknown> }
  const customized = { displayName: 'Local Huihui Qwen', api: 'openai-completions', baseURL: 'http://127.0.0.1:9080/v1', models: [{ id: '/custom/model', name: 'Huihui Qwen3.8 27B (Local)' }] }
  llm.providers['local-huihui-qwen'] = customized
  rows[0]!.config = { provider: 'local-huihui-qwen', model: '/custom/model' }
  await writeFile(f.patch, stringify(rows)); await initializeCustomProfile(f.home, f.home)
  const output = parse(await readFile(f.patch, 'utf8')) as typeof rows
  expect((output.find(row => row.id === 'llm-pi-ai')!.config as typeof llm).providers['local-huihui-qwen']).toEqual(customized)
  expect(output[0]!.config).toEqual(rows[0]!.config)
})

it('upgrades only the unchanged Huihui capacity and configures existing Local compaction policies', async () => {
  const f = await fixture()
  await initializeCustomProfile(f.home, f.home)
  const rowSchema = z.array(z.object({ id: z.string(), config: z.record(z.string(), z.unknown()) }))
  const routeSchema = z.object({
    models: z.array(z.object({ id: z.string(), name: z.string(), contextWindow: z.number(), maxTokens: z.number() }).loose()),
    llamaCppContextAdmission: z.object({ safetyMarginTokens: z.number(), minimumOutputTokens: z.number() }).optional(),
  }).loose()
  const readRows = async () => rowSchema.parse(parse(await readFile(f.patch, 'utf8')))
  const readLocal = (rows: z.infer<typeof rowSchema>) => routeSchema.parse(z.record(z.string(), z.unknown()).parse(rows.find(row => row.id === 'llm-pi-ai')!.config['providers'])['dsh-local-huihui'])
  const rows = await readRows()
  const provider = readLocal(rows)
  provider.models[0]!.contextWindow = 32768
  delete provider.llamaCppContextAdmission
  rows.find(row => row.id === 'llm-pi-ai')!.config['providers'] = { 'dsh-local-huihui': provider }
  await writeFile(f.patch, stringify(rows))
  await initializeCustomProfile(f.home, f.home)
  const next = await readRows()
  const local = readLocal(next)
  expect(local.models[0]!.contextWindow).toBe(65536)
  expect(local.models[1]!.contextWindow).toBe(32768)
  expect(local.llamaCppContextAdmission).toEqual({ safetyMarginTokens: 4096, minimumOutputTokens: 1024 })
  const compaction = next.find(row => row.id === 'compaction-basic')!.config['modelPolicies']
  expect(compaction).toEqual(local.models.map((model: { id: string }) => ({ provider: 'dsh-local-huihui', model: model.id, headroomTokens: 4096, maxTokens: 8192 })))
  local.models[0]!.contextWindow = 16384
  next.find(row => row.id === 'llm-pi-ai')!.config['providers'] = { 'dsh-local-huihui': local }
  await writeFile(f.patch, stringify(next))
  await initializeCustomProfile(f.home, f.home)
  expect(readLocal(await readRows()).models[0]!.contextWindow).toBe(16384)
})
