/** Qualify a DS Harness staging application without release credentials or installation. */

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { resolveDesktopProductFlavorDefinition } from './product-flavor.mjs'

export const DESKTOP_LOCAL_MACOS_QUALIFICATION_ENV = 'DSH_DESKTOP_LOCAL_MACOS_QUALIFICATION'

/**
 * Validate the explicit, staging-only macOS qualification mode.
 * @param {NodeJS.ProcessEnv} environment - Package environment loaded from the local configuration file.
 * @param {{ platform: 'darwin' | 'win32' }} target - Requested package target.
 * @param {{ directory?: boolean }} options - Requested packaging mode.
 * @returns {boolean} Whether local macOS qualification was selected.
 */
export function isDesktopLocalMacOSQualification(environment, target, options = {}) {
  const value = environment[DESKTOP_LOCAL_MACOS_QUALIFICATION_ENV]
  if (value === undefined) return false
  if (value !== '1') throw new Error(`desktop package: ${DESKTOP_LOCAL_MACOS_QUALIFICATION_ENV} must be 1 when set`)
  if (resolveDesktopProductFlavorDefinition(environment).id !== 'ds-harness') {
    throw new Error('desktop package: local macOS qualification is limited to the ds-harness flavor')
  }
  if (target.platform !== 'darwin' || options.directory !== true) {
    throw new Error('desktop package: local macOS qualification requires a macOS --dir package')
  }
  return true
}

/**
 * Ad-hoc-sign and strictly verify an isolated staging app after electron-builder has materialized it.
 * @param {string} artifactsRoot - Target-owned electron-builder output directory.
 * @param {string} targetName - Fixed target directory emitted by electron-builder.
 * @param {string} productName - Product filename selected by the flavor.
 * @returns {string} Qualified application path.
 */
export function qualifyLocalMacOSApplication(artifactsRoot, targetName, productName) {
  const app = join(artifactsRoot, targetName, `${productName}.app`)
  if (!existsSync(app)) throw new Error(`desktop package: local macOS qualification did not find ${app}`)
  // Keep the staging qualification signature ad hoc and non-hardened.  A
  // hardened Electron build requires release entitlements (notably JIT
  // allowances) that are intentionally unavailable in this local-only gate;
  // the release signing/notarization path remains responsible for those.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  return app
}
