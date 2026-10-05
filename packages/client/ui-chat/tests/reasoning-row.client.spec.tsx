// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { ReasoningRow } from '../src/client/chat/ReasoningRow.tsx'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
  it('renders only a neutral thinking label and a running marker', () => {
    const view = render(<ReasoningRow running t={t} />)
    const root = view.container.querySelector('[data-variant="think"]')!
    expect(root.getAttribute('data-state')).toBe('running')
    expect(view.getByText('正在分析请求')).toBeTruthy()
    expect(view.getByText('运行中').className).toContain('visuallyHidden')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('never renders assistant reasoning content in detailed transcript mode', () => {
    const privateText = 'Inspect the session\nCheck persistence'
    const props: AssistantMarkdownProps = {
      useDisclosure,
      usePresentation: useDetailedPresentation,
      t,
      blocks: [{ kind: 'reasoning', text: privateText }],
      streaming: true,
      renderMessageImages,
    }
    const view = render(<AssistantMarkdown {...props} />)
    expect(view.getByText('正在分析请求')).toBeTruthy()
    expect(view.queryByText(/Inspect the session|Check persistence/u)).toBeNull()
    expect(view.queryByRole('button')).toBeNull()

    view.rerender(<AssistantMarkdown {...props} blocks={[
      ...props.blocks,
      { kind: 'text', text: 'Public answer' },
    ]} streaming={false} />)
    expect(view.getByText('Public answer')).toBeTruthy()
    expect(view.queryByText(/Inspect the session|Check persistence/u)).toBeNull()
  })
})
