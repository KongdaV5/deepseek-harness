import { useCallback, useEffect } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft persisted while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, inputActions, useStore, actions,
  renderSlot, bindDraftPersistence, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewRequest = useStore(s => s.viewRequest ?? null)
  const hiddenMessageSeqs = useStore(s => s.hiddenMessageSeqs ?? EMPTY_HIDDEN_MESSAGE_SEQS)
  const showHiddenMessages = useStore(s => s.showHiddenMessages ?? false)
  const setMessageHidden = useCallback(
    (seq: number, hidden: boolean) => { actions.setMessageHidden(seq, hidden) },
    [actions.setMessageHidden],
  )
  const setHiddenMessagesVisible = useCallback(
    (visible: boolean) => { actions.setHiddenMessagesVisible(visible) },
    [actions.setHiddenMessagesVisible],
  )

  useEffect(() => {
    const unbindDraftPersistence = bindDraftPersistence(actions.setDraft)
    inputActions.persistDraft()
    return () => { unbindDraftPersistence() }
    // The Session input owns content before this persistence writer is attached.
  }, [inputActions])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  const viewId = view ?? active?.id
  return (
    <div className={css.viewArea}>
      {viewId !== undefined && renderSlot('conversation.view', {
        inspectCall,
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
        hiddenMessageSeqs,
        showHiddenMessages,
        setMessageHidden,
        setHiddenMessagesVisible,
      }, { only: viewId })}
    </div>
  )
}

const EMPTY_HIDDEN_MESSAGE_SEQS: readonly number[] = []
