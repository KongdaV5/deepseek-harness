// @vitest-environment jsdom
/** FontSizeRow behavior: editable value display, direct entry, arrow clicks
 * drive setFontSize, display follows the store mirror. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { FontSizeRow } from '../src/client/FontSizeRow.tsx'
import type { FontSizeRowComponentProps } from '../src/client/FontSizeRow.tsx'
import { createFontSizeRowStore } from '../src/client/settings-store.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'fontSize.title': 'Global interface size',
  'fontSize.description': 'Scales text and layout throughout the client; enter any value greater than 0',
  'fontSize.inputLabel': 'Global interface size in pixels',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<FontSizeRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: FontSizeRowComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(fontSize = 14) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createFontSizeRowStore().create()
  store.actions.sync(fontSize, 0)
  const setFontSize = vi.fn()
  const props: FontSizeRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setFontSize,
  }
  render(<FontSizeRow {...props} />)
  return { store, setFontSize }
}

const arrow = (name: string): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement

const sizeInput = (): HTMLInputElement => screen.getByLabelText('Global interface size in pixels') as HTMLInputElement

describe('FontSizeRow', () => {
  it('renders the title, the description, and the current size with both arrows enabled', () => {
    mount(14)
    expect(screen.getByText('Global interface size')).toBeDefined()
    expect(screen.getByText('Scales text and layout throughout the client; enter any value greater than 0')).toBeDefined()
    expect(sizeInput().value).toBe('14')
    expect(arrow('Increase font size').disabled).toBe(false)
    expect(arrow('Decrease font size').disabled).toBe(false)
  })

  it('arrow clicks step by 1; display follows the store mirror, not the click echo', () => {
    const b = mount(14)
    fireEvent.click(arrow('Increase font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(15)
    // No store write yet: the display is unchanged.
    expect(sizeInput().value).toBe('14')
    act(() => { b.store.actions.sync(15, 1) })
    expect(sizeInput().value).toBe('15')
    fireEvent.click(arrow('Decrease font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(14)
  })

  it('keeps stepping below 1px by halving instead of imposing a floor', () => {
    const b = mount(0.5)
    fireEvent.click(arrow('Decrease font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(0.25)
    fireEvent.click(arrow('Increase font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(1)
    expect(arrow('Decrease font size').disabled).toBe(false)
  })

  it('commits a typed positive value on blur and discards junk', () => {
    const b = mount(14)
    const input = sizeInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '18.5' } })
    expect(input.value).toBe('18.5')
    fireEvent.blur(input)
    expect(b.setFontSize).toHaveBeenCalledWith(18.5)

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(b.setFontSize).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('14')
  })

  it('commits a typed value on Enter without waiting for blur', () => {
    const b = mount(14)
    const input = sizeInput()
    // Real focus rather than a synthetic event: Enter commits by blurring the
    // field, and jsdom only dispatches the `focusout` React listens for when
    // the element actually holds focus.
    act(() => { input.focus() })
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(b.setFontSize).toHaveBeenCalledWith(20)
  })
})
