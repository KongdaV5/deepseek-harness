import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { installModelSelection, type Agent, type ExternalTurnEvent, type ExternalTurnExecutor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { hasDesktopActiveTasks } from '../../../../apps/desktop-host/src/update-tasks.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'local-only persona' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['codex'], adapter)
  ctx.provide('externalModelProviders', {
    listProviders: () => [{
      id: 'codex',
      name: 'Codex',
      listModels: async () => [],
      resolveSelection: async selection => selection,
    }],
  })
  return { ctx, adapter }
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('external Agent turns', () => {
  it('keeps model selection and disposal independent across live Sessions', async () => {
    const { ctx } = await harness()
    try {
      const local = new MockAdapter([textResponse('Local first'), textResponse('Local retained')])
      ctx.llm.registerAdapter(['local'], local)
      const localSelection = { current: { provider: 'local', model: 'huihui' }, assembled: undefined }
      const codexSelection = { current: { provider: 'codex', model: 'dynamic-model' }, assembled: undefined }
      const first = await ctx.agents.create({
        sessionId: SessionId('selection-local'),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: 'local', model: 'huihui' },
        setup(agentCtx) { installModelSelection(agentCtx, localSelection) },
      })
      const second = await ctx.agents.create({
        sessionId: SessionId('selection-codex'),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: 'local', model: 'huihui' },
        setup(agentCtx) { installModelSelection(agentCtx, codexSelection) },
      })
      const external = vi.fn(async () => ({ text: 'Codex selected' }))
      ctx.on('agent/resolve-external-turn', async (_request, next) => await next() ?? {
        providerId: 'codex',
        resolveWorkspace: async (_session, cwd) => ({ identity: 'isolated-selection', cwd }),
        executeTurn: external,
      })
      expect(ctx.get('agentModelSelection')).toBeUndefined()
      expect(first.agent.ctx.get('agentModelSelection')).toBe(localSelection)
      expect(second.agent.ctx.get('agentModelSelection')).toBe(codexSelection)
      const localIdle = waitForIdle(ctx, first.agent)
      const codexIdle = waitForIdle(ctx, second.agent)
      send(first.agent, 'Local only')
      send(second.agent, 'Codex only')
      await Promise.all([localIdle, codexIdle])
      expect(external).toHaveBeenCalledTimes(1)
      expect(local.requests).toHaveLength(1)
      expect(second.agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end', data: { reason: { kind: 'completed' } },
      })
      await second.dispose()
      expect(first.agent.ctx.get('agentModelSelection')).toBe(localSelection)
      const retainedIdle = waitForIdle(ctx, first.agent)
      send(first.agent, 'Still Local')
      await retainedIdle
      expect(local.requests).toHaveLength(2)
      expect(external).toHaveBeenCalledTimes(1)
      await first.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves a frozen external route before local prompt/tool assembly and settles through DSH', async () => {
    const { ctx, adapter } = await harness()
    const agent = await ctx.agentLoop.create(SessionId('external-before-local-assembly'), {
      provider: 'codex', model: 'gpt-5.4',
    }, { cwd: process.cwd() })
    const selectionRef = { current: { provider: 'codex', model: 'gpt-5.4' }, assembled: undefined }
    agent.ctx.provide('agentModelSelection', selectionRef)
    const localAssembly = vi.fn()
    const externalEvents: ExternalTurnEvent[] = []
    ctx.on('agent/external-turn-event', ({ event }) => { externalEvents.push(event) }, { global: true })
    ctx.on('system-prompt/assemble', async (...args) => {
      localAssembly()
      return args[2]()
    })
    let requestRoute: { provider: string; model: string } | undefined
    let workspaceIdentity: string | undefined
    const executor: ExternalTurnExecutor = {
      providerId: 'codex',
      async resolveWorkspace(_session, cwd) { return { identity: 'workspace-test', cwd } },
      async executeTurn(request) {
        expect(Object.isFrozen(request.selection)).toBe(true)
        requestRoute = request.selection
        workspaceIdentity = request.workspaceIdentity
        selectionRef.current = { provider: 'local', model: 'local-model' }
        request.publish.event({
          kind: 'command', id: 'codex-item-1', command: 'node', status: 'completed',
          identity: {
            activityId: 'codex-thread:codex-turn:codex-item-1',
            eventId: 'codex-thread:codex-turn:codex-item-1:item/completed:completed',
            sessionId: request.session.id, dshTurn: request.turn, dshStep: request.step,
            provider: 'codex', runtimeSource: 'system', runtimeVersion: 'test-runtime',
            threadId: 'codex-thread', turnId: 'codex-turn', itemId: 'codex-item-1',
            eventKind: 'item/completed', terminalState: 'completed',
          },
        })
        request.publish.textDelta('Codex response')
        return { text: 'Codex response', usage: { inputTokens: 12, outputTokens: 3 } }
      },
    }
    ctx.on('agent/resolve-external-turn', async ({ selection }, next) => {
      expect(selection).toEqual({ provider: 'codex', model: 'gpt-5.4' })
      return await next() ?? executor
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'Run through the external provider')
    await idle

    expect(adapter.requests).toHaveLength(0)
    expect(localAssembly).not.toHaveBeenCalled()
    expect(requestRoute).toEqual({ provider: 'codex', model: 'gpt-5.4' })
    expect(workspaceIdentity).toBe('workspace-test')
    expect(externalEvents).toHaveLength(1)
    expect(externalEvents[0]).toMatchObject({ kind: 'command', status: 'completed', id: 'codex-item-1' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })
  })

  it('fails closed instead of falling back to the Local adapter when external execution fails', async () => {
    const { ctx, adapter } = await harness()
    const agent = await ctx.agentLoop.create(SessionId('external-failure-no-fallback'), {
      provider: 'codex', model: 'gpt-5.4',
    }, { cwd: process.cwd() })
    ctx.on('agent/resolve-external-turn', async (_payload, next) => await next() ?? {
      providerId: 'codex',
      async resolveWorkspace(_session, cwd) { return { identity: 'workspace-test', cwd } },
      async executeTurn() { throw new Error('Codex account is unavailable') },
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'Do not route this to Local')
    await idle

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/attempt')).toBe(true)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error' } },
    })
  })

  it('settles cancellation through the existing DSH turn end without local fallback', async () => {
    const { ctx, adapter } = await harness()
    await ctx.plugin(LocalJobRegistry)
    const agent = await ctx.agentLoop.create(SessionId('external-cancel'), {
      provider: 'codex', model: 'gpt-5.4',
    }, { cwd: process.cwd() })
    const started = Promise.withResolvers<boolean>()
    ctx.on('agent/resolve-external-turn', async (_payload, next) => await next() ?? {
      providerId: 'codex',
      async resolveWorkspace(_session, cwd) { return { identity: 'workspace-test', cwd } },
      executeTurn: ({ signal }) => new Promise((_resolve, reject) => {
        started.resolve(true)
        signal.addEventListener('abort', () => { reject(new Error('external turn aborted')) }, { once: true })
      }),
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'Cancel external turn')
    await started.promise
    expect(hasDesktopActiveTasks(ctx.agents.list(), ctx.jobs)).toBe(true)
    agent.cancel({ kind: 'user' })
    await idle
    expect(hasDesktopActiveTasks(ctx.agents.list(), ctx.jobs)).toBe(false)

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })
})


