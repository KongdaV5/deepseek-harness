/** Plugin activation must own the Remote event carrier as well as its namespaces. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('activates through the canonical slot and Remote lifecycle without issuing runtime commands', async () => {
  const ctx = new Context()
  const errors: unknown[] = []
  ctx.logger.exporter({ export: (message) => { if (message.type === 'error') errors.push(message.args) } })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const status = vi.fn()
  const command = vi.fn()
  await ctx.plugin({ apply: (owner) => { new TestRemote(owner, {
    localModels: { status, start: command, restart: command, stop: command },
    codexSubscription: { status, selectRuntime: command, reconnect: command,
      connect: command, disconnect: command, cancelLogin: command },
  }) } }).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'settings.models.footer': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  try {
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(errors).toEqual([])
    expect(slots.entries('settings.models.footer').map(entry => entry.options.id)).toEqual(['custom-runtime'])
    expect(status).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(slots.entries('settings.models.footer')).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})
