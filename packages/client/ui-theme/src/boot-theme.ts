/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference and global interface size.
 * Head CSS colors the document canvas before script execution; the body script
 * installs the palette selector and global scale that the client presenters adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, type ThemePreference } from './theme-settings.ts'

const LIGHT_BACKGROUND = '#fff'
const DARK_BACKGROUND = '#151517'

/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference: ThemePreference): string {
  const light = `:root{color-scheme:light}body{background-color:${LIGHT_BACKGROUND};--dsh-boot-bg:${LIGHT_BACKGROUND}}`
  const dark = `:root{color-scheme:dark}body{background-color:${DARK_BACKGROUND};--dsh-boot-bg:${DARK_BACKGROUND}}`
  if (preference === 'light') return light
  if (preference === 'dark') return dark
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/** Build the body script that installs the palette selector and global UI scale. */
function bootThemeBodyScript(preference: ThemePreference, fontSize: number): string {
  const scale = fontSize / DEFAULT_FONT_SIZE
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', ${JSON.stringify(`${DEFAULT_FONT_SIZE}px`)})
  document.body.style.setProperty('--dsh-ui-font-size', ${JSON.stringify(`${fontSize}px`)})
  document.body.style.setProperty('--dsh-ui-font-scale', ${JSON.stringify(String(scale > 0 ? scale : Number.MIN_VALUE))})
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector and global
 * interface scale before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSize - Current Host-backed global interface font-size reference in px.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_FONT_SIZE,
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSize) },
  ]
}
