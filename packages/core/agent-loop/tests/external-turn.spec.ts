import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type ExternalTurnEvent, type ExternalTurnExecutor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter } from './mock-adapter.ts'

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
    agent.cancel({ kind: 'user' })
    await idle

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })
})
