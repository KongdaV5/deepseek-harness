import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
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
async function permissions(facts: unknown, text = 'Accessibility: granted. Screen Recording: NOT granted.') {
  const ctx = await fixture(); const calls: unknown[] = []
  ctx.tools.register({ name: 'mcp__cua-driver-mcp__check_permissions', description: 'fixture',
    parameters: { type: 'object', properties: { prompt: { type: 'boolean' }, probe_direct_capture: { type: 'boolean' } } },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text }] },
    async execute(args) {
      calls.push(args)
      return { content: [{ type: 'text', text }], ...facts === undefined ? {} : { structuredContent: facts } }
    } })
  return { ctx, calls }
}
it('reads structured MCP grants despite non-JSON text and confines prompt authority to one human call identity', async () => {
  const { ctx, calls } = await permissions({ accessibility: true, screen_recording: false })
  expect(ctx.computerUseController.status().accessibility).toBe('not-requested')
  expect(calls).toEqual([])
  expect(await ctx.computerUseController.checkPermissions()).toMatchObject({ accessibility: 'granted', screenRecording: 'denied' })
  expect(await ctx.computerUseController.requestPermissions()).toMatchObject({ accessibility: 'granted' })
  expect(calls).toEqual([{ prompt: false, probe_direct_capture: false }, { prompt: true, probe_direct_capture: false }])
})
it('accepts both granted permissions and reports an explicit driver restart requirement', async () => {
  const granted = await permissions({ accessibility: true, screen_recording: true })
  expect(await granted.ctx.computerUseController.checkPermissions()).toMatchObject({ accessibility: 'granted', screenRecording: 'granted' })
  const restart = await permissions({ accessibility: true, screen_recording: true, needs_restart: true })
  expect(await restart.ctx.computerUseController.checkPermissions()).toMatchObject({ accessibility: 'granted', screenRecording: 'needs-restart' })
})
it.each([
  undefined,
  { accessibility: true },
  { accessibility: 'true', screen_recording: true },
  { accessibility: true, screen_recording: 'true' },
])('refuses missing or invalid structured grants without trusting a JSON text projection: %j', async (facts) => {
  const { ctx } = await permissions(facts, JSON.stringify({ accessibility: true, screen_recording: true }))
  await expect(ctx.computerUseController.checkPermissions()).rejects.toThrow('Could not verify Computer Use permissions')
  expect(ctx.computerUseController.status()).toMatchObject({ accessibility: 'denied', screenRecording: 'denied' })
})
