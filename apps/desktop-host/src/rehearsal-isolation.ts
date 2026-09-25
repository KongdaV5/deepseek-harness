import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const DATA_MODE_ENV = 'DSH_DESKTOP_DATA_MODE'
const REHEARSAL_ROOT_ENV = 'DSH_DESKTOP_REHEARSAL_ROOT'

export interface DesktopHostProfileBoundary {
  readonly environment: NodeJS.ProcessEnv
  readonly projectDir: string
  readonly profileName: string
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function requireDirectoryInsideRoot(root: string, directory: string, label: string): void {
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('not a real directory')
    }
    if (!isWithin(root, realpathSync(directory))) throw new Error('resolves outside the root')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`qualification isolation violation: ${label} is unavailable or outside rehearsal root (${detail})`)
  }
}

/** Verify the complete rehearsal boundary before allowing the profile loader to read or create profile state. */
export function loadDesktopHostProfile<T>(
  boundary: DesktopHostProfileBoundary,
  loadProfile: () => T,
): T {
  const { environment, projectDir, profileName } = boundary
  const mode = environment[DATA_MODE_ENV]
  const configuredRoot = environment[REHEARSAL_ROOT_ENV]
  if (mode === undefined && configuredRoot === undefined) return loadProfile()
  if (mode !== 'candidate-rehearsal' || configuredRoot === undefined || configuredRoot.trim() === '') {
    throw new Error('qualification isolation violation: incomplete or unsupported rehearsal boundary')
  }
  if (!isAbsolute(configuredRoot)) {
    throw new Error('qualification isolation violation: rehearsal root must be absolute')
  }
  if (!/^[a-z][a-z0-9-]*$/u.test(profileName)) {
    throw new Error('qualification isolation violation: invalid profile name')
  }

  const root = resolve(configuredRoot)
  const profilePath = join(root, 'dsh-home', 'profiles', profileName)
  const flavorDirectory = profileName === 'desktop-custom' ? 'ds-harness' : profileName === 'desktop' ? 'official' : undefined
  if (flavorDirectory === undefined) {
    throw new Error('qualification isolation violation: unsupported qualification profile')
  }
  const expectedPaths: Readonly<Record<string, string>> = {
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    DSH_HOME: join(root, 'dsh-home'),
    DSH_DESKTOP_PROFILE_PATH: profilePath,
    DSH_DESKTOP_SESSION_ROOT: join(root, 'dsh-home', 'sessions'),
    DSH_DESKTOP_ELECTRON_USER_DATA: join(root, 'electron', flavorDirectory),
    DSH_DESKTOP_WORKSPACE_ROOT: join(root, 'workspace'),
    DSH_DESKTOP_MAINTENANCE_ROOT: join(root, 'maintenance'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
  }
  for (const [name, expected] of Object.entries(expectedPaths)) {
    const value = environment[name]
    if (value === undefined || !isAbsolute(value) || resolve(value) !== expected) {
      if (name === 'DSH_DESKTOP_PROFILE_PATH') {
        throw new Error('qualification isolation violation: resolved profile path escapes rehearsal root')
      }
      throw new Error(`qualification isolation violation: ${name} is missing or escapes rehearsal root`)
    }
  }
  if (!isAbsolute(projectDir) || resolve(projectDir) !== profilePath) {
    throw new Error('qualification isolation violation: resolved profile path escapes rehearsal root')
  }

  let canonicalRoot: string
  try {
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('root is not a real directory')
    canonicalRoot = realpathSync(root)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`qualification isolation violation: rehearsal root is unavailable (${detail})`)
  }
  for (const [name, value] of Object.entries(expectedPaths)) {
    requireDirectoryInsideRoot(canonicalRoot, value, name)
  }
  requireDirectoryInsideRoot(canonicalRoot, projectDir, 'resolved profile path')
  return loadProfile()
}
