import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-schedule/src/runtime.ts'
/**
 * The safety layer's contract with the rest of the Host is only observable
 * through the real seams: the tool pipeline that routes an approval, the agent
 * events that carry a turn's origin, and the command registry the user's stop and
 * permission affordances come from. This spec therefore mounts the production
 * ToolRuntime, approval service, command runtime, and Computer Use registry, and
 * registers fake driver tools whose names come from the official provider's
 * catalog — no real desktop is touched anywhere in this file.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_RUNTIME_SCHEDULER, defineContentToolFixture, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as Safety from '../src/index.ts'

const PROVIDER = 'mcp__cua-driver-mcp__'

/** Driver-owned tool names the official Cua Driver MCP catalog publishes. */
const OBSERVE_TOOLS = ['screenshot', 'get_window_state', 'check_permissions'] as const
const ACTION_TOOLS = ['click', 'type_text'] as const
const IRREVERSIBLE_TOOLS = ['send_message'] as const
/** Every driver tool this spec registers, for the status count. */
const DRIVER_TOOL_COUNT = OBSERVE_TOOLS.length + ACTION_TOOLS.length + IRREVERSIBLE_TOOLS.length

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

/** How the harness should answer an action approval, or `none` for no answerer. */
type ApprovalAnswer = 'allow' | 'reject' | 'unavailable' | 'none'

/** A live foreground session plus the handles a test needs to drive it. */
interface Peer {
  readonly agent: Agent
  readonly session: Session
  /** Append a further `turn/start`, as the loop driver does when a turn opens. */
  readonly openTurn: (turn: number) => void
}

/** A session with no turn open yet; a test opens the turns it needs. */
async function peer(ctx: Context, id: string, provider = 'dsh-local-huihui', model = 'text-only'): Promise<Peer> {
  const { agent } = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider, model } })
  const session = agent.session
  return { agent, session, openTurn: (turn) => { session.append('turn/start', { turn }) } }
}

/** One admitted message carrying a durable source kind. */
function message(kind: string): UserMessage {
  return createUserMessage({ source: kind === 'schedule' ? { kind: 'schedule' } : { kind: 'user' }, content: [] })
}

/**
 * Open a turn and let the safety layer record how it started.
 *
 * The loop opens the turn and then dispatches `agent/pre-step` with the messages
 * it admitted, so a test that wants admission to see a real owner identity must
 * do both. Approvals additionally require an open turn in the Session log.
 */
