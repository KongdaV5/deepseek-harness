import * as ComputerUseUI from '../../../client/ui-custom-computer-use/src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-schedule/src/runtime.ts'
/**
 * The bundle's Host integration: the rows `cordis.patch.yml` declares are mounted
 * over a real MCP child, and the safety layer's guarantees are asserted where they
 * actually have to hold — at the wire, where a desktop effect either reaches the
 * driver or does not.
 *
 * The driver is a fixture process that never touches the desktop. Every assertion
 * about "the click happened" is read from that process's own request log, so a
 * denial is proven by the absence of a request rather than by a mocked return.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import * as Safety from '@deepseek-ai/dsh-custom-computer-use-safety'
import * as Provider from '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type ModelModality,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

const PREFIX = 'mcp__cua-driver-mcp__'
const BUNDLE_DIR = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/driver.mjs', import.meta.url))

/** One row of the bundle patch, with the fields this spec composes. */
interface Row {
  readonly id: string
  readonly name: string
  readonly config?: Record<string, unknown>
}

/** How the harness should answer an action approval. */
type ApprovalAnswer = 'allow' | 'reject' | 'none'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

/**
 * The rows the bundle declares, read from the patch file the Host composes.
 *
 * Reading the patch rather than restating its rows is the point: a row that is
 * added, removed, or reordered breaks this spec, so the composition under test
 * is the one that ships.
 * @returns the inserted rows in declaration order.
 */
