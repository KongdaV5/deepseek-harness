import { expect, it } from 'vitest'
import { RuntimeSettingsModel, type RuntimeOperations } from '../src/client/model.ts'
import type { LocalModelRuntimeSnapshot } from '@deepseek-ai/dsh-custom-foundation/local-runtime-types'
import type { CodexSubscriptionStatus } from '@deepseek-ai/dsh-agent-codex/types'
const local: LocalModelRuntimeSnapshot = { enabled: true, available: true, state: 'stopped', canStop: false, profile: null,
  endpoint: 'http://127.0.0.1:1/v1', profiles: [] }
const codex: CodexSubscriptionStatus = { enabled: true, runtime: 'stopped', runtimePreference: 'auto',
  systemRuntimeAvailable: false, bundledRuntimeVersion: 'fixture', account: 'not-connected', login: 'idle', modelCount: 0,
  usage: { state: 'unavailable' } }
function operations(): RuntimeOperations {
  const done = async () => undefined
  return { localStatus: async () => local, codexStatus: async () => codex, start: done, stop: done, select: done,
    reconnect: done, connect: done, disconnect: done, cancelLogin: done }
}
it('replaces previous healthy observations with absence when the next read fails', async () => {
  const ops = operations(); const model = new RuntimeSettingsModel(ops)
  await model.refresh(); expect(model.getSnapshot().local).toBe(local)
  ops.localStatus = async () => { throw new Error('transport unavailable') }
  await model.refresh(); expect(model.getSnapshot()).toEqual({ loading: false, error: 'transport unavailable' })
})
it('retires a delayed response after a newer generation or disposal', async () => {
  const ops = operations(); let resolve!: (value: LocalModelRuntimeSnapshot) => void
  ops.localStatus = () => new Promise((accept) => { resolve = accept })
  const model = new RuntimeSettingsModel(ops); const first = model.refresh()
  ops.localStatus = async () => ({ ...local, available: false })
  await model.refresh(); resolve(local); await first
  expect(model.getSnapshot().local?.available).toBe(false)
  ops.localStatus = () => new Promise((accept) => { resolve = accept })
  const pending = model.refresh(); model.dispose(); resolve(local); await pending
  expect(model.getSnapshot().local?.available).toBe(false)
})
it('serializes explicit interactions and never manufactures successful status after a rejected verb', async () => {
  const model = new RuntimeSettingsModel(operations()); let calls = 0; let release!: () => void
  const first = model.run(() => new Promise<void>((resolve) => { calls++; release = resolve }))
  await model.run(async () => { calls++ }); expect(calls).toBe(1)
  release(); await first
  await model.run(async () => { throw new Error('operation rejected') })
  expect(model.getSnapshot()).toEqual({ loading: false, error: 'operation rejected' })
})