async function beginTurn(
  ctx: Context,
  target: Peer,
  turn = 1,
  kind = 'user',
): Promise<void> {
  target.openTurn(turn)
  await agentEvents(ctx, target.agent).waterfall(
    'agent/pre-step',
    { messages: [message(kind)], turn, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

interface Harness extends Peer {
  /** The mounted context owning every service and the safety plugin. */
  readonly ctx: Context
  /** Driver tool names whose body actually executed, in call order. */
  readonly runs: readonly string[]
  /** Create a second, independent session. */
  readonly other: (id: string) => Promise<Peer>
  /** Run one driver tool through the real pipeline. */
  readonly call: (name: string, args?: Record<string, unknown>, agent?: Agent) => Promise<ToolExecutionResult>
  /** Run one slash command through the real command registry. */
  readonly command: (line: string, agent?: Agent) => Promise<string>
}

/** Mount the production composition under test over a chosen approval policy. */
async function mount(approval: ApprovalAnswer, config: Partial<Safety.Config> = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(CommandRuntime)
  if (approval !== 'none') {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(
      approval === 'allow' ? 'allowed-once' : approval === 'reject' ? 'rejected' : 'unavailable',
    ))
  }
  await ctx.plugin(Safety, { ...config })
  return ctx
}

/** Register the fake driver catalog over one context. */
function registerDriverTools(ctx: Context, runs: string[]): void {
  const register = (driverName: string): void => {
    ctx.tools.register(defineContentToolFixture({
      name: `${PROVIDER}${driverName}`,
      description: `fake driver tool ${driverName}`,
      parameters: { prompt: { type: 'boolean' } },
      async execute() {
        runs.push(driverName)
        return [{ type: 'text', text: driverName === 'check_permissions' ? JSON.stringify({ accessibility: true, screen_recording: true }) : `${driverName} ran` }]
      },
    }))
  }
  for (const name of [...OBSERVE_TOOLS, ...ACTION_TOOLS, ...IRREVERSIBLE_TOOLS]) register(name)
  // An unrelated tool proves the layer only touches driver-owned names.
  ctx.tools.register(defineContentToolFixture({
    name: 'read_file',
    description: 'not a desktop tool',
    parameters: {},
    async execute() {
      runs.push('read_file')
      return [{ type: 'text', text: 'read' }]
    },
  }))
}

/**
 * Build the full harness.
 * @param approval - how action approvals resolve.
 * @param config - safety-layer configuration overrides.
 * @returns handles for driving the pipeline and inspecting what ran.
 */
async function harness(approval: ApprovalAnswer = 'allow', config: Partial<Safety.Config> = {}): Promise<Harness> {
  const ctx = await mount(approval, config)
  const runs: string[] = []
  registerDriverTools(ctx, runs)
  const primary = await peer(ctx, 'primary')
  let nextCallId = 0

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    agent: Agent = primary.agent,
  ): Promise<ToolExecutionResult> => {
    nextCallId += 1
    return await ctx.tools.execute({
      agent,
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${String(nextCallId)}`),
      name: `${PROVIDER}${name}`,
      arguments: args,
    })
  }

  return {
    ...primary,
    ctx,
    runs,
    other: id => peer(ctx, id),
    call,
    command: async (line, agent = primary.agent) => {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) throw new Error(`command did not resolve: ${line}`)
      return execution.result.text ?? ''
    },
  }
}

/** Drive one tool call by name through the real pipeline. */
async function callTool(
  ctx: Context,
  agent: Agent,
  driverName: string,
  args: Record<string, unknown> = {},
): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    agent,
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${driverName}-${String(Math.random())}`),
    name: `${PROVIDER}${driverName}`,
    arguments: args,
  })
}

/** Read one driver call's error text, asserting it actually failed. */
function denial(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected a text error block')
  return block.text
}

describe('admission through the real tool pipeline', () => {
  it('runs an observation with no approval service consulted', async () => {
    // No answerer at all: an observation must not need one.
    const h = await harness('none')
    await beginTurn(h.ctx, h)
    expect((await h.call('screenshot')).isError).toBe(false)
    expect(h.runs).toEqual(['screenshot'])
  })

  it('leaves a non-desktop tool completely untouched', async () => {
    const h = await harness('reject')
    await beginTurn(h.ctx, h)
    const result = await h.ctx.tools.execute({
      agent: h.agent,
      signal: new AbortController().signal,
      callId: ToolCallId('unrelated'),
      name: 'read_file',
      arguments: {},
    })

    expect(result.isError).toBe(false)
    expect(h.runs).toEqual(['read_file'])
  })

  it('runs the first action once the user approves it', async () => {
    const h = await harness('allow')
    await beginTurn(h.ctx, h)
    expect((await h.call('click', { x: 1 })).isError).toBe(false)
    expect(h.runs).toEqual(['click'])
  })

  it('never runs an action the user rejected', async () => {
    const h = await harness('reject')
    await beginTurn(h.ctx, h)
    denial(await h.call('click', { x: 1 }))
    expect(h.runs).toEqual([])
  })

  it('fails closed when nothing can answer the approval', async () => {
    const h = await harness('none')
    await beginTurn(h.ctx, h)
    // With no approval service the runtime denies, and the model is left with the
    // ask reason — which is why that reason has to explain itself.
    expect(denial(await h.call('click', { x: 1 }))).toContain('needs one approval')
    expect(h.runs).toEqual([])
  })

  it('treats an unavailable answerer as a refusal', async () => {
    const h = await harness('unavailable')
    await beginTurn(h.ctx, h)
    denial(await h.call('click'))
    expect(h.runs).toEqual([])
  })

  it('asks once per turn and then runs later actions without asking again', async () => {
    const h = await harness('allow')
    await beginTurn(h.ctx, h)
    expect((await h.call('click')).isError).toBe(false)
    expect((await h.call('type_text', { text: 'hi' })).isError).toBe(false)
    expect(h.runs).toEqual(['click', 'type_text'])
  })

  it('asks again for every irreversible action family', async () => {
    const h = await harness('allow')
    await beginTurn(h.ctx, h)
    expect((await h.call('click')).isError).toBe(false)

    // The second approval is refused, so the irreversible action must not run.
    h.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'), { prepend: true })
    denial(await h.call('send_message', { text: 'to a person' }))

    expect(h.runs).toEqual(['click'])
  })

  it('lets an approved irreversible action run', async () => {
    const h = await harness('allow')
    await beginTurn(h.ctx, h)
    expect((await h.call('click')).isError).toBe(false)
    expect((await h.call('send_message', { text: 'hi' })).isError).toBe(false)
    expect(h.runs).toEqual(['click', 'send_message'])
  })

  it('asks again for a new turn, because a turn is the approval unit', async () => {
    const h = await harness('allow')
    await beginTurn(h.ctx, h, 1)
    expect((await h.call('click')).isError).toBe(false)
    await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })

    await beginTurn(h.ctx, h, 2)
    expect((await h.call('click')).isError).toBe(false)
    expect(h.runs).toEqual(['click', 'click'])
  })
})

