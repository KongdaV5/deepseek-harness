import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Safety from '../src/index.ts'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx); await ctx.plugin(CommandRuntime); await ctx.plugin(Safety)
  return ctx
}
it('reports an absent driver without any startup permission query', async () => {
  const ctx = await fixture()
  expect(ctx.computerUseController.status()).toMatchObject({ driver: 'driver-unavailable', accessibility: 'driver-unavailable' })
})
it('accepts only boolean permission facts and confines prompt authority to one human call identity', async () => {
  const ctx = await fixture(); const calls: unknown[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'mcp__cua-driver-mcp__check_permissions', description: 'fixture',
    parameters: { prompt: { type: 'boolean' }, probe_direct_capture: { type: 'boolean' } },
    async execute(args) { calls.push(args); return [{ type: 'text', text: JSON.stringify({ accessibility: true, screen_recording: false }) }] } }))
  expect(ctx.computerUseController.status().accessibility).toBe('not-requested')
  expect(calls).toEqual([])
  expect(await ctx.computerUseController.checkPermissions()).toMatchObject({ accessibility: 'granted', screenRecording: 'denied' })
  expect(await ctx.computerUseController.requestPermissions()).toMatchObject({ accessibility: 'granted' })
  expect(calls).toEqual([{ prompt: false, probe_direct_capture: false }, { prompt: true, probe_direct_capture: false }])
})
