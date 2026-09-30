/** Explicit Desktop ownership for DSH data and Electron state. */

import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DesktopProductFlavor } from './product-flavor.ts'

/** Selects the isolated data mode used by an adaptation candidate. */
export const DESKTOP_DATA_MODE_ENV = 'DSH_DESKTOP_DATA_MODE'

/** Root containing every filesystem authority used by a candidate rehearsal. */
export const DESKTOP_REHEARSAL_ROOT_ENV = 'DSH_DESKTOP_REHEARSAL_ROOT'

/** Explicit command-line qualification root used when LaunchServices drops custom environment variables. */
export const DESKTOP_QUALIFICATION_ROOT_ARGUMENT = '--dsh-qualification-root='

/** Trusted DSH data root passed separately from CODEX_HOME to the Host runtime. */
export const DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV = 'DSH_DESKTOP_CODEX_HOME_ALLOWED_ROOT'

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

export interface DesktopRehearsalPaths {
  readonly root: string
  readonly home: string
  readonly temp: string
  readonly appData: string
  readonly cache: string
  readonly logs: string
  readonly crashDumps: string
  readonly workspace: string
  readonly maintenance: string
  readonly xdgConfig: string
  readonly xdgData: string
  readonly xdgCache: string
  readonly electronUserData: string
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

export function readDesktopQualificationRootArgument(args: readonly string[]): string | undefined {
  const configured = args.filter(argument => argument.startsWith(DESKTOP_QUALIFICATION_ROOT_ARGUMENT))
  if (configured.length > 1) throw new Error('desktop data: duplicate qualification root argument')
  const value = configured[0]?.slice(DESKTOP_QUALIFICATION_ROOT_ARGUMENT.length)
  if (value === '') throw new Error('desktop data: qualification root argument must not be empty')
  return value
}

function requiredRehearsalRoot(environment: NodeJS.ProcessEnv, explicitRoot?: string): string {
  const configured = environment[DESKTOP_REHEARSAL_ROOT_ENV]
  if (configured !== undefined && configured.trim() === '') {
    throw new Error(`desktop data: ${DESKTOP_REHEARSAL_ROOT_ENV} must not be empty`)
  }
  if (explicitRoot !== undefined && configured !== undefined
    && normalizeKnownDesktopPath(resolve(explicitRoot)) !== normalizeKnownDesktopPath(resolve(configured))) {
    throw new Error('desktop data: qualification root argument conflicts with rehearsal environment')
  }
  const selected = explicitRoot ?? configured
  if (selected === undefined) {
    throw new Error(
      `desktop data: candidate rehearsal requires ${DESKTOP_REHEARSAL_ROOT_ENV}; live shared data migration is disabled`,
    )
  }
  if (!isAbsolute(selected)) {
    throw new Error(`desktop data: ${DESKTOP_REHEARSAL_ROOT_ENV} must be an absolute path`)
  }
  return normalizeKnownDesktopPath(resolve(selected))
}

function normalizeKnownDesktopPath(path: string): string {
  if (process.platform !== 'darwin' || (path !== '/tmp' && !path.startsWith('/tmp/'))) return path
  try {
    if (realpathSync('/tmp') === '/private/tmp') return join('/private/tmp', relative('/tmp', path))
  } catch (_error) {
    // The path validation below reports a missing or inaccessible root.
  }
  return path
}

function rehearsalBoundary(
  flavor: DesktopProductFlavor,
  environment: NodeJS.ProcessEnv,
  explicitRoot?: string,
): DesktopDataBoundary {
  const root = requiredRehearsalRoot(environment, explicitRoot)
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
    join(root, 'home'),
    join(root, 'tmp'),
    join(root, 'workspace'),
    join(root, 'cache'),
    join(root, 'maintenance'),
    join(root, 'xdg-config'),
    join(root, 'xdg-data'),
    join(root, 'xdg-cache'),
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
  explicitRehearsalRoot?: string,
): DesktopDataBoundary {
  let requested = environment[DESKTOP_DATA_MODE_ENV]
  if (explicitRehearsalRoot !== undefined && requested === undefined) requested = 'candidate-rehearsal'
  if (requested === undefined && environment[DESKTOP_REHEARSAL_ROOT_ENV] !== undefined) {
    requested = 'candidate-rehearsal'
  }
  if (requested === 'candidate-rehearsal') return rehearsalBoundary(flavor, environment, explicitRehearsalRoot)
  if (explicitRehearsalRoot !== undefined || environment[DESKTOP_REHEARSAL_ROOT_ENV] !== undefined) {
    throw new Error('desktop data: rehearsal root requires candidate-rehearsal mode')
  }
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

/** Create and verify only the directories owned by a rehearsal boundary before Electron or Host can hydrate them. */
export function prepareDesktopRehearsalPaths(boundary: DesktopDataBoundary): DesktopRehearsalPaths | undefined {
  if (boundary.mode !== 'candidate-rehearsal') return undefined
  const root = boundary.approvedRoots[0]
  const electronUserData = boundary.electronUserData.mode === 'explicit' ? boundary.electronUserData.path : undefined
  if (root === undefined || electronUserData === undefined) {
    throw new Error('qualification isolation violation: rehearsal boundary is incomplete')
  }

  ensureRealDirectoryChain(root)
  const canonicalRoot = realpathSync(root)
  if (canonicalRoot !== root) throw new Error('qualification isolation violation: rehearsal root must be canonical')
  const paths: DesktopRehearsalPaths = {
    root,
    home: join(root, 'home'),
    temp: join(root, 'tmp'),
    appData: join(root, 'electron', 'appData'),
    cache: join(root, 'cache'),
    logs: join(root, 'logs'),
    crashDumps: join(root, 'crash-dumps'),
    workspace: join(root, 'workspace'),
    maintenance: join(root, 'maintenance'),
    xdgConfig: join(root, 'xdg-config'),
    xdgData: join(root, 'xdg-data'),
    xdgCache: join(root, 'xdg-cache'),
    electronUserData,
  }
  const ownedDirectories = [
    paths.home, paths.temp, paths.appData, paths.cache, paths.logs, paths.crashDumps, paths.workspace, paths.maintenance,
    paths.xdgConfig, paths.xdgData, paths.xdgCache, paths.electronUserData,
    boundary.dshHome, boundary.profiles, boundary.profile, boundary.sessions,
  ]
  for (const directory of ownedDirectories) {
    ensureRealDirectoryChain(directory)
    const canonicalDirectory = realpathSync(directory)
    if (!isWithin(canonicalRoot, canonicalDirectory)) {
      throw new Error(`qualification isolation violation: rehearsal path escapes rehearsal root: ${directory}`)
    }
  }
  return paths
}

function ensureRealDirectoryChain(path: string): void {
  const { root } = parse(path)
  let current = root
  assertRealDirectory(current)
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment)
    let details
    try {
      details = lstatSync(current)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 })
      details = lstatSync(current)
    }
    assertRealDirectory(current, details)
  }
}