describe('desktop ownership across sessions', () => {
  it('refuses a second session while the first holds the desktop', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h, 1)
    const second = await h.other('secondary')
    await beginTurn(h.ctx, second, 1)

    expect((await h.call('click')).isError).toBe(false)
    expect(denial(await h.call('type_text', { text: 'hi' }, second.agent))).toContain('in use by')
    expect(h.runs).toEqual(['click'])
  })

  it('lets the second session act after the first turn ends', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h, 1)
    const second = await h.other('secondary')
    await beginTurn(h.ctx, second, 1)
    expect((await h.call('click')).isError).toBe(false)

    await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })

    expect((await h.call('click', {}, second.agent)).isError).toBe(false)
    expect(h.runs).toEqual(['click', 'click'])
  })

  it('lets another session observe while the desktop is owned', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h, 1)
    const second = await h.other('secondary')
    await beginTurn(h.ctx, second, 1)
    expect((await h.call('click')).isError).toBe(false)

    expect((await h.call('screenshot', {}, second.agent)).isError).toBe(false)
    expect(h.runs).toEqual(['click', 'screenshot'])
  })

  it('does not let a later turn of the owning session inherit the desktop', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h, 1)
    expect((await h.call('click')).isError).toBe(false)

    // The desktop was acquired in turn 1; turn 2 is a different run identity.
    await beginTurn(h.ctx, h, 2)
    expect(denial(await h.call('type_text', { text: 'hi' }))).toContain('in use by')
  })

  it('refuses a desktop action from a call that has no turn identity', async () => {
    const h = await harness()
    const result = await h.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('host-plane'),
      name: `${PROVIDER}click`,
      arguments: {},
    })

    expect(denial(result)).toContain('requires a foreground Agent turn')
    expect(h.runs).toEqual([])
  })

  it('allows a host-plane observation, which changes no desktop state', async () => {
    const h = await harness()
    const result = await h.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('host-plane-observe'),
      name: `${PROVIDER}screenshot`,
      arguments: {},
    })

    expect(result.isError).toBe(false)
    expect(h.runs).toEqual(['screenshot'])
  })
})

