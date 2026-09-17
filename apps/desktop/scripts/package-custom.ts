/** Build one local, ad-hoc-signed Custom Desktop directory without release upload or notarization. */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(appRoot, '..', '..')
const buildRoot = join(appRoot, '.desktop-build', 'targets', 'mac-arm64')
const packedCustom = join(buildRoot, 'packed', 'custom')
const customBundle = '@deepseek-ai/dsh-desktop-custom-composition'

function commandOutput(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
}

/** Write human-inspectable provenance beside the locally packaged application. */
function writeBuildMetadata(): void {
  const desktopManifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }
  const runtimeVersions = JSON.parse(readFileSync(join(buildRoot, 'runtime', 'versions.json'), 'utf8')) as {
    node: string
    pnpm: string
  }
  writeFileSync(join(buildRoot, 'custom-build.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'DS Harness',
    productName: 'DS Harness',
    buildFlavor: 'custom',
    desktopVersion: desktopManifest.version,
    runtime: runtimeVersions,
    source: {
      commit: commandOutput('git', ['rev-parse', 'HEAD']),
      dirty: commandOutput('git', ['status', '--porcelain']) !== '',
    },
    capabilitySet: {
      phase: '2-7',
      compositionPackage: customBundle,
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', customBundle],
    },
    target: { platform: 'darwin', arch: 'arm64' },
    builtAt: new Date().toISOString(),
  }, undefined, 2)}\n`, { mode: 0o600 })
}

function run(args: readonly string[], cwd = repositoryRoot, extra: NodeJS.ProcessEnv = {}): Promise<void> {
  const entry = process.env.npm_execpath
  if (entry === undefined || entry === '') throw new Error('desktop custom package: run through pnpm')
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extra,
        DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
        DSH_DESKTOP_TARGET_ARCH: 'arm64',
        DSH_DESKTOP_BUILD_FLAVOR: 'custom',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', code => code === 0 ? accept() : reject(new Error(`desktop custom package: ${args.join(' ')} exited ${String(code)}`)))
  })
}

async function main(): Promise<void> {
  rmSync(packedCustom, { recursive: true, force: true })
  mkdirSync(packedCustom, { recursive: true })
  await run(['run', 'build:official', '--', '--title', 'DS Harness'])
  await run(['run', 'release:pack', '--family', 'dsh', '--out', join(buildRoot, 'packed', 'dsh')])
  await run(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', join(buildRoot, 'packed', 'dsh')])
  await run(['run', 'release:pack', '--family', 'vendor', '--out', join(buildRoot, 'packed', 'vendor')])
  await run(['--dir', 'native/system', 'run', 'build:ts'])
  await run(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(buildRoot, 'packed', 'landlock')])
  for (const directory of [
    'packages/runtime-diagnostics/desktop-run-diagnostics',
    'packages/client/desktop-run-diagnostics-remote',
    'packages/client/ui-run-details',
    'packages/bundle/desktop-custom-composition',
  ]) await run(['--dir', directory, 'pack', '--pack-destination', packedCustom])
  await run(['run', 'prepare:runtime'], appRoot)
  await run(['run', 'prepare:packages', '--from', join(buildRoot, 'packed', 'dsh'), '--from', join(buildRoot, 'packed', 'vendor'), '--from', join(buildRoot, 'packed', 'landlock'), '--from', packedCustom, '--root', customBundle], appRoot)
  await run(['run', 'prepare:dsh'], appRoot, { DSH_DESKTOP_CUSTOM_BUNDLE: customBundle })
  writeBuildMetadata()
  await run(['exec', 'electron-builder', '--config', 'electron-builder.config.mjs', '--mac', '--arm64', '--dir', '--publish', 'never'], appRoot)
}

await main()