it('switches Local → Codex → Local through one Session without substitute routing or local request duplication', async () => {
  const { ctx } = await harness()
  const local = new MockAdapter([textResponse('Local first'), textResponse('Local returned')])
  ctx.llm.registerAdapter(['local'], local)
  const agent = await ctx.agentLoop.create(SessionId('cross-provider'), { provider: 'local', model: 'huihui' }, { cwd: process.cwd() })
  const selection = { current: { provider: 'local', model: 'huihui' }, assembled: undefined }
  installModelSelection(agent.ctx, selection)
  let external = 0
  ctx.on('agent/resolve-external-turn', async ({ selection: selected }, next) => await next() ?? (selected.provider !== 'codex' ? undefined : {
    providerId: 'codex', resolveWorkspace: async (_session, cwd) => ({ identity: 'isolated-switch', cwd }),
    executeTurn: async (request) => { external++; request.publish.textDelta('Codex selected'); return { text: 'Codex selected' } },
  }))
  for (const route of [{ provider: 'local', model: 'huihui' }, { provider: 'codex', model: 'dynamic-model' }, { provider: 'local', model: 'huihui' }]) {
    selection.current = route
    const idle = waitForIdle(ctx, agent); send(agent, 'Selected route only'); await idle
  }
  expect(local.requests).toHaveLength(2); expect(external).toBe(1)
  const events = agent.session.snapshotEvents()
  expect(events.filter(e => e.type === 'assistant/message')).toHaveLength(3)
  expect(events.filter(e => e.type === 'request/header').map(e => e.data.header.config.provider)).toEqual(['local', 'codex', 'local'])
  expect(events.filter(e => e.type === 'turn/end').every(e => e.data.reason.kind === 'completed')).toBe(true)
  await ctx.fiber.dispose()
})


it('drains an admitted external turn through the native Agent disposal owner before root shutdown completes', async () => {
  const { ctx, adapter } = await harness()
  const agent = await ctx.agentLoop.create(SessionId('external-shutdown'), { provider: 'codex', model: 'fixture' }, { cwd: process.cwd() })
  const entered = Promise.withResolvers<undefined>()
  let cancelled = false
  ctx.on('agent/resolve-external-turn', async (_payload, next) => await next() ?? {
    providerId: 'codex', resolveWorkspace: async (_session, cwd) => ({ identity: 'fixture', cwd }),
    executeTurn: async ({ signal }) => {
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { cancelled = true; reject(new Error('external owner disposed')) }, { once: true }) })
      return { text: '' }
    },
  })
  send(agent, 'Shut down this external turn'); await entered.promise
  await ctx.fiber.dispose()
  expect(cancelled).toBe(true)
  expect(adapter.requests).toHaveLength(0)
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
})