describe('refused turn origins', () => {
  it('refuses a scheduled occurrence every desktop tool, reading included', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h, 1, 'schedule')

    expect(denial(await h.call('click'))).toContain('not supported for scheduled tasks')

    // V1 has one rule per origin rather than a partial capability: a background
    // occurrence may not use the desktop at all, so it cannot even read it.
    expect(denial(await h.call('screenshot'))).toContain('not supported for scheduled tasks')
    expect(h.runs).toEqual([])
  })

  it('still narrows a foreground turn to scheduled when the message arrives later', async () => {
    const h = await harness()
    // A wake-up message opens the turn...
    await beginTurn(h.ctx, h, 1, 'user')
    // ...and the scheduled delivery is admitted into the same turn.
    await agentEvents(h.ctx, h.agent).waterfall(
      'agent/pre-step',
      { messages: [message('schedule')], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )

    denial(await h.call('click'))
    expect(h.runs).toEqual([])
  })

  it('lets a new foreground turn act after a scheduled turn ended', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h, 1, 'schedule')
    denial(await h.call('click'))

    await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    await beginTurn(h.ctx, h, 2, 'user')

    expect((await h.call('click')).isError).toBe(false)
    expect(h.runs).toEqual(['click'])
  })

  it('refuses a Codex external turn an action', async () => {
    const ctx = await mount('allow')
    const runs: string[] = []
    registerDriverTools(ctx, runs)
    const owner = await peer(ctx, 'codex')

    // The loop resolves the external route before the turn's first step.
    await agentEvents(ctx, owner.agent).waterfall(
      'agent/resolve-external-turn',
      { selection: { provider: 'codex', model: 'gpt' }, signal: new AbortController().signal },
      () => Promise.resolve({}),
    )
    await beginTurn(ctx, owner, 1)

    expect(denial(await callTool(ctx, owner.agent, 'click'))).toContain('Codex external route')
    expect(runs).toEqual([])
  })

  it('refuses an external turn every desktop tool, reading included', async () => {
    const ctx = await mount('allow')
    const runs: string[] = []
    registerDriverTools(ctx, runs)
    const owner = await peer(ctx, 'codex-observer')
    await agentEvents(ctx, owner.agent).waterfall(
      'agent/resolve-external-turn',
      { selection: { provider: 'codex', model: 'gpt' }, signal: new AbortController().signal },
      () => Promise.resolve({}),
    )
    await beginTurn(ctx, owner, 1)

    // The external runtime bypasses the DSH desktop ownership model entirely, so
    // it is given no desktop tool at all rather than a read-only subset.
    expect(denial(await callTool(ctx, owner.agent, 'screenshot'))).toContain('Codex external route')
    expect(runs).toEqual([])
  })

  it('refuses a subagent every desktop tool and tells it to report back', async () => {
    const ctx = await mount('allow')
    const runs: string[] = []
    registerDriverTools(ctx, runs)

    // A delegated child is classified by its own session header, which the store
    // freezes at creation.
    const { agent: child } = await ctx.agents.create({ sessionId: SessionId('child'), meta: { origin: 'subagent' }, agentOptions: { provider: 'dsh-local-huihui' } })
    const session = child.session
    await beginTurn(ctx, { agent: child, session, openTurn: (turn) => { session.append('turn/start', { turn }) } }, 1)

    expect(denial(await callTool(ctx, child, 'click'))).toContain('subagent may not control the desktop')
    expect(denial(await callTool(ctx, child, 'screenshot'))).toContain('subagent may not control the desktop')
    expect(runs).toEqual([])
  })
})

