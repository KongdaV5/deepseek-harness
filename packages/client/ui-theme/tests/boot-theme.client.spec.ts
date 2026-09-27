// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjections } from '../src/boot-theme.ts'
import type { ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(preference?: ThemePreference, fontSize?: number): void {
  for (const row of bootThemeInjections(preference, fontSize)) {
    if (row.kind === 'script') runInNewContext(row.text, { document, matchMedia: globalThis.matchMedia })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.dsThemeSource
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.style.removeProperty('--dsh-content-font-size')
  document.body.style.removeProperty('--dsh-ui-font-size')
  document.body.style.removeProperty('--dsh-ui-font-scale')
})

describe('theme bootstrap row', () => {
  it('colors the body with head CSS before applying body state', () => {
    mockSystemDark(false)
    const [head, body] = bootThemeInjections('dark')
    expect(head).toMatchObject({ kind: 'style' })
    expect(body).toMatchObject({ kind: 'script', placement: 'body' })
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.documentElement.dataset.dsThemeSource).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    const [head] = bootThemeInjections('light')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}')
    executeBootstrap('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, true],
    [false, false],
  ] as const)('resolves system=%s for the body palette', (matches, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('uses a media query for the system canvas palette', () => {
    const [head] = bootThemeInjections('system')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(
      ':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}'
      + '@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}}',
    )
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the global scale before first paint and defaults it to the 14px reference', () => {
    mockSystemDark(false)
    executeBootstrap('light', 17)
    expect(document.body.style.getPropertyValue('--dsh-ui-font-size')).toBe('17px')
    expect(document.body.style.getPropertyValue('--dsh-ui-font-scale')).toBe(String(17 / 14))
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-ui-font-size')).toBe('14px')
    expect(document.body.style.getPropertyValue('--dsh-ui-font-scale')).toBe('1')
  })
})
