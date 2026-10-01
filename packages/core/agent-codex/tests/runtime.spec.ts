import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import type { CodexConfigOwner } from '../src/config.ts'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ExternalTurnRequest } from '@deepseek-ai/dsh-agent'
import { CodexSubscriptionRuntime } from '../src/runtime.ts'
import type { CodexRuntimeInternals } from '../src/runtime.ts'
import type {
  CodexAppServerConnection, CodexRuntimeDescriptor, CodexServerCallbacks, SystemCodexRuntimeResolution,
} from '../src/app-server.ts'
import { codexSubscriptionProjection } from '../src/projection.ts'
import { CodexIncompatibleError } from '../src/compatibility.ts'
import { reportFixture } from './compatibility-fixtures.ts'


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
  preference: z.enum(['auto', 'system', 'bundled']).default('auto'),
  authGeneration: z.string().min(1).optional(),
  authTransition: z.object({ id: z.string().min(1), kind: z.enum(['login', 'logout', 'invalidated']) }).nullable().optional(),
}).transform(({ preference, authGeneration, authTransition }) => ({ preference,
  ...authGeneration === undefined ? {} : { authGeneration }, ...authTransition === undefined ? {} : { authTransition },
}))

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
  readonly runtimeSettings: FixtureConfigOwner
  readonly session: ReturnType<Context['sessions']['create']>
  readonly workspaces: Array<{ readonly id: string; readonly path: string; readonly sessionIds: readonly string[] }>
  readonly startCount: () => number
  readonly cleanup: () => Promise<void>
}

function settingsDocument(h: Harness): Record<string, unknown> {
  return { 'openai-codex-runtime': h.runtimeSettings.snapshot() }
}