describe('the macOS permission prompt boundary', () => {
  it('lets the model read permission state without prompting', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h)
    expect((await h.call('check_permissions', { prompt: false })).isError).toBe(false)
    expect(h.runs).toEqual(['check_permissions'])
  })

  it('refuses implicit permission defaults so the model cannot accidentally prompt', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h)
    expect((await h.call('check_permissions')).isError).toBe(true)
    expect(h.runs).toEqual([])
  })

  it('refuses a model-initiated permission prompt', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h)
    expect(denial(await h.call('check_permissions', { prompt: true })))
      .toContain('only the user may start the macOS permission prompt')
    expect(h.runs).toEqual([])
  })

  it('lets the user command raise the driver prompt exactly once', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h)
    expect(await h.command('/computer-use-permissions'))
      .toContain('Requested macOS Accessibility and Screen Recording')
    expect(h.runs).toEqual(['check_permissions'])

    // The consent window is one-shot: a later model call cannot reuse it.
    denial(await h.call('check_permissions', { prompt: true }))
  })

  it('reports a clear unavailable state when no driver tool is registered', async () => {
    const ctx = await mount('allow')
    const owner = await peer(ctx, 'no-driver')
    await beginTurn(ctx, owner, 1)

    const execution = await ctx.commands.execute(owner.agent, '/computer-use-permissions', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toContain('provider is unavailable')
  })
})

describe('the Host stop surface', () => {
  it('refuses new actions, reports honestly, and recovers on resume', async () => {
    const h = await harness('none')
    await beginTurn(h.ctx, h)
    denial(await h.call('click'))

    const stopped = await h.command('/computer-use-stop')
    expect(stopped).toContain('Computer Use stopped.')
    expect(stopped).toContain('cannot undo an action that already reached an application')
    expect(stopped).toContain('the desktop is released')

    expect(denial(await h.call('click'))).toContain('Computer Use is stopped')
    // An observation is refused too, so a stop is not merely an action freeze.
    denial(await h.call('screenshot'))

    expect(await h.command('/computer-use-resume')).toContain('Computer Use resumed.')
    expect((await h.call('screenshot')).isError).toBe(false)
  })

  it('cancels an in-flight action and retains its unknown physical outcome', async () => {
    const ctx = await mount('allow')
    const entered = Promise.withResolvers<undefined>()
    let bodies = 0
    ctx.tools.register(defineContentToolFixture({
      name: `${PROVIDER}click`,
      description: 'cancellable click',
      parameters: {},
      async execute(_args, exec) {
        bodies += 1
        entered.resolve(undefined)
        return await new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => { reject(new Error('cancelled by the Host stop')) }, { once: true })
        })
      },
    }))

    const owner = await peer(ctx, 'cancelled')
    await beginTurn(ctx, owner, 1)

    const pending = callTool(ctx, owner.agent, 'click')
    await entered.promise

    const text = (await ctx.commands.execute(owner.agent, '/computer-use-stop', [], new AbortController().signal))?.result.text ?? ''
    expect(text).toContain('lease is poisoned')

    expect((await pending).isError).toBe(true)
    expect(bodies).toBe(1)
    expect(ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'poisoned', stop: 'stopped', inFlight: 0 })
  })

  it('never replays an action whose outcome stayed unknown', async () => {
    const ctx = await mount('allow', { drainTimeoutMs: 20 })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let bodies = 0
    // A driver that has gone away: the call ignores cancellation and never
    // answers, so its outcome cannot be observed at all.
    ctx.tools.register(defineContentToolFixture({
      name: `${PROVIDER}click`,
      description: 'never-answering click',
      parameters: {},
      async execute() {
        bodies += 1
        entered.resolve(undefined)
        await release.promise
        return [{ type: 'text', text: 'settled long after the stop' }]
      },
    }))

    const owner = await peer(ctx, 'unknown')
    await beginTurn(ctx, owner, 1)

    const pending = callTool(ctx, owner.agent, 'click')
    await entered.promise

    const text = (await ctx.commands.execute(owner.agent, '/computer-use-stop', [], new AbortController().signal))?.result.text ?? ''
    expect(text).toContain('did not settle inside')
    expect(text).toContain('Host and driver restarted')
    expect(ctx.get('desktopLease')?.snapshot().state).toBe('poisoned')

    // No replay: the next call is refused and the body never runs again.
    expect((await callTool(ctx, owner.agent, 'click')).isError).toBe(true)
    expect(bodies).toBe(1)

    // A late settlement does not reopen the desktop on its own.
    release.resolve(undefined)
    await pending
    expect(ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'poisoned', inFlight: 0 })
    expect(bodies).toBe(1)

    const recovered = (await ctx.commands.execute(owner.agent, '/computer-use-resume', [], new AbortController().signal))?.result.text ?? ''
    expect(recovered).toContain('cannot resume')
    expect(ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'poisoned' })
  })

  it('reports the owner, provider, and stop state', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h, 1)
    expect((await h.call('click')).isError).toBe(false)

    const status = await h.command('/computer-use-status')
    expect(status).toContain('provider unavailable')
    expect(status).toContain('Desktop lease: active')
    expect(status).toContain('held by session')
    expect(status).toContain('Stop state: running')
    expect(status).toContain(`Registered desktop tools: ${String(DRIVER_TOOL_COUNT)}`)

    await h.command('/computer-use-stop')
    expect(await h.command('/computer-use-status')).toContain('Stop state: stopped')
  })

  it('names the connected provider when one is registered', async () => {
    const h = await harness()
    h.ctx.computerUse.register(ComputerUseProviderName('cua-driver-mcp'))

    expect(await h.command('/computer-use-status')).toContain('provider cua-driver-mcp')
  })

  it('reports a released desktop before anything acquired it', async () => {
    const h = await harness()
    expect(await h.command('/computer-use-status')).toContain('Desktop lease: released')
  })

  it('has no effect when resume is asked for on a healthy Host', async () => {
    const h = await harness()
    await h.command('/computer-use-resume')
    expect(await h.command('/computer-use-status')).toContain('Stop state: running')
  })
})

