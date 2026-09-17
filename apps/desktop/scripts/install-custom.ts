/** Install the verified local Custom flavor without touching the formal Desktop. */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

const PRODUCT_NAME = 'DS Harness'
const BUNDLE_ID = 'dev.dsh.desktop.custom'
const appRoot = join(import.meta.dirname, '..')
const source = join(appRoot, '.desktop-build', 'targets', 'mac-arm64', 'custom-artifacts', 'mac-arm64', `${PRODUCT_NAME}.app`)
const applications = '/Applications'
const destination = join(applications, `${PRODUCT_NAME}.app`)
const staging = join(applications, `.${PRODUCT_NAME}.install-${process.pid}.app`)

interface BundleInfo {
  readonly CFBundleDisplayName?: unknown
  readonly CFBundleIdentifier?: unknown
  readonly CFBundleName?: unknown
}

interface CustomBuildInfo {
  readonly buildFlavor?: unknown
  readonly product?: unknown
  readonly productName?: unknown
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Require the specific Custom product before replacing anything in /Applications. */
function assertVerifiedCustomBundle(path: string, role: 'source' | 'staging copy' | 'existing installation'): void {
  if (!existsSync(path)) throw new Error(`DS Harness install: ${role} is absent: ${path}`)
  // plutil emits JSON for an Apple plist without changing the source application.
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents', 'Info.plist')], { encoding: 'utf8' })) as BundleInfo
  const build = readJson(join(path, 'Contents', 'Resources', 'custom-build.json')) as CustomBuildInfo
  if (
    plist.CFBundleIdentifier !== BUNDLE_ID
    || plist.CFBundleDisplayName !== PRODUCT_NAME
    || plist.CFBundleName !== PRODUCT_NAME
    || build.buildFlavor !== 'custom'
    || build.product !== PRODUCT_NAME
    || build.productName !== PRODUCT_NAME
  ) throw new Error(`DS Harness install: refusing to replace unrecognized ${role}: ${path}`)
}

function verifySignature(path: string): void {
  execFileSync('codesign', ['--verify', '--deep', '--strict', path], { stdio: 'inherit' })
}

function main(): void {
  if (process.platform !== 'darwin') throw new Error('DS Harness install: macOS only')
  assertVerifiedCustomBundle(source, 'source')
  verifySignature(source)
  if (existsSync(destination)) assertVerifiedCustomBundle(destination, 'existing installation')
  if (existsSync(staging)) throw new Error(`DS Harness install: stale staging application exists: ${staging}`)
  // Electron Framework embeds symlinked versioned resources. Dereferencing them
  // changes the sealed bundle tree and makes the staging signature unverifiable.
  cpSync(source, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true })
  try {
    assertVerifiedCustomBundle(staging, 'staging copy')
    verifySignature(staging)
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: false })
    renameSync(staging, destination)
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
  console.log(`Installed ${basename(destination)} at ${destination}`)
}

main()
