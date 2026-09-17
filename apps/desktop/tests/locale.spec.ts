import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('derives custom startup and update identity from the product flavor name', () => {
    const english = resolveDesktopLocale('en-US', 'DS Harness').messages
    const chinese = resolveDesktopLocale('zh-CN', 'DS Harness').messages
    expect(english).toMatchObject({
      aboutMenu: 'About DS Harness', startupFailed: 'DS Harness is unavailable', updateTitle: 'DS Harness Update',
    })
    expect(chinese).toMatchObject({
      aboutMenu: '关于 DS Harness', startupFailed: 'DS Harness 无法使用', updateTitle: 'DS Harness 更新',
    })
    expect(JSON.stringify({ english, chinese })).not.toContain('DeepSeek Harness')
  })

})