describe('a driver that stops answering', () => {
  /** Register one driver tool whose body rejects, standing in for a lost driver. */
  function registerFailing(ctx: Context, driverName: string, message: string, bodies: { count: number }): void {
    ctx.tools.register(defineContentToolFixture({
      name: `${PROVIDER}${driverName}`,
      description: `driver tool that fails: ${driverName}`,
      parameters: {},
      async execute(): Promise<never> {
        bodies.count += 1
        throw new Error(message)
      },
    }))
  }

  it('marks the action outcome uncertain and withholds the desktop from every later turn', async () => {
    const ctx = await mount('allow')
    const bodies = { count: 0 }
    registerFailing(ctx, 'click', 'driver connection closed', bodies)
    // A read that still works, so the poisoned lease can be inspected.
    ctx.tools.register(defineContentToolFixture({
      name: `${PROVIDER}screenshot`,
      description: 'working screenshot',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'display 0' }]
      },
    }))

    const owner = await peer(ctx, 'owner')
    const other = await peer(ctx, 'other')
    await beginTurn(ctx, owner, 1)
    await beginTurn(ctx, other, 1)

    expect((await callTool(ctx, owner.agent, 'click')).isError).toBe(true)
    const lease = ctx.get('desktopLease')
    expect(lease?.snapshot()).toMatchObject({ state: 'poisoned', inFlight: 0 })
    expect(lease?.snapshot().owner).toBeUndefined()
    expect(lease?.snapshot().detail).toContain('unattestable')

    // No replay, and no hand-over: neither the acting turn nor another session
    // receives the desktop, so nothing repeats the click on an unknown desktop.
    expect((await callTool(ctx, owner.agent, 'click')).isError).toBe(true)
    const refused = await callTool(ctx, other.agent, 'click')
    expect(denial(refused)).toContain('poisoned')
    expect(bodies.count).toBe(1)

    // Observation remains available, so the desktop can be inspected.
    expect((await callTool(ctx, other.agent, 'screenshot')).isError).toBe(false)
  })

  it('reopens the desktop only through an explicit recovery', async () => {
    const ctx = await mount('allow')
    const bodies = { count: 0 }
    registerFailing(ctx, 'click', 'driver connection closed', bodies)
    const owner = await peer(ctx, 'owner')
    await beginTurn(ctx, owner, 1)
    await callTool(ctx, owner.agent, 'click')

    const recovered = (await ctx.commands.execute(owner.agent, '/computer-use-resume', [], new AbortController().signal))?.result.text ?? ''
    expect(recovered).toContain('cannot resume')
    expect(ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'poisoned' })
    // The recovered turn starts a fresh approval unit, so the next action asks.
    expect(ctx.get('desktopLease')?.snapshot().actApproved).toBe(false)
  })

  it('leaves the lease untouched when only an observation fails', async () => {
    const ctx = await mount('allow')
    const bodies = { count: 0 }
    registerFailing(ctx, 'screenshot', 'display unavailable', bodies)
    const owner = await peer(ctx, 'owner')
    await beginTurn(ctx, owner, 1)

    expect((await callTool(ctx, owner.agent, 'screenshot')).isError).toBe(true)
    // A failed read changed no desktop state, so nothing has to be proven and
    // the next read is unaffected.
    expect(ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'released', inFlight: 0 })
    expect((await callTool(ctx, owner.agent, 'screenshot')).isError).toBe(true)
    expect(bodies.count).toBe(2)
  })

  it('treats a Host-stop cancellation as a stop, not as an unknown outcome', async () => {
    const ctx = await mount('allow')
    const entered = Promise.withResolvers<undefined>()
    ctx.tools.register(defineContentToolFixture({
      name: `${PROVIDER}click`,
      description: 'cancellable click',
      parameters: {},
      async execute(_args, exec) {
        entered.resolve(undefined)
        return await new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => { reject(new Error('cancelled by the Host stop')) }, { once: true })
        })
      },
    }))
    const owner = await peer(ctx, 'owner')
    await beginTurn(ctx, owner, 1)

    const pending = callTool(ctx, owner.agent, 'click')
    await entered.promise
    await ctx.commands.execute(owner.agent, '/computer-use-stop', [], new AbortController().signal)
    expect((await pending).isError).toBe(true)

    // The drain owns that transition: a proven-empty in-flight set releases the
    // desktop rather than poisoning it, and the recorded reason is the stop.
    const snapshot = ctx.get('desktopLease')?.snapshot()
    expect(snapshot).toMatchObject({ state: 'poisoned', stop: 'stopped', inFlight: 0 })
    expect(snapshot?.detail).not.toContain('did not return')
  })
})