function assertRealDirectory(path: string, details = lstatSync(path)): void {
  if (!details.isDirectory() || details.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`qualification isolation violation: path is not a canonical real directory: ${path}`)
  }
}

/** Build the complete child environment from the already-validated rehearsal boundary. */
export function desktopHostEnvironment(
  boundary: DesktopDataBoundary,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const trustedRoot = boundary.mode === 'candidate-rehearsal'
    ? boundary.approvedRoots[0]
    : boundary.approvedRoots[0] ?? boundary.dshHome
  if (trustedRoot === undefined || !isAbsolute(trustedRoot)) {
    throw new Error('desktop data: trusted Codex home root is missing or not absolute')
  }
  if (boundary.mode === 'candidate-rehearsal') {
    const root = boundary.approvedRoots[0]
    if (root === undefined) throw new Error('qualification isolation violation: rehearsal root is missing')
    const electronUserData = boundary.electronUserData.mode === 'explicit' ? boundary.electronUserData.path : undefined
    if (electronUserData === undefined) throw new Error('qualification isolation violation: Electron userData is missing')
    return {
      ...environment,
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      DSH_HOME: boundary.dshHome,
      [DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV]: trustedRoot,
      DSH_DESKTOP_PROFILE_PATH: boundary.profile,
      DSH_DESKTOP_SESSION_ROOT: boundary.sessions,
      DSH_DESKTOP_ELECTRON_USER_DATA: electronUserData,
      [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal',
      [DESKTOP_REHEARSAL_ROOT_ENV]: root,
      DSH_DESKTOP_WORKSPACE_ROOT: join(root, 'workspace'),
      DSH_DESKTOP_MAINTENANCE_ROOT: join(root, 'maintenance'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
    }
  }
  if (boundary.mode === 'custom-default') {
    return {
      ...environment,
      DSH_HOME: boundary.dshHome,
      [DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV]: trustedRoot,
    }
  }
  return { ...environment, [DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV]: trustedRoot }
}
