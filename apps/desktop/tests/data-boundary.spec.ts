import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_DATA_MODE_ENV,
  DESKTOP_REHEARSAL_ROOT_ENV,
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
    expect(resolveDesktopDataBoundary(official, { DSH_HOME: dshHome })).toEqual({
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
  })

  it('fails closed before a DS Harness candidate can select live shared data', () => {
    expect(() => resolveDesktopDataBoundary(custom, {}))
      .toThrow('DS Harness candidate cannot use live shared data')
    expect(() => resolveDesktopDataBoundary(custom, { [DESKTOP_DATA_MODE_ENV]: 'candidate-rehearsal' }))
      .toThrow(DESKTOP_REHEARSAL_ROOT_ENV)
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
})