describe('guidance and driver results', () => {
  it('states the desktop rules in the system prompt', async () => {
    const h = await harness()
    const assembly = await h.ctx.systemPrompt.assemble({ agent: h.agent })
    const section = assembly.sections.find(entry => entry.name === 'computer-use:custom-safety')

    expect(section?.text).toContain('private keys')
    expect(section?.text).toContain('No click or typing is replayed')
  })

  it('places the guidance with the Computer Use section', async () => {
    const h = await harness()
    const order = h.ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE')
    h.ctx.systemPrompt.section({ name: 'probe:before', order: order - 1, text: 'BEFORE' })
    h.ctx.systemPrompt.section({ name: 'probe:after', order: order + 1, text: 'AFTER' })

    const names = (await h.ctx.systemPrompt.assemble()).sections.map(entry => entry.name)
    expect(names.indexOf('probe:before')).toBeLessThan(names.indexOf('computer-use:custom-safety'))
    expect(names.indexOf('computer-use:custom-safety')).toBeLessThan(names.indexOf('probe:after'))
  })

  it('drops the guidance when the layer is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(ComputerUseRegistry)
    await ctx.plugin(CommandRuntime)
    const fiber = await ctx.plugin(Safety, {})
    const names = async (): Promise<readonly string[]> =>
      (await ctx.systemPrompt.assemble()).sections.map(entry => entry.name)

    expect(await names()).toContain('computer-use:custom-safety')
    await fiber.dispose()
    expect(await names()).not.toContain('computer-use:custom-safety')
  })

  it('passes a driver result through unchanged', async () => {
    const h = await harness()
    await beginTurn(h.ctx, h)
    expect((await h.call('screenshot')).content).toEqual([{ type: 'text', text: 'screenshot ran' }])
  })
})