class FixtureConfigOwner implements CodexConfigOwner {
  private value: RuntimePreferenceSettings
  constructor(value: unknown = {}) { this.value = RuntimePreferenceSchema.parse(value) }
  snapshot(): RuntimePreferenceSettings { return structuredClone(this.value) }
  async writeLifecycle(patch: Partial<RuntimePreferenceSettings>): Promise<void> {
    this.value = RuntimePreferenceSchema.parse({ ...this.value, ...patch })
  }
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
    compatibilityFailure?: Error
    compatibilityFingerprint?: () => string
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
  const runtimeSettings = new FixtureConfigOwner(options.settingsDocument?.['openai-codex-runtime'])
  ctx.sessionProjections.register(codexSubscriptionProjection)
  ctx.provide('approval', { request: async () => 'denied' })
  const server = new FakeAppServer()
  const servers = [server]
  let startCount = 0
  const internals: CodexRuntimeInternals = {
    inspectRuntime: async () => ({ trustedLocationId: 'fixture', signer: 'fixture', architecture: 'darwin-arm64',
      binaryFingerprint: 'a'.repeat(64) }),
    verifyCompatibility: async (descriptor, _client, _root, _initialized, protocolOnly) => {
      if (options.compatibilityFailure !== undefined) throw options.compatibilityFailure
      if (descriptor.source === 'system' && options.missingSystemCapability !== undefined) {
        throw new CodexIncompatibleError(options.missingSystemCapability)
      }
      const report = reportFixture(descriptor)
      if (options.compatibilityFingerprint !== undefined) report.fingerprint = options.compatibilityFingerprint()
      if (protocolOnly) report.lightStatus = 'UNKNOWN'
      return report
    },
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
  runtime.attachConfig(runtimeSettings)
  const session = ctx.sessions.create(SessionId('codex-runtime-test'), { meta: { cwd: process.cwd() } })
  const workspaces = [{ id: 'workspace-codex-runtime-test', path: process.cwd(), sessionIds: [String(session.id)] }]
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  const cleanup = async (): Promise<void> => {
    await runtime.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  return { root, ctx, runtime, server, servers, runtimeSettings, session, workspaces, startCount: () => startCount, cleanup }
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

describe('canonical Config runtime integration', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
  it('keeps the persisted authentication generation stable through account-read errors and runtime restarts', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.accountFailure = new Error('temporary account endpoint failure')
    expect(await h.runtime.status()).toMatchObject({ runtime: 'error', account: 'error' })
    const generation = h.runtimeSettings.snapshot().authGeneration
    expect(generation).toMatch(/^[0-9a-f-]{36}$/u)

    h.server.accountFailure = undefined
    expect(await h.runtime.status()).toMatchObject({ runtime: 'ready', account: 'connected' })
    expect(h.runtimeSettings.snapshot().authGeneration).toBe(generation)

    await h.runtime.reconnect()
    expect(h.runtimeSettings.snapshot().authGeneration).toBe(generation)
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
    expect(h.server.calls.map(call => call.method)).toEqual(expect.arrayContaining(['account/read', 'model/list']))
    expect(h.server.calls.some(call => call.method.startsWith('thread/') || call.method.startsWith('turn/'))).toBe(false)
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
    const generation = h.runtimeSettings.snapshot().authGeneration
    const status = await h.runtime.reconnect()
    expect(status.account).toBe('connected')
    expect(h.runtimeSettings.snapshot().authGeneration).toBe(generation)
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
    const generation = h.runtimeSettings.snapshot().authGeneration
    const mappingBeforeExit = h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')
    const firstProcessCallbacks = h.server.callbacks
    firstProcessCallbacks?.onExit(new Error('simulated App Server process exit'))

    expect(h.runtimeSettings.snapshot().authGeneration).toBe(generation)
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
    expect(h.runtimeSettings.snapshot().authGeneration).toBe(generation)
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
    const generation = h.runtimeSettings.snapshot().authGeneration
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
    expect(h.runtimeSettings.snapshot().authGeneration).toBe(generation)
  })

  it('keeps quota failures informational and never lets them break a connected account', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    h.server.rateLimitFailure = new Error('quota service unavailable')
    const status = await h.runtime.status()
    expect(status).toMatchObject({ runtime: 'ready', account: 'connected', usage: { state: 'unavailable' } })
    expect(status.error).toBeUndefined()
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
    const mappingEvents = h.session.snapshotEvents().filter(event => event.type === 'plugin:codex/subscription-state')
    const latest = mappingEvents.at(-1)
    expect(latest?.type === 'plugin:codex/subscription-state' && latest.data.state.dispatch).toBeNull()
    expect(JSON.stringify(mappingEvents)).not.toMatch(/authUrl|accessToken|refreshToken|codex-home/u)
  })

  it('blocks undelivered reconciliation recovery across an unknown runtime pair without resuming or replaying', async () => {
    let fingerprint = 'c'.repeat(64)
    const h = await harness(undefined, { compatibilityFingerprint: () => fingerprint })
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const turnRequest = request(h.session, appendUser(h.session, 'Perform one file change'))
    h.server.onStart = async (params) => {
      h.server.turns.push(finalTurn('accepted-turn', String(params.clientUserMessageId), 'Recovered result'))
      throw new Error('connection closed before the turn/start response')
    }
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow('connection closed')
    const failedDelivery = { ...turnRequest, publish: {
      ...turnRequest.publish, textDelta: () => { throw new Error('delivery failed') },
    } }
    await expect(executor.executeTurn(failedDelivery)).rejects.toThrow('delivery failed')
    const state = h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')
    expect(state?.dispatch).toBeNull()
    expect(state?.lastReconciliation?.status).toBe('completed')

    fingerprint = 'e'.repeat(64)
    await h.runtime.reconnect()
    const replacement = h.servers.at(-1)!
    const currentExecutor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    await expect(currentExecutor.executeTurn(turnRequest)).rejects.toThrow(/runtime.*pair|compatibility/u)
    expect(replacement.calls.filter(call => call.method.startsWith('thread/') || call.method.startsWith('turn/'))).toEqual([])
    expect(replacement.starts).toHaveLength(0)
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')?.runtimeFingerprint).toBe('c'.repeat(64))
  })

  it('blocks an unresolved dispatch after child replacement changes the runtime fingerprint', async () => {
    let fingerprint = 'c'.repeat(64)
    const h = await harness(undefined, { compatibilityFingerprint: () => fingerprint })
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const turnRequest = request(h.session, appendUser(h.session, 'Change one file'))
    h.server.onStart = async () => { throw new Error('lost acknowledgement') }
    const executor = await h.runtime.executorFor(turnRequest.selection, turnRequest.signal)
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow('lost acknowledgement')
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')?.dispatch).not.toBeNull()

    fingerprint = 'e'.repeat(64)
    h.server.callbacks?.onExit(new Error('unexpected child exit'))
    await h.runtime.status()
    await expect(executor.executeTurn(turnRequest)).rejects.toThrow('runtime pair is unverified')
    const replacement = h.servers.at(-1)!
    expect(replacement.calls.filter(call => call.method.startsWith('thread/') || call.method.startsWith('turn/'))).toEqual([])
    expect(replacement.starts).toHaveLength(0)
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
    const states = h.session.snapshotEvents().filter(event => event.type === 'plugin:codex/subscription-state')
    expect(states.some(event => event.type === 'plugin:codex/subscription-state'
      && event.data.state.lastReconciliation?.status === 'interrupted')).toBe(true)
    expect(states.at(-1)?.type === 'plugin:codex/subscription-state'
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
    const latest = h.session.snapshotEvents().filter(event => event.type === 'plugin:codex/subscription-state').at(-1)
    expect(latest?.type === 'plugin:codex/subscription-state' && latest.data.state.lastReconciliation)
      .toMatchObject({ status: 'interrupted', sideEffectCount: 1 })
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
      .filter(event => event.type === 'plugin:codex/subscription-state').at(-1)
    expect(pendingState?.type === 'plugin:codex/subscription-state' && pendingState.data.state.dispatch?.status)
      .toBe('uncertain')
    if (pendingState?.type !== 'plugin:codex/subscription-state') throw new Error('Missing uncertain dispatch checkpoint.')

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
    afterCrash.session.appendIgnorable('plugin:codex/subscription-state', { state: pendingState.data.state })
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

  it('discards a stale Connected account read after logout commits', async () => {
    const h = await harness()
    cleanups.push(h.cleanup)
    await h.runtime.status()
    const before = h.runtimeSettings.snapshot().authGeneration
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
    expect(h.runtimeSettings.snapshot().authGeneration).not.toBe(before)
    release.resolve(undefined)
    expect(await oldStatus).toMatchObject({ account: 'reauth-required', login: 'idle' })
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
    const generationBefore = h.runtimeSettings.snapshot().authGeneration

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
    expect(h.runtimeSettings.snapshot().authGeneration).toBe(generationBefore)
    expect(h.ctx.sessionProjections.stateOf(h.session, 'codexSubscription')).toEqual(mappingBefore)
    browserRelease.resolve(undefined)
    await expect(connecting).rejects.toThrow(/cancelled, failed, or superseded/u)

  })

})
