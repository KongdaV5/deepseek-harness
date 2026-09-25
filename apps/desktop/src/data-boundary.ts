/** Explicit Desktop ownership for DSH data and Electron state. */

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DesktopProductFlavor } from './product-flavor.ts'

/** Selects the isolated data mode used by an adaptation candidate. */
export const DESKTOP_DATA_MODE_ENV = 'DSH_DESKTOP_DATA_MODE'

/** Root containing every filesystem authority used by a candidate rehearsal. */
export const DESKTOP_REHEARSAL_ROOT_ENV = 'DSH_DESKTOP_REHEARSAL_ROOT'

/** Data modes admitted by the Desktop entry point. */
export type DesktopDataMode = 'upstream-default' | 'candidate-rehearsal' | 'custom-default'

/** Stable store-sharing policy independent of product display text. */
export interface DesktopDataPolicy {
  readonly profile: 'flavor-isolated'
  readonly settings: 'shared-global' | 'flavor-isolated'
  readonly sessions: 'shared-global' | 'flavor-isolated'
  readonly electronState: 'flavor-isolated'
}

/** Resolved filesystem authorities for one Desktop process. */
export interface DesktopDataBoundary {
  readonly mode: DesktopDataMode
  readonly policy: DesktopDataPolicy
  readonly dshHome: string
  readonly settings: string
  readonly profiles: string
  readonly profile: string
  readonly sessions: string
  readonly electronUserData: { readonly mode: 'electron-default' } | {
    readonly mode: 'explicit'
    readonly path: string
  }
  readonly migration: {
    readonly historicalSessionRead: 'upstream-native' | 'fixture-copy-only' | 'disabled'
    readonly liveSharedDataMigrationAllowed: boolean
  }
  readonly approvedRoots: readonly string[]
}

const DATA_POLICY: DesktopDataPolicy = {
  profile: 'flavor-isolated',
  settings: 'shared-global',
  sessions: 'shared-global',
  electronState: 'flavor-isolated',
}

const CUSTOM_DATA_POLICY: DesktopDataPolicy = {
  profile: 'flavor-isolated',
  settings: 'flavor-isolated',
  sessions: 'flavor-isolated',
  electronState: 'flavor-isolated',
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function requiredRehearsalRoot(environment: NodeJS.ProcessEnv): string {
  const configured = environment[DESKTOP_REHEARSAL_ROOT_ENV]
  if (configured === undefined || configured.trim() === '') {
    throw new Error(
      `desktop data: candidate rehearsal requires ${DESKTOP_REHEARSAL_ROOT_ENV}; live shared data migration is disabled`,
    )
  }
  if (!isAbsolute(configured)) {
    throw new Error(`desktop data: ${DESKTOP_REHEARSAL_ROOT_ENV} must be an absolute path`)
  }
  return resolve(configured)
}

function rehearsalBoundary(
  flavor: DesktopProductFlavor,
  environment: NodeJS.ProcessEnv,
): DesktopDataBoundary {
  const root = requiredRehearsalRoot(environment)
  const dshHome = join(root, 'dsh-home')
  const profiles = join(dshHome, 'profiles')
  const electronUserData = join(root, 'electron', flavor.id)
  const resolved: DesktopDataBoundary = {
    mode: 'candidate-rehearsal',
    policy: DATA_POLICY,
    dshHome,
    settings: join(dshHome, 'settings.yaml'),
    profiles,
    profile: join(profiles, flavor.profileName),
    sessions: join(dshHome, 'sessions'),
    electronUserData: { mode: 'explicit', path: electronUserData },
    migration: {
      historicalSessionRead: 'fixture-copy-only',
      liveSharedDataMigrationAllowed: false,
    },
    approvedRoots: [root],
  }
  for (const candidate of [
    resolved.dshHome,
    resolved.settings,
    resolved.profiles,
    resolved.profile,
    resolved.sessions,
    electronUserData,
  ]) {
    if (!isWithin(root, candidate)) {
      throw new Error(`desktop data: candidate path escapes the rehearsal root: ${candidate}`)
    }
  }
  return resolved
}

/**
 * Resolve Desktop data authorities before profile or Host startup.
 * Official mode without an override preserves upstream paths and migration;
 * standalone DS Harness uses its own stable appData root without migration.
 * Qualification rehearsals use a disposable root; standalone DS Harness uses
 * a product-owned root and never migrates legacy or Official data.
 * @param flavor - explicit product flavor; product display text has no authority.
 * @param environment - process environment supplying mode and root overrides.
 * @param appDataPath - Electron's stable per-user Application Support directory.
 * @returns the complete immutable data authority set.
 */
export function resolveDesktopDataBoundary(
  flavor: DesktopProductFlavor,
  environment: NodeJS.ProcessEnv = process.env,
  appDataPath?: string,
): DesktopDataBoundary {
  const requested = environment[DESKTOP_DATA_MODE_ENV]
  if (requested === 'candidate-rehearsal') return rehearsalBoundary(flavor, environment)
  if (requested !== undefined && requested !== '') {
    throw new Error(`desktop data: unsupported ${DESKTOP_DATA_MODE_ENV} ${JSON.stringify(requested)}`)
  }
  if (flavor.id === 'ds-harness') {
    if (flavor.userData.mode !== 'isolated') {
      throw new Error('desktop data: Custom flavor must declare isolated Electron userData')
    }
    if (appDataPath === undefined || !isAbsolute(appDataPath)) {
      throw new Error('desktop data: normal DS Harness startup requires Electron appData')
    }
    const electronUserData = join(appDataPath, ...flavor.userData.pathSegments)
    const root = dirname(electronUserData)
    const dshHome = root
    const profiles = join(dshHome, 'profiles')
    const resolved: DesktopDataBoundary = {
      mode: 'custom-default',
      policy: CUSTOM_DATA_POLICY,
      dshHome,
      settings: join(dshHome, 'settings.yaml'),
      profiles,
      profile: join(profiles, flavor.profileName),
      sessions: join(dshHome, 'sessions'),
      electronUserData: { mode: 'explicit', path: electronUserData },
      migration: {
        historicalSessionRead: 'disabled',
        liveSharedDataMigrationAllowed: false,
      },
      approvedRoots: [root],
    }
    for (const candidate of [
      resolved.dshHome,
      resolved.settings,
      resolved.profiles,
      resolved.profile,
      resolved.sessions,
      electronUserData,
    ]) {
      if (!isWithin(root, candidate)) {
        throw new Error(`desktop data: Custom path escapes its product root: ${candidate}`)
      }
    }
    return resolved
  }
  const dshHome = resolveDshHome(undefined, environment)
  const profiles = join(dshHome, 'profiles')
  return {
    mode: 'upstream-default',
    policy: DATA_POLICY,
    dshHome,
    settings: join(dshHome, 'settings.yaml'),
    profiles,
    profile: join(profiles, flavor.profileName),
    sessions: join(dshHome, 'sessions'),
    electronUserData: { mode: 'electron-default' },
    migration: {
      historicalSessionRead: 'upstream-native',
      liveSharedDataMigrationAllowed: true,
    },
    approvedRoots: [dshHome],
  }
}