it('a Stop arriving while approval is pending prevents dispatch after approval resolves', async () => {
  const h = await harness('allow')
  await beginTurn(h.ctx, h)
  const approval = Promise.withResolvers<ApprovalOutcome>()
  const entered = Promise.withResolvers<undefined>()
  h.ctx.on('approval/request', () => { entered.resolve(undefined); return approval.promise }, { prepend: true })
  const pending = h.call('click')
  await entered.promise
  await h.ctx.computerUseController.stop()
  approval.resolve('allowed-once')
  expect((await pending).isError).toBe(true)
  expect(h.runs).toEqual([])
})

it('verified delegated work shares the live root owner and loses authority when that root turn ends', async () => {
  const h = await harness('allow')
  await beginTurn(h.ctx, h)
  const { agent: child } = await h.agent.ctx.agents.create({ sessionId: SessionId('delegated'), parentAgent: h.agent,
    agentOptions: { provider: 'dsh-local-huihui', model: 'fixture' }, meta: { parentSession: h.agent.id, origin: 'subagent' } })
  const target = { agent: child, session: child.session, openTurn: (turn: number) => { child.session.append('turn/start', { turn }) } }
  await beginTurn(h.ctx, target)
  const delegated = await h.call('click', {}, child)
  expect(delegated, JSON.stringify(delegated)).toMatchObject({ isError: false })
  expect(h.ctx.desktopLease.snapshot().owner?.sessionId).toBe(String(h.agent.id))
  await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
  expect((await h.call('click', {}, child)).isError).toBe(true)
  expect(h.runs).toEqual(['click'])
})


it('Stop then resume and same-owner reacquire cannot revive an old pending approval', async () => {
  const h = await harness('allow')
  await beginTurn(h.ctx, h)
  const approval = Promise.withResolvers<ApprovalOutcome>()
  const entered = Promise.withResolvers<undefined>()
  let requests = 0
  h.ctx.on('approval/request', () => {
    requests += 1
    if (requests === 1) { entered.resolve(undefined); return approval.promise }
    return Promise.resolve<ApprovalOutcome>('allowed-once')
  }, { prepend: true })
  const pending = h.call('click')
  await entered.promise
  await h.ctx.computerUseController.stop()
  h.ctx.computerUseController.resume()
  expect((await h.call('type_text')).isError).toBe(false)
  approval.resolve('allowed-once')
  expect((await pending).isError).toBe(true)
  expect(h.runs).toEqual(['type_text'])
})

it('uses the in-force Session request route rather than stale Local constructor options', async () => {
  const h = await harness('allow')
  await beginTurn(h.ctx, h)
  h.session.append('request/header', { header: { config: { provider: 'codex', model: 'fixture' } } })
  expect((await h.call('get_window_state')).isError).toBe(true)
  expect((await h.call('click')).isError).toBe(true)
  expect(h.runs).toEqual([])
})

it('refuses a prepared scheduler call retired by Stop even after same-owner reacquisition', async () => {
  const h = await harness('allow')
  await beginTurn(h.ctx, h)
  const stages = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
  const prepared = await stages.prepare({ name: `${PROVIDER}click`, arguments: {}, agent: h.agent,
    callId: ToolCallId('queued-click'), signal: new AbortController().signal })
  if (prepared.kind !== 'dispatch') throw new Error('Expected approved preparation')
  await h.ctx.computerUseController.stop()
  h.ctx.computerUseController.resume()
  expect((await h.call('type_text')).isError).toBe(false)
  const dispatched = await stages.dispatch(prepared.exec)
  const result = dispatched.kind === 'post-result' ? await stages.finalize(prepared.exec, dispatched.result)
    : stages.finish(prepared.exec, dispatched.result)
  expect(result.isError).toBe(true)
  expect(h.runs).toEqual(['type_text'])
})
