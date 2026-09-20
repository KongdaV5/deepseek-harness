import { createProfileResolutionGeneration, composeEntries, loadOverlayPatches, loadProfileDirectory, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertDesktopCompositionBundles,
  assertDesktopCustomProfileManifest,
  DESKTOP_CUSTOM_COMPOSITION,
} from '../src/desktop-composition.ts'
import { DesktopProjectManager, createPluginProfile } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-composition-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop-custom current-upstream composition', () => {
  it('extends the current Web profile layers with the DS Harness capability layer', () => {
    expect(DESKTOP_CUSTOM_COMPOSITION.profileName).toBe('desktop-custom')
    expect(DESKTOP_CUSTOM_COMPOSITION.upstreamTemplate).toBe('web')
    // The composed prefix stays exactly upstream; the DS Harness layer appends.
    expect(DESKTOP_CUSTOM_COMPOSITION.bundles).toEqual([
      ...PROFILE_TEMPLATES.web!.bundles,
      '@deepseek-ai/dsh-desktop-custom',
    ])
    expect(DESKTOP_CUSTOM_COMPOSITION.customEntryIds).toEqual([
      'task-checkpoint',
      'agent-run-policy',
      'compaction-task-aware-policy',
      'run-details',
      'ui-run-details',
    ])
    expect(new Set(DESKTOP_CUSTOM_COMPOSITION.bundles).size).toBe(DESKTOP_CUSTOM_COMPOSITION.bundles.length)
  })

  it('initializes a fresh profile without legacy patch lifecycle metadata', () => {
    const profile = join(temporaryRoot(), 'profiles', 'desktop-custom')
    createPluginProfile(profile)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as Record<string, unknown>
    assertDesktopCustomProfileManifest(manifest)
    expect(manifest).toMatchObject({
      name: 'dsh-profile-desktop-custom',
      dsh: { profile: { bundles: [...DESKTOP_CUSTOM_COMPOSITION.bundles] } },
    })
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).not.toContain('patchReload')
  })

  it('rejects duplicate or retired layers instead of guessing a composition', () => {
    expect(() => { assertDesktopCompositionBundles([
      ...DESKTOP_CUSTOM_COMPOSITION.bundles,
      DESKTOP_CUSTOM_COMPOSITION.bundles[0]!,
    ]) }).toThrow('duplicate package')
    expect(() => { assertDesktopCompositionBundles([
      ...DESKTOP_CUSTOM_COMPOSITION.bundles,
      '@deepseek-ai/dsh-desktop-custom-composition',
    ]) }).toThrow('legacy Custom composition')
  })

  it('resolves the fresh profile through the upstream package-generation path', async () => {
    const root = temporaryRoot()
    const dsh = join(root, 'resources', 'dsh')
    runtimeFixture(dsh)
    const home = join(root, '.dsh')
    const manager = new DesktopProjectManager(resolveDesktopPaths(home, 'desktop-custom'), { dsh })
    await manager.applyRelease()
    const installAnchor = join(dsh, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const profile = loadProfileDirectory('dsh', manager.paths.profile, installAnchor)
    expect(profile.layers.map(layer => layer.packageName)).toEqual([...DESKTOP_CUSTOM_COMPOSITION.bundles])
    const generation = await createProfileResolutionGeneration({ installAnchor, profile, home })
    const names = generation.entries.map(entry => entry.name)
    expect(names).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-desktop-custom',
      '@deepseek-ai/cordis',
    ]))
    expect(new Set(names).size).toBe(names.length)
    expect(generation.profileDir).toBe(manager.paths.profile)
  })

  it('composes current upstream rows once, then the DS Harness rows once', () => {
    const repository = resolve(import.meta.dirname, '..', '..', '..')
    const base = loadOverlayPatches('dsh', join(repository, 'packages/bundle/base/cordis.patch.yml'))
    const web = loadOverlayPatches('dsh', join(repository, 'packages/bundle/web-app/cordis.patch.yml'))
    const custom = loadOverlayPatches('dsh', join(repository, 'packages/bundle/desktop-custom/cordis.patch.yml'))
    const entries = composeEntries([base, web, custom])
    const ids = entries.map(entry => entry.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(['agent-loop', 'webserver', 'modules', 'connection']))
    // Every declared custom row is present exactly once, and no custom row id
    // collides with an inherited upstream row.
    expect(ids.filter(id => DESKTOP_CUSTOM_COMPOSITION.customEntryIds.includes(id)))
      .toEqual([...DESKTOP_CUSTOM_COMPOSITION.customEntryIds])
    // The layer restates the inherited executor rather than inserting a second
    // one: the row id stays single and the DS validation budget applies.
    const executor = entries.filter(entry => entry.id === 'compaction-basic')
    expect(executor).toHaveLength(1)
    expect(executor[0]).toMatchObject({
      name: '@deepseek-ai/dsh-compaction-basic',
      disabled: false,
      config: { maxSummaryValidationRetries: 1 },
    })
  })
})
