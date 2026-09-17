/** Product identity shared by packaging and the Electron runtime. */

import definitions from '../src/product-flavors.json' with { type: 'json' }

export const DESKTOP_PRODUCT_FLAVOR_ENV = 'DSH_DESKTOP_PRODUCT_FLAVOR'

/**
 * Select one declared product flavor. An absent selector preserves the official product.
 * @param {NodeJS.ProcessEnv} environment Build or development environment.
 * @returns {{ id: 'official' | 'ds-harness' } & (typeof definitions)[keyof typeof definitions]}
 */
export function resolveDesktopProductFlavorDefinition(environment = process.env) {
  const id = environment[DESKTOP_PRODUCT_FLAVOR_ENV] ?? 'official'
  if (id !== 'official' && id !== 'ds-harness') {
    throw new Error(`desktop product flavor: unsupported ${DESKTOP_PRODUCT_FLAVOR_ENV} ${JSON.stringify(id)}`)
  }
  return { id, ...definitions[id] }
}

/**
 * Resolve a flavor's concrete bundle identifier without borrowing another product's identity.
 * @param {ReturnType<typeof resolveDesktopProductFlavorDefinition>} flavor Selected product flavor.
 * @param {NodeJS.ProcessEnv} environment Build environment.
 * @param {(environment: NodeJS.ProcessEnv) => string} resolveOfficialAppId Existing official resolver.
 * @returns {string} Concrete appId for electron-builder metadata.
 */
export function resolveDesktopFlavorAppId(flavor, environment, resolveOfficialAppId) {
  if (flavor.appId.mode === 'release-environment') return resolveOfficialAppId(environment)
  const configured = environment.DSH_DESKTOP_APP_ID?.trim()
  if (configured !== undefined && configured !== '' && configured !== flavor.appId.value) {
    throw new Error(`desktop product flavor: ${flavor.id} requires appId ${flavor.appId.value}`)
  }
  return flavor.appId.value
}
