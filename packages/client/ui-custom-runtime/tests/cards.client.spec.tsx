// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeCards } from '../src/client/cards.tsx'
import { RuntimeSettingsModel, type RuntimeOperations, type RuntimeSnapshot } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
function fixture() {
  const done = async () => undefined
  const operations: RuntimeOperations = {
    localStatus: async () => ({ enabled: true, available: true, state: 'stopped', canStop: false, profile: null,
      endpoint: 'http://127.0.0.1:1/v1', profiles: [{ id: 'huihui', name: 'Huihui', modality: 'text', manageable: true, available: true },
        { id: '38', name: 'Original Qwen', modality: 'text', manageable: true, available: false },
        { id: 'img21', name: 'Image inventory', modality: 'image', manageable: false, available: true }] }),
    codexStatus: async () => ({ enabled: true, runtime: 'stopped', runtimePreference: 'auto', systemRuntimeAvailable: false,
      bundledRuntimeVersion: 'fixture', account: 'not-connected', login: 'idle', modelCount: 0, usage: { state: 'unavailable' } }),
    start: vi.fn(done), restart: vi.fn(done), stop: vi.fn(done), select: vi.fn(done),
    reconnect: done, connect: vi.fn(done), disconnect: vi.fn(done), cancelLogin: done,
  }
  const model = new RuntimeSettingsModel(operations)
  function useRuntime<T>(select: (state: RuntimeSnapshot) => T): T {
    return select(useSyncExternalStore(listener => model.subscribe(listener), () => model.getSnapshot()))
  }
  render(<RuntimeCards model={model} useRuntime={useRuntime} t={key => en[key]} />)
  return { operations, model }
}

it('admits only exact available Local profiles and explicit runtime choices without starting an auth operation', async () => {
  const { operations, model } = fixture()
  const start = await screen.findByRole('button', { name: 'Start Huihui' })
  expect(screen.getByRole('button', { name: 'Start Original Qwen' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Image inventory')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start Image inventory' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('tab', { name: 'System' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(start)
  await waitFor(() =>{  expect(operations.start).toHaveBeenCalledWith('huihui') })
  await waitFor(() =>{  expect(model.getSnapshot().loading).toBe(false) })
  fireEvent.click(screen.getByRole('tab', { name: 'Bundled' }))
  await waitFor(() =>{  expect(operations.select).toHaveBeenCalledWith('bundled') })
  expect(operations.connect).not.toHaveBeenCalled()
  expect(operations.disconnect).not.toHaveBeenCalled()
  model.dispose()
})

it('identifies the active Local profile and delegates its explicit restart to the Host', async () => {
  const { operations, model } = fixture()
  await screen.findByRole('button', { name: 'Start Huihui' })
  const status = await operations.localStatus()
  operations.localStatus = async () => ({ ...status, state: 'running', profile: 'huihui', canStop: true })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
  await screen.findByText('Current profile')
  expect(screen.queryByRole('button', { name: 'Restart Original Qwen' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Restart Huihui' }))
  await waitFor(() => { expect(operations.restart).toHaveBeenCalledWith('huihui') })
  fireEvent.click(screen.getByRole('button', { name: 'Stop Huihui' }))
  await waitFor(() => { expect(operations.stop).toHaveBeenCalledOnce() })
  expect(operations.start).not.toHaveBeenCalled()
  expect(operations.connect).not.toHaveBeenCalled()
  model.dispose()
})

it('shows each canonical Local lifecycle and availability state with its active profile', async () => {
  const { operations, model } = fixture()
  const waitForLocalStatus = async (expected: string): Promise<void> => {
    await waitFor(() => { expect(screen.getAllByRole('status')[0]?.textContent).toBe(expected) })
  }
  await waitForLocalStatus('Local runtime · Stopped')
  const stopped = await operations.localStatus()
  const refreshAs = async (next: Awaited<ReturnType<RuntimeOperations['localStatus']>>, expected: string): Promise<void> => {
    operations.localStatus = async () => next
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitForLocalStatus(expected)
  }
  await refreshAs({ ...stopped, state: 'starting' }, 'Local runtime · Starting')
  await refreshAs({ ...stopped, state: 'running', profile: 'huihui' }, 'Local runtime · Ready')
  await refreshAs({ ...stopped, state: 'stopping', profile: 'huihui' }, 'Local runtime · Stopping')
  await refreshAs({ ...stopped, available: false, state: 'error', error: 'Manager unavailable' }, 'Local runtime · Unavailable')
  await refreshAs({ ...stopped, state: 'error', error: 'Health check failed' }, 'Local runtime · Error')
  await refreshAs({ ...stopped, enabled: false, available: false, state: 'stopped' }, 'Local runtime · Disabled in this profile')
  model.dispose()
})

it('replaces a stale runtime view with an alert and disables controls when the owner read fails', async () => {
  const { operations, model } = fixture()
  await screen.findByRole('button', { name: 'Start Huihui' })
  operations.localStatus = async () => { throw new Error('Host disconnected') }
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe('Host disconnected')
  expect(screen.queryByRole('button', { name: 'Start Huihui' })).toBeNull()
  expect(screen.getByText('Local models').closest('fieldset')?.disabled).toBe(true)
  model.dispose()
})

it('renders the Host runtime, catalog and both usage windows without inferring connection or invoking auth', async () => {
  const { operations, model } = fixture()
  await screen.findByRole('button', { name: 'Start Huihui' })
  operations.codexStatus = async () => ({ enabled: true, runtime: 'ready', runtimePreference: 'system',
    runtimeSource: 'system', runtimeVersion: '0.159.2', systemRuntimeAvailable: true, bundledRuntimeVersion: 'fixture',
    runtimeSelectionNote: 'Host-selected System runtime', account: 'connected', login: 'idle', modelCount: 8,
    usage: { state: 'available', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1700000000 },
      secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1700604800 } },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
  await screen.findByText('Ready · Connected')
  expect(screen.getByText('Available models: 8')).toBeTruthy()
  expect(screen.getByText('Host-selected System runtime')).toBeTruthy()
  expect(screen.getByText(/Primary window: 12%/u).textContent).toContain('300 min')
  expect(screen.getByText(/Secondary window: 34%/u).textContent).toContain('10080 min')
  expect(document.querySelectorAll('time')).toHaveLength(2)
  expect(operations.connect).not.toHaveBeenCalled()
  expect(operations.disconnect).not.toHaveBeenCalled()
  model.dispose()
})
