/** V1 uses the production scoped registry, including dynamic discovery and ACT approval. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { ToolTaxonomy } from '../src/classify.ts'
import { installV1Presentation, isV1PresentedTool, V1_TOOL_GROUPS } from '../src/presentation.ts'
import { COMPUTER_USE_SAFETY_GUIDANCE } from '../src/guidance.ts'
import * as Safety from '../src/index.ts'

const prefix = 'mcp__cua-driver-mcp__'
const contexts: Context[] = []
afterEach(async () => { while (contexts.length > 0) await contexts.pop()!.fiber.dispose() })

/** Use real ToolRuntime/Agent scopes without an inference backend. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  return ctx
}

/** One fake provider registration preserves the real production registry semantics. */
function register(ctx: Context, name: string, ran: string[] = []): () => void {
  return ctx.tools.register(defineContentToolFixture({
    name, description: name, parameters: {},
    async execute() { ran.push(name); return [{ type: 'text', text: 'done' }] },
  }))
}

/** Install the single policy owner, without replacing provider discovery. */
function install(ctx: Context): void {
  installV1Presentation(ctx, new ToolTaxonomy({ prefixes: [prefix], observeTools: [], actTools: [] }))
}

/** Canonical foreground Agent creation runs the awaited presentation hook. */
async function create(ctx: Context, id = 'presentation'): Promise<Agent> {
  return (await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'dsh-local-huihui', model: 'text' } })).agent
}

it('keeps full discovery but presents exactly the eight reviewed tools and unchanged non-CU schemas', async () => {
  const ctx = await mount()
  const catalog = Object.values(V1_TOOL_GROUPS).flat()
  expect(new Set(catalog).size).toBe(56)
  for (const name of catalog) register(ctx, prefix + name)
  register(ctx, 'read_file')
  const original = ctx.tools.schemas().find(tool => tool.name === 'read_file')
  install(ctx)
  const agent = await create(ctx)
  const schemas = ctx.tools.schemas(agent)
  expect(ctx.tools.schemas()).toHaveLength(57)
  expect(schemas.filter(tool => tool.name.startsWith(prefix)).map(tool => tool.name).sort())
    .toEqual([...V1_TOOL_GROUPS.OBSERVE_CORE, ...V1_TOOL_GROUPS.ACT_CORE].map(name => prefix + name).sort())
  expect(schemas.find(tool => tool.name === 'read_file')).toEqual(original)
  register(ctx, 'new_non_cu_tool')
  expect(ctx.tools.schemas(agent).some(tool => tool.name === 'new_non_cu_tool')).toBe(true)
  // The permission controller queries the complete global registry, not the model view.
  expect(ctx.tools.schemas().some(tool => tool.name === prefix + 'check_permissions')).toBe(true)
})

it('future unknown tools fail closed, including reconnect discovery, without running their body', async () => {
  const ctx = await mount()
  register(ctx, prefix + 'list_windows')
  install(ctx)
  const agent = await create(ctx)
  const ran: string[] = []
  const dispose = register(ctx, prefix + 'future_action', ran)
  expect(ctx.tools.schemas(agent).some(tool => tool.name.endsWith('future_action'))).toBe(false)
  const result = await ctx.tools.execute({ agent, signal: new AbortController().signal,
    callId: ToolCallId('future'), name: prefix + 'future_action', arguments: {} })
  expect(result.isError).toBe(true)
  expect(ran).toEqual([])
  dispose()
  register(ctx, prefix + 'future_action', ran)
  expect(ctx.tools.schemas(agent).some(tool => tool.name.endsWith('future_action'))).toBe(false)
  expect(isV1PresentedTool('future_action')).toBe(false)
})

it('enabling after an Agent exists installs the same presentation mask', async () => {
  const ctx = await mount()
  register(ctx, prefix + 'clipboard_read')
  register(ctx, prefix + 'click')
  const agent = await create(ctx)
  install(ctx)
  expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual([prefix + 'click'])
})

for (const allowed of [false, true]) {
  it(`a presented ACT still traverses canonical approval (${allowed ? 'allow' : 'deny'})`, async () => {
    const ctx = await mount()
    await ctx.plugin(ComputerUseRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    let approvals = 0
    ctx.on('approval/request', async () => { approvals++; return allowed ? 'allowed-once' : 'rejected' })
    await ctx.plugin(Safety, {})
    const ran: string[] = []
    register(ctx, prefix + 'click', ran)
    const agent = await create(ctx)
    agent.session.append('turn/start', { turn: 1 })
    await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [createUserMessage({ source: { kind: 'user' }, content: [] })],
      turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    const result = await ctx.tools.execute({ agent, signal: new AbortController().signal,
      callId: ToolCallId('click'), name: prefix + 'click', arguments: {} })
    expect(approvals).toBe(1)
    expect(result.isError).toBe(!allowed)
    expect(ran).toEqual(allowed ? [prefix + 'click'] : [])
  })
}

it('the structured text-only workflow requests no screenshots and retains original parameter schemas', async () => {
  const ctx = await mount()
  const parameters = { window_id: { type: 'integer' }, include_screenshot: { type: 'boolean' } } as const
  ctx.tools.register(defineContentToolFixture({ name: prefix + 'get_window_state',
    description: 'structured state', parameters,
    async execute() { return [{ type: 'text', text: 'tree' }] },
  }))
  const before = ctx.tools.schemas()[0]
  install(ctx)
  const agent = await create(ctx)
  expect(ctx.tools.schemas(agent)[0]).toEqual(before)
  expect(COMPUTER_USE_SAFETY_GUIDANCE).toContain('include_screenshot:false')
  expect(COMPUTER_USE_SAFETY_GUIDANCE).toContain('element_token')
})
