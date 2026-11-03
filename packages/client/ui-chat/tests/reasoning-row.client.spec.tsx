// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { ReasoningRow } from '../src/client/chat/ReasoningRow.tsx'
import { renderReasoningSlot, unusedImageLoader } from './reasoning-component-fixture.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const props = {
  renderSlot: renderReasoningSlot,
  useDisclosure,
  useGroupAction: useSearchableHidden,
  usePresentation: useDetailedPresentation,
  loadImage: unusedImageLoader,
  t,
}

describe('AssistantMarkdown reasoning privacy', () => {
  it('shows a neutral thinking status without rendering or forwarding reasoning text', () => {
    const privateText = 'private reasoning that must remain hidden'
    const calls = vi.fn()
    const renderSlot: AssistantMarkdownProps['renderSlot'] = (key, owner, options) => {
      calls(key, owner)
      return renderReasoningSlot(key, owner, options)
    }
    const view = render(<AssistantMarkdown {...props} renderSlot={renderSlot}
      blocks={[{ kind: 'reasoning', text: privateText }]} streaming={false} />)

    expect(view.getByText(t('message.stepProcess.thinking'))).toBeTruthy()
    expect(view.queryByText(privateText)).toBeNull()
    expect(calls).not.toHaveBeenCalledWith('conversation.chat.reasoning.body', expect.anything())
  })

  it('omits blank reasoning blocks without changing neighboring response text', () => {
    const view = render(<AssistantMarkdown {...props} blocks={[
      { kind: 'reasoning', text: ' \t\r\n' },
      { kind: 'text', text: 'visible answer' },
    ]} streaming={false} />)

    expect(view.queryByText(t('message.stepProcess.thinking'))).toBeNull()
    expect(view.getByText('visible answer')).toBeTruthy()
  })

  it('keeps a live accessible running status while the model is thinking', () => {
    const view = render(<ReasoningRow running t={t} />)
    const row = view.container.querySelector('[data-variant="think"]')
    expect(row?.getAttribute('data-state')).toBe('running')
    expect(view.getByText(t('row.running'))).toBeTruthy()
  })
})
