/** Isolated real profile edits, one-way imports, and Local-first composition. */
import { readFile, writeFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { parse, stringify } from 'yaml'
import { boot, initProfile, readProfilePatches, composeEntries, loadOptionalPatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Projections from '@deepseek-ai/dsh-session-projection'
import Codex from '@deepseek-ai/dsh-agent-codex'
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

it('composes actual official bundle layers with Schedule, Computer Use and hosted defaults excluded', () => {
  const layers = ['base', 'web-app', 'desktop-custom'].map(name => loadOptionalPatches('test', fileURLToPath(new URL(`../../../bundle/${name}/cordis.patch.yml`, import.meta.url))) ?? [])
  const entries = composeEntries([...layers, customLocalPatches('/fixture')])
  const enabled = entries.filter(entry => entry.disabled !== true)
  for (const id of ['deepseek-account', 'llm-deepseek', 'timer', 'session-title-llm']) expect(enabled.some(entry => entry.id === id)).toBe(false)
  expect(enabled.map(entry => entry.name).some(name => /schedule|automation|computer-use|cua-driver/i.test(name ?? ''))).toBe(false)
  expect(enabled.find(entry => entry.id === 'agent-default-model')?.config).toMatchObject({ provider: 'dsh-local-huihui' })
  for (const id of ['custom-foundation', 'agent-codex', 'task-checkpoint', 'config-editor']) expect(enabled.some(entry => entry.id === id)).toBe(true)
})
