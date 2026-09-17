/** Product flavor facts shared with JavaScript packaging entry points. */

export const DESKTOP_PRODUCT_FLAVOR_ENV: 'DSH_DESKTOP_PRODUCT_FLAVOR'

export type DesktopPackagingProductFlavor = {
  readonly id: 'official'
  readonly productName: string
  readonly appId: { readonly mode: 'release-environment' }
  readonly profileName: string
  readonly userData: { readonly mode: 'electron-default' }
  readonly updates: { readonly mode: 'official' }
  readonly artifactPrefix: string
} | {
  readonly id: 'ds-harness'
  readonly productName: string
  readonly appId: { readonly mode: 'fixed'; readonly value: string }
  readonly profileName: string
  readonly userData: { readonly mode: 'isolated'; readonly pathSegments: readonly string[] }
  readonly updates: { readonly mode: 'disabled' }
  readonly artifactPrefix: string
}

export function resolveDesktopProductFlavorDefinition(
  environment?: NodeJS.ProcessEnv,
): DesktopPackagingProductFlavor

export function resolveDesktopFlavorAppId(
  flavor: DesktopPackagingProductFlavor,
  environment: NodeJS.ProcessEnv,
  resolveOfficialAppId: (environment: NodeJS.ProcessEnv) => string,
): string
