import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { createMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ExternalTurnEvent, ExternalTurnRequest } from '@deepseek-ai/dsh-agent'
import { CodexSubscriptionRuntime } from '../src/runtime.ts'
import type { CodexRuntimeInternals } from '../src/runtime.ts'
import { codexRuntimePackageVersion } from '../src/app-server.ts'
import type {
  CodexAppServerConnection, CodexRuntimeDescriptor, CodexServerCallbacks, SystemCodexRuntimeResolution,
} from '../src/app-server.ts'
import { codexSubscriptionProjection } from '../src/projection.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'

interface StoredTurn extends Record<string, unknown> {
  id: string
  status: 'completed' | 'failed' | 'interrupted' | 'inProgress'
  items: Record<string, unknown>[]
}

interface RuntimePreferenceSettings {
  preference: 'auto' | 'system' | 'bundled'
}

const RuntimePreferenceSchema = z.object({
  preference: z.union(['auto', 'system', 'bundled']).default('auto'),
})

const systemCodex: CodexRuntimeDescriptor = {
  source: 'system',
  version: '0.158.0-alpha.2.1',
  executablePath: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  identity: 'official-chatgpt-codex-test-identity',
}

class FakeAppServer implements CodexAppServerConnection {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly starts: Array<Record<string, unknown>> = []
  readonly injections: Array<Record<string, unknown>[]> = []
  readonly turns: StoredTurn[] = []
  readonly dispose = vi.fn(async () => undefined)
  account: Record<string, unknown> | null = { type: 'chatgpt', email: 'private@example.test', planType: 'plus' }
  accountFailure: Error | undefined
  rateLimitFailure: Error | undefined
  onStart: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  onTurnList: (() => void) | undefined
  callbacks: CodexServerCallbacks | undefined
  home = ''
  cwd = ''
  runtimeSource: 'system' | 'bundled' = 'bundled'
  missingCapability: string | undefined
  missingThreads = new Set<string>()
  threadCount = 0

  async initialize(): Promise<Record<string, unknown>> {
    return { codexHome: this.home, userAgent: 'codex-test', platformFamily: 'unix', platformOs: 'darwin' }
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'thread/start' && params.cwd === null) {
      if (this.missingCapability === method) throw new JsonRpcResponseError(-32601, 'method not found')
      throw new JsonRpcResponseError(-32602, 'invalid capability probe parameters')
    }
    if (params.threadId === 'dsh-system-capability-probe-no-such-thread') {
      if (this.missingCapability === method) throw new JsonRpcResponseError(-32601, 'method not found')
      if (method === 'turn/interrupt') return {}
      throw new JsonRpcResponseError(-32004, 'thread not found')
    }
    switch (method) {
      case 'account/read':
        if (this.accountFailure !== undefined) throw this.accountFailure
        return { account: this.account, requiresOpenaiAuth: this.account === null }
      case 'account/rateLimits/read':
        if (this.rateLimitFailure !== undefined) throw this.rateLimitFailure
        return {
          accountId: 'private-account-id',
          rateLimits: { primary: { usedPercent: 20 }, secondary: null },
          rateLimitsByLimitId: {
            codex: {
              primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: { usedPercent: 41, windowDurationMins: 10_080 },
            },
          },
        }
      case 'account/login/start':
        return { type: 'chatgpt', loginId: 'login-transaction', authUrl: 'https://auth.openai.com/authorize?code=temporary' }
      case 'account/login/cancel':
      case 'account/logout':
      case 'thread/resume':
        return {}
      case 'model/list':
        return {
          data: this.runtimeSource === 'system'
            ? [{
              id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
              defaultReasoningEffort: 'high',
            }]
            : [{
              id: 'catalog-model-a', model: 'runtime-model-a', displayName: 'Codex Model A', hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
              defaultReasoningEffort: 'high',
            }],
          nextCursor: null,
        }
      case 'thread/start':
        this.cwd = String(params.cwd)
        this.threadCount += 1
        return { thread: { id: `thread-${this.threadCount}`, cwd: this.cwd } }
      case 'thread/read':
        if (this.missingThreads.has(String(params.threadId))) {
          throw new JsonRpcResponseError(-32004, 'thread not found')
        }
        return { thread: { id: params.threadId, cwd: this.cwd } }
      case 'thread/inject_items':
        this.injections.push(params.items as Record<string, unknown>[])
        return {}
      case 'thread/turns/list':
        if (params.sortDirection !== 'asc' && params.sortDirection !== 'desc') {
          throw new JsonRpcResponseError(
            -32602,
            `Invalid request: unknown variant '${String(params.sortDirection)}', expected 'asc' or 'desc'`,
          )
        }
        this.onTurnList?.()
        return { data: [...this.turns].reverse(), nextCursor: null, backwardsCursor: null }
      case 'turn/start':
        this.starts.push(params)
        return this.onStart?.(params)
      case 'turn/interrupt':
        return {}
      default:
        throw new Error(`Unexpected App Server request: ${method}`)
    }
  }
}

