/** Local Session visibility action: hidden state never enters Host registry or session history. */

import {
  IconCloseOutlineRegular, IconRefreshOutlineRegular, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HideSessionProps } from '../contract/slots.ts'

/** Hide a Session from the browser, or restore it while hidden rows are shown. */
export function HideSessionMenuItem({
  sessionId, useHidden, useMenuOpenState, setSessionHidden, t,
}: HideSessionProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const hidden = useHidden(ids => ids.has(sessionId))
  return (
    <MenuItemButton
      icon={hidden ? <IconRefreshOutlineRegular size={14} /> : <IconCloseOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        setSessionHidden(sessionId, !hidden)
      }}
    >
      {t(hidden ? 'menu.unhideSession' : 'menu.hideSession')}
    </MenuItemButton>
  )
}
