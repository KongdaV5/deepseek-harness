// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComputerUseStatus } from '@deepseek-ai/dsh-custom-computer-use-safety/types'
import { ComputerUseActivity, ComputerUseSettings } from '../src/client/controls.tsx'
import { ComputerUseModel, type Snapshot } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)
const idle: ComputerUseStatus = { driver: 'ready', accessibility: 'not-requested', screenRecording: 'not-requested',
  permissionOwner: 'CuaDriver (com.trycua.driver)', lease: { state: 'released', stop: 'running', inFlight: 0, actApproved: false } }

it('keeps the composer clear at idle and offers Stop during desktop work even when the composer is locked', () => {
  const stop = vi.fn(async () => idle)
  const model = new ComputerUseModel({ status: stop, stop, requestPermissions: stop, checkPermissions: stop, resume: stop })
  function activity(state: Snapshot) {
    return <ComputerUseActivity locked useComputerUse={select => select(state)}
      model={model} t={key => en[key]} />
  }
  const composer = render(activity({}))
  expect(composer.container.textContent).toBe('')
  composer.rerender(activity({ status: idle }))
  expect(composer.container.textContent).toBe('')

  composer.rerender(activity({ status: { ...idle, lease: { ...idle.lease, state: 'active', inFlight: 1 } } }))
  expect(screen.getByRole('status').textContent).toBe('Computer use active')
  fireEvent.click(screen.getByRole('button', { name: 'Stop all computer use' }))
  expect(stop).toHaveBeenCalledOnce()

  composer.rerender(activity({ status: { ...idle, lease: { ...idle.lease, state: 'draining', stop: 'stopping', inFlight: 1 } } }))
  expect(screen.getByRole('status').textContent).toBe('Stopping computer use')
  expect(screen.getByRole('button', { name: 'Stop all computer use' })).toBeTruthy()

  composer.rerender(activity({ status: { ...idle, lease: { ...idle.lease, stop: 'stopped' } } }))
  expect(screen.getByRole('status').textContent).toBe('Computer use stopped')
  expect(screen.queryByRole('button')).toBeNull()
  composer.rerender(activity({ error: 'host-unavailable' }))
  expect(screen.getByRole('status').textContent).toBe('Computer use status unavailable')
  expect(screen.getByRole('button', { name: 'Stop all computer use' })).toBeTruthy()
  composer.rerender(activity({ status: idle }))
  expect(composer.container.textContent).toBe('')
  model.dispose()
})

it('never prompts on mount; permission and Stop remain separate explicit user operations', async () => {
  const status = vi.fn(async () => idle)
  const checked = Promise.withResolvers<ComputerUseStatus>()
  const requestPermissions = vi.fn(() => checked.promise)
  const stop = vi.fn(async () => ({ ...idle, lease: { ...idle.lease, stop: 'stopped' as const } }))
  const model = new ComputerUseModel({ status, stop, requestPermissions, checkPermissions: status, resume: status })
  function useComputerUse<T>(select: (value: Snapshot) => T): T {
    return select(useSyncExternalStore(listener => model.subscribe(listener), () => model.getSnapshot()))
  }
  render(<ComputerUseSettings model={model} useComputerUse={useComputerUse} t={key => en[key]} />)
  await screen.findByRole('button', { name: 'Request permissions' })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Request permissions' }).hasAttribute('disabled')).toBe(false) })
  expect(screen.getByText('Computer Use · Lease: Idle · Global Stop: Not engaged')).toBeTruthy()
  expect(requestPermissions).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Request permissions' }))
  fireEvent.click(screen.getByRole('button', { name: 'Global Stop' }))
  await waitFor(() => { expect(stop).toHaveBeenCalledOnce() })
  checked.resolve(idle)
  await waitFor(() => { expect(model.getSnapshot().status?.lease.stop).toBe('stopped') })
  expect(await screen.findByText('Computer Use · Lease: Idle · Global Stop: Engaged')).toBeTruthy()
  model.dispose()
})
it('retiring the model rejects a late healthy response and owns polling cleanup', async () => {
  const pending = Promise.withResolvers<ComputerUseStatus>()
  const operation = () => pending.promise
  const model = new ComputerUseModel({ status: operation, stop: operation, resume: operation,
    checkPermissions: operation, requestPermissions: operation })
  const read = model.run(operation)
  model.dispose(); pending.resolve(idle); await read
  expect(model.getSnapshot().status).toBeUndefined()
})

it('periodic observations cannot discard a slow explicit permission result', async () => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<ComputerUseStatus>()
  const status = vi.fn(async () => idle)
  const model = new ComputerUseModel({ status, stop: status, resume: status,
    checkPermissions: () => pending.promise, requestPermissions: () => pending.promise })
  const dispose = model.subscribe(() => {})
  try {
    await Promise.resolve()
    const checked = model.run(() => model.operations.checkPermissions())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(status).toHaveBeenCalledOnce()
    pending.resolve({ ...idle, accessibility: 'granted', screenRecording: 'granted' })
    await checked
    expect(model.getSnapshot().status?.accessibility).toBe('granted')
  } finally { dispose(); model.dispose(); vi.useRealTimers() }
})
