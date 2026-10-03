/** Optional UI activation installs its generated namespace through the real Gateway. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-custom-computer-use-safety/remote'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, vi } from 'vitest'
import * as ComputerUseUi from '../src/client/index.ts'

it('activates without a preinstalled Computer Use namespace and removes it on disposal', async () => {
  const ctx = new Context()
  const call = vi.fn<ConnectionHandle['rpc']['call']>(async () => {
    throw new Error('UI activation must not call the Host')
  })
  const connection: ConnectionHandle = {
    isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call, open: async function *() { throw new Error('UI activation must not open a Host stream') } },
    reconnect: () => {},
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  }
  try {
    await ctx.plugin(TypertRegistry).await()
    ctx.provide('connection', connection)
    await ctx.plugin(Gateway).await()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    expect(ctx.get('remote.computerUse')).toBeUndefined()
    const ui = ctx.plugin(ComputerUseUi)
    await ui.await()
    expect(ctx.get('remote.computerUse')).toBeDefined()
    expect(ctx.remote.computerUse.status).toBeTypeOf('function')
    expect(ctx.remote.computerUse.stop).toBeTypeOf('function')
    expect(call).not.toHaveBeenCalled()
    await ui.dispose()
    expect(ctx.get('remote.computerUse')).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
  }
}, 2_000)
