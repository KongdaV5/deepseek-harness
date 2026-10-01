import { isAbsolute, join, relative, resolve } from 'node:path'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_QUALIFICATION_ROOT_ARGUMENT,
  DESKTOP_DATA_MODE_ENV,
  DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV,
  DESKTOP_REHEARSAL_ROOT_ENV,
  desktopHostEnvironment,
  prepareDesktopRehearsalPaths,
  readDesktopQualificationRootArgument,
  resolveDesktopDataBoundary,
} from '../src/data-boundary.ts'
import { resolveDesktopRuntimeProductFlavor } from '../src/product-flavor.ts'

const official = resolveDesktopRuntimeProductFlavor(true, { dshDesktopAppId: 'com.deepseek.dsh' })
const custom = resolveDesktopRuntimeProductFlavor(true, {
  dshDesktopProductFlavor: 'ds-harness',
  dshDesktopAppId: 'dev.dsh.desktop.custom',
})

function rehearsal(root: string): NodeJS.ProcessEnv {
  return {
    HOME: join(root, 'forbidden-real-home'),
    DSH_HOME: join(root, 'forbidden-real-home', '.dsh'),
    [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal',
    [DESKTOP_REHEARSAL_ROOT_ENV]: join(root, 'allowed-candidate'),
  }
}

describe('desktop data boundary', () => {
  it('preserves official upstream defaults when no data mode is selected', () => {
    const dshHome = resolve('/synthetic/official/.dsh')
    const boundary = resolveDesktopDataBoundary(official, { DSH_HOME: dshHome })
    expect(boundary).toEqual({
      mode: 'upstream-default',
      policy: {
        profile: 'flavor-isolated', settings: 'shared-global', sessions: 'shared-global',
        electronState: 'flavor-isolated',
      },
      dshHome,
      settings: join(dshHome, 'settings.yaml'),
      profiles: join(dshHome, 'profiles'),
      profile: join(dshHome, 'profiles', 'desktop'),
      sessions: join(dshHome, 'sessions'),
      electronUserData: { mode: 'electron-default' },
      migration: { historicalSessionRead: 'upstream-native', liveSharedDataMigrationAllowed: true },
      approvedRoots: [dshHome],
    })
    expect(desktopHostEnvironment(boundary, {})).toMatchObject({
      [DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV]: dshHome,
    })
  })

  it('fails closed before a DS Harness candidate can select live shared data', () => {
    expect(() => resolveDesktopDataBoundary(custom, {}))
      .toThrow('normal DS Harness startup requires Electron appData')
    expect(() => resolveDesktopDataBoundary(custom, { [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal' }))
      .toThrow(DESKTOP_REHEARSAL_ROOT_ENV)
  })

  it('gives standalone Custom a stable product-owned root and never reads ambient DSH_HOME', () => {
    const appData = '/synthetic/app-data'
    const boundary = resolveDesktopDataBoundary(custom, {
      HOME: '/synthetic/home', DSH_HOME: '/synthetic/legacy-dsh-home',
    }, appData)
    const root = join(appData, '@deepseek-ai', 'dsh-harness-custom')
    expect(boundary).toEqual({
      mode: 'custom-default',
      policy: {
        profile: 'flavor-isolated', settings: 'flavor-isolated', sessions: 'flavor-isolated',
        electronState: 'flavor-isolated',
      },
      dshHome: root,
      settings: join(root, 'settings.yaml'),
      profiles: join(root, 'profiles'),
      profile: join(root, 'profiles', 'desktop-custom'),
      sessions: join(root, 'sessions'),
      electronUserData: { mode: 'explicit', path: join(root, 'electron') },
      migration: { historicalSessionRead: 'disabled', liveSharedDataMigrationAllowed: false },
      approvedRoots: [root],
    })
    expect(desktopHostEnvironment(boundary, {})).toMatchObject({
      DSH_HOME: root,
      [DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV]: boundary.dshHome,
    })
  })

  it('keeps shared stores common and flavor-local state distinct inside one rehearsal root', () => {
    const environment = rehearsal('/synthetic')
    const officialData = resolveDesktopDataBoundary(official, environment)
    const customData = resolveDesktopDataBoundary(custom, environment)
    expect(customData.settings).toBe(officialData.settings)
    expect(customData.sessions).toBe(officialData.sessions)
    expect(customData.profile).not.toBe(officialData.profile)
    expect(customData.profile).toBe(join(customData.dshHome, 'profiles', 'desktop-custom'))
    expect(customData.electronUserData).not.toEqual(officialData.electronUserData)
    expect(customData.migration).toEqual({
      historicalSessionRead: 'fixture-copy-only', liveSharedDataMigrationAllowed: false,
    })
  })

  it('keeps every rehearsal authority below the approved root and away from HOME and DSH_HOME sentinels', () => {
    const environment = rehearsal('/synthetic')
    const data = resolveDesktopDataBoundary(custom, environment)
    const approved = resolve(environment[DESKTOP_REHEARSAL_ROOT_ENV]!)
    const forbidden = [resolve(environment.HOME!), resolve(environment.DSH_HOME!)]
    const authorities = [
      data.dshHome,
      data.settings,
      data.profiles,
      data.profile,
      data.sessions,
      data.electronUserData.mode === 'explicit' ? data.electronUserData.path : '',
    ]
    for (const authority of authorities) {
      const approvedRelative = relative(approved, authority)
      expect(approvedRelative === '' || (!approvedRelative.startsWith('..') && !isAbsolute(approvedRelative))).toBe(true)
      expect(forbidden.some((root) => {
        const forbiddenRelative = relative(root, authority)
        return forbiddenRelative === '' || (!forbiddenRelative.startsWith('..') && !isAbsolute(forbiddenRelative))
      })).toBe(false)
    }
  })

  it('accepts one explicit qualification root when LaunchServices supplies no environment overrides', () => {
    const root = '/synthetic/explicit-rehearsal'
    expect(readDesktopQualificationRootArgument([`${DESKTOP_QUALIFICATION_ROOT_ARGUMENT}${root}`])).toBe(root)
    const boundary = resolveDesktopDataBoundary(custom, {}, '/ignored/app-data', root)
    expect(boundary.mode).toBe('candidate-rehearsal')
    expect(boundary.approvedRoots).toEqual([root])
    expect(boundary.profile).toBe(join(root, 'dsh-home', 'profiles', 'desktop-custom'))
    expect(desktopHostEnvironment(boundary, {})).toMatchObject({
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      DSH_HOME: join(root, 'dsh-home'),
      [DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV]: boundary.dshHome,
      DSH_DESKTOP_PROFILE_PATH: boundary.profile,
      DSH_DESKTOP_SESSION_ROOT: boundary.sessions,
      DSH_DESKTOP_ELECTRON_USER_DATA: join(root, 'electron', 'ds-harness'),
      DSH_DESKTOP_WORKSPACE_ROOT: join(root, 'workspace'),
      DSH_DESKTOP_MAINTENANCE_ROOT: join(root, 'maintenance'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
    })
  })

  it('rejects ambiguous or incomplete qualification root arguments and environment', () => {
    const root = '/synthetic/qualification'
    expect(() => readDesktopQualificationRootArgument([
      `${DESKTOP_QUALIFICATION_ROOT_ARGUMENT}${root}`,
      `${DESKTOP_QUALIFICATION_ROOT_ARGUMENT}${root}`,
    ])).toThrow('duplicate qualification root')
    expect(() => readDesktopQualificationRootArgument([DESKTOP_QUALIFICATION_ROOT_ARGUMENT]))
      .toThrow('must not be empty')
    expect(() => resolveDesktopDataBoundary(custom, {
      [DESKTOP_REHEARSAL_ROOT_ENV]: '/synthetic/from-env',
    }, undefined, root)).toThrow('conflicts with rehearsal environment')
    expect(() => resolveDesktopDataBoundary(custom, {
      [DESKTOP_DATA_MODE_ENV]: 'custom-default',
      [DESKTOP_REHEARSAL_ROOT_ENV]: root,
    })).toThrow('requires candidate-rehearsal mode')
  })

  it('creates only verified rehearsal directories and rejects an escaping symlink', () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-data-boundary-')))
    const rehearsalRoot = join(tempRoot, 'rehearsal')
    try {
      const boundary = resolveDesktopDataBoundary(custom, {
        [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal',
        [DESKTOP_REHEARSAL_ROOT_ENV]: rehearsalRoot,
      })
      const paths = prepareDesktopRehearsalPaths(boundary)
      expect(paths?.electronUserData).toBe(join(rehearsalRoot, 'electron', 'ds-harness'))
      expect(paths?.appData).toBe(join(rehearsalRoot, 'electron', 'appData'))

      const unsafeRoot = join(tempRoot, 'unsafe')
      const unsafeBoundary = resolveDesktopDataBoundary(custom, {
        [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal',
        [DESKTOP_REHEARSAL_ROOT_ENV]: unsafeRoot,
      })
      rmSync(unsafeRoot, { recursive: true, force: true })
      // Replacing an owned directory with a symlink must fail before Electron receives the path.
      mkdirSync(unsafeRoot, { recursive: true })
      symlinkSync(tempRoot, join(unsafeRoot, 'cache'), 'dir')
      expect(() => prepareDesktopRehearsalPaths(unsafeBoundary)).toThrow('real directory')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked rehearsal root before creating any owned path in its target', () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-data-boundary-root-link-')))
    const external = join(tempRoot, 'external')
    const linkedRoot = join(tempRoot, 'rehearsal-link')
    try {
      mkdirSync(external)
      symlinkSync(external, linkedRoot, 'dir')
      const boundary = resolveDesktopDataBoundary(custom, {
        [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal',
        [DESKTOP_REHEARSAL_ROOT_ENV]: linkedRoot,
      })
      expect(() => prepareDesktopRehearsalPaths(boundary)).toThrow(/canonical real directory/u)
      expect(() => lstatSync(join(external, 'dsh-home'))).toThrow()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('takes authority from the flavor id, never productName text', () => {
    const environment = rehearsal('/synthetic')
    const renamedOfficial = { ...official, productName: 'DS Harness' }
    const renamedCustom = { ...custom, productName: 'DeepSeek Harness' }
    expect(resolveDesktopDataBoundary(renamedOfficial, environment).profile.endsWith('/desktop')).toBe(true)
    expect(resolveDesktopDataBoundary(renamedCustom, environment).profile.endsWith('/desktop-custom')).toBe(true)
  })

  it('rejects relative rehearsal roots and unknown modes', () => {
    expect(() => resolveDesktopDataBoundary(custom, {
      [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal',
      [DESKTOP_REHEARSAL_ROOT_ENV]: 'relative',
    })).toThrow('must be an absolute path')
    expect(() => resolveDesktopDataBoundary(official, { [DESKTOP_DATA_MODE_ENV]: 'live' }))
      .toThrow(`unsupported ${DESKTOP_DATA_MODE_ENV}`)
  })

  it('reuses an explicitly isolated DSH home while rejecting roots outside rehearsal ownership', () => {
    const environment = { ...rehearsal('/synthetic'), DSH_DESKTOP_REHEARSAL_DSH_HOME: '/synthetic/allowed-candidate/profile' }
    const boundary = resolveDesktopDataBoundary(custom, environment)
    expect(boundary.dshHome).toBe('/synthetic/allowed-candidate/profile')
    expect(desktopHostEnvironment(boundary, {}).DSH_HOME).toBe('/synthetic/allowed-candidate/profile')
    expect(desktopHostEnvironment(boundary, {})[DESKTOP_CODEX_HOME_ALLOWED_ROOT_ENV]).toBe(boundary.dshHome)
    for (const invalid of ['/synthetic/allowed-candidate', '/production/profile', 'relative']) {
      expect(() => resolveDesktopDataBoundary(custom, { ...environment, DSH_DESKTOP_REHEARSAL_DSH_HOME: invalid })).toThrow('rehearsal DSH home')
    }
  })
})