interface Harness {
  readonly ctx: Context
  readonly runtime: CodexSubscriptionRuntime
  readonly server: FakeAppServer
  readonly servers: FakeAppServer[]
  readonly runtimeSettings: SettingsScope<RuntimePreferenceSettings>
  readonly session: ReturnType<Context['sessions']['create']>
  readonly workspaces: Array<{ readonly id: string; readonly path: string; readonly sessionIds: readonly string[] }>
  readonly cleanup: () => Promise<void>
}

async function harness(
  openLoginUrl = async () => undefined,
  options: {
    systemRuntime?: SystemCodexRuntimeResolution
    missingSystemCapability?: string
    settingsDocument?: Record<string, unknown>
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-runtime-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(MemorySettings, options.settingsDocument === undefined ? {} : { doc: options.settingsDocument })
  const runtimeSettings = ctx.settings.register('openai-codex-runtime', RuntimePreferenceSchema, {
    base: { preference: 'auto' },
  })
  ctx.sessionProjections.register(codexSubscriptionProjection)
  ctx.provide('approval', { request: async () => 'denied' })
  const server = new FakeAppServer()
  const servers = [server]
  let startCount = 0
  const internals: CodexRuntimeInternals = {
    resolveHomePath: () => join(root, 'codex-home'),
    ensureHome: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }) },
    openLoginUrl,
    resolveSystemRuntime: () => options.systemRuntime ?? { unavailableReason: 'system runtime is disabled in this test harness' },
    startClient: (runtime, home, cwd, callbacks) => {
      let next = servers[startCount]
      if (next === undefined) {
        next = new FakeAppServer()
        servers.push(next)
      }
      startCount++
      next.runtimeSource = runtime.source
      next.missingCapability = runtime.source === 'system' ? options.missingSystemCapability : undefined
      next.home = home
      next.cwd = cwd
      next.callbacks = callbacks
      return next
    },
  }
  const runtime = new CodexSubscriptionRuntime(ctx, internals)
  runtime.attachSettings(runtimeSettings)
  const session = ctx.sessions.create(SessionId('codex-runtime-test'), { meta: { cwd: process.cwd() } })
  const workspaces = [{ id: 'workspace-codex-runtime-test', path: process.cwd(), sessionIds: [String(session.id)] }]
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  const cleanup = async (): Promise<void> => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
  return { ctx, runtime, server, servers, runtimeSettings, session, workspaces, cleanup }
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function appendUser(session: Harness['session'], text: string): ReturnType<typeof userMessage> {
  const message = userMessage(text)
  session.append('turn/start', { turn: Number(session.seq) + 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  return message
}

function request(
  session: Harness['session'],
  message: ReturnType<typeof userMessage>,
  signal = new AbortController().signal,
  turn = 1,
  step = 1,
): ExternalTurnRequest {
  return {
    agent: {} as never,
    session,
    turn,
    step,
    selection: { provider: 'openai-codex-subscription', model: 'catalog-model-a', reasoningEffort: ReasoningEffortId('high') },
    messages: [message],
    workspaceIdentity: 'workspace-codex-runtime-test',
    cwd: process.cwd(),
    signal,
    publish: { textDelta: vi.fn(), event: vi.fn() },
  }
}

function finalTurn(id: string, clientUserMessageId: string, text: string): StoredTurn {
  return {
    id,
    status: 'completed',
    items: [
      { type: 'userMessage', id: `user-${id}`, clientId: clientUserMessageId, content: [{ type: 'text', text: 'the user prompt' }] },
      { type: 'agentMessage', id: `answer-${id}`, phase: 'final_answer', text },
    ],
  }
}

function interruptedTurn(
  id: string,
  clientUserMessageId: string,
  items: Record<string, unknown>[] = [],
): StoredTurn {
  return {
    id,
    status: 'interrupted',
    items: [
      { type: 'userMessage', id: `user-${id}`, clientId: clientUserMessageId },
      ...items,
    ],
  }
}

describe('Codex subscription runtime', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  })

  it('starts lazily, uses the dedicated home, and discovers model and effort from that runtime', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    expect(h.server.calls).toHaveLength(0)

    const status = await h.runtime.status()
    expect(status).toMatchObject({ enabled: true, runtime: 'ready', account: 'connected', login: 'idle', modelCount: 1 })
    expect(h.server.home).toContain('codex-home')
    expect(h.server.calls.map(call => call.method)).toEqual([
      'account/read', 'model/list', 'account/rateLimits/read',
    ])
    expect(status.usage).toEqual({
      state: 'available',
      primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 41, windowDurationMins: 10_080 },
    })
    expect(JSON.stringify(status)).not.toContain('private-account-id')
    await h.runtime.status()
    expect(h.server.calls.filter(call => call.method === 'account/rateLimits/read')).toHaveLength(1)
    await expect(h.runtime.listModels()).resolves.toEqual([{
      id: 'catalog-model-a', name: 'Codex Model A', reasoning: {
        efforts: [{ id: 'high', name: 'high', description: 'High' }], defaultEffort: 'high',
      },
    }])
    await expect(h.runtime.resolveSelection({ provider: 'openai-codex-subscription', model: 'runtime-model-a' }))
      .rejects.toThrow('not available')
  })

  it('prefers the verified system runtime and discovers its catalog dynamically', async () => {
    const h = await harness(undefined, { systemRuntime: { runtime: systemCodex } })
    cleanups.push(h.cleanup)

    const status = await h.runtime.status()
    expect(status).toMatchObject({
      runtime: 'ready', runtimePreference: 'auto', runtimeSource: 'system',
      runtimeVersion: '0.158.0-alpha.2.1', systemRuntimeAvailable: true,
    })
    await expect(h.runtime.listModels()).resolves.toEqual([{
      id: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: {
        efforts: [{ id: 'high', name: 'high', description: 'High' }], defaultEffort: 'high',
      },
    }])
    expect(h.servers).toHaveLength(1)
    expect(h.server.calls.map(call => call.method)).toEqual(expect.arrayContaining([
      'account/read', 'model/list', 'thread/start', 'turn/start', 'turn/interrupt',
      'thread/resume', 'thread/read', 'thread/inject_items', 'thread/turns/list',
    ]))
    expect(h.server.calls.find(call => call.method === 'thread/turns/list')?.params).toMatchObject({
      sortDirection: 'desc',
    })
    expect(h.server.calls.find(call => call.method === 'thread/start')).toMatchObject({
      params: { cwd: null },
    })
  })

  it('falls back only during auto startup when system capability probing fails', async () => {
    const h = await harness(undefined, {
      systemRuntime: { runtime: systemCodex },
      missingSystemCapability: 'thread/resume',
    })
    cleanups.push(h.cleanup)

    const status = await h.runtime.status()
    expect(status).toMatchObject({
      runtime: 'ready', runtimePreference: 'auto', runtimeSource: 'bundled',
      runtimeSelectionNote: 'System Codex did not pass its capability check; using the bundled runtime.',
    })
    expect(h.servers).toHaveLength(2)
    expect(h.servers[0]?.dispose).toHaveBeenCalledOnce()
    expect(h.servers[1]?.runtimeSource).toBe('bundled')
    await expect(h.runtime.listModels()).resolves.toMatchObject([{ id: 'catalog-model-a' }])
  })

  it('does not fall back when the user explicitly selects an incompatible system runtime', async () => {
    const h = await harness(undefined, {
      systemRuntime: { runtime: systemCodex },
      missingSystemCapability: 'thread/resume',
    })
    cleanups.push(h.cleanup)
    await h.runtime.status()
    expect(h.servers[1]?.runtimeSource).toBe('bundled')

    const status = await h.runtime.selectRuntime('system')
    expect(status).toMatchObject({ runtime: 'error', runtimePreference: 'system', account: 'error' })
    expect(h.servers).toHaveLength(3)
    expect(h.servers[2]?.runtimeSource).toBe('system')
    expect(h.servers[2]?.dispose).toHaveBeenCalledOnce()
    expect(h.servers.slice(3)).toHaveLength(0)
  })

  it('does not switch binaries when a requested model is absent from the active catalog', async () => {
    const h = await harness(undefined, { systemRuntime: { runtime: systemCodex } })
    cleanups.push(h.cleanup)
    await h.runtime.status()

    await expect(h.runtime.resolveSelection({ provider: 'openai-codex-subscription', model: 'catalog-model-a' }))
      .rejects.toThrow('not available in the active runtime')
    expect(h.servers).toHaveLength(1)
    expect(h.servers[0]?.runtimeSource).toBe('system')
  })

  it('persists an explicit runtime choice and reuses it after the DSH runtime is recreated', async () => {
    const h = await harness(undefined, { systemRuntime: { runtime: systemCodex } })
    cleanups.push(h.cleanup)
    await h.runtime.status()

    const selected = await h.runtime.selectRuntime('bundled')
    expect(selected).toMatchObject({ runtimePreference: 'bundled', runtimeSource: 'bundled' })
    expect(h.servers).toHaveLength(2)
    expect(h.servers[0]?.dispose).toHaveBeenCalledOnce()
    expect(h.servers[1]?.runtimeSource).toBe('bundled')
    const persisted = structuredClone((h.ctx.get('settings') as unknown as MemorySettings).doc)
    expect(persisted['openai-codex-runtime']).toEqual({ preference: 'bundled' })

    const restarted = await harness(undefined, {
      systemRuntime: { runtime: systemCodex },
      settingsDocument: persisted,
    })
    cleanups.push(restarted.cleanup)
    expect(await restarted.runtime.status()).toMatchObject({
      runtimePreference: 'bundled', runtimeSource: 'bundled', runtimeVersion: codexRuntimePackageVersion(),
    })
    expect(restarted.servers).toHaveLength(1)
    expect(restarted.server.runtimeSource).toBe('bundled')
    const selectedSystem = await restarted.runtime.selectRuntime('system')
    expect(selectedSystem).toMatchObject({ runtimePreference: 'system', runtimeSource: 'system' })
    expect(restarted.servers[0]?.dispose).toHaveBeenCalledOnce()
    expect(restarted.servers[1]?.runtimeSource).toBe('system')
    await expect(restarted.runtime.listModels()).resolves.toMatchObject([{ id: 'gpt-6-luna' }])
  })

  it('rejects unknown runtime preferences without starting an App Server', async () => {
    const h = await harness(undefined, { systemRuntime: { runtime: systemCodex } })
    cleanups.push(h.cleanup)

    await expect(h.runtime.selectRuntime('path')).rejects.toThrow('Choose Automatic, System Codex, or Bundled Codex')
    expect(h.server.calls).toHaveLength(0)
    expect(h.runtimeSettings.get()).toEqual({ preference: 'auto' })
  })

  it('refuses a runtime change while a Codex turn is active', async () => {
    const h = await harness(undefined, { systemRuntime: { runtime: systemCodex } })
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const message = appendUser(h.session, 'Keep one turn active')
    const turnRequest = {
      ...request(h.session, message),
      selection: {
        provider: 'openai-codex-subscription',
        model: 'gpt-6-luna',
        reasoningEffort: ReasoningEffortId('high'),
      },
    }
    h.server.onStart = async () => {
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-active' } })
      return { turn: { id: 'turn-active', status: 'inProgress', items: [] } }
    }
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    const pending = executor.executeTurn(turnRequest)
    await vi.waitFor(() => { expect(h.server.starts).toHaveLength(1) })
    await expect(h.runtime.selectRuntime('bundled')).rejects.toThrow('active Codex turn')
    h.server.callbacks?.onNotification('turn/completed', {
      threadId: 'thread-1', turn: finalTurn('turn-active', String(h.server.starts[0]?.clientUserMessageId), 'done'),
    })
    await expect(pending).resolves.toMatchObject({ text: 'done', reason: 'completed' })
  })

  it('keeps quota failures informational and never lets them break a connected account', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.rateLimitFailure = new Error('quota service unavailable')
    const status = await h.runtime.status()
    expect(status).toMatchObject({ runtime: 'ready', account: 'connected', usage: { state: 'unavailable' } })
    expect(status.error).toBeUndefined()
  })

  it('redacts credentials, cookies, auth URLs, and runtime paths from projected errors', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.accountFailure = new Error([
      'Authorization: Bearer bearer-secret-value',
      'Cookie: session=private-cookie; refresh_token=cookie-refresh-secret',
      'account error https://auth.openai.com/authorize?code=private-login-code',
      'runtime path ACCESS_TOKEN=inline-token-secret',
      `CODEX_HOME=${h.server.home || '/tmp/dsh-codex-home-sentinel'}`,
    ].join('\n'))

    const status = await h.runtime.status()
    const projected = JSON.stringify(status)
    for (const secret of [
      'bearer-secret-value', 'private-cookie', 'cookie-refresh-secret', 'private-login-code',
      'inline-token-secret', '/tmp/dsh-codex-home-sentinel', h.server.home,
    ]) expect(projected).not.toContain(secret)
    expect(projected).toContain('authentication URL redacted')
    expect(projected).toContain('local path redacted')
  })

  it('requires exactly one registered workspace that owns the Session', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const turnRequest = request(h.session, appendUser(h.session, 'Use the registered workspace'))
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    await expect(executor.resolveWorkspace(h.session, process.cwd(), turnRequest.signal)).resolves.toEqual({
      identity: 'workspace-codex-runtime-test', cwd: process.cwd(),
    })
    h.workspaces.splice(0, h.workspaces.length)
    await expect(executor.resolveWorkspace(h.session, process.cwd(), turnRequest.signal))
      .rejects.toThrow('exactly one registered DSH workspace')
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow('exactly one registered DSH workspace')
    expect(h.server.starts).toHaveLength(0)
  })

  it('uses Responses API history items and explicitly freezes the active runtime model and effort per turn', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const old = appendUser(h.session, 'Earlier public request')
    const current = appendUser(h.session, 'Current request')
    const published = vi.fn()
    const currentRequest = { ...request(h.session, current), publish: { textDelta: published, event: vi.fn() } }
    h.server.onStart = async (params) => {
      expect(params).toMatchObject({ model: 'runtime-model-a', effort: 'high' })
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
      const turn = finalTurn('turn-1', String(params.clientUserMessageId), 'Codex response')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
    }
    const executor = await h.runtime.executorFor(currentRequest.selection, new AbortController().signal)
    await expect(executor.executeTurn(currentRequest)).resolves.toMatchObject({ text: 'Codex response', reason: 'completed' })
    expect(published).toHaveBeenCalledWith('Codex response')
    expect(h.server.injections).toEqual([[
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier public request' }] },
    ]])
    expect(String(old.id)).not.toBe(String(current.id))
    expect(h.server.starts).toHaveLength(1)
    expect(h.server.starts[0]).toHaveProperty('clientUserMessageId')
    const mapping = h.session.snapshotEvents().filter(event => event.type === 'codex/subscription-state').at(-1)
    expect(mapping?.type === 'codex/subscription-state' && mapping.data.state).toMatchObject({
      workspaceIdentity: 'workspace-codex-runtime-test',
      latestTurnId: 'turn-1',
    })
    const serializedSession = JSON.stringify(h.session.snapshotEvents())
    expect(serializedSession).not.toContain(h.server.home)
    expect(serializedSession).not.toMatch(/authUrl|accessToken|refreshToken/u)
  })

  it('publishes bounded Codex command, file-change, and terminal activity without local tool execution', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const message = appendUser(h.session, 'Create one canary file')
    const publishedEvents: ExternalTurnEvent[] = []
    const publishEvent = vi.fn((event: ExternalTurnEvent) => { publishedEvents.push(event) })
    const turnRequest = {
      ...request(h.session, message),
      publish: { textDelta: vi.fn(), event: publishEvent },
    }
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', {
        threadId: 'thread-1', turn: { id: 'turn-1' },
      })
      h.server.callbacks?.onNotification('item/started', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'command-1', type: 'commandExecution', command: 'touch canary.txt' },
      })
      h.server.callbacks?.onNotification('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: {
          id: 'command-1', type: 'commandExecution', command: 'touch canary.txt',
          status: 'completed', exitCode: 0, aggregatedOutput: 'must not be published',
        },
      })
      h.server.callbacks?.onNotification('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: {
          id: 'file-change-1', type: 'fileChange',
          changes: [{ path: `${process.cwd()}/canary.txt`, kind: 'add' }],
        },
      })
      const turn = finalTurn('turn-1', String(params.clientUserMessageId), 'Canary created')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
    }
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    await expect(executor.executeTurn(turnRequest)).resolves.toMatchObject({ text: 'Canary created' })

    expect(publishedEvents).toHaveLength(4)
    const [started, completed, fileChanged, terminal] = publishedEvents
    expect(started?.kind).toBe('command')
    if (started?.kind === 'command') {
      expect(started.command).toBe('touch canary.txt')
      expect(started.status).toBe('started')
      expect(started.identity).toMatchObject({
        sessionId: h.session.id, dshTurn: 1, dshStep: 1,
        provider: 'openai-codex-subscription', runtimeSource: 'bundled',
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', eventKind: 'item/started',
      })
      expect(started.identity.runtimeVersion).toBe(codexRuntimePackageVersion())
    }
    expect(completed?.kind).toBe('command')
    if (completed?.kind === 'command') {
      expect(completed.status).toBe('completed')
      expect(completed.identity).toMatchObject({ itemId: 'command-1', eventKind: 'item/completed' })
    }
    expect(fileChanged?.kind).toBe('file-change')
    if (fileChanged?.kind === 'file-change') {
      expect(fileChanged.path).toBe('canary.txt')
      expect(fileChanged.status).toBe('created')
      expect(fileChanged.identity).toMatchObject({ itemId: 'file-change-1', eventKind: 'item/completed' })
    }
    expect(terminal?.kind).toBe('turn')
    if (terminal?.kind === 'turn') {
      expect(terminal.status).toBe('completed')
      expect(terminal.identity).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1', eventKind: 'turn/completed' })
    }
    expect(JSON.stringify(publishedEvents)).not.toContain('must not be published')
    expect(h.server.starts).toHaveLength(1)
  })

  it('reconciles a lost turn/start acknowledgement by correlation ID and never starts the turn twice', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const message = appendUser(h.session, 'Perform one file change')
    const turnRequest = request(h.session, message)
    h.server.onStart = async (params) => {
      h.server.turns.push(finalTurn('accepted-turn', String(params.clientUserMessageId), 'Recovered result'))
      throw new Error('connection closed before the turn/start response')
    }
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow('connection closed')
    await expect(executor.executeTurn(turnRequest)).resolves.toMatchObject({ text: 'Recovered result' })
    expect(h.server.starts).toHaveLength(1)
    expect(h.server.calls.some(call => call.method === 'thread/turns/list')).toBe(true)
    const mappingEvents = h.session.snapshotEvents().filter(event => event.type === 'codex/subscription-state')
    const latest = mappingEvents.at(-1)
    expect(latest?.type === 'codex/subscription-state' && latest.data.state.dispatch).toBeNull()
    expect(JSON.stringify(mappingEvents)).not.toMatch(/authUrl|accessToken|refreshToken|codex-home/u)
  })

  it('reconciles interrupted dispatches and allows a distinct next turn without replay', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Run the first command'), undefined, 1)
    h.server.onStart = async (params) => {
      h.server.turns.push(interruptedTurn('interrupted-1', String(params.clientUserMessageId)))
      throw new Error('socket ended after write')
    }
    const executor = await h.runtime.executorFor(first.selection, first.signal)
    await expect(executor.executeTurn(first)).rejects.toThrow('socket ended')

    const second = request(h.session, appendUser(h.session, 'Run the next command'), undefined, 2)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', {
        threadId: String(params.threadId), turn: { id: 'turn-next' },
      })
      const turn = finalTurn('turn-next', String(params.clientUserMessageId), 'Next turn completed')
      h.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'turn-next', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(second)).resolves.toMatchObject({ text: 'Next turn completed' })
    expect(h.server.starts).toHaveLength(2)
    expect(h.server.starts.map(start => start.clientUserMessageId)).toEqual([
      expect.any(String), expect.any(String),
    ])
    expect(h.server.starts[0]?.clientUserMessageId).not.toBe(h.server.starts[1]?.clientUserMessageId)
    const states = h.session.snapshotEvents().filter(event => event.type === 'codex/subscription-state')
    expect(states.some(event => event.type === 'codex/subscription-state'
      && event.data.state.lastReconciliation?.status === 'interrupted')).toBe(true)
    expect(states.at(-1)?.type === 'codex/subscription-state'
      && states.at(-1)?.data.state.dispatch).toBeNull()
  })

  it('retains interrupted file side effects and never replays the same DSH turn', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const turnRequest = request(h.session, appendUser(h.session, 'Create one file'))
    h.server.onStart = async (params) => {
      h.server.turns.push(interruptedTurn('interrupted-with-file', String(params.clientUserMessageId), [
        { type: 'fileChange', id: 'file-1', changes: [{ path: 'canary.txt', kind: 'add' }] },
      ]))
      throw new Error('connection ended')
    }
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow('connection ended')
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow(/interrupted.*not replayed/u)
    expect(h.server.starts).toHaveLength(1)
    const latest = h.session.snapshotEvents().filter(event => event.type === 'codex/subscription-state').at(-1)
    expect(latest?.type === 'codex/subscription-state' && latest.data.state.lastReconciliation)
      .toMatchObject({ status: 'interrupted', sideEffectCount: 1 })
  })

  it('recovers a completed remote turn once and permits the next distinct turn', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Finish this turn'), undefined, 1)
    const firstExecutor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async (params) => {
      h.server.turns.push(finalTurn('completed-after-crash', String(params.clientUserMessageId), 'Recovered public result'))
      throw new Error('connection ended after completion')
    }
    await expect(firstExecutor.executeTurn(first)).rejects.toThrow('connection ended')
    await expect(firstExecutor.executeTurn(first)).resolves.toMatchObject({ text: 'Recovered public result' })
    await expect(firstExecutor.executeTurn(first)).rejects.toThrow(/already delivered or committed.*not replayed/u)
    expect(h.server.starts).toHaveLength(1)

    const next = request(h.session, appendUser(h.session, 'Continue in the same Session'), undefined, 2)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', {
        threadId: String(params.threadId), turn: { id: 'turn-after-complete' },
      })
      const turn = finalTurn('turn-after-complete', String(params.clientUserMessageId), 'Continued')
      h.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'turn-after-complete', status: 'inProgress', items: [] } }
    }
    await expect(firstExecutor.executeTurn(next)).resolves.toMatchObject({ text: 'Continued' })
    expect(h.server.starts).toHaveLength(2)
  })

  it('reconstructs the assistant-settlement guard after Session restore and prevents recovered-result redelivery', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const message = appendUser(h.session, 'Recover a result only once')
    const first = request(h.session, message)
    const firstExecutor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async (params) => {
      h.server.turns.push(finalTurn('completed-before-crash', String(params.clientUserMessageId), 'Recovered once'))
      throw new Error('connection closed after remote completion')
    }
    await expect(firstExecutor.executeTurn(first)).rejects.toThrow('connection closed')
    await expect(firstExecutor.executeTurn(first)).resolves.toMatchObject({ text: 'Recovered once' })

    h.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Recovered once' }],
        source: { kind: 'model', provider: 'openai-codex-subscription', model: 'gpt-6-luna' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    const settledMapping = h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')
    expect(settledMapping?.lastAssistantSettlement).toEqual({ turn: 1, step: 1 })
    if (settledMapping === undefined) throw new Error('Missing Codex Session projection.')
    const { lastAssistantSettlement, ...legacyMapping } = settledMapping
    expect(lastAssistantSettlement).toEqual({ turn: 1, step: 1 })
    h.session.appendIgnorable('codex/subscription-state', { state: legacyMapping })
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')?.lastAssistantSettlement)
      .toEqual({ turn: 1, step: 1 })

    const restored = await harness()
    cleanups.push(restored.cleanup)
    restored.server.threadCount = 1
    restored.server.turns.push(...h.server.turns)
    await restored.runtime.status()
    const restoredSession = restored.ctx.sessions.create(SessionId('restored-codex-session'), {
      seed: h.session.snapshotEvents(),
      meta: { cwd: process.cwd() },
    })
    const workspace = restored.workspaces[0]
    if (workspace === undefined) throw new Error('Missing restored test workspace.')
    restored.workspaces[0] = {
      ...workspace,
      sessionIds: [...workspace.sessionIds, String(restoredSession.id)],
    }
    expect(restored.ctx.sessionProjections.stateOf(restoredSession, 'codexSubscription')?.lastAssistantSettlement)
      .toEqual({ turn: 1, step: 1 })

    const repeated = request(restoredSession, message)
    const restoredExecutor = await restored.runtime.executorFor(repeated.selection, repeated.signal)
    await expect(restoredExecutor.executeTurn(repeated)).rejects.toThrow(/already delivered or committed.*not replayed/u)
    expect(restored.server.starts).toHaveLength(0)
  })

  it('waits on the existing in-progress turn and never starts it a second time', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const turnRequest = request(h.session, appendUser(h.session, 'Continue the accepted turn'))
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    h.server.onStart = async (params) => {
      h.server.turns.push({
        id: 'turn-already-running', status: 'inProgress',
        items: [{ type: 'userMessage', id: 'user-running', clientId: String(params.clientUserMessageId) }],
      })
      throw new Error('socket ended after remote acceptance')
    }
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow('socket ended')
    let listReads = 0
    h.server.onTurnList = () => {
      listReads++
      if (listReads < 2) return
      const turn = h.server.turns[0]!
      turn.status = 'completed'
      turn.items.push({ type: 'agentMessage', id: 'answer-running', phase: 'final_answer', text: 'Recovered after wait' })
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
    }

    await expect(executor.executeTurn(turnRequest)).resolves.toMatchObject({ text: 'Recovered after wait' })
    expect(h.server.starts).toHaveLength(1)
    expect(h.server.calls.filter(call => call.method === 'thread/turns/list')).toHaveLength(2)
  })

  it('clears a failed terminal dispatch barrier so only a distinct request can proceed', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Fail remotely'), undefined, 1)
    const executor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async (params) => {
      h.server.turns.push({
        id: 'failed-remote-turn', status: 'failed',
        items: [{ type: 'userMessage', id: 'user-failed', clientId: String(params.clientUserMessageId) }],
      })
      throw new Error('socket ended')
    }
    await expect(executor.executeTurn(first)).rejects.toThrow('socket ended')
    await expect(executor.executeTurn(first)).rejects.toThrow(/failed.*not replayed/u)
    const next = request(h.session, appendUser(h.session, 'A new request'), undefined, 2)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', {
        threadId: String(params.threadId), turn: { id: 'new-after-failure' },
      })
      const turn = finalTurn('new-after-failure', String(params.clientUserMessageId), 'Fresh request completed')
      h.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'new-after-failure', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(next)).resolves.toMatchObject({ text: 'Fresh request completed' })
    expect(h.server.starts).toHaveLength(2)
  })

  it('fails closed when the local reconciliation commit cannot be durably flushed', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Resolve this safely'), undefined, 1)
    const executor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async (params) => {
      h.server.turns.push(interruptedTurn('flush-failure-interrupted', String(params.clientUserMessageId)))
      throw new Error('socket ended')
    }
    await expect(executor.executeTurn(first)).rejects.toThrow('socket ended')
    const flush = vi.spyOn(h.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('local flush failed'))
    await expect(executor.executeTurn(first)).rejects.toThrow('local flush failed')
    const next = request(h.session, appendUser(h.session, 'Do not dispatch after failed commit'), undefined, 2)
    await expect(executor.executeTurn(next)).rejects.toThrow(/could not be durably committed/u)
    expect(h.server.starts).toHaveLength(1)
    expect(flush).toHaveBeenCalledOnce()
  })

  it('reconciles an interrupted dispatch after restart when the first local commit is interrupted', async () => {
    const beforeCrash = await harness()
    cleanups.push(beforeCrash.cleanup)
    await beforeCrash.runtime.status()
    const message = appendUser(beforeCrash.session, 'Resume reconciliation after a crash')
    const first = request(beforeCrash.session, message)
    const firstExecutor = await beforeCrash.runtime.executorFor(first.selection, first.signal)
    beforeCrash.server.onStart = async (params) => {
      beforeCrash.server.turns.push(interruptedTurn(
        'terminal-before-reconcile-commit', String(params.clientUserMessageId),
      ))
      throw new Error('connection ended after remote interruption')
    }
    await expect(firstExecutor.executeTurn(first)).rejects.toThrow('remote interruption')
    const pendingState = beforeCrash.session.snapshotEvents()
      .filter(event => event.type === 'codex/subscription-state').at(-1)
    expect(pendingState?.type === 'codex/subscription-state' && pendingState.data.state.dispatch?.status)
      .toBe('uncertain')
    if (pendingState?.type !== 'codex/subscription-state') throw new Error('Missing uncertain dispatch checkpoint.')

    const flush = vi.spyOn(beforeCrash.ctx.sessions, 'flush')
      .mockRejectedValueOnce(new Error('reconciliation commit interrupted by process exit'))
    await expect(firstExecutor.executeTurn(first)).rejects.toThrow('process exit')
    expect(flush).toHaveBeenCalledOnce()
    expect(beforeCrash.server.starts).toHaveLength(1)

    const afterCrash = await harness()
    cleanups.push(afterCrash.cleanup)
    afterCrash.server.threadCount = 1
    afterCrash.server.turns.push(...beforeCrash.server.turns)
    // Restore the last flushed Session cut in a fresh Context, before the local reconciliation record.
    afterCrash.session.append('turn/start', { turn: 1 })
    afterCrash.session.append('user/message', message, { surfaceOp: 'append' })
    afterCrash.session.appendIgnorable('codex/subscription-state', { state: pendingState.data.state })
    await afterCrash.runtime.status()
    afterCrash.server.cwd = process.cwd()
    const resumed = request(afterCrash.session, message)
    const resumedExecutor = await afterCrash.runtime.executorFor(resumed.selection, resumed.signal)

    await expect(resumedExecutor.executeTurn(resumed)).rejects.toThrow(/confirmed as interrupted.*not replayed/u)
    await expect(resumedExecutor.executeTurn(resumed)).rejects.toThrow(/interrupted.*not replayed/u)
    expect(afterCrash.server.starts).toHaveLength(0)

    const next = request(afterCrash.session, appendUser(afterCrash.session, 'Continue after recovery'), undefined, 2)
    afterCrash.server.onStart = async (params) => {
      afterCrash.server.callbacks?.onNotification('turn/started', {
        threadId: String(params.threadId), turn: { id: 'turn-after-reconcile-restart' },
      })
      const turn = finalTurn('turn-after-reconcile-restart', String(params.clientUserMessageId), 'Continued safely')
      afterCrash.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'turn-after-reconcile-restart', status: 'inProgress', items: [] } }
    }
    await expect(resumedExecutor.executeTurn(next)).resolves.toMatchObject({ text: 'Continued safely' })
    expect(afterCrash.server.starts).toHaveLength(1)
    expect(afterCrash.server.starts[0]?.clientUserMessageId).not.toBe(pendingState.data.state.dispatch?.clientUserMessageId)
  })

  it('retires an authoritative missing dispatch thread and bootstraps canonical DSH history', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Unconfirmed older request'), undefined, 1)
    const executor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async () => { throw new Error('socket ended') }
    await expect(executor.executeTurn(first)).rejects.toThrow('socket ended')
    h.server.missingThreads.add('thread-1')

    const next = request(h.session, appendUser(h.session, 'New request after recovery'), undefined, 2)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', {
        threadId: String(params.threadId), turn: { id: 'turn-on-new-thread' },
      })
      const turn = finalTurn('turn-on-new-thread', String(params.clientUserMessageId), 'New thread works')
      h.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'turn-on-new-thread', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(next)).resolves.toMatchObject({ text: 'New thread works' })
    await expect(executor.executeTurn(first)).rejects.toThrow(/unknown.*not replayed/u)
    expect(h.server.threadCount).toBe(2)
    expect(h.server.starts).toHaveLength(2)
    expect(h.server.injections.flat().some(item => (
      item.type === 'message' && JSON.stringify(item).includes('Unconfirmed older request')
    ))).toBe(true)
  })

  it('retires a live thread whose authoritative turn history omits the dispatch', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Older request missing from Codex'), undefined, 1)
    const executor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async () => { throw new Error('socket ended before acknowledgement') }
    await expect(executor.executeTurn(first)).rejects.toThrow('socket ended')

    const next = request(h.session, appendUser(h.session, 'Continue from canonical history'), undefined, 2)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', {
        threadId: String(params.threadId), turn: { id: 'turn-after-retirement' },
      })
      const turn = finalTurn('turn-after-retirement', String(params.clientUserMessageId), 'Bootstrapped from DSH')
      h.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'turn-after-retirement', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(next)).resolves.toMatchObject({ text: 'Bootstrapped from DSH' })

    await expect(executor.executeTurn(first)).rejects.toThrow(/unknown.*not replayed/u)
    expect(h.server.threadCount).toBe(2)
    expect(h.server.starts).toHaveLength(2)
    expect(h.server.injections.flat().some(item => (
      item.type === 'message' && JSON.stringify(item).includes('Older request missing from Codex')
    ))).toBe(true)
  })

  it('uses only the official browser login transaction and exposes no credential or URL in status', async () => {
    const openLoginUrl = vi.fn(async () => undefined)
    const h = await harness(openLoginUrl)
    cleanups.push(h.cleanup)
    h.server.account = null
    const started = await h.runtime.connectChatGPT()
    expect(started).toEqual({ status: 'signing-in' })
    expect(openLoginUrl).toHaveBeenCalledWith('https://auth.openai.com/authorize?code=temporary')
    const status = await h.runtime.status()
    expect(status).toMatchObject({ account: 'reauth-required', login: 'signing-in' })
    expect(JSON.stringify(status)).not.toMatch(/authUrl|accessToken|refreshToken|private@example/u)
    const loginId = 'login-transaction'
    h.server.callbacks?.onNotification('account/login/completed', { loginId, success: false, error: 'cancelled by user' })
    expect((await h.runtime.status()).account).toBe('reauth-required')
  })
})
