import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadDesktopHostProfile } from '../src/rehearsal-isolation.ts'

const fixtureRoots: string[] = []

function rehearsalFixture(profileName = 'desktop-custom') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-rehearsal-'))
  fixtureRoots.push(root)
  const profilePath = join(root, 'dsh-home', 'profiles', profileName)
  const paths = [
    join(root, 'home'), join(root, 'tmp'), join(root, 'electron', 'ds-harness'),
    join(root, 'workspace'), join(root, 'maintenance'), join(root, 'xdg-config'),
    join(root, 'xdg-data'), join(root, 'xdg-cache'), join(root, 'dsh-home', 'sessions'), profilePath,
  ]
  for (const path of paths) mkdirSync(path, { recursive: true })
  return {
    root,
    profilePath,
    environment: {
      DSH_DESKTOP_DATA_MODE: 'candidate-rehearsal',
      DSH_DESKTOP_REHEARSAL_ROOT: root,
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      DSH_HOME: join(root, 'dsh-home'),
      DSH_DESKTOP_PROFILE_PATH: profilePath,
      DSH_DESKTOP_SESSION_ROOT: join(root, 'dsh-home', 'sessions'),
      DSH_DESKTOP_ELECTRON_USER_DATA: join(root, 'electron', 'ds-harness'),
      DSH_DESKTOP_WORKSPACE_ROOT: join(root, 'workspace'),
      DSH_DESKTOP_MAINTENANCE_ROOT: join(root, 'maintenance'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
    },
  }
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop Host rehearsal isolation', () => {
  it('validates every resolved root before loading the profile', () => {
    const fixture = rehearsalFixture()
    const loadProfile = vi.fn(() => 'loaded-profile')
    expect(loadDesktopHostProfile({ environment: fixture.environment, projectDir: fixture.profilePath,
      profileName: 'desktop-custom' }, loadProfile)).toBe('loaded-profile')
    expect(loadProfile).toHaveBeenCalledOnce()
  })

  it('fails closed before profile loading when a boundary value is missing or escapes', () => {
    const fixture = rehearsalFixture()
    const loadProfile = vi.fn(() => 'loaded-profile')
    expect(() => loadDesktopHostProfile({
      environment: { ...fixture.environment, DSH_DESKTOP_SESSION_ROOT: undefined },
      projectDir: fixture.profilePath,
      profileName: 'desktop-custom',
    }, loadProfile)).toThrow('DSH_DESKTOP_SESSION_ROOT is missing or escapes rehearsal root')
    expect(loadProfile).not.toHaveBeenCalled()

    expect(() => loadDesktopHostProfile({
      environment: { ...fixture.environment, DSH_DESKTOP_PROFILE_PATH: '/Users/other/live-profile' },
      projectDir: '/Users/other/live-profile',
      profileName: 'desktop-custom',
    }, loadProfile)).toThrow('resolved profile path escapes rehearsal root')
    expect(loadProfile).not.toHaveBeenCalled()
  })

  it('rejects a profile symlink that resolves outside the rehearsal root before loading it', () => {
    const fixture = rehearsalFixture()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-host-outside-'))
    fixtureRoots.push(outside)
    rmSync(fixture.profilePath, { recursive: true, force: true })
    symlinkSync(outside, fixture.profilePath, 'dir')
    const loadProfile = vi.fn(() => 'loaded-profile')
    expect(() => loadDesktopHostProfile({ environment: fixture.environment, projectDir: fixture.profilePath,
      profileName: 'desktop-custom' }, loadProfile)).toThrow('DSH_DESKTOP_PROFILE_PATH is unavailable or outside rehearsal root')
    expect(loadProfile).not.toHaveBeenCalled()
  })

  it('leaves a normal standalone Custom profile path unchanged when no rehearsal marker exists', () => {
    const loadProfile = vi.fn(() => '/Users/current/Library/Application Support/DS Harness/profile')
    expect(loadDesktopHostProfile({ environment: { DSH_HOME: '/Users/current/Library/Application Support/DS Harness' },
      projectDir: '/Users/current/Library/Application Support/DS Harness/profiles/desktop-custom',
      profileName: 'desktop-custom' }, loadProfile)).toContain('Application Support')
    expect(loadProfile).toHaveBeenCalledOnce()
  })
})
