import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyDesktopProductIdentity,
  resolveDesktopRuntimeProductFlavor,
} from '../src/product-flavor.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { claimDesktopSingleInstance } from '../src/single-instance.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-product-flavor-'))
  roots.push(root)
  return root
}

function fakeApp(root: string) {
  const paths = new Map<string, string>([
    ['appData', root],
    ['userData', join(root, '@deepseek-ai', 'dsh-desktop')],
    ['sessionData', join(root, '@deepseek-ai', 'dsh-desktop')],
  ])
  const app = {
    name: 'DeepSeek Harness',
    getPath: (name: string) => paths.get(name)!,
    setPath: vi.fn((name: string, path: string) => { paths.set(name, path) }),
    setName: vi.fn((name: string) => { app.name = name }),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn(),
  }
  return { app, paths }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop product flavor', () => {
  it('preserves the official product as the default without changing Electron paths', () => {
    const root = temporaryRoot()
    const flavor = resolveDesktopRuntimeProductFlavor(true, { dshDesktopAppId: 'dev.dsh.desktop' })
    const { app, paths } = fakeApp(root)
    const originalUserData = paths.get('userData')
    applyDesktopProductIdentity(app, flavor)
    expect(flavor).toEqual({
      id: 'official', productName: 'DeepSeek Harness', appId: 'dev.dsh.desktop', profileName: 'desktop',
      userData: { mode: 'electron-default' }, updateBehavior: 'official',
    })
    expect(paths.get('userData')).toBe(originalUserData)
    expect(app.setPath).not.toHaveBeenCalled()
    expect(resolveDesktopPaths(join(root, '.dsh'), flavor.profileName).profile)
      .toBe(join(root, '.dsh', 'profiles', 'desktop'))
  })

  it('selects the complete isolated DS Harness identity from packaged metadata', () => {
    const root = temporaryRoot()
    const flavor = resolveDesktopRuntimeProductFlavor(true, {
      dshDesktopProductFlavor: 'ds-harness',
      dshDesktopAppId: 'dev.dsh.desktop.custom',
    })
    const { app, paths } = fakeApp(root)
    applyDesktopProductIdentity(app, flavor)
    expect(flavor).toMatchObject({
      id: 'ds-harness', productName: 'DS Harness', appId: 'dev.dsh.desktop.custom',
      profileName: 'desktop-custom', updateBehavior: 'disabled',
    })
    expect(paths.get('userData')).toBe(join(root, '@deepseek-ai', 'dsh-harness-custom', 'electron'))
    expect(paths.get('sessionData')).toBe(join(root, '@deepseek-ai', 'dsh-harness-custom', 'electron'))
    expect(app.setName).toHaveBeenCalledWith('DS Harness')
    expect(resolveDesktopPaths(join(root, '.dsh'), flavor.profileName).profile)
      .toBe(join(root, '.dsh', 'profiles', 'desktop-custom'))
  })

  it('fails closed for unknown flavors and a mismatched custom appId', () => {
    expect(() => resolveDesktopRuntimeProductFlavor(false, {}, { DSH_DESKTOP_PRODUCT_FLAVOR: 'other' }))
      .toThrow('unsupported DSH_DESKTOP_PRODUCT_FLAVOR')
    expect(() => resolveDesktopRuntimeProductFlavor(true, {
      dshDesktopProductFlavor: 'ds-harness', dshDesktopAppId: 'dev.dsh.desktop',
    })).toThrow('requires appId dev.dsh.desktop.custom')
  })

  it('applies custom userData before acquiring an independent single-instance lock', () => {
    const root = temporaryRoot()
    const owned = new Set<string>()
    const make = (id: 'official' | 'ds-harness') => {
      const holder = fakeApp(root)
      if (id === 'ds-harness') {
        applyDesktopProductIdentity(holder.app, resolveDesktopRuntimeProductFlavor(false, {}, {
          DSH_DESKTOP_PRODUCT_FLAVOR: 'ds-harness',
        }))
      }
      holder.app.requestSingleInstanceLock.mockImplementation(() => {
        const identity = holder.paths.get('userData')!
        if (owned.has(identity)) return false
        owned.add(identity)
        return true
      })
      return holder
    }
    const official = make('official')
    const custom = make('ds-harness')
    expect(claimDesktopSingleInstance(official.app, vi.fn())).toBe(true)
    expect(claimDesktopSingleInstance(custom.app, vi.fn())).toBe(true)
    expect(official.paths.get('userData')).not.toBe(custom.paths.get('userData'))
    expect(custom.app.setPath.mock.invocationCallOrder[0]).toBeLessThan(custom.app.requestSingleInstanceLock.mock.invocationCallOrder[0]!)
  })
})
