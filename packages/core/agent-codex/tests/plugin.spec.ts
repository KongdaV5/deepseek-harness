import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as agentCodex from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('agent-codex composition', () => {
  it('mounts account and model discovery without a selected workspace or turn-only services', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)

    await ctx.plugin(agentCodex)

    expect(agentCodex.inject).toEqual(['sessionProjections', 'sessions'])
    expect(ctx.get('codexSubscription')).toBeDefined()
    expect(ctx.get('externalModelProviders')?.listProviders()).toHaveLength(1)
    expect(ctx.get('workspaceRegistry')).toBeUndefined()
    expect(ctx.get('approval')).toBeUndefined()
    expect(ctx.get('subprocess')).toBeUndefined()
  })
})
