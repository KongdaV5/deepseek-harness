import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareDesktopRuntimePackageManifests } from '../scripts/prepare-runtime-package-manifests.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions, extractFile } = builderRequire('@electron/asar') as {
  createPackageWithOptions: (source: string, destination: string, options: { unpack: string }) => Promise<void>
  extractFile: (archive: string, path: string) => Buffer
}
const { createTransformer } = builderRequire('app-builder-lib/out/fileTransformer.js') as {
  createTransformer: (source: string, configuration: object, metadata: undefined, extraTransformer: null) =>
  (file: string) => string | null | undefined | Promise<string | null | undefined>
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('seals Electron Builder-transformed manifests while retaining ordinary integrity checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-manifests-'))
  roots.push(root)
  const dsh = join(root, 'dsh')
  const initial = runtimeFixture(dsh)
  const packageRoot = writePackage(join(dsh, 'node_modules'), 'runtime-manifest-fixture', {
    bugs: { url: 'https://example.invalid/issues' }, scripts: { test: 'must-not-ship' },
  }, 'export const fixture = true\n')
  const manifest = join(packageRoot, 'package.json')
  const ordinaryFile = join(packageRoot, 'index.js')
  const beforeManifest = readFileSync(manifest)
  const beforeOrdinaryFile = readFileSync(ordinaryFile)

  expect(await prepareDesktopRuntimePackageManifests(dsh)).toBe(1)
  const sealed = writeDesktopRuntime(dsh, initial.release, initial.sharedPackages.map(entry => entry.name))
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).resolves.toEqual(sealed)

  const builderTransform = createTransformer(dsh, {}, undefined, null)
  expect(await builderTransform(manifest)).toBeNull()
  const archive = join(root, 'runtime.asar')
  await createPackageWithOptions(dsh, archive, { unpack: '**/*.node' })

  const relativeManifest = 'node_modules/runtime-manifest-fixture/package.json'
  const relativeOrdinaryFile = 'node_modules/runtime-manifest-fixture/index.js'
  const packagedManifest = extractFile(archive, relativeManifest)
  const packagedOrdinaryFile = extractFile(archive, relativeOrdinaryFile)
  const manifestEntry = sealed.files.find(entry => entry.path === relativeManifest)
  const ordinaryEntry = sealed.files.find(entry => entry.path === relativeOrdinaryFile)
  expect(manifestEntry).toMatchObject({ bytes: packagedManifest.length,
    sha256: createHash('sha256').update(packagedManifest).digest('hex') })
  expect(ordinaryEntry).toMatchObject({ bytes: packagedOrdinaryFile.length,
    sha256: createHash('sha256').update(packagedOrdinaryFile).digest('hex') })
  expect(packagedManifest.toString('utf8')).not.toContain('must-not-ship')
  expect(packagedManifest.toString('utf8')).not.toContain('example.invalid')
  expect(packagedOrdinaryFile).toEqual(beforeOrdinaryFile)
  expect(readFileSync(manifest)).not.toEqual(beforeManifest)

  writeFileSync(ordinaryFile, 'export const fixture = false\n')
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow(/integrity/u)
})
