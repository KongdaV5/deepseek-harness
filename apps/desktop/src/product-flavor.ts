/** Typed product identity and early Electron process isolation. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import definitions from './product-flavors.json' with { type: 'json' }

const productDefinitions = definitions as unknown as {
  readonly official: {
    readonly productName: string
    readonly appId: { readonly mode: 'release-environment' }
    readonly profileName: string
    readonly userData: { readonly mode: 'electron-default' }
    readonly updates: { readonly mode: 'official' }
  }
  readonly 'ds-harness': {
    readonly productName: string
    readonly appId: { readonly mode: 'fixed'; readonly value: string }
    readonly profileName: string
    readonly userData: { readonly mode: 'isolated'; readonly pathSegments: readonly string[] }
    readonly updates: { readonly mode: 'disabled' }
  }
}

export const DESKTOP_PRODUCT_FLAVOR_ENV = 'DSH_DESKTOP_PRODUCT_FLAVOR'

export type DesktopProductFlavorId = keyof typeof definitions

export interface DesktopApplicationManifest {
  readonly dshDesktopAppId?: unknown
  readonly dshDesktopProductFlavor?: unknown
  readonly dshMandatoryUpdatePolicy?: unknown
  readonly [key: string]: unknown
}

export interface DesktopProductFlavor {
  readonly id: DesktopProductFlavorId
  readonly productName: string
  readonly appId: string | undefined
  readonly profileName: string
  readonly userData: { readonly mode: 'electron-default' } | {
    readonly mode: 'isolated'
    readonly pathSegments: readonly string[]
  }
  readonly updateBehavior: 'official' | 'disabled'
}

interface DesktopIdentityApp {
  getPath(name: 'appData'): string
  setPath(name: 'userData' | 'sessionData', path: string): void
  setName(name: string): void
}

function flavorId(value: unknown): DesktopProductFlavorId {
  const id = value ?? 'official'
  if (id !== 'official' && id !== 'ds-harness') {
    throw new Error(`desktop product flavor: unsupported ${DESKTOP_PRODUCT_FLAVOR_ENV} ${JSON.stringify(id)}`)
  }
  return id
}

function optionalAppId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('desktop product flavor: application bundle ID must be non-empty text')
  }
  return value.trim()
}

/** Read application-owned metadata; this never resolves or reads an Electron user-data directory. */
export function readDesktopApplicationManifest(appPath: string): DesktopApplicationManifest {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`desktop product flavor: cannot read application manifest: ${detail}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop product flavor: invalid application manifest')
  }
  return value as DesktopApplicationManifest
}

/**
 * Resolve runtime identity from packaged metadata or an explicit development selector.
 * Packaged applications never accept an ambient flavor override.
 */
export function resolveDesktopRuntimeProductFlavor(
  packaged: boolean,
  manifest: DesktopApplicationManifest,
  environment: NodeJS.ProcessEnv = process.env,
): DesktopProductFlavor {
  const id = flavorId(packaged ? manifest.dshDesktopProductFlavor : environment[DESKTOP_PRODUCT_FLAVOR_ENV])
  const definition = productDefinitions[id]
  const manifestAppId = optionalAppId(packaged ? manifest.dshDesktopAppId : environment.DSH_DESKTOP_APP_ID)
  const appId = definition.appId.mode === 'fixed' ? definition.appId.value : manifestAppId
  if (definition.appId.mode === 'fixed' && manifestAppId !== undefined && manifestAppId !== definition.appId.value) {
    throw new Error(`desktop product flavor: ${id} requires appId ${definition.appId.value}`)
  }
  if (packaged && appId === undefined) throw new Error('desktop product flavor: packaged application is missing its bundle ID')
  const userData = definition.userData.mode === 'isolated'
    ? { mode: 'isolated' as const, pathSegments: definition.userData.pathSegments }
    : { mode: 'electron-default' as const }
  return {
    id,
    productName: definition.productName,
    appId,
    profileName: definition.profileName,
    userData,
    updateBehavior: definition.updates.mode,
  }
}

/**
 * Apply custom process identity before Electron's single-instance lock is acquired.
 * The official flavor deliberately leaves Electron's existing name and paths untouched.
 */
export function applyDesktopProductIdentity(app: DesktopIdentityApp, flavor: DesktopProductFlavor): void {
  if (flavor.id === 'official') return
  if (flavor.userData.mode !== 'isolated') throw new Error('desktop product flavor: custom userData must be isolated')
  const userData = join(app.getPath('appData'), ...flavor.userData.pathSegments)
  app.setName(flavor.productName)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
}
