/**
 * Font-size preference row registered into the General section item slot:
 * title + global-size description + editable numeric control + stepper pill
 * (centered value; hover reveals the up/down arrow column at its right edge) + a px
 * unit label after the pill. Registered by this package — the theme feature
 * owns the global interface-size setting the same way it owns the appearance
 * preference. The displayed value follows the persisted setting, never the
 * click echo.
 */
import {
  IconChevronDownOutline14, IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontSizeRowStore } from './settings-store.ts'
import css from './FontSizeRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface FontSizeRowInjected {
  /** Change the global interface font-size reference to any positive finite value. */
  setFontSize: (px: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontSizeRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontSizeRowStore>>
  & PropsLocale<'settings.theme'> & FontSizeRowInjected

/**
 * Render the font-size row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function FontSizeRow({ t, setFontSize, useStore }: FontSizeRowComponentProps) {
  const fontSize = useStore(s => s.fontSize)
  const [draft, setDraft] = useState<string | null>(null)
  const increase = fontSize < 1 ? fontSize * 2 : fontSize + 1
  const decrease = fontSize > 1 ? fontSize - 1 : fontSize / 2
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('fontSize.title')}</div>
        <div className={css.desc}>{t('fontSize.description')}</div>
      </div>
      <div className={css.control}>
        <div className={css.stepper}>
          <input
            className={css.value}
            type="number"
            inputMode="decimal"
            step="any"
            aria-label={t('fontSize.inputLabel')}
            value={draft ?? String(fontSize)}
            onFocus={() => { setDraft(current => current ?? String(fontSize)) }}
            onChange={(event) => {
              setDraft(event.currentTarget.value)
            }}
            onBlur={() => {
              if (draft === null) return
              const value = Number(draft)
              if (Number.isFinite(value) && value > 0) setFontSize(value)
              setDraft(null)
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
          <span className={css.arrows}>
            <button
              type="button"
              className={css.arrow}
              aria-label={t('fontSize.increase')}
              disabled={!Number.isFinite(increase) || increase <= fontSize}
              onClick={() => { setFontSize(increase) }}
            >
              <IconChevronUpOutline14 size={9} />
            </button>
            <button
              type="button"
              className={css.arrow}
              aria-label={t('fontSize.decrease')}
              disabled={!Number.isFinite(decrease) || decrease <= 0 || decrease >= fontSize}
              onClick={() => { setFontSize(decrease) }}
            >
              <IconChevronDownOutline14 size={9} />
            </button>
          </span>
        </div>
        <span className={css.unit}>{t('fontSize.unit')}</span>
      </div>
    </div>
  )
}
