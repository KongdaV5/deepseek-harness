/** Desktop launch facts keep machine Local resources separate from isolated Harness persistence. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { initializeDesktopCustomProfile } from '../src/index.ts'
import { desktopHostEnvironment, resolveDesktopDataBoundary } from '../../desktop/src/data-boundary.ts'
import { resolveDesktopRuntimeProductFlavor } from '../../desktop/src/product-flavor.ts'
import { SystemLocalModelRuntimeDriver } from '../../../packages/boot/custom-foundation/src/local-runtime.ts'

const custom = resolveDesktopRuntimeProductFlavor(true, {
  dshDesktopProductFlavor: 'ds-harness', dshDesktopAppId: 'dev.dsh.desktop.custom',
})

it('boots isolated data with explicit account resources despite a fake process HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-machine-home-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const fakeHome = join(root, 'fake-home')
  vi.stubEnv('HOME', fakeHome)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const machineResourceHome = resolve('/Users/example')
  const boundary = resolveDesktopDataBoundary(custom, {}, undefined, join(root, 'qualification'))
  const environment = desktopHostEnvironment(boundary, { HOME: fakeHome, DSH_HOME: join(root, 'forbidden-dsh'),
    DSH_DESKTOP_MACHINE_RESOURCE_HOME: fakeHome }, machineResourceHome)
  expect(environment.HOME).toBe(join(root, 'qualification', 'home'))
  expect(environment.DSH_HOME).toBe(boundary.dshHome)
  expect(environment.DSH_DESKTOP_MACHINE_RESOURCE_HOME).toBe(machineResourceHome)
  expect(boundary.profile).toBe(join(boundary.dshHome, 'profiles', 'desktop-custom'))
  expect(boundary.electronUserData).toEqual({ mode: 'explicit', path: join(root, 'qualification', 'electron', 'ds-harness') })
  if (process.platform !== 'win32') expect(homedir()).toBe(fakeHome)

  expect(await initializeDesktopCustomProfile(boundary.profile, environment)).toBe(boundary.profile)
  const rows = z.array(z.object({ id: z.string(), config: z.record(z.string(), z.unknown()) })).parse(parse(await readFile(join(boundary.profile, 'cordis.patch.yml'), 'utf8')))
  const runtimeConfig = z.object({ machineResourceHome: z.string() }).parse(rows.find(row => row.id === 'local-model-runtime')?.config)
  expect(runtimeConfig.machineResourceHome).toBe(machineResourceHome)
  const profiles = z.object({ localProfiles: z.array(z.object({ id: z.string(), name: z.string(), modality: z.enum(['text', 'image']), modelId: z.string() })) }).parse(rows.find(row => row.id === 'custom-foundation')?.config).localProfiles
  expect(profiles.every(profile => profile.modelId.startsWith(join(machineResourceHome, 'Models')))).toBe(true)
  expect(rows.find(row => row.id === 'agent-default-model')?.config['model']).toBe(profiles[0]?.modelId)
  const route = z.object({ providers: z.record(z.string(), z.object({ models: z.array(z.object({ id: z.string() })) })) }).parse(rows.find(row => row.id === 'llm-pi-ai')?.config)
  expect(route.providers['dsh-local-huihui']?.models[0]?.id).toBe(profiles[0]?.modelId)

  const execute = vi.fn(async () => '')
  const driver = new SystemLocalModelRuntimeDriver({ inventory: () => profiles, home: runtimeConfig.machineResourceHome, execute })
  onTestFinished(() => driver.dispose())
  await driver.run('runtime-start', 'huihui')
  expect(execute).toHaveBeenCalledWith(join(machineResourceHome, '.local', 'bin', 'local-model'), ['runtime-start', 'huihui'], 240_000)
})

it('preserves normal Custom machine paths and rejects a missing launch owner before profile access', async () => {
  const machineResourceHome = resolve('/Users/example')
  const boundary = resolveDesktopDataBoundary(custom, { HOME: machineResourceHome }, join(machineResourceHome, 'Library', 'Application Support'))
  expect(desktopHostEnvironment(boundary, { HOME: machineResourceHome }, machineResourceHome)).toMatchObject({
    HOME: machineResourceHome, DSH_DESKTOP_MACHINE_RESOURCE_HOME: machineResourceHome, DSH_HOME: boundary.dshHome,
  })
  await expect(initializeDesktopCustomProfile(boundary.profile, { HOME: machineResourceHome })).rejects.toThrow('requires an absolute machine resource home')
  expect(() => desktopHostEnvironment(boundary, {}, 'relative')).toThrow('must be absolute')
})
