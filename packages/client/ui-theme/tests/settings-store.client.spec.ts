/** Appearance and font-size row stores: snapshot-mirror actions and the revision guards. */
import { describe, expect, it } from 'vitest'
import { createAppearanceRowStore, createFontRowStore } from '../src/client/settings-store.ts'

describe('createAppearanceRowStore', () => {
  it('init shape: system preference with revision at -1', () => {
    const store = createAppearanceRowStore().create()
    expect(store.getSnapshot()).toEqual({ preference: 'system', revision: -1 })
  })

  it('sync mirrors the preference and advances the revision', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', 0)
    expect(store.getSnapshot()).toEqual({ preference: 'dark', revision: 0 })
    store.actions.sync('light', 2)
    expect(store.getSnapshot().preference).toBe('light')
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', 3)
    store.actions.sync('system', 2)
    store.actions.sync('system', 3)
    expect(store.getSnapshot().preference).toBe('dark')
    expect(store.getSnapshot().revision).toBe(3)
  })
})

describe('createFontRowStore', () => {
  it('init shape: default size with revision at -1', () => {
    const store = createFontRowStore().create()
    expect(store.getSnapshot()).toEqual({ interfaceFontSize: 14, fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' }, revision: -1 })
  })

  it('sync mirrors the size; the revision guard drops stale and duplicate writes', () => {
    const store = createFontRowStore().create()
    const sizes = { text: 16, code: 12, terminal: 14 }
    const fonts = { text: '"Inter"', code: '', terminal: '' }
    store.actions.sync(15, sizes, { ...fonts }, 3)
    expect(store.getSnapshot()).toEqual({ interfaceFontSize: 15, fontSizes: sizes, fontFamilies: fonts, revision: 3 })
    store.actions.sync(16, { ...sizes, text: 12 }, fonts, 2)
    store.actions.sync(16, { ...sizes, text: 12 }, fonts, 3)
    expect(store.getSnapshot().fontSizes.text).toBe(16)
    expect(store.getSnapshot().interfaceFontSize).toBe(15)
    expect(store.getSnapshot().revision).toBe(3)
  })
})