function bundleRows(): Row[] {
  const parsed = yaml.load(readFileSync(resolve(BUNDLE_DIR, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as { insert: Row[] }[]
  return parsed.flatMap(patch => patch.insert)
}

/** The plugin each declared row names. */
const ROW_MODULES: Record<string, unknown> = {
  '@deepseek-ai/dsh-client-ui-custom-computer-use': ComputerUseUI,
  '@deepseek-ai/dsh-computer-use': ComputerUseRegistry,
  '@deepseek-ai/dsh-custom-computer-use-safety': Safety,
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp': Provider,
}

/** A model route the composed MCP client can resolve image capability from. */
class FixtureModel extends LlmAdapter {
  constructor(private readonly modalities: readonly ModelModality[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: [...this.modalities] })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A live session plus the handles a test needs to drive it. */
interface Peer {
  readonly agent: Agent
  readonly session: Session
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
 * Open a turn and let the safety layer record how it started, the way the loop
 * does: the turn is appended, then `agent/pre-step` carries the admitted message.
 */
async function beginTurn(ctx: Context, target: Peer, turn = 1, kind = 'user'): Promise<void> {
  target.openTurn(turn)
  await agentEvents(ctx, target.agent).waterfall(
    'agent/pre-step',
    { messages: [message(kind)], turn, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

/** One driver-side request, as the fixture recorded it. */
interface DriverEvent {
  readonly event: string
  readonly pid: number
  readonly name?: string
  readonly arguments?: Record<string, unknown>
}

interface Host {
  readonly ctx: Context
  readonly root: string
  readonly rows: readonly Row[]
  /** Driver-side calls whose name matches, in order. */
  readonly calls: (name?: string) => Promise<DriverEvent[]>
  /** Run one driver tool through the composed Host pipeline. */
  readonly call: (name: string, agent: Agent, args?: Record<string, unknown>) => Promise<ToolExecutionResult>
  /** Run one slash command through the composed command registry. */
  readonly command: (line: string, agent: Agent) => Promise<string>
  readonly other: (id: string) => Promise<Peer>
}

interface HostOptions {
  /** Fixture mode; `fail` stands in for a machine without a working driver. */
  readonly mode?: string
  /** Modalities of the resolved model route. */
  readonly modalities?: readonly ModelModality[]
  /** How action approvals resolve. */
  readonly approval?: ApprovalAnswer
  /** Whether the provider row reconnects after its child dies. */
  readonly reconnect?: boolean
  /** Whether to mount a given declared row. */
  readonly mountRow?: (row: Row) => boolean
}

/**
 * Mount the bundle's rows over the production services and a real MCP child.
 * @param options - fixture mode, model route, approval policy, and reconnect policy.
 * @returns handles for driving the composed Host.
 */
async function host(options: HostOptions = {}): Promise<Host> {
  const {
    mode = 'ok',
    modalities = VISION,
    approval = 'allow',
    reconnect = true,
  } = options
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-use-host-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)

  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  if (approval !== 'none') {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(
      approval === 'allow' ? 'allowed-once' : 'rejected',
    ))
  }
  ctx.llm.registerAdapter(['dsh-local-huihui'], new FixtureModel(modalities))

  const rows = bundleRows()
  const mountRow = options.mountRow ?? (() => true)
  for (const row of rows) {
    if (!mountRow(row)) continue
    const module = ROW_MODULES[row.name]
    if (module === undefined) throw new Error(`bundle row has no module under test: ${row.name}`)
    // The only substitution is the executable: a test cannot launch the real
    // `cua-driver`, so the row's own command is replaced and nothing else. The
    // reconnect timings are shortened so a dead child surfaces inside the test
    // rather than after a production-length backoff.
    const config = row.name === '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
      ? {
        ...row.config,
        command: process.execPath,
        args: [FIXTURE, root, mode],
        reconnect: reconnect
          ? { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 }
          : { enabled: false, initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 1 },
      }
      : { ...row.config }
    await ctx.plugin(module, config)
  }

  let nextCallId = 0
  return {
    ctx,
    root,
    rows,
    other: id => peer(ctx, id),
    calls: async (name) => {
      const calls = (await driverEvents(root)).filter(event => event.event === 'call')
      return name === undefined ? calls : calls.filter(event => event.name === name)
    },
    call: async (name, agent, args = {}) => {
      nextCallId += 1
      return await ctx.tools.execute({
        agent,
        signal: new AbortController().signal,
        callId: ToolCallId(`host-call-${String(nextCallId)}`),
        name: `${PREFIX}${name}`,
        arguments: args,
      })
    },
    command: async (line, agent) => {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) throw new Error(`command did not resolve: ${line}`)
      return execution.result.text ?? ''
    },
  }
}

/** Every request the fixture child recorded, in order. */
async function driverEvents(root: string): Promise<DriverEvent[]> {
  const text = await readFile(join(root, 'driver.ndjson'), 'utf8')
  return text.trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as DriverEvent)
}

/** The model-facing denial text of a refused call. */
function denial(result: ToolExecutionResult): string {
  if (!result.isError) throw new Error('expected a refused call')
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** The model-facing text of any result, accepted or refused. */
function textOf(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** A route with no image input, and one that accepts images. */
const TEXT_ONLY: readonly ModelModality[] = ['text']
const VISION: readonly ModelModality[] = ['text', 'image']

describe('the bundle composition over a real MCP driver', () => {
  it('mounts exactly the rows the patch declares, in declaration order', () => {
    expect(bundleRows().map(row => row.id)).toEqual([
      'computer-use',
      'computer-use-safety',
      'computer-use-cua-driver-mcp', 'ui-custom-computer-use',
    ])
  })

  it('activates the provider and exposes the driver catalog to the model', async () => {
    const h = await host()

    expect(h.ctx.computerUse.providerName).toBe('cua-driver-mcp')
    for (const name of ['check_permissions', 'screenshot', 'accessibility_tree', 'click', 'disconnect']) {
      expect(h.ctx.tools.get(`${PREFIX}${name}`)).toBeDefined()
    }
    // The registration precedes the provider, so an implicit desktop tool can
    // never exist without the layer that governs it.
    expect(h.ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'released', stop: 'running' })
    expect(await driverEvents(h.root)).toContainEqual(expect.objectContaining({ event: 'initialize' }))
  })

  it('reports the driver as unavailable without failing the rest of the Host', async () => {
    const h = await host({ mode: 'fail', mountRow: row => row.id !== 'computer-use-cua-driver-mcp' })

    // The failing provider row is mounted here explicitly so its rejection is
    // observable, exactly as app-boot's optional-entry policy sees it: the row
    // fails, every sibling keeps running, and the unavailability is what the
    // Host reports rather than a silently dead capability.
    let failure: unknown
    const fiber = h.ctx.plugin(Provider, {
      command: process.execPath,
      args: [FIXTURE, h.root, 'fail'],
      reconnect: { enabled: false, initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 1 },
    })
    try {
      await fiber
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeDefined()

    expect(h.ctx.computerUse.providerName).toBeUndefined()
    expect(h.ctx.tools.get(`${PREFIX}screenshot`)).toBeUndefined()
    expect(h.ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'released', stop: 'running' })

    const user = await peer(h.ctx, 'user')
    const status = await h.command('/computer-use-status', user.agent)
    expect(status).toContain('provider unavailable (driver not connected)')
    expect(status).toContain('Registered desktop tools: 0')

    // The permission affordance names the fix rather than failing silently.
    const permissions = await h.command('/computer-use-permissions', user.agent)
    expect(permissions).toContain('Computer Use provider is unavailable')
    expect(permissions).toContain('Install the driver')
  })
})

describe('admission at the MCP seam', () => {
  it('lets an observation reach the driver and refuses an action until it is approved', async () => {
    const h = await host({ approval: 'reject' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)

    expect((await h.call('screenshot', owner.agent, { display: 0 })).isError).toBe(false)
    expect(await h.calls('screenshot')).toHaveLength(1)

    // The refusal is proven by the driver never seeing the request, and the
    // model is told the canonical reason: a person declined this action. The
    // safety layer's own wording is not what the model sees here — the approval
    // service owns the answer — so the assertion is on the driver, not on text.
    const refused = await h.call('click', owner.agent, { x: 10, y: 20 })
    expect(refused.isError).toBe(true)
    expect(denial(refused)).toContain('rejected')
    expect(await h.calls('click')).toEqual([])
  })

  it('explains itself when nothing can answer the approval', async () => {
    // No approval service is composed, so the ask is answered fail-closed by the
    // service seam using the asker's own reason. That makes this reason string
    // the model's only diagnostic, which is why it is a full sentence.
    const h = await host({ approval: 'none' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)

    expect(denial(await h.call('click', owner.agent, { x: 10, y: 20 }))).toContain('needs one approval')
    expect(await h.calls('click')).toEqual([])
  })

  it('admits the approved action once per turn and asks nothing further', async () => {
    const h = await host({ approval: 'allow' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)

    expect((await h.call('click', owner.agent, { x: 10, y: 20 })).isError).toBe(false)
    expect((await h.call('click', owner.agent, { x: 11, y: 21 })).isError).toBe(false)
    const clicks = await h.calls('click')
    expect(clicks.map(event => event.arguments)).toEqual([{ x: 10, y: 20 }, { x: 11, y: 21 }])
  })

  it('serializes the desktop and proves a refused second session never reaches the driver', async () => {
    const h = await host({ approval: 'allow' })
    const first = await peer(h.ctx, 'first')
    const second = await peer(h.ctx, 'second')
    await beginTurn(h.ctx, first)
    await beginTurn(h.ctx, second)

    expect((await h.call('click', first.agent, { x: 1, y: 1 })).isError).toBe(false)
    expect(denial(await h.call('click', second.agent, { x: 2, y: 2 }))).toContain('in use by session first (turn 1)')
    expect(await h.calls('click')).toHaveLength(1)

    // The refusal is a refusal, not a queue: once the owning turn ends, the
    // second session acts on the same desktop with no parked work to flush.
    agentEvents(h.ctx, first.agent).emit('agent/turn-stopping', { turn: 1 })
    await vi.waitFor(() => { expect(h.ctx.desktopLease.snapshot().state).toBe('released') })
    expect((await h.call('click', second.agent, { x: 2, y: 2 })).isError).toBe(false)
    expect(await h.calls('click')).toHaveLength(2)
  })

  it('refuses a scheduled occurrence and an external route every desktop tool', async () => {
    const h = await host({ approval: 'allow' })
    const scheduled = await peer(h.ctx, 'scheduled')
    await beginTurn(h.ctx, scheduled, 1, 'schedule')

    expect(denial(await h.call('screenshot', scheduled.agent, { display: 0 }))).toContain('not supported for scheduled tasks')
    expect(denial(await h.call('click', scheduled.agent, { x: 1, y: 1 }))).toContain('not supported for scheduled tasks')

    const external = await peer(h.ctx, 'external')
    await agentEvents(h.ctx, external.agent).waterfall(
      'agent/resolve-external-turn',
      { selection: { provider: 'codex', model: 'gpt' }, signal: new AbortController().signal },
      () => Promise.resolve({}),
    )
    await beginTurn(h.ctx, external)
    expect(denial(await h.call('click', external.agent, { x: 1, y: 1 }))).toContain('Codex external route')

    expect(await h.calls()).toEqual([])
  })

  it('lets the model read permission state but never raise the system prompt', async () => {
    const h = await host({ approval: 'allow' })
    expect(await h.ctx.computerUseController.checkPermissions())
      .toMatchObject({ accessibility: 'granted', screenRecording: 'granted' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)

    expect((await h.call('check_permissions', owner.agent, { prompt: false })).isError).toBe(false)
    expect(await h.calls('check_permissions')).toHaveLength(2)

    expect(denial(await h.call('check_permissions', owner.agent, { prompt: true })))
      .toContain('only the user may start the macOS permission prompt')
    // Only the read reached the driver, and it was a read.
    expect((await h.calls('check_permissions')).every(event => event.arguments?.['prompt'] !== true)).toBe(true)

    // The user's own command is the one path that may ask for the prompt.
    expect(await h.command('/computer-use-permissions', owner.agent))
      .toContain('Requested macOS Accessibility and Screen Recording')
    const permissions = await h.calls('check_permissions')
    expect(permissions[permissions.length - 1]?.arguments).toEqual({ prompt: true, probe_direct_capture: false })
  })
})

describe('the Host stop over a real MCP driver', () => {
  it('refuses everything, and recovers only through an explicit resume', async () => {
    const h = await host({ approval: 'allow' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)

    const stopped = await h.command('/computer-use-stop', owner.agent)
    expect(stopped).toContain('Computer Use stopped.')
    // The stop is honest about what it cannot do.
    expect(stopped).toContain('cannot undo an action that already reached an application')

    expect(denial(await h.call('click', owner.agent, { x: 1, y: 1 }))).toContain('Computer Use is stopped')
    expect(denial(await h.call('screenshot', owner.agent, { display: 0 }))).toContain('Computer Use is stopped')
    expect(await h.calls()).toEqual([])

    expect(await h.command('/computer-use-resume', owner.agent)).toContain('Computer Use resumed.')
    expect((await h.call('screenshot', owner.agent, { display: 0 })).isError).toBe(false)
    expect(await h.calls('screenshot')).toHaveLength(1)
  })

  it('cancels an in-flight action and never lets it reach the driver twice', async () => {
    const h = await host({ mode: 'hang' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)

    // The driver never answers, so the call stays accounted while the stop runs.
    const pending = h.call('click', owner.agent, { x: 5, y: 5 })
    pending.catch(() => { /* the fixture child is killed at teardown */ })
    await vi.waitFor(async () => {
      expect(await h.calls('click')).toHaveLength(1)
    }, { timeout: 10_000 })

    const stopped = await h.command('/computer-use-stop', owner.agent)
    expect(stopped).toContain('Computer Use stopped.')
    // Whatever the drain concluded, the desktop must never see the action twice,
    // and the stop must not claim to have undone it.
    expect(stopped).toContain('cannot undo an action that already reached an application')
    expect(denial(await h.call('screenshot', owner.agent, { display: 0 }))).toContain('Computer Use is stopped')
    expect(await h.calls('click')).toHaveLength(1)
  })

  it('marks an action whose outcome was lost as unattestable, and never replays it', async () => {
    const h = await host({ mode: 'drop', approval: 'allow' })
    const owner = await peer(h.ctx, 'owner')
    const other = await peer(h.ctx, 'other')
    await beginTurn(h.ctx, owner)
    await beginTurn(h.ctx, other)

    // The driver dies after receiving the request and before answering it, so
    // whether the click reached the application is unknowable.
    expect((await h.call('click', owner.agent, { x: 5, y: 5 })).isError).toBe(true)
    expect(await h.calls('click')).toHaveLength(1)

    const snapshot = h.ctx.get('desktopLease')?.snapshot()
    expect(snapshot).toMatchObject({ state: 'poisoned', inFlight: 0 })
    expect(snapshot?.owner).toBeUndefined()
    expect(snapshot?.detail).toContain('unattestable')

    // No replay and no hand-over: another session is refused, and the driver —
    // which has reconnected by now — is never asked to repeat the action.
    expect(denial(await h.call('click', other.agent, { x: 6, y: 6 }))).toContain('poisoned')
    expect(await h.calls('click')).toHaveLength(1)
    expect(await h.command('/computer-use-status', other.agent)).toContain('Desktop lease: poisoned')

    expect(await h.command('/computer-use-resume', other.agent)).toContain('cannot resume')
    expect(h.ctx.get('desktopLease')?.snapshot()).toMatchObject({ state: 'poisoned' })
  })

  it('leaves no driver process behind once the layer is disposed', async () => {
    const h = await host({ approval: 'allow' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)
    await h.call('screenshot', owner.agent, { display: 0 })

    const pids = (await driverEvents(h.root)).filter(event => event.event === 'start').map(event => event.pid)
    expect(pids.length).toBeGreaterThan(0)
    await h.ctx.fiber.dispose()
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })
})

describe('screenshots stay on the official image admission path', () => {
  it('rejects an image when the model declares no image input, and writes nothing', async () => {
    const h = await host({ modalities: TEXT_ONLY, approval: 'allow' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)
    const before = await listFiles(h.root)

    const result = await h.call('screenshot', owner.agent, { display: 0 })
    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(false)

    const text = textOf(result)
    expect(text).toContain('image unavailable')
    expect(text).toContain('does not declare image input')
    // The Custom layer keeps no screenshot of its own: nothing was written under
    // the installation home, so the diagnostic is the whole outcome.
    expect(await listFiles(h.root)).toEqual(before)
    expect(await h.calls('screenshot')).toHaveLength(1)
  })

  it('stores an image through the official attachment store when the model accepts one', async () => {
    const h = await host({ modalities: VISION, approval: 'allow' })
    const owner = await peer(h.ctx, 'owner')
    await beginTurn(h.ctx, owner)
    const before = await listFiles(h.root)

    const result = await h.call('screenshot', owner.agent, { display: 0 })
    expect(result.isError).toBe(false)
    const image = result.content.find(block => block.type === 'image')
    expect(image).toBeDefined()
    if (image?.type !== 'image') throw new Error('missing admitted image')
    await expect(h.ctx.attachments.readImage(image.attachment)).resolves.toMatchObject({
      ref: { width: 1, height: 1, mediaType: 'image/png' },
    })
    // The durable result carries a reference, never the pixels, and the store is
    // the official one — this layer contributed no storage of its own.
    expect(JSON.stringify(result.content)).not.toContain('iVBORw0KGgo')
    expect((await listFiles(h.root)).length).toBeGreaterThan(before.length)
  })
})

/** Recursive file listing under one directory, or none when it does not exist. */
async function listFiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true })
    return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
  } catch {
    return []
  }
}
