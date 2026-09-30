import { lstat, mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
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
  authGeneration?: string
  authTransition?: { readonly id: string; readonly kind: 'login' | 'logout' | 'invalidated' } | null
}

const RuntimePreferenceSchema = z.object({
  preference: z.union(['auto', 'system', 'bundled']).default('auto'),
  authGeneration: z.string().min(1).required(false),
  authTransition: z.union([
    z.object({ id: z.string().min(1), kind: z.union(['login', 'logout', 'invalidated']) }),
    z.const(null),
  ]).required(false),
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
  logoutFailure: Error | undefined
  rateLimitFailure: Error | undefined
  loginIds = ['login-transaction']
  loginStartCount = 0
  onStart: ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  requestGate: ((method: string, params: Record<string, unknown>) => Promise<void>) | undefined
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
    await this.requestGate?.(method, params)
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
      {
        const loginId = this.loginIds[this.loginStartCount] ?? `login-transaction-${this.loginStartCount + 1}`
        this.loginStartCount++
        return { type: 'chatgpt', loginId, authUrl: 'https://auth.openai.com/authorize?code=temporary' }
      }
      case 'account/login/cancel':
      case 'thread/resume':
        return {}
      case 'account/logout':
        if (this.logoutFailure !== undefined) throw this.logoutFailure
        this.account = null
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
  readonly root: string
  readonly ctx: Context
  readonly runtime: CodexSubscriptionRuntime
  readonly server: FakeAppServer
  readonly servers: FakeAppServer[]
  readonly runtimeSettings: SettingsScope<RuntimePreferenceSettings>
  readonly session: ReturnType<Context['sessions']['create']>
  readonly workspaces: Array<{ readonly id: string; readonly path: string; readonly sessionIds: readonly string[] }>
  readonly startCount: () => number
  readonly cleanup: () => Promise<void>
}

function settingsDocument(h: Harness): Record<string, unknown> {
  return structuredClone((h.ctx.get('settings') as unknown as MemorySettings).doc)
}

function deferred<T = undefined>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function harness(
  openLoginUrl = async () => undefined,
  options: {
    systemRuntime?: SystemCodexRuntimeResolution
    missingSystemCapability?: string
    settingsDocument?: Record<string, unknown>
    root?: string
    ensureHome?: CodexRuntimeInternals['ensureHome']
    resolveHomePath?: CodexRuntimeInternals['resolveHomePath']
    resolveAllowedHomeRoot?: CodexRuntimeInternals['resolveAllowedHomeRoot']
  } = {},
): Promise<Harness> {
  const root = await realpath(options.root ?? await mkdtemp(join(tmpdir(), 'dsh-codex-runtime-')))
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
    resolveHomePath: options.resolveHomePath ?? ((...segments) => join(root, ...segments)),
    resolveAllowedHomeRoot: options.resolveAllowedHomeRoot ?? (() => root),
    ...(options.ensureHome === undefined ? {} : { ensureHome: options.ensureHome }),
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
  return { root, ctx, runtime, server, servers, runtimeSettings, session, workspaces, startCount: () => startCount, cleanup }
}

function replacementRuntimeSettings(h: Harness, generation: string): SettingsScope<RuntimePreferenceSettings> {
  return h.ctx.settings.register('openai-codex-runtime-replacement', RuntimePreferenceSchema, {
    base: { preference: 'auto', authGeneration: generation, authTransition: null },
  })
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

  it('does not start App Server when the independently trusted home root is a symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-codex-trusted-root-')))
    const target = join(root, 'external-target')
    const linkedRoot = join(root, 'trusted-root-link')
    await mkdir(target)
    await symlink(target, linkedRoot, 'dir')
    const h = await harness(undefined, {
      root,
      resolveAllowedHomeRoot: () => linkedRoot,
      resolveHomePath: (...segments) => join(linkedRoot, ...segments),
    })
    cleanups.push(h.cleanup)

    const status = await h.runtime.status()
    expect(status).toMatchObject({ runtime: 'crashed', account: 'error' })
    expect(h.startCount()).toBe(0)
    await expect(lstat(join(target, 'codex-subscription'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the persisted authentication generation stable through account-read errors and runtime restarts', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.accountFailure = new Error('temporary account endpoint failure')
    expect(await h.runtime.status()).toMatchObject({ runtime: 'error', account: 'error' })
    const generation = h.runtimeSettings.get().authGeneration
    expect(generation).toMatch(/^[0-9a-f-]{36}$/u)

    h.server.accountFailure = undefined
    expect(await h.runtime.status()).toMatchObject({ runtime: 'ready', account: 'connected' })
    expect(h.runtimeSettings.get().authGeneration).toBe(generation)

    await h.runtime.reconnect()
    expect(h.runtimeSettings.get().authGeneration).toBe(generation)
    expect(h.startCount()).toBe(2)
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
    const persisted = settingsDocument(h)
    expect(persisted['openai-codex-runtime']).toMatchObject({
      preference: 'bundled',
      authGeneration: h.runtimeSettings.get().authGeneration,
    })
    const generation = h.runtimeSettings.get().authGeneration
    expect(generation).toMatch(/^[0-9a-f-]{36}$/u)

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
    expect(restarted.runtimeSettings.get().authGeneration).toBe(generation)
    const selectedSystem = await restarted.runtime.selectRuntime('system')
    expect(selectedSystem).toMatchObject({ runtimePreference: 'system', runtimeSource: 'system' })
    expect(restarted.runtimeSettings.get().authGeneration).toBe(generation)
    expect(restarted.servers[0]?.dispose).toHaveBeenCalledOnce()
    expect(restarted.servers[1]?.runtimeSource).toBe('system')
    await expect(restarted.runtime.listModels()).resolves.toMatchObject([{ id: 'gpt-6-luna' }])
  })

  it('rejects unknown runtime preferences without starting an App Server', async () => {
    const h = await harness(undefined, { systemRuntime: { runtime: systemCodex } })
    cleanups.push(h.cleanup)

    await expect(h.runtime.selectRuntime('path')).rejects.toThrow('Choose Automatic, System Codex, or Bundled Codex')
    expect(h.server.calls).toHaveLength(0)
    expect(h.runtimeSettings.get().preference).toBe('auto')
    expect(h.runtimeSettings.get().authGeneration).toMatch(/^[0-9a-f-]{36}$/u)
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
    const turnStarted = deferred()
    h.server.onStart = async () => {
      turnStarted.resolve(undefined)
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-active' } })
      return { turn: { id: 'turn-active', status: 'inProgress', items: [] } }
    }
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    const pending = executor.executeTurn(turnRequest)
    await turnStarted.promise
    await expect(h.runtime.selectRuntime('bundled')).rejects.toThrow('active Codex operation')
    h.server.callbacks?.onNotification('turn/completed', {
      threadId: 'thread-1', turn: finalTurn('turn-active', String(h.server.starts[0]?.clientUserMessageId), 'done'),
    })
    await expect(pending).resolves.toMatchObject({ text: 'done', reason: 'completed' })
  })

  it('allows concurrent Session turns but rejects account transitions while either lease is active', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const secondSession = h.ctx.sessions.create(SessionId('codex-runtime-second-session'), {
      meta: { cwd: process.cwd() },
    })
    h.workspaces.push({
      id: 'workspace-codex-runtime-second', path: process.cwd(), sessionIds: [String(secondSession.id)],
    })
    const first = request(h.session, appendUser(h.session, 'Run concurrently one'), undefined, 1)
    const second = {
      ...request(secondSession, appendUser(secondSession, 'Run concurrently two'), undefined, 1),
      workspaceIdentity: 'workspace-codex-runtime-second',
    }
    const firstExecutor = await h.runtime.executorFor(first.selection, first.signal)
    const secondExecutor = await h.runtime.executorFor(second.selection, second.signal)
    let arrivals = 0
    let bothAtTurnStart!: () => void
    const bothStarted = new Promise<void>((resolve) => { bothAtTurnStart = resolve })
    let releaseTurnStarts!: () => void
    const turnStartGate = new Promise<void>((resolve) => { releaseTurnStarts = resolve })
    h.server.requestGate = async (method) => {
      if (method !== 'turn/start') return
      arrivals++
      if (arrivals === 2) bothAtTurnStart()
      await turnStartGate
    }
    h.server.onStart = async (params) => {
      const threadId = String(params.threadId)
      const turnId = `turn-${threadId}`
      h.server.callbacks?.onNotification('turn/started', { threadId, turn: { id: turnId } })
      const turn = finalTurn(turnId, String(params.clientUserMessageId), `Finished ${threadId}`)
      h.server.callbacks?.onNotification('turn/completed', { threadId, turn })
      return { turn: { id: turnId, status: 'inProgress', items: [] } }
    }

    const firstPending = firstExecutor.executeTurn(first)
    const secondPending = secondExecutor.executeTurn(second)
    await bothStarted
    await expect(h.runtime.disconnect()).rejects.toThrow('active Codex operation')
    expect(h.server.calls.some(call => call.method === 'account/logout')).toBe(false)
    releaseTurnStarts()
    const results = await Promise.all([firstPending, secondPending])
    expect(results.map(result => result.text).sort()).toEqual(['Finished thread-1', 'Finished thread-2'])
    expect(results.every(result => result.reason === 'completed')).toBe(true)
    expect(h.server.starts).toHaveLength(2)
  })

  it('holds the account-transition gate during pre-turn history injection before active-turn registration', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    appendUser(h.session, 'Earlier public history')
    const current = request(h.session, appendUser(h.session, 'Send after history sync'))
    const executor = await h.runtime.executorFor(current.selection, current.signal)
    let injectionReached!: () => void
    const atInjection = new Promise<void>((resolve) => { injectionReached = resolve })
    let releaseInjection!: () => void
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve })
    h.server.requestGate = async (method) => {
      if (method !== 'thread/inject_items') return
      injectionReached()
      await injectionGate
    }
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', {
        threadId: String(params.threadId), turn: { id: 'turn-after-history' },
      })
      const turn = finalTurn('turn-after-history', String(params.clientUserMessageId), 'History synced')
      h.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'turn-after-history', status: 'inProgress', items: [] } }
    }

    const pending = executor.executeTurn(current)
    await atInjection
    expect(h.server.starts).toHaveLength(0)
    await expect(h.runtime.disconnect()).rejects.toThrow('active Codex operation')
    expect(h.server.calls.some(call => call.method === 'account/logout')).toBe(false)
    releaseInjection()
    await expect(pending).resolves.toMatchObject({ text: 'History synced', reason: 'completed' })
  })

  it('keeps an App Server restart in the same auth generation and resumes the existing Session thread', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Create a durable private thread'), undefined, 1)
    const executor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-before-restart' } })
      const turn = finalTurn('turn-before-restart', String(params.clientUserMessageId), 'First result')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'turn-before-restart', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(first)).resolves.toMatchObject({ text: 'First result' })
    const generation = h.runtimeSettings.get().authGeneration
    const status = await h.runtime.reconnect()
    expect(status.account).toBe('connected')
    expect(h.runtimeSettings.get().authGeneration).toBe(generation)
    const restartedServer = h.servers[1]
    if (restartedServer === undefined) throw new Error('Missing restarted App Server fixture.')
    restartedServer.cwd = process.cwd()
    const next = request(h.session, appendUser(h.session, 'Continue after server restart'), undefined, 2)
    restartedServer.onStart = async (params) => {
      restartedServer.callbacks?.onNotification('turn/started', {
        threadId: 'thread-1', turn: { id: 'turn-after-restart' },
      })
      const turn = finalTurn('turn-after-restart', String(params.clientUserMessageId), 'Resumed result')
      restartedServer.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'turn-after-restart', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(next)).resolves.toMatchObject({ text: 'Resumed result' })
    expect(restartedServer.calls.some(call => call.method === 'thread/resume' && call.params.threadId === 'thread-1'))
      .toBe(true)
  })

  it('clears process-local resume state on unexpected exit and revalidates the persisted thread', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const executorRequest = request(h.session, appendUser(h.session, 'Create a private thread before process exit'), undefined, 1)
    const executor = await h.runtime.executorFor(executorRequest.selection, executorRequest.signal)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'before-exit' } })
      const turn = finalTurn('before-exit', String(params.clientUserMessageId), 'Before exit')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'before-exit', status: 'inProgress', items: [] } }
    }
    await executor.executeTurn(executorRequest)
    const generation = h.runtimeSettings.get().authGeneration
    const mappingBeforeExit = h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')
    const firstProcessCallbacks = h.server.callbacks
    firstProcessCallbacks?.onExit(new Error('simulated App Server process exit'))

    expect(h.runtimeSettings.get().authGeneration).toBe(generation)
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')).toEqual(mappingBeforeExit)
    await expect(h.runtime.status()).resolves.toMatchObject({ runtime: 'ready', account: 'connected' })
    const secondProcess = h.servers[1]
    if (secondProcess === undefined) throw new Error('Missing App Server process after unexpected exit.')
    secondProcess.cwd = process.cwd()
    secondProcess.onStart = async (params) => {
      secondProcess.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'after-exit' } })
      const turn = finalTurn('after-exit', String(params.clientUserMessageId), 'After exit')
      secondProcess.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'after-exit', status: 'inProgress', items: [] } }
    }
    const next = request(h.session, appendUser(h.session, 'Continue after process exit'), undefined, 2)
    await expect(executor.executeTurn(next)).resolves.toMatchObject({ text: 'After exit' })
    const methods = secondProcess.calls.map(call => call.method)
    const resumeIndex = methods.indexOf('thread/resume')
    const readIndex = methods.indexOf('thread/read')
    const turnStartIndex = methods.indexOf('turn/start')
    expect(resumeIndex).toBeGreaterThanOrEqual(0)
    expect(readIndex).toBeGreaterThan(resumeIndex)
    expect(turnStartIndex).toBeGreaterThan(readIndex)
    expect(secondProcess.calls[readIndex]?.params).toMatchObject({ threadId: 'thread-1' })
    expect(secondProcess.starts).toHaveLength(1)
    expect(h.runtimeSettings.get().authGeneration).toBe(generation)
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')).toMatchObject({
      authGeneration: generation,
      activeThreadId: 'thread-1',
    })
  })

  it('ignores a stale process exit after a replacement App Server resumed a thread', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const first = request(h.session, appendUser(h.session, 'Create a thread for stale-exit test'), undefined, 1)
    const executor = await h.runtime.executorFor(first.selection, first.signal)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'stale-seed' } })
      const turn = finalTurn('stale-seed', String(params.clientUserMessageId), 'Seed')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'stale-seed', status: 'inProgress', items: [] } }
    }
    await executor.executeTurn(first)
    const generation = h.runtimeSettings.get().authGeneration
    const oldProcessCallbacks = h.server.callbacks
    await h.runtime.reconnect()

    const currentProcess = h.servers[1]
    if (currentProcess === undefined) throw new Error('Missing replacement App Server process.')
    currentProcess.cwd = process.cwd()
    currentProcess.onStart = async (params) => {
      currentProcess.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'current-turn' } })
      const turn = finalTurn('current-turn', String(params.clientUserMessageId), 'Current process result')
      currentProcess.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'current-turn', status: 'inProgress', items: [] } }
    }
    const second = request(h.session, appendUser(h.session, 'Resume in replacement process'), undefined, 2)
    await executor.executeTurn(second)
    const resumeCount = currentProcess.calls.filter(call => call.method === 'thread/resume').length
    const readCount = currentProcess.calls.filter(call => call.method === 'thread/read').length
    expect(resumeCount).toBe(1)
    expect(readCount).toBe(1)

    const turnStartReached = deferred()
    const releaseTurnStart = deferred()
    currentProcess.requestGate = async (method) => {
      if (method === 'turn/start') {
        turnStartReached.resolve(undefined)
        await releaseTurnStart.promise
      }
    }
    currentProcess.onStart = async (params) => {
      currentProcess.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'after-stale-exit' } })
      const turn = finalTurn('after-stale-exit', String(params.clientUserMessageId), 'Still owned by replacement')
      currentProcess.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'after-stale-exit', status: 'inProgress', items: [] } }
    }
    const third = request(h.session, appendUser(h.session, 'Keep replacement operation alive'), undefined, 3)
    const running = executor.executeTurn(third)
    await turnStartReached.promise
    oldProcessCallbacks?.onExit(new Error('late old process exit'))
    releaseTurnStart.resolve(undefined)
    await expect(running).resolves.toMatchObject({ text: 'Still owned by replacement' })
    expect(currentProcess.calls.filter(call => call.method === 'thread/resume')).toHaveLength(resumeCount)
    expect(currentProcess.calls.filter(call => call.method === 'thread/read')).toHaveLength(readCount)
    expect(h.runtimeSettings.get().authGeneration).toBe(generation)
  })

  it('retires a legacy mapping without authGeneration and bootstraps the same DSH Session without old-thread calls', async () => {
    const original = await harness()
    cleanups.push(original.cleanup)
    await original.runtime.status()
    const first = request(original.session, appendUser(original.session, 'Public history to preserve'), undefined, 1)
    const executor = await original.runtime.executorFor(first.selection, first.signal)
    original.server.onStart = async (params) => {
      original.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'legacy-turn' } })
      const turn = finalTurn('legacy-turn', String(params.clientUserMessageId), 'Legacy result')
      original.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'legacy-turn', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(first)).resolves.toMatchObject({ text: 'Legacy result' })
    const legacyEvents = original.session.snapshotEvents().map((event) => {
      if (event.type !== 'codex/subscription-state') return event
      const state: Record<string, unknown> = { ...event.data.state }
      delete state.authGeneration
      return { ...event, data: { ...event.data, state } } as unknown as typeof event
    })

    const restored = await harness(undefined, { settingsDocument: settingsDocument(original) })
    cleanups.push(restored.cleanup)
    await restored.runtime.status()
    restored.server.threadCount = 1
    const legacySession = restored.ctx.sessions.create(SessionId('codex-legacy-mapping'), {
      seed: legacyEvents,
      meta: { cwd: process.cwd() },
    })
    const workspace = restored.workspaces[0]
    if (workspace === undefined) throw new Error('Missing restored test workspace.')
    restored.workspaces[0] = {
      ...workspace,
      sessionIds: [...workspace.sessionIds, String(legacySession.id)],
    }
    expect(restored.ctx.sessionProjections.stateOf(legacySession, 'codexSubscription')?.authGeneration).toBeNull()

    const callsBefore = restored.server.calls.length
    const next = request(legacySession, appendUser(legacySession, 'Continue from canonical Session history'), undefined, 2)
    const nextExecutor = await restored.runtime.executorFor(next.selection, next.signal)
    restored.server.onStart = async (params) => {
      const threadId = String(params.threadId)
      restored.server.callbacks?.onNotification('turn/started', { threadId, turn: { id: 'legacy-bootstrap-turn' } })
      const turn = finalTurn('legacy-bootstrap-turn', String(params.clientUserMessageId), 'Bootstrapped result')
      restored.server.callbacks?.onNotification('turn/completed', { threadId, turn })
      return { turn: { id: 'legacy-bootstrap-turn', status: 'inProgress', items: [] } }
    }
    await expect(nextExecutor.executeTurn(next)).resolves.toMatchObject({ text: 'Bootstrapped result' })
    const remoteThreadCalls = restored.server.calls.slice(callsBefore)
      .filter(call => ['thread/resume', 'thread/read', 'thread/turns/list', 'turn/interrupt'].includes(call.method))
    expect(remoteThreadCalls).toEqual([])
    expect(restored.server.calls.slice(callsBefore).filter(call => call.method === 'thread/start'))
      .toHaveLength(1)
    expect(restored.server.injections.flat().some(item => JSON.stringify(item).includes('Public history to preserve')))
      .toBe(true)
    expect(restored.server.starts).toHaveLength(1)
  })

  it('retires an old-account dispatch locally after logout and re-login, then bootstraps without replay', async () => {
    const openLoginUrl = vi.fn(async () => undefined)
    const h = await harness(openLoginUrl)
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const generationA = h.runtimeSettings.get().authGeneration
    const uncertain = request(h.session, appendUser(h.session, 'Do not replay across accounts'), undefined, 1)
    const executor = await h.runtime.executorFor(uncertain.selection, uncertain.signal)
    h.server.onStart = async (params) => {
      h.server.turns.push(interruptedTurn('account-a-uncertain-turn', String(params.clientUserMessageId)))
      throw new Error('connection lost after dispatch')
    }
    await expect(executor.executeTurn(uncertain)).rejects.toThrow('connection lost after dispatch')

    h.server.logoutFailure = new Error('logout request failed')
    h.server.requestGate = async (method) => {
      if (method === 'account/logout') {
        expect(h.runtimeSettings.get().authTransition).toMatchObject({ kind: 'logout' })
      }
    }
    await expect(h.runtime.disconnect()).rejects.toThrow('logout request failed')
    expect(h.runtimeSettings.get().authGeneration).toBe(generationA)
    expect(h.runtimeSettings.get().authTransition).toMatchObject({ kind: 'logout' })
    h.server.logoutFailure = undefined
    h.server.requestGate = undefined
    await h.runtime.disconnect()
    expect(h.runtimeSettings.get().authTransition).toBeNull()
    const generationAfterLogout = h.runtimeSettings.get().authGeneration
    expect(generationAfterLogout).not.toBe(generationA)

    await expect(h.runtime.connectChatGPT()).resolves.toEqual({ status: 'signing-in' })
    expect(h.runtimeSettings.get().authGeneration).toBe(generationAfterLogout)
    h.server.account = { type: 'chatgpt', email: 'different-private@example.test', planType: 'plus' }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    expect(completion).toBeDefined()
    await completion
    expect(h.runtimeSettings.get().authGeneration).not.toBe(generationAfterLogout)
    expect(h.server.calls.filter(call => call.method === 'account/rateLimits/read').length).toBeGreaterThanOrEqual(2)
    const generationAfterLogin = h.runtimeSettings.get().authGeneration
    await expect(h.runtime.connectChatGPT()).resolves.toEqual({ status: 'connected' })
    expect(generationAfterLogin).not.toBe(generationA)

    const callsBeforeRetirement = h.server.calls.length
    await expect(executor.executeTurn(uncertain)).rejects.toThrow(/retired authentication generation/u)
    const callsDuringRetirement = h.server.calls.slice(callsBeforeRetirement)
    expect(callsDuringRetirement.map(call => call.method)).toEqual(['account/read'])
    expect(h.server.starts).toHaveLength(1)

    const next = request(h.session, appendUser(h.session, 'Continue in the same public Session'), undefined, 2)
    h.server.onStart = async (params) => {
      const threadId = String(params.threadId)
      h.server.callbacks?.onNotification('turn/started', { threadId, turn: { id: 'new-account-turn' } })
      const turn = finalTurn('new-account-turn', String(params.clientUserMessageId), 'Fresh account result')
      h.server.callbacks?.onNotification('turn/completed', { threadId, turn })
      return { turn: { id: 'new-account-turn', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(next)).resolves.toMatchObject({ text: 'Fresh account result' })
    expect(h.server.threadCount).toBe(2)
    expect(h.server.starts).toHaveLength(2)
    expect(h.server.injections.flat().some(item => JSON.stringify(item).includes('Do not replay across accounts')))
      .toBe(true)
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

    const restored = await harness(undefined, { settingsDocument: settingsDocument(h) })
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

    const afterCrash = await harness(undefined, { settingsDocument: settingsDocument(beforeCrash) })
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

  it('commits login success during browser launch and rotates authGeneration only once', async () => {
    const browserStarted = deferred()
    const browserRelease = deferred()
    const openLoginUrl = vi.fn(() => {
      browserStarted.resolve(undefined)
      return browserRelease.promise
    })
    const h = await harness(openLoginUrl)
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    let markerAtLoginStart: RuntimePreferenceSettings['authTransition'] = undefined
    h.server.requestGate = async (method) => {
      if (method === 'account/login/start') markerAtLoginStart = h.runtimeSettings.get().authTransition
    }
    const generationBefore = h.runtimeSettings.get().authGeneration
    const update = vi.spyOn(h.runtimeSettings, 'update')

    const connecting = h.runtime.connectChatGPT()
    await browserStarted.promise
    expect(await h.runtime.status()).toMatchObject({ account: 'reauth-required', login: 'signing-in' })

    h.server.account = { type: 'chatgpt', email: 'new-private@example.test', planType: 'plus' }
    const notification = { loginId: 'login-transaction', success: true }
    h.server.callbacks?.onNotification('account/login/completed', notification)
    h.server.callbacks?.onNotification('account/login/completed', notification)
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    expect(completion).toBeDefined()
    await completion
    expect(h.runtimeSettings.get().authGeneration).not.toBe(generationBefore)
    expect(await h.runtime.status()).toMatchObject({ account: 'connected', login: 'idle' })
    expect(update.mock.calls.filter(([patch]) => Object.hasOwn(patch, 'authGeneration'))).toHaveLength(1)
    expect(markerAtLoginStart).toMatchObject({ kind: 'login' })
    expect(h.runtimeSettings.get().authTransition).toBeNull()
    expect(JSON.stringify(h.server.calls)).not.toMatch(/auth\.json|accessToken|cookie/u)

    browserRelease.resolve(undefined)
    await expect(connecting).resolves.toEqual({ status: 'connected' })
  })

  it('does not publish Connected from an account read started before LoginPending', async () => {
    const browserStarted = deferred()
    const browserRelease = deferred()
    const h = await harness(async () => {
      browserStarted.resolve(undefined)
      await browserRelease.promise
    })
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    const generationBefore = h.runtimeSettings.get().authGeneration
    const readStarted = deferred()
    const readRelease = deferred()
    let holdNextRead = true
    h.server.requestGate = async (method) => {
      if (method === 'account/read' && holdNextRead) {
        holdNextRead = false
        readStarted.resolve(undefined)
        await readRelease.promise
      }
    }

    const statusBeforeLogin = h.runtime.status()
    await readStarted.promise
    const connecting = h.runtime.connectChatGPT()
    await browserStarted.promise
    h.server.account = { type: 'chatgpt', email: 'new-private@example.test', planType: 'plus' }
    readRelease.resolve(undefined)
    const observed = await statusBeforeLogin
    browserRelease.resolve(undefined)
    const connectResult = await connecting

    expect(h.runtimeSettings.get().authGeneration).toBe(generationBefore)
    expect({ account: observed.account, login: observed.login, connectStatus: connectResult.status }).toEqual({
      account: 'reauth-required',
      login: 'signing-in',
      connectStatus: 'signing-in',
    })
  })

  it.each(['disconnected', 'error'] as const)('discards a stale %s account read after login commits', async (outcome) => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    const started = deferred()
    const release = deferred()
    const original = h.server.request.bind(h.server)
    let hold = true
    vi.spyOn(h.server, 'request').mockImplementation(async (method, params) => {
      if (method === 'account/read' && hold) {
        hold = false
        started.resolve(undefined)
        await release.promise
        if (outcome === 'error') throw new Error('old account read timed out')
        return { account: null, requiresOpenaiAuth: true }
      }
      return original(method, params)
    })
    const oldStatus = h.runtime.status()
    await started.promise
    await h.runtime.connectChatGPT()
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    // Await the attempt-owned settlement so the late read is released only after its commit boundary.
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    expect(completion).toBeDefined()
    await completion
    const committedGeneration = h.runtimeSettings.get().authGeneration
    release.resolve(undefined)
    const observed = await oldStatus
    expect(h.runtimeSettings.get().authGeneration).toBe(committedGeneration)
    expect(observed).toMatchObject({ account: 'connected', login: 'idle', runtime: 'ready' })
    expect(observed.error).toBeUndefined()
  })

  it('discards a stale Connected account read after logout commits', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const before = h.runtimeSettings.get().authGeneration
    const started = deferred()
    const release = deferred()
    const original = h.server.request.bind(h.server)
    let hold = true
    vi.spyOn(h.server, 'request').mockImplementation(async (method, params) => {
      if (method === 'account/read' && hold) {
        hold = false
        started.resolve(undefined)
        await release.promise
        return { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false }
      }
      return original(method, params)
    })
    const oldStatus = h.runtime.status()
    await started.promise
    await h.runtime.disconnect()
    expect(h.runtimeSettings.get().authGeneration).not.toBe(before)
    release.resolve(undefined)
    expect(await oldStatus).toMatchObject({ account: 'reauth-required', login: 'idle' })
  })

  it('does not let a cancelled browser call inherit a later login result', async () => {
    const browserStarted = deferred()
    const browserRelease = deferred()
    let opens = 0
    const h = await harness(async () => {
      if (opens++ === 0) {
        browserStarted.resolve(undefined)
        await browserRelease.promise
      }
    })
    cleanups.push(h.cleanup)
    h.server.loginIds = ['login-a', 'login-b']
    h.server.account = null
    await h.runtime.status()
    const loginA = h.runtime.connectChatGPT()
    await browserStarted.promise
    await h.runtime.cancelLogin()
    await h.runtime.connectChatGPT()
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-b', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    await completion
    browserRelease.resolve(undefined)
    const outcome = await loginA.then(value => value.status, () => 'cancelled')
    expect(outcome).not.toBe('connected')
  })

  it('does not commit a success notification received after cancellation begins', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    await h.runtime.connectChatGPT()
    const before = h.runtimeSettings.get().authGeneration
    const started = deferred()
    const release = deferred()
    h.server.requestGate = async (method) => {
      if (method === 'account/login/cancel') {
        started.resolve(undefined)
        await release.promise
      }
    }
    const cancelling = h.runtime.cancelLogin()
    await started.promise
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    release.resolve(undefined)
    await cancelling
    await completion
    expect(h.runtimeSettings.get().authGeneration).toBe(before)
  })

  it('never publishes Connected after auth generation persistence fails', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    await h.runtime.connectChatGPT()
    const before = h.runtimeSettings.get().authGeneration
    vi.spyOn(h.runtimeSettings, 'update').mockRejectedValue(new Error('controlled persistence failure'))
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    await completion
    expect(h.runtimeSettings.get().authGeneration).toBe(before)
    expect(h.runtimeSettings.get().authTransition).toMatchObject({ kind: 'login' })
    expect((h.runtime as unknown as { authLifecycleBlocked: boolean }).authLifecycleBlocked).toBe(true)
    expect((await h.runtime.status()).account).not.toBe('connected')
    await expect(h.runtime.executorFor(request(h.session, appendUser(h.session, 'Blocked')).selection, new AbortController().signal))
      .rejects.toThrow(/authentication transition/u)
    expect(h.server.calls.some(call => call.method === 'model/list' || call.method.startsWith('thread/')
      || call.method.startsWith('turn/'))).toBe(false)
    await expect(h.runtime.connectChatGPT()).rejects.toThrow(/persistence failure/u)
  })

  it('does not let a successful stale login commit block a replacement settings owner', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    await h.runtime.connectChatGPT()
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    const commitStarted = deferred()
    const releaseCommit = deferred()
    const update = h.runtimeSettings.update.bind(h.runtimeSettings)
    vi.spyOn(h.runtimeSettings, 'update').mockImplementation(async (patch) => {
      if ((patch as Partial<RuntimePreferenceSettings>).authGeneration !== undefined
        && (patch as Partial<RuntimePreferenceSettings>).authTransition === null) {
        commitStarted.resolve(undefined)
        await releaseCommit.promise
      }
      await update(patch)
    })
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    await commitStarted.promise

    const replacement = replacementRuntimeSettings(h, 'committed-owner-b')
    h.runtime.attachSettings(replacement)
    const before = await h.runtime.status()
    expect(before.account).toBe('connected')
    expect((h.runtime as unknown as { authLifecycleBlocked: boolean }).authLifecycleBlocked).toBe(false)
    releaseCommit.resolve(undefined)
    await completion

    expect(replacement.get().authGeneration).toBe('committed-owner-b')
    expect(replacement.get().authTransition).toBeNull()
    expect((h.runtime as unknown as { authGeneration: string }).authGeneration).toBe('committed-owner-b')
    expect((h.runtime as unknown as { authLifecycleBlocked: boolean }).authLifecycleBlocked).toBe(false)
    expect(await h.runtime.status()).toMatchObject({ account: 'connected', runtime: 'ready' })
  })

  it('does not let a failed stale login commit block a replacement settings owner', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    await h.runtime.connectChatGPT()
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    const commitStarted = deferred()
    const releaseCommit = deferred()
    vi.spyOn(h.runtimeSettings, 'update').mockImplementation(async (patch) => {
      if ((patch as Partial<RuntimePreferenceSettings>).authGeneration !== undefined
        && (patch as Partial<RuntimePreferenceSettings>).authTransition === null) {
        commitStarted.resolve(undefined)
        await releaseCommit.promise
        throw new Error('stale owner persistence failed')
      }
    })
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    await commitStarted.promise

    const replacement = replacementRuntimeSettings(h, 'committed-owner-b')
    h.runtime.attachSettings(replacement)
    const before = await h.runtime.status()
    expect(before.account).toBe('connected')
    expect((h.runtime as unknown as { authLifecycleBlocked: boolean }).authLifecycleBlocked).toBe(false)
    releaseCommit.resolve(undefined)
    await completion

    expect(replacement.get().authGeneration).toBe('committed-owner-b')
    expect(replacement.get().authTransition).toBeNull()
    expect((h.runtime as unknown as { authGeneration: string }).authGeneration).toBe('committed-owner-b')
    expect((h.runtime as unknown as { authLifecycleBlocked: boolean }).authLifecycleBlocked).toBe(false)
    expect(await h.runtime.status()).toMatchObject({ account: 'connected', runtime: 'ready' })
  })

  it('does not commit login from an account read whose App Server exited', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    await h.runtime.connectChatGPT()
    const before = h.runtimeSettings.get().authGeneration
    const started = deferred()
    const release = deferred()
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    h.server.requestGate = async (method) => {
      if (method === 'account/read') {
        started.resolve(undefined)
        await release.promise
      }
    }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    await started.promise
    h.server.callbacks?.onExit(new Error('controlled current process exit'))
    release.resolve(undefined)
    await completion
    expect(h.runtimeSettings.get().authGeneration).toBe(before)
  })

  it('keeps a persisted auth generation when the App Server exits before Connected publication', async () => {
    const browserStarted = deferred()
    const browserRelease = deferred()
    const h = await harness(async () => {
      browserStarted.resolve(undefined)
      await browserRelease.promise
    })
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    const generationBefore = h.runtimeSettings.get().authGeneration
    const connecting = h.runtime.connectChatGPT()
    await browserStarted.promise
    h.server.account = { type: 'chatgpt', planType: 'plus' }

    const persisted = deferred()
    const persistenceContinuation = deferred()
    const update = h.runtimeSettings.update.bind(h.runtimeSettings)
    vi.spyOn(h.runtimeSettings, 'update').mockImplementation(async (patch) => {
      await update(patch)
      if ((patch as Partial<RuntimePreferenceSettings>).authGeneration !== undefined
        && (patch as Partial<RuntimePreferenceSettings>).authTransition === null) {
        persisted.resolve(undefined)
        await persistenceContinuation.promise
      }
    })
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    expect(completion).toBeDefined()
    await persisted.promise

    const generationCommitted = h.runtimeSettings.get().authGeneration
    expect(generationCommitted).not.toBe(generationBefore)
    expect(h.runtimeSettings.get().authTransition).toBeNull()
    h.server.callbacks?.onExit(new Error('controlled current process exit'))
    persistenceContinuation.resolve(undefined)
    await completion
    const projection = (h.runtime as unknown as {
      statusProjection: () => { account: string; login: string; runtime: string }
    }).statusProjection()
    expect(h.runtimeSettings.get().authGeneration).toBe(generationCommitted)
    expect(projection).toMatchObject({ account: 'reauth-required', login: 'idle', runtime: 'crashed' })

    browserRelease.resolve(undefined)
    await expect(connecting).rejects.toThrow(/cancelled, failed, or superseded/u)
  })

  it('retains a failed login commit barrier across DSH runtime recreation', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    await h.runtime.status()
    await h.runtime.connectChatGPT()
    vi.spyOn(h.runtimeSettings, 'update').mockRejectedValue(new Error('controlled persistence failure'))
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    await completion
    const persisted = settingsDocument(h)
    const persistedRuntimeSettings = persisted['openai-codex-runtime'] as RuntimePreferenceSettings
    expect(persistedRuntimeSettings.authTransition).toMatchObject({ kind: 'login' })
    const restored = await harness(undefined, { settingsDocument: persisted, root: h.root })
    cleanups.push(async () => { await restored.runtime.dispose() })
    expect(await restored.runtime.status()).toMatchObject({ account: 'reauth-required', login: 'idle' })
    expect(restored.server.calls.some(call => call.method === 'account/read')).toBe(false)
    expect(restored.runtimeSettings.get().authTransition).toEqual(persistedRuntimeSettings.authTransition)
  })

  it('discards a catalog result started before LoginPending', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const started = deferred()
    const release = deferred()
    let hold = true
    h.server.requestGate = async (method) => {
      if (method === 'model/list' && hold) {
        hold = false
        started.resolve(undefined)
        await release.promise
      }
    }
    const oldStatus = h.runtime.status()
    await started.promise
    h.server.account = null
    await h.runtime.connectChatGPT()
    release.resolve(undefined)
    expect(await oldStatus).toMatchObject({ login: 'signing-in', modelCount: 0, runtime: 'auth-check' })
  })

  it('discards a quota result started before logout', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    h.server.account = null
    await h.runtime.status()
    h.server.account = { type: 'chatgpt', planType: 'plus' }
    const started = deferred()
    const release = deferred()
    h.server.requestGate = async (method) => {
      if (method === 'account/rateLimits/read') {
        started.resolve(undefined)
        await release.promise
      }
    }
    const oldStatus = h.runtime.status()
    await started.promise
    await h.runtime.disconnect()
    release.resolve(undefined)
    expect(await oldStatus).toMatchObject({ account: 'reauth-required', usage: { state: 'unavailable' } })
  })

  it('waits for initialization before a concurrent login issues account RPCs', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.account = null
    const started = deferred()
    const release = deferred()
    const initialize = h.server.initialize.bind(h.server)
    vi.spyOn(h.server, 'initialize').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      return initialize()
    })
    const starting = h.runtime.status()
    await started.promise
    const connecting = h.runtime.connectChatGPT()
    // Drain the already-queued login continuation while initialization is explicitly held, without a clock delay.
    await Promise.resolve()
    const callsBeforeInitialized = h.server.calls.map(call => call.method)
    release.resolve(undefined)
    await starting
    await connecting
    expect(callsBeforeInitialized).toEqual([])
  })

  it('waits for App Server initialization before a model resolver reads the catalog', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    const started = deferred()
    const release = deferred()
    const initialize = h.server.initialize.bind(h.server)
    vi.spyOn(h.server, 'initialize').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      return initialize()
    })
    const status = h.runtime.status()
    await started.promise

    const resolving = h.runtime.resolveSelection({
      provider: 'openai-codex-subscription',
      model: 'catalog-model-a',
    })
    expect(h.server.calls).toEqual([])

    release.resolve(undefined)
    await status
    await expect(resolving).resolves.toMatchObject({
      provider: 'openai-codex-subscription',
      model: 'catalog-model-a',
      reasoningEffort: 'high',
    })
    expect(h.server.calls.some(call => call.method === 'model/list')).toBe(true)
  })

  it('ignores failed generation initialization belonging to a replaced settings scope', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const before = h.runtimeSettings.get().authGeneration
    const pending = Promise.withResolvers<undefined>()
    const updateStarted = deferred()
    // Minimal obsolete-scope responder; only get/update are used by attachSettings.
    const obsolete = {
      get: () => ({ preference: 'auto' as const }),
      update: () => {
        updateStarted.resolve(undefined)
        return pending.promise
      },
    } as unknown as SettingsScope<RuntimePreferenceSettings>
    h.runtime.attachSettings(obsolete)
    await updateStarted.promise
    const initialization = (h.runtime as unknown as { authGenerationInitialization?: Promise<void> }).authGenerationInitialization
    h.runtime.attachSettings(h.runtimeSettings)
    pending.reject(new Error('obsolete scope persistence failed'))
    await initialization
    expect((h.runtime as unknown as { authGeneration?: string }).authGeneration).toBe(before)
  })

  it('invalidates an execution account read when account/updated removes authentication', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const markerPersisted = deferred()
    const updateSettings = h.runtimeSettings.update.bind(h.runtimeSettings)
    vi.spyOn(h.runtimeSettings, 'update').mockImplementation(async (patch) => {
      await updateSettings(patch)
      if ((patch as Partial<RuntimePreferenceSettings>).authTransition?.kind === 'invalidated') {
        markerPersisted.resolve(undefined)
      }
    })
    const turnRequest = request(h.session, appendUser(h.session, 'Never execute after auth invalidation'))
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    const started = deferred()
    const release = deferred()
    const original = h.server.request.bind(h.server)
    let hold = true
    vi.spyOn(h.server, 'request').mockImplementation(async (method, params) => {
      if (method === 'account/read' && hold) {
        hold = false
        started.resolve(undefined)
        await release.promise
        return { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false }
      }
      return original(method, params)
    })
    h.server.onStart = async (params) => {
      const turn = finalTurn('invalidated-turn', String(params.clientUserMessageId), 'Should never execute')
      h.server.callbacks?.onNotification('turn/completed', { threadId: String(params.threadId), turn })
      return { turn: { id: 'invalidated-turn', status: 'inProgress', items: [] } }
    }
    const execution = executor.executeTurn(turnRequest).then(() => 'executed', () => 'blocked')
    await started.promise
    h.server.account = null
    h.server.callbacks?.onNotification('account/updated', { authMode: null, planType: null })
    await markerPersisted.promise
    expect(h.runtimeSettings.get().authTransition).toMatchObject({ kind: 'invalidated' })
    release.resolve(undefined)
    const outcome = await execution
    expect({ outcome, starts: h.server.starts.length }).toEqual({ outcome: 'blocked', starts: 0 })
  })

  it('blocks mapped and uncertain old-thread operations throughout LoginPending', async () => {
    const browserStarted = deferred()
    const browserRelease = deferred()
    const openLoginUrl = vi.fn(() => {
      browserStarted.resolve(undefined)
      return browserRelease.promise
    })
    const h = await harness(openLoginUrl)
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const seed = request(h.session, appendUser(h.session, 'Establish a private thread'), undefined, 1)
    const executor = await h.runtime.executorFor(seed.selection, seed.signal)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'seed-turn' } })
      const turn = finalTurn('seed-turn', String(params.clientUserMessageId), 'Seed result')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'seed-turn', status: 'inProgress', items: [] } }
    }
    await executor.executeTurn(seed)

    const uncertain = request(h.session, appendUser(h.session, 'Do not reconcile during login'), undefined, 2)
    h.server.onStart = async () => { throw new Error('connection lost after dispatch') }
    await expect(executor.executeTurn(uncertain)).rejects.toThrow('connection lost after dispatch')
    const mappingBefore = h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')
    const generationBefore = h.runtimeSettings.get().authGeneration

    h.server.account = null
    const connecting = h.runtime.connectChatGPT()
    await browserStarted.promise
    const callsBefore = h.server.calls.length
    const mappedTurn = request(h.session, appendUser(h.session, 'Do not resume or inject during login'), undefined, 3)
    await expect(executor.executeTurn(mappedTurn)).rejects.toThrow(/account transition is in progress/u)
    await expect(executor.executeTurn(uncertain)).rejects.toThrow(/account transition is in progress/u)
    expect(h.server.calls).toHaveLength(callsBefore)
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')).toEqual(mappingBefore)

    await h.runtime.cancelLogin()
    expect(h.runtimeSettings.get().authGeneration).toBe(generationBefore)
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')).toEqual(mappingBefore)
    browserRelease.resolve(undefined)
    await expect(connecting).rejects.toThrow(/cancelled, failed, or superseded/u)
  })

  it('keeps admission closed until the new authGeneration is persisted', async () => {
    const browserStarted = deferred()
    const browserRelease = deferred()
    const openLoginUrl = vi.fn(() => {
      browserStarted.resolve(undefined)
      return browserRelease.promise
    })
    const h = await harness(openLoginUrl)
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const seed = request(h.session, appendUser(h.session, 'Keep this account thread private'), undefined, 1)
    const executor = await h.runtime.executorFor(seed.selection, seed.signal)
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'seed-turn' } })
      const turn = finalTurn('seed-turn', String(params.clientUserMessageId), 'Seed result')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-1', turn })
      return { turn: { id: 'seed-turn', status: 'inProgress', items: [] } }
    }
    await executor.executeTurn(seed)
    const generationBefore = h.runtimeSettings.get().authGeneration

    h.server.account = null
    const connecting = h.runtime.connectChatGPT()
    await browserStarted.promise
    h.server.account = { type: 'chatgpt', email: 'new-private@example.test', planType: 'plus' }
    const persistStarted = deferred()
    const persistRelease = deferred()
    const originalUpdate = h.runtimeSettings.update.bind(h.runtimeSettings)
    vi.spyOn(h.runtimeSettings, 'update').mockImplementation(async (patch) => {
      if ((patch as Record<string, unknown>).authGeneration !== undefined) {
        persistStarted.resolve(undefined)
        await persistRelease.promise
      }
      await originalUpdate(patch)
    })
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-transaction', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    expect(completion).toBeDefined()
    await persistStarted.promise
    expect(h.runtimeSettings.get().authGeneration).toBe(generationBefore)
    expect(await h.runtime.status()).toMatchObject({ account: 'reauth-required', login: 'signing-in' })

    const next = request(h.session, appendUser(h.session, 'Run only after generation commit'), undefined, 2)
    const callsBefore = h.server.calls.length
    await expect(executor.executeTurn(next)).rejects.toThrow(/account transition is in progress/u)
    expect(h.server.calls).toHaveLength(callsBefore)

    persistRelease.resolve(undefined)
    await completion
    expect(h.runtimeSettings.get().authGeneration).not.toBe(generationBefore)
    browserRelease.resolve(undefined)
    await expect(connecting).resolves.toEqual({ status: 'connected' })
    h.server.onStart = async (params) => {
      h.server.callbacks?.onNotification('turn/started', { threadId: 'thread-2', turn: { id: 'post-login-turn' } })
      const turn = finalTurn('post-login-turn', String(params.clientUserMessageId), 'Post-login result')
      h.server.callbacks?.onNotification('turn/completed', { threadId: 'thread-2', turn })
      return { turn: { id: 'post-login-turn', status: 'inProgress', items: [] } }
    }
    await expect(executor.executeTurn(next)).resolves.toMatchObject({ text: 'Post-login result' })
  })

  it('ignores cancelled and replaced login notifications', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.loginIds = ['login-a', 'login-b']
    h.server.account = null
    await h.runtime.status()
    const generationBefore = h.runtimeSettings.get().authGeneration
    const update = vi.spyOn(h.runtimeSettings, 'update')

    await expect(h.runtime.connectChatGPT()).resolves.toEqual({ status: 'signing-in' })
    await h.runtime.cancelLogin()
    expect(h.runtimeSettings.get().authGeneration).toBe(generationBefore)
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-a', success: true })
    expect(h.runtimeSettings.get().authGeneration).toBe(generationBefore)
    expect((await h.runtime.status()).login).toBe('idle')

    await expect(h.runtime.connectChatGPT()).resolves.toEqual({ status: 'signing-in' })
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-a', success: true })
    expect(h.runtimeSettings.get().authGeneration).toBe(generationBefore)
    expect(await h.runtime.status()).toMatchObject({ account: 'reauth-required', login: 'signing-in' })

    h.server.account = { type: 'chatgpt', email: 'current-private@example.test', planType: 'plus' }
    h.server.callbacks?.onNotification('account/login/completed', { loginId: 'login-b', success: true })
    const completion = (h.runtime as unknown as { loginAttempt?: { completion?: Promise<void> } }).loginAttempt?.completion
    expect(completion).toBeDefined()
    await completion
    expect(h.runtimeSettings.get().authGeneration).not.toBe(generationBefore)
    expect(update.mock.calls.filter(([patch]) => Object.hasOwn(patch, 'authGeneration'))).toHaveLength(1)
    expect(await h.runtime.status()).toMatchObject({ account: 'connected', login: 'idle' })
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
    const generation = h.runtimeSettings.get().authGeneration
    h.server.callbacks?.onNotification('account/login/completed', { loginId, success: false, error: 'cancelled by user' })
    expect((await h.runtime.status()).account).toBe('reauth-required')
    expect(h.runtimeSettings.get().authGeneration).toBe(generation)
  })
})
