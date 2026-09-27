// @vitest-environment jsdom
/** FontSizeRow behavior: value display, arrow clicks drive setFontSize,
 * bound-value arrows disable, display follows the store mirror. */
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
    { ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
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

describe('FontSizeRow', () => {
  it('renders the global-size guidance and an editable positive value', () => {
    mount(14)
    expect(screen.getByText('Global interface size')).toBeDefined()
    expect(screen.getByText('Scales text and layout throughout the client; enter any value greater than 0')).toBeDefined()
    expect(screen.getByRole('spinbutton', { name: 'Global interface size in pixels' })).toHaveProperty('value', '14')
    expect(arrow('Increase font size').disabled).toBe(false)
    expect(arrow('Decrease font size').disabled).toBe(false)
  })

  it('arrow clicks step by 1; display follows the store mirror, not the click echo', () => {
    const b = mount(14)
    fireEvent.click(arrow('Increase font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(15)
    // No store write yet: the controlled input still reflects the store.
    expect(screen.getByRole('spinbutton', { name: 'Global interface size in pixels' })).toHaveProperty('value', '14')
    act(() => { b.store.actions.sync(15, 1) })
    expect(screen.getByRole('spinbutton', { name: 'Global interface size in pixels' })).toHaveProperty('value', '15')
    fireEvent.click(arrow('Decrease font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(14)
  })

  it('steps below the previous 12px floor and accepts positive decimal values', () => {
    const b = mount(12)
    expect(arrow('Decrease font size').disabled).toBe(false)
    fireEvent.click(arrow('Decrease font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(11)
    const input = screen.getByRole('spinbutton', { name: 'Global interface size in pixels' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0.25' } })
    expect(b.setFontSize).toHaveBeenLastCalledWith(11)
    fireEvent.blur(input)
    expect(b.setFontSize).toHaveBeenLastCalledWith(0.25)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(b.setFontSize).toHaveBeenLastCalledWith(0.25)
  })

  it('keeps decreasing with a positive fractional step rather than imposing a minimum', () => {
    const b = mount(0.5)
    fireEvent.click(arrow('Decrease font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(0.25)
  })
})
