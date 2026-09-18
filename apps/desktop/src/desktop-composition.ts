/** The smallest Desktop composition owned by the current upstream profile model. */

import {
  PROFILE_TEMPLATES,
  type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'

const UPSTREAM_WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate

/**
 * Current upstream layers used by both the official Desktop surface and the
 * DS Harness Desktop flavor.  The flavor is expressed by the Electron
 * product/profile contract; it does not fork or duplicate Cordis rows.
 */
export const DESKTOP_CUSTOM_COMPOSITION = Object.freeze({
  profileName: 'desktop-custom',
  upstreamTemplate: 'web',
  bundles: Object.freeze([...UPSTREAM_WEB_PROFILE.bundles]),
  /** Stage 5 deliberately contributes no custom Cordis rows. */
  customEntryIds: Object.freeze([] as readonly string[]),
})

const LEGACY_CUSTOM_COMPOSITION = '@deepseek-ai/dsh-desktop-custom-composition'

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function profileRecord(manifest: unknown): Record<string, unknown> {
  const root = record(manifest)
  const dsh = record(root?.dsh)
  const profile = record(dsh?.profile)
  if (profile === undefined) {
    throw new Error('desktop composition: profile metadata is missing')
  }
  return profile
}

/**
 * Validate the immutable upstream prefix of an application-owned profile.
 * External user bundles may follow the prefix, but duplicate layers and the
 * retired Custom composition are rejected instead of being guessed into the
 * new runtime.
 */
export function assertDesktopCompositionBundles(bundles: readonly string[]): void {
  if (new Set(bundles).size !== bundles.length) {
    throw new Error('desktop composition: profile bundle list contains a duplicate package')
  }
  if (bundles.includes(LEGACY_CUSTOM_COMPOSITION)) {
    throw new Error('desktop composition: legacy Custom composition requires a fresh candidate profile')
  }
  const expected = DESKTOP_CUSTOM_COMPOSITION.bundles
  if (bundles.length < expected.length || expected.some((name, index) => bundles[index] !== name)) {
    throw new Error(`desktop composition: profile must begin with the current ${DESKTOP_CUSTOM_COMPOSITION.upstreamTemplate} bundle layers`)
  }
}

/**
 * Validate the profile metadata without changing it.  The current upstream
 * loader owns patch lifecycle; legacy `patchReload` metadata is therefore not
 * a composition input for the new Desktop flavor.
 */
export function assertDesktopCustomProfileManifest(manifest: unknown): void {
  const profile = profileRecord(manifest)
  if (Object.hasOwn(profile, 'patchReload')) {
    throw new Error('desktop composition: legacy patchReload metadata requires a fresh candidate profile')
  }
  const bundles = profile.bundles
  if (!Array.isArray(bundles) || !bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error('desktop composition: profile bundle list is invalid')
  }
  assertDesktopCompositionBundles(bundles)
}
