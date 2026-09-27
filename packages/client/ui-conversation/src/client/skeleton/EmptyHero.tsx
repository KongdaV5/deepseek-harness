// The composer remains in ConversationRoot so switching out of the blank-draft
// phase does not remount its textarea.

import type { ReactNode, RefObject } from 'react'
import { IconChevronDownOutline14, IconFolderClose16, IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ConversationContentProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationContentProps['t']

/** Basename label for the workspace chip; separator-only paths echo the raw cwd. */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/** The workspace chip remains switchable before the first message. */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label?: string | undefined
  menuOpen?: boolean
  onClick?: () => void
  t: HeroTranslate
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label={t('hero.chooseWorkspace')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={onClick}
    >
      {label === undefined
        ? <IconFolderClose16 className={css.folder} size={16} />
        : <IconFolderOpen16 className={css.folder} size={16} />}
      <span className={css.workspaceLabel}>{label ?? t('hero.chooseWorkspace')}</span>
      <IconChevronDownOutline14 className={css.chevron} size={12} />
    </button>
  )
}

/** Hero chrome props. The workspace row rides the InputBar accessory hole. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Authorized renderer for the hero brand-mark slot. */
  renderSlot: ConversationContentProps['renderSlot']
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/** Original DSH helper mascot; intentionally not based on third-party character art. */
function HeroAssistant() {
  return (
    <svg className={css.mascot} width="44" height="44" viewBox="0 0 64 64" aria-hidden="true">
      <path className={css.antenna} d="M32 13V7" />
      <circle className={css.signal} cx="32" cy="6" r="3.5" />
      <rect className={css.robotBody} x="8" y="14" width="48" height="42" rx="17" />
      <rect className={css.robotFace} x="14" y="20" width="36" height="25" rx="11" />
      <g className={css.robotEyes}>
        <circle cx="24" cy="30" r="2.8" />
        <circle cx="40" cy="30" r="2.8" />
      </g>
      <path className={css.robotSmile} d="M26 37c1.6 2 3.6 3 6 3s4.4-1 6-3" />
      <rect className={css.robotBadge} x="27" y="48" width="10" height="3" rx="1.5" />
    </svg>
  )
}

/** Render the hero chrome (headline only; no composer, no workspace row). */
export function HeroShell({ t, renderSlot, children }: HeroShellProps) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline} data-testid="hero-headline">
          <span className={css.mascotHost}>
            {renderSlot('conversation.hero.brand.mark', { size: 44, className: css.mascot }, {
              fallback: <HeroAssistant />,
            })}
          </span>
          <span className={css.titleGroup}>{t('hero.headline')}</span>
        </div>
        <div className={css.body}>
          {/* The composer remains mounted outside this component. */}
        </div>
      </div>
      {children}
    </div>
  )
}
