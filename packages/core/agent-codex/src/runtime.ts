/** Official Codex App Server lifecycle, subscription state, and external-turn execution. */

import { createHash } from 'node:crypto'
import { chmod, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type {
  ExternalModelCatalogEntry,
  ExternalModelProvider,
  ExternalTurnExecutor,
  ExternalTurnActivityIdentity,
  ExternalTurnRequest,
  ExternalTurnResult,
  ExternalTurnSelection,
  ExternalTurnWorkspace,
} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { openNativePath } from '@deepseek-ai/dsh-native-command'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { codexSubscriptionProjection, EMPTY_CODEX_MAPPING } from './projection.ts'
import {
  bundledCodexRuntime, CodexAppServerClient, jsonObject, requiredString, resolveSystemCodexRuntime,
} from './app-server.ts'
import type { CodexAppServerConnection, CodexRuntimeDescriptor, SystemCodexRuntimeResolution } from './app-server.ts'
import type { CodexServerCallbacks } from './app-server.ts'
import type {
  CodexAccountState, CodexRuntimePreference, CodexRuntimeState, CodexSessionMappingState, CodexSubscriptionStatus,
  CodexUsageStatus, CodexUsageWindow,
} from './types.ts'

const PROVIDER_ID = 'openai-codex-subscription'
const PROVIDER_NAME = 'OpenAI Codex'
const MAX_HISTORY_ITEMS = 80
const MAX_HISTORY_CHARS = 48_000
const RPC_TIMEOUT_MS = 45_000
const RATE_LIMIT_REFRESH_MS = 5 * 60_000
const CODEX_RUNTIME_SETTINGS_NAMESPACE = 'openai-codex-runtime'
const CAPABILITY_PROBE_THREAD_ID = 'dsh-system-capability-probe-no-such-thread'
const REQUIRED_SYSTEM_METHOD_PROBES = [
  // A deliberately invalid cwd must fail request validation before the server
  // can create a thread. All other thread-scoped probes name an impossible ID.
  { method: 'thread/start', params: { cwd: null, approvalPolicy: '__dsh_probe_invalid__', sandbox: '__dsh_probe_invalid__' }, allowSuccess: false },
  { method: 'turn/start', params: { threadId: CAPABILITY_PROBE_THREAD_ID, input: [], model: '', effort: '' }, allowSuccess: false },
  { method: 'turn/interrupt', params: { threadId: CAPABILITY_PROBE_THREAD_ID, turnId: CAPABILITY_PROBE_THREAD_ID }, allowSuccess: true },
  { method: 'thread/resume', params: { threadId: CAPABILITY_PROBE_THREAD_ID }, allowSuccess: false },
  { method: 'thread/read', params: { threadId: CAPABILITY_PROBE_THREAD_ID }, allowSuccess: false },
  { method: 'thread/inject_items', params: { threadId: CAPABILITY_PROBE_THREAD_ID, items: [] }, allowSuccess: false },
  { method: 'thread/turns/list', params: { threadId: CAPABILITY_PROBE_THREAD_ID, limit: 1, sortDirection: 'desc', itemsView: 'full' }, allowSuccess: false },
] as const
const UNAVAILABLE_USAGE: CodexUsageStatus = { state: 'unavailable' }
type JsonObject = Record<string, unknown>

interface CodexRuntimeSettings {
  preference: CodexRuntimePreference
}

const CodexRuntimeSettingsSchema: z<CodexRuntimeSettings> = z.object({
  preference: z.union(['auto', 'system', 'bundled']).default('auto'),
})

interface ActiveCodexTurn {
  readonly request: ExternalTurnRequest
  readonly threadId: string
  turnId?: string
  finalText: string
  terminal?: JsonObject
}

interface CodexModelEntry extends ExternalModelCatalogEntry {
  /** App Server's model field, distinct from the catalog ID used by DSH. */
  readonly runtimeModel: string
}

/** Host lifecycle hooks replaceable by deterministic tests. */
export interface CodexRuntimeInternals {
  readonly spawn?: (spec: SubprocessSpawnSpec) => ReturnType<Context['subprocess']['spawn']>
  readonly openLoginUrl?: (url: string) => Promise<void>
  readonly ensureHome?: (path: string) => Promise<void>
  readonly resolveHomePath?: (...segments: string[]) => string
  readonly resolveSystemRuntime?: () => SystemCodexRuntimeResolution
  readonly startClient?: (
    runtime: CodexRuntimeDescriptor,
    home: string,
    cwd: string,
    callbacks: CodexServerCallbacks,
  ) => CodexAppServerConnection
}

/** App Server-backed provider, model directory, and external turn executor. */
export class CodexSubscriptionRuntime extends Service implements ExternalModelProvider {
  static Config: z<{}> = z.object({})

  readonly id: string = PROVIDER_ID
  override readonly name: string = PROVIDER_NAME
  private client: CodexAppServerConnection | undefined
  private activeRuntime: CodexRuntimeDescriptor | undefined
  private runtimeSettings: SettingsScope<CodexRuntimeSettings> | undefined
  private runtimeInventory: SystemCodexRuntimeResolution | undefined
  private runtimeSelectionNote: string | undefined
  private runtimeState: CodexRuntimeState = 'stopped'
  private accountState: CodexAccountState = 'not-connected'
  private statusError: string | undefined
  private modelCount = 0
  private usage: CodexUsageStatus = UNAVAILABLE_USAGE
  private rateLimitReadAt = 0
  private loginId: string | undefined
  private loginPending = false
  private disposed = false
  private activeTurns = new Map<string, ActiveCodexTurn>()
  private readonly failedReconciliationCommits = new WeakSet<Session>()
  private readonly deliveredReconciliations = new WeakMap<Session, Set<string>>()
  private readonly spawn: (spec: SubprocessSpawnSpec) => ReturnType<Context['subprocess']['spawn']>
  private readonly openLoginUrl: (url: string) => Promise<void>
  private readonly ensureHome: (path: string) => Promise<void>
  private readonly resolveHomePath: (...segments: string[]) => string
  private readonly resolveSystemRuntime: () => SystemCodexRuntimeResolution
  private readonly startClient: (
    runtime: CodexRuntimeDescriptor,
    home: string,
    cwd: string,
    callbacks: CodexServerCallbacks,
  ) => CodexAppServerConnection

  constructor(ctx: Context, internals: CodexRuntimeInternals = {}) {
    super(ctx, 'codexSubscription')
    this.spawn = internals.spawn ?? ((spec) => {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) throw new Error('Codex App Server requires the DSH subprocess service.')
      return subprocess.spawn(spec)
    })
    this.openLoginUrl = internals.openLoginUrl ?? (async (url) => { await openNativePath(url, AbortSignal.timeout(10_000)) })
    this.ensureHome = internals.ensureHome ?? secureHome
    this.resolveHomePath = internals.resolveHomePath ?? dshHomePath
    this.resolveSystemRuntime = internals.resolveSystemRuntime ?? resolveSystemCodexRuntime
    this.startClient = internals.startClient
      ?? ((runtime, home, cwd, callbacks) => CodexAppServerClient.start(this.spawn, home, cwd, callbacks, runtime))
  }

  /** Attach the persistent runtime preference owned by DSH settings.
   * @param scope - the DSH settings scope that stores the user's runtime preference.
   */
  attachSettings(scope: SettingsScope<CodexRuntimeSettings>): void {
    this.runtimeSettings = scope
  }

  /** Change runtime preference only between turns, then start a fresh pinned connection.
   * @param preference - the requested automatic, verified system, or bundled runtime.
   * @returns the refreshed renderer-safe Codex subscription status.
   */
  async selectRuntime(preference: unknown): Promise<CodexSubscriptionStatus> {
    if (preference !== 'auto' && preference !== 'system' && preference !== 'bundled') {
      throw new Error('Choose Automatic, System Codex, or Bundled Codex.')
    }
    if (this.activeTurns.size > 0) throw new Error('Finish or cancel the active Codex turn before changing runtimes.')
    const system = this.systemRuntime()
    if (preference === 'system' && system.runtime === undefined) {
      throw new Error(system.unavailableReason ?? 'The verified system Codex runtime is unavailable.')
    }
    const scope = this.runtimeSettings
    if (scope === undefined) throw new Error('Codex runtime settings are unavailable in this deployment.')
    if (scope.get().preference !== preference) {
      await scope.update({ preference })
      await this.stopClient()
      this.accountState = 'not-connected'
      this.modelCount = 0
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
      this.statusError = undefined
      this.runtimeSelectionNote = undefined
    }
    return this.status()
  }

  /** The model catalog owner is this exact active runtime instance.
   * @returns This runtime as the only external provider owned by the package.
   */
  listProviders(): readonly ExternalModelProvider[] { return [this] }

  private systemRuntime(): SystemCodexRuntimeResolution {
    if (this.runtimeInventory !== undefined) return this.runtimeInventory
    try {
      this.runtimeInventory = this.resolveSystemRuntime()
    } catch {
      this.runtimeInventory = { unavailableReason: 'The installed ChatGPT Codex runtime could not be verified.' }
    }
    return this.runtimeInventory
  }

  private runtimeStatusFields(): Pick<
    CodexSubscriptionStatus,
    'runtimePreference' | 'runtimeSource' | 'runtimeVersion' | 'systemRuntimeAvailable' | 'systemRuntimeVersion'
      | 'bundledRuntimeVersion' | 'runtimeSelectionNote'
  > {
    const system = this.systemRuntime().runtime
    return {
      runtimePreference: this.runtimeSettings?.get().preference ?? 'auto',
      ...(this.activeRuntime === undefined ? {} : {
        runtimeSource: this.activeRuntime.source,
        runtimeVersion: this.activeRuntime.version,
      }),
      systemRuntimeAvailable: system !== undefined,
      bundledRuntimeVersion: bundledCodexRuntime().version,
      ...(system === undefined ? {} : { systemRuntimeVersion: system.version }),
      ...(this.runtimeSelectionNote === undefined ? {} : { runtimeSelectionNote: this.runtimeSelectionNote }),
    }
  }

  /** Return redacted current state; a settings visit is an on-demand start boundary.
   * @returns The current renderer-safe runtime, account, and usage state.
   */
  async status(): Promise<CodexSubscriptionStatus> {
    if (this.disposed) return {
      enabled: true, runtime: 'stopped', account: 'error', login: 'idle', modelCount: 0,
      usage: UNAVAILABLE_USAGE, error: 'Codex runtime is shutting down.', ...this.runtimeStatusFields(),
    }
    try {
      await this.ensureStarted()
      this.runtimeState = 'auth-check'
      await this.refreshAccount()
      if (this.accountState === 'connected') {
        this.runtimeState = 'catalog-loading'
        const models = await this.readModels()
        this.modelCount = models.length
        await this.refreshRateLimits()
        this.runtimeState = 'ready'
      } else {
        this.modelCount = 0
        this.usage = UNAVAILABLE_USAGE
        this.runtimeState = 'ready'
      }
      this.statusError = undefined
    } catch (error: unknown) {
      this.runtimeState = this.client === undefined && this.runtimeState !== 'error' ? 'crashed' : 'error'
      this.statusError = safeError(error)
      if (this.accountState !== 'connected') this.accountState = 'error'
    }
    return {
      enabled: true,
      runtime: this.runtimeState,
      ...this.runtimeStatusFields(),
      account: this.accountState,
      login: this.loginPending ? 'signing-in' : 'idle',
      modelCount: this.modelCount,
      usage: this.usage,
      ...(this.statusError === undefined ? {} : { error: this.statusError }),
    }
  }

  /** Start the official ChatGPT subscription login and open only its allowlisted URL.
   * @returns Whether the official browser sign-in is pending or already connected.
   */
  async connectChatGPT(): Promise<{ readonly status: 'signing-in' | 'connected' }> {
    const client = await this.ensureStarted()
    await this.refreshAccount()
    if (this.accountState === 'connected') return { status: 'connected' }
    this.loginPending = true
    this.runtimeState = 'auth-check'
    try {
      const response = jsonObject(await client.request('account/login/start', { type: 'chatgpt' }, 20_000), 'login response')
      if (response.type !== 'chatgpt') throw new Error('Codex App Server did not start the official ChatGPT login flow.')
      const url = requiredString(response.authUrl, 'official ChatGPT login URL')
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname)) {
        throw new Error('Codex App Server returned an unapproved authentication destination')
      }
      this.loginId = requiredString(response.loginId, 'official login transaction id')
      await this.openLoginUrl(url)
      return { status: 'signing-in' }
    } catch (error: unknown) {
      this.loginPending = false
      this.statusError = safeError(error)
      throw new Error(this.statusError)
    }
  }

  /** Cancel only the login transaction owned by this runtime process.
   * @returns The refreshed renderer-safe subscription state.
   */
  async cancelLogin(): Promise<CodexSubscriptionStatus> {
    if (!this.loginPending || this.loginId === undefined) return this.status()
    const client = await this.ensureStarted()
    await client.request('account/login/cancel', { loginId: this.loginId }, 10_000)
    this.loginPending = false
    this.loginId = undefined
    return this.status()
  }

  /** Reconnect means restarting only the DSH-owned App Server, not user Codex apps.
   * @returns The refreshed renderer-safe subscription state.
   */
  async reconnect(): Promise<CodexSubscriptionStatus> {
    await this.stopClient()
    return this.status()
  }

  /** Use the official logout method in the isolated CODEX_HOME; never edit auth files directly.
   * @returns The refreshed renderer-safe subscription state.
   */
  async disconnect(): Promise<CodexSubscriptionStatus> {
    const client = await this.ensureStarted()
    await client.request('account/logout', {}, 15_000)
    this.accountState = 'not-connected'
    this.loginPending = false
    this.loginId = undefined
    this.modelCount = 0
    this.usage = UNAVAILABLE_USAGE
    this.rateLimitReadAt = 0
    this.runtimeState = 'ready'
    return this.status()
  }

  /** Discover model IDs and reasoning capabilities from the active official runtime.
   * @param signal - Optional cancellation signal for discovery.
   * @returns The available Codex model catalog entries.
   */
  async listModels(signal?: AbortSignal): Promise<readonly ExternalModelCatalogEntry[]> {
    signal?.throwIfAborted()
    await this.ensureStarted()
    await this.refreshAccount()
    if (this.accountState !== 'connected') throw new Error('Connect a ChatGPT subscription to discover Codex models.')
    const models = await this.readModels(signal)
    signal?.throwIfAborted()
    this.modelCount = models.length
    return models.map(({ id, name, description, reasoning }) => ({
      id,
      name,
      ...(description === undefined ? {} : { description }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }))
  }

  /** Validate a model and materialize its runtime-owned default effort.
   * @param selection - The requested Codex provider, model, and optional effort.
   * @param signal - Optional cancellation signal for model discovery.
   * @returns The validated selection with its resolved reasoning effort.
   */
  async resolveSelection(selection: ExternalTurnSelection, signal?: AbortSignal): Promise<ExternalTurnSelection> {
    if (selection.provider !== PROVIDER_ID) throw new Error('The Codex runtime cannot resolve another provider route.')
    const models = await this.readModels(signal)
    const model = models.find(candidate => candidate.id === selection.model)
    if (model === undefined) throw new Error(`Codex model "${selection.model}" is not available in the active runtime.`)
    return this.resolveFromModel(selection, model)
  }

  /** Ensure selected model/effort is still served by this runtime and return the external executor.
   * @param selection - The frozen external provider, model, and reasoning choice.
   * @param signal - Cancellation signal for model discovery and workspace execution.
   * @returns An executor bound to the validated model and this runtime.
   */
  async executorFor(selection: ExternalTurnSelection, signal: AbortSignal): Promise<ExternalTurnExecutor> {
    if (selection.provider !== PROVIDER_ID) throw new Error('The Codex runtime cannot resolve another provider route.')
    const models = await this.readModels(signal)
    const model = models.find(candidate => candidate.id === selection.model)
    if (model === undefined) throw new Error(`Codex model "${selection.model}" is not available in the active runtime.`)
    const resolved = this.resolveFromModel(selection, model)
    return {
      providerId: PROVIDER_ID,
      resolveWorkspace: (session, cwd, workspaceSignal) => this.resolveWorkspace(session, cwd, workspaceSignal),
      executeTurn: request => this.executeTurn({ ...request, selection: resolved }, model.runtimeModel),
    }
  }

  /** Require one registered DSH workspace that explicitly owns this Session. */
  private async resolveWorkspace(session: Session, cwd: string, signal: AbortSignal): Promise<ExternalTurnWorkspace> {
    signal.throwIfAborted()
    const canonicalCwd = await canonicalWorkspace(cwd)
    signal.throwIfAborted()
    const workspaceRegistry = this.ctx.get('workspaceRegistry')
    if (workspaceRegistry === undefined) {
      throw new Error('Codex requires the DSH workspace registry before a turn can start.')
    }
    const matches = workspaceRegistry.list().filter((workspace: Workspace) =>
      workspace.path === canonicalCwd
      && workspace.sessionIds.some(sessionId => String(sessionId) === String(session.id)),
    )
    const workspace = matches.at(0)
    if (matches.length !== 1 || workspace === undefined) {
      throw new Error('Codex requires this Session to belong to exactly one registered DSH workspace.')
    }
    return { identity: String(workspace.id), cwd: canonicalCwd }
  }

  /** Shut down only the process range started by this DSH service. */
  async dispose(): Promise<void> {
    this.disposed = true
    const client = this.client
    if (client !== undefined && this.turnWaiters.size > 0) {
      const pending = [...this.turnWaiters.entries()]
      await Promise.all(pending.map(([threadId, waiter]) =>
        client.request('turn/interrupt', { threadId, turnId: waiter.turnId }, 5_000).catch(() => undefined),
      ))
      await withDeadline(
        Promise.allSettled(pending.map(([, waiter]) => waiter.completion)),
        4_000,
        'Codex turns did not settle before runtime shutdown',
      ).catch(() => undefined)
    }
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error('Codex runtime was disposed during an active turn.'))
    }
    this.turnWaiters.clear()
    this.activeTurns.clear()
    await this.stopClient()
  }

  private async ensureStarted(): Promise<CodexAppServerConnection> {
    if (this.client !== undefined) return this.client
    if (this.disposed) throw new Error('Codex runtime is shutting down.')
    this.runtimeState = 'starting'
    const requestedHome = this.resolveHomePath('codex-subscription', 'codex-home')
    await this.ensureHome(requestedHome)
    const home = await realpath(requestedHome)
    const preference = this.runtimeSettings?.get().preference ?? 'auto'
    const system = this.systemRuntime()
    const bundled = bundledCodexRuntime()
    const candidates = preference === 'bundled'
      ? [bundled]
      : preference === 'system'
        ? system.runtime === undefined ? [] : [system.runtime]
        : system.runtime === undefined ? [bundled] : [system.runtime, bundled]

    if (preference === 'system' && candidates.length === 0) {
      this.runtimeState = 'error'
      this.statusError = system.unavailableReason ?? 'The verified system Codex runtime is unavailable.'
      throw new Error(this.statusError)
    }
    if (preference === 'auto' && system.runtime === undefined) {
      this.runtimeSelectionNote = system.unavailableReason ?? 'Using the bundled Codex runtime.'
    }
    let lastFailure: Error | undefined
    for (const runtime of candidates) {
      try {
        const starting = await this.startRuntime(runtime, home)
        this.activeRuntime = runtime
        this.runtimeSelectionNote = runtime.source === 'bundled' && preference === 'auto' && lastFailure !== undefined
          ? 'System Codex did not pass its capability check; using the bundled runtime.'
          : undefined
        this.runtimeState = 'auth-check'
        return starting
      } catch (error: unknown) {
        lastFailure = error instanceof Error ? error : new Error('Codex runtime startup failed.')
        if (preference !== 'auto' || runtime.source !== 'system') {
          this.runtimeState = 'error'
          this.statusError = safeError(lastFailure)
          throw new Error(this.statusError)
        }
      }
    }
    this.runtimeState = 'error'
    this.statusError = safeError(lastFailure ?? new Error('No supported Codex App Server runtime is available.'))
    throw new Error(this.statusError)
  }

  private async startRuntime(runtime: CodexRuntimeDescriptor, home: string): Promise<CodexAppServerConnection> {
    const owned: { client?: CodexAppServerConnection } = {}
    const callbacks: CodexServerCallbacks = {
      onNotification: (method, params) => { this.onNotification(method, params) },
      onRequest: (method, params) => this.onServerRequest(method, params),
      onExit: (error) => {
        if (owned.client !== undefined && this.client === owned.client) {
          this.client = undefined
          this.activeRuntime = undefined
          this.runtimeInventory = undefined
          this.runtimeState = 'crashed'
          this.accountState = 'error'
          this.statusError = error === undefined ? 'Codex App Server disconnected.' : safeError(error)
        }
        for (const [threadId, waiter] of this.turnWaiters) {
          const active = this.activeTurns.get(threadId)
          if (active?.turnId === waiter.turnId) waiter.reject(new Error('Codex App Server exited during an active turn.'))
        }
      },
    }
    this.runtimeState = 'initializing'
    const starting = this.startClient(runtime, home, home, callbacks)
    owned.client = starting
    this.client = starting
    try {
      await withDeadline(starting.initialize(), 18_000, 'Codex App Server initialization timed out')
      if (runtime.source === 'system') await verifySystemRuntimeCapabilities(starting)
      return starting
    } catch (error: unknown) {
      if (this.client === starting) this.client = undefined
      this.activeRuntime = undefined
      await starting.dispose().catch(() => {})
      throw error instanceof Error ? error : new Error('Codex runtime compatibility check failed.')
    }
  }

  private async stopClient(): Promise<void> {
    this.runtimeInventory = undefined
    const client = this.client
    if (client === undefined) { this.activeRuntime = undefined; this.runtimeState = 'stopped'; return }
    this.runtimeState = 'stopping'
    this.client = undefined
    this.activeRuntime = undefined
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error('Codex App Server restarted during an active turn.'))
    }
    this.turnWaiters.clear()
    await client.dispose()
    this.runtimeState = 'stopped'
  }

  private async refreshAccount(): Promise<void> {
    const client = this.client
    if (client === undefined) throw new Error('Codex App Server is not connected.')
    const response = jsonObject(await client.request('account/read', { refreshToken: false }, 15_000), 'account state')
    const account = response.account
    if (account === null || account === undefined) {
      this.accountState = response.requiresOpenaiAuth === true ? 'reauth-required' : 'not-connected'
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
      return
    }
    const view = jsonObject(account, 'account')
    if (view.type === 'chatgpt') {
      this.accountState = 'connected'
      // Do not return account email or any protocol fields to the renderer.
      return
    }
    if (view.type === 'apiKey') {
      this.accountState = 'not-connected'
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
      return
    }
    this.accountState = response.requiresOpenaiAuth === true ? 'reauth-required' : 'error'
  }

  /** Read the official account quota snapshot at most once per five minutes. */
  private async refreshRateLimits(force = false): Promise<void> {
    const client = this.client
    if (client === undefined || this.accountState !== 'connected') {
      this.usage = UNAVAILABLE_USAGE
      return
    }
    const now = Date.now()
    if (!force && now - this.rateLimitReadAt < RATE_LIMIT_REFRESH_MS) return
    this.rateLimitReadAt = now
    try {
      const response = jsonObject(await client.request('account/rateLimits/read', {}, 15_000), 'account rate limits')
      const buckets = response.rateLimitsByLimitId
      const bucketMap = buckets !== null && typeof buckets === 'object' && !Array.isArray(buckets)
        ? buckets as Record<string, unknown>
        : undefined
      const codexBucket = bucketMap?.codex
      const snapshot = jsonObject(codexBucket ?? response.rateLimits, 'account rate-limit snapshot')
      const primary = usageWindow(snapshot.primary)
      const secondary = usageWindow(snapshot.secondary)
      this.usage = primary === undefined && secondary === undefined
        ? UNAVAILABLE_USAGE
        : {
          state: 'available',
          ...(primary === undefined ? {} : { primary }),
          ...(secondary === undefined ? {} : { secondary }),
        }
    } catch {
      // Quota visibility is informational; it must not turn account/runtime
      // status into an authentication failure or block a turn.
      this.usage = UNAVAILABLE_USAGE
    }
  }

  private async readModels(signal?: AbortSignal): Promise<CodexModelEntry[]> {
    const client = this.client
    if (client === undefined) throw new Error('Codex App Server is not connected.')
    const models: CodexModelEntry[] = []
    const seen = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      signal?.throwIfAborted()
      const response = jsonObject(await client.request(
        'model/list',
        cursor === undefined ? { limit: 200 } : { cursor, limit: 200 },
        RPC_TIMEOUT_MS,
      ), 'model directory')
      if (!Array.isArray(response.data)) throw new Error('Codex App Server did not return a model directory page.')
      for (const raw of response.data) {
        const entry = jsonObject(raw, 'model entry')
        if (entry.hidden === true) continue
        const id = requiredString(entry.id, 'model id')
        const runtimeModel = requiredString(entry.model, 'model runtime name')
        const name = requiredString(entry.displayName, 'model display name')
        if (seen.has(id)) throw new Error('Codex App Server returned duplicate model identifiers.')
        seen.add(id)
        if (!Array.isArray(entry.supportedReasoningEfforts)) {
          throw new Error(`Codex model "${id}" did not return its supported reasoning efforts.`)
        }
        const efforts = entry.supportedReasoningEfforts.map((rawEffort) => {
          const effort = jsonObject(rawEffort, 'reasoning effort')
          const effortId = requiredString(effort.reasoningEffort, 'reasoning effort id')
          return {
            id: effortId,
            name: effortId,
            description: requiredString(effort.description, 'reasoning effort description'),
          }
        })
        const defaultEffort = requiredString(entry.defaultReasoningEffort, 'default reasoning effort')
        if (!efforts.some(effort => effort.id === defaultEffort)) {
          throw new Error(`Codex model "${id}" advertised an unsupported default reasoning effort.`)
        }
        models.push({
          id,
          runtimeModel,
          name,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          reasoning: { efforts, defaultEffort },
        })
      }
      if (response.nextCursor === null) return models
      const nextCursor = requiredString(response.nextCursor, 'model directory cursor')
      if (seenCursors.has(nextCursor) || nextCursor === cursor) {
        throw new Error('Codex App Server repeated a model directory cursor.')
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    throw new Error('Codex App Server model directory exceeded the bounded pagination limit.')
  }

  private resolveFromModel(selection: ExternalTurnSelection, model: CodexModelEntry): ExternalTurnSelection {
    const efforts = model.reasoning?.efforts ?? []
    const selectedEffort = selection.reasoningEffort === undefined
      ? model.reasoning?.defaultEffort
      : String(selection.reasoningEffort)
    if (selectedEffort === undefined || !efforts.some(effort => effort.id === selectedEffort)) {
      throw new Error(`Reasoning effort "${String(selectedEffort)}" is not supported by the selected Codex model.`)
    }
    return {
      provider: PROVIDER_ID,
      model: model.id,
      reasoningEffort: ReasoningEffortId(selectedEffort),
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/login/completed') {
      const loginId = typeof params.loginId === 'string' ? params.loginId : undefined
      if (!this.loginPending || this.loginId === undefined || loginId !== this.loginId) return
      this.loginPending = false
      this.loginId = undefined
      if (params.success !== true) {
        this.accountState = 'error'
        this.runtimeState = 'error'
        this.statusError = safeError(params.error)
        return
      }
      void this.refreshAccount().then(async () => {
        if (this.accountState !== 'connected') {
          throw new Error('Official ChatGPT login completed but the subscription account is not connected.')
        }
        this.runtimeState = 'ready'
        this.statusError = undefined
        this.modelCount = (await this.readModels()).length
        await this.refreshRateLimits(true)
      }).catch((error: unknown) => {
        this.accountState = 'error'
        this.runtimeState = 'error'
        this.statusError = safeError(error)
      })
      return
    }
    if (method === 'turn/started') {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
      if (threadId === undefined) return
      const turn = typeof params.turn === 'object' && params.turn !== null ? params.turn as Record<string, unknown> : undefined
      const turnId = typeof turn?.id === 'string' ? turn.id : undefined
      const active = this.activeTurns.get(threadId)
      if (active !== undefined && turnId !== undefined) {
        active.turnId = turnId
        const waiter = this.turnWaiters.get(threadId)
        if (waiter !== undefined && waiter.turnId !== turnId) waiter.reject(new Error('Codex App Server started an unexpected turn.'))
      }
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
      if (threadId === undefined) return
      const active = this.activeTurns.get(threadId)
      if (active === undefined || !notificationMatchesTurn(params, active)) return
      const item = params.item === null || typeof params.item !== 'object' || Array.isArray(params.item)
        ? undefined
        : params.item as Record<string, unknown>
      if (item === undefined) return
      const itemId = typeof item.id === 'string' ? item.id : undefined
      if (itemId === undefined) return
      if (method === 'item/started' && item.type === 'commandExecution') {
        const command = typeof item.command === 'string' ? safeCommandSummary(item.command) : ''
        if (command !== '') {
          const identity = this.activityIdentity(active, itemId, itemId, method, 'started')
          if (identity !== undefined) {
            active.request.publish.event({ kind: 'command', id: itemId, command, status: 'started', identity })
          }
        }
        return
      }
      if (method === 'item/completed') {
        const publicText = finalAssistantText(item)
        if (publicText !== undefined) active.finalText += publicText
        if (item.type === 'commandExecution') this.publishCommandCompletion(active, itemId, item)
        if (item.type === 'fileChange') this.publishFileChanges(active, itemId, item)
      }
      return
    }
    if (method === 'turn/completed') {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
      if (threadId === undefined) return
      const active = this.activeTurns.get(threadId)
      const turn = params.turn === null || typeof params.turn !== 'object' || Array.isArray(params.turn)
        ? undefined
        : params.turn as Record<string, unknown>
      if (active === undefined) return
      if (turn === undefined) {
        this.turnWaiters.get(threadId)?.reject(new Error('Codex App Server completed a turn without terminal metadata.'))
        return
      }
      const completedId = typeof turn.id === 'string' ? turn.id : undefined
      if (active.turnId === undefined && completedId !== undefined) active.turnId = completedId
      if (!notificationMatchesTurn(params, active)) return
      const text = active.finalText || finalAssistantTextFromTurn(turn) || ''
      const turnStatus = externalTurnTerminalStatus(turn.status)
      if (turnStatus !== undefined) {
        const identity = this.activityIdentity(
          active,
          active.turnId ?? completedId ?? 'unknown-turn',
          active.turnId ?? completedId ?? 'unknown-turn',
          method,
          turnStatus,
        )
        if (identity !== undefined) {
          active.request.publish.event({
            kind: 'turn',
            id: identity.itemId,
            status: turnStatus,
            identity,
          })
        }
      }
      const terminal: JsonObject = { ...turn, __dshText: text }
      active.terminal = terminal
      const waiter = this.turnWaiters.get(threadId)
      if (waiter !== undefined && waiter.turnId === active.turnId) waiter.resolve(terminal)
    }
  }

  private activityIdentity(
    active: ActiveCodexTurn,
    itemId: string,
    activityKey: string,
    eventKind: string,
    terminalState: string,
    requestId?: string,
  ): ExternalTurnActivityIdentity | undefined {
    const runtime = this.activeRuntime
    const turnId = active.turnId
    if (runtime === undefined || turnId === undefined) return undefined
    const safeThreadId = active.threadId
    const activityId = `${safeThreadId}:${turnId}:${activityKey}`.slice(0, 768)
    return {
      activityId,
      eventId: `${activityId}:${eventKind}:${terminalState}`.slice(0, 1024),
      sessionId: active.request.session.id,
      dshTurn: active.request.turn,
      dshStep: active.request.step,
      provider: PROVIDER_ID,
      runtimeSource: runtime.source,
      runtimeVersion: runtime.version,
      threadId: safeThreadId,
      turnId: turnId.slice(0, 256),
      itemId: itemId.slice(0, 256),
      ...(requestId === undefined ? {} : { requestId: requestId.slice(0, 256) }),
      eventKind: eventKind.slice(0, 128),
      terminalState: terminalState.slice(0, 64),
    }
  }

  private publishCommandCompletion(
    active: ActiveCodexTurn,
    itemId: string,
    item: Record<string, unknown>,
  ): void {
    const command = typeof item.command === 'string' ? safeCommandSummary(item.command) : ''
    if (command === '') return
    const status = commandTerminalStatus(item)
    const identity = this.activityIdentity(active, itemId, itemId, 'item/completed', status)
    if (identity === undefined) return
    active.request.publish.event({ kind: 'command', id: itemId, command, status, identity })
  }

  private publishFileChanges(
    active: ActiveCodexTurn,
    itemId: string,
    item: Record<string, unknown>,
  ): void {
    if (!Array.isArray(item.changes)) return
    for (const candidate of item.changes) {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const change = candidate as Record<string, unknown>
      const path = safeWorkspaceRelativePath(active.request.cwd, change.path)
      if (path === undefined) continue
      const status = fileChangeStatus(change.kind)
      const identity = this.activityIdentity(
        active,
        itemId,
        `${itemId}:${path}`,
        'item/completed',
        status,
      )
      if (identity === undefined) continue
      active.request.publish.event({ kind: 'file-change', id: itemId, path, status, identity })
    }
  }

  private async executeTurn(request: ExternalTurnRequest, runtimeModel: string): Promise<ExternalTurnResult> {
    const client = await this.ensureStarted()
    await this.refreshAccount()
    if (this.accountState !== 'connected') throw new Error('OpenAI Codex is not connected to a ChatGPT subscription.')
    const cwd = await canonicalWorkspace(request.cwd)
    const workspace = await this.resolveWorkspace(request.session, cwd, request.signal)
    if (workspace.identity !== request.workspaceIdentity || workspace.cwd !== cwd) {
      throw new Error('Codex turn workspace identity no longer matches the canonical DSH workspace.')
    }
    const textInput = request.messages.flatMap(textFromUserMessage)
    if (textInput.length === 0) throw new Error('Codex turns require non-empty text input.')
    const effort = request.selection.reasoningEffort === undefined ? undefined : String(request.selection.reasoningEffort)
    if (effort === undefined) throw new Error('Codex turn requires the model directory default reasoning effort to be frozen.')
    const inputHash = digest(JSON.stringify(textInput))
    let mapping = this.ctx.sessionProjections.stateOf(request.session, 'codexSubscription') ?? EMPTY_CODEX_MAPPING
    const requestedMessageId = request.messages.at(-1)?.id === undefined
      ? ''
      : String(request.messages.at(-1)?.id)
    if (requestedMessageId === '') throw new Error('Codex turn is missing its canonical DSH user message identity.')
    if (this.failedReconciliationCommits.has(request.session)) {
      throw new Error('A previous Codex reconciliation could not be durably committed; no new turn was sent.')
    }

    // Resolve any persisted side-effecting dispatch before touching the thread.
    // Authoritative terminal state releases the barrier; ambiguous state never
    // causes the old turn to be replayed.
    if (mapping.dispatch !== null) {
      const recovered = await this.reconcileDispatch(
        client, request, mapping, cwd, inputHash, effort, requestedMessageId,
      )
      if (recovered !== undefined) return recovered
      mapping = this.ctx.sessionProjections.stateOf(request.session, 'codexSubscription') ?? mapping
    } else {
      const reconciliation = mapping.lastReconciliation
      if (reconciliation !== null && matchesReconciliation(
        reconciliation,
        request,
        cwd,
        inputHash,
        effort,
        requestedMessageId,
      )) {
        return this.recoverCompletedReconciliation(client, request, reconciliation, cwd)
      }
    }
    const transcript = request.session.deriveMessages()
    const transcriptIds = new Set(transcript.map(message => String(message.id)))

    let mustBootstrap = mapping.activeThreadId === null
      || mapping.workspaceIdentity !== request.workspaceIdentity
      || mapping.cwd !== cwd
      || mapping.pendingSync !== null
      || (mapping.committedMessageId !== null && !transcriptIds.has(mapping.committedMessageId))

    if (mapping.activeThreadId !== null && !mustBootstrap && !this.resumedThreads.has(mapping.activeThreadId)) {
      try {
        await client.request('thread/resume', { threadId: mapping.activeThreadId }, 20_000)
        const resumed = jsonObject(await client.request('thread/read', { threadId: mapping.activeThreadId }, 20_000), 'resumed thread')
        const resumedThread = jsonObject(resumed.thread, 'resumed thread metadata')
        if (requiredString(resumedThread.cwd, 'resumed thread workspace') !== cwd) {
          throw new Error('Codex thread workspace no longer matches the canonical DSH workspace.')
        }
        this.resumedThreads.add(mapping.activeThreadId)
      } catch {
        mustBootstrap = true
      }
    }
    let threadId = mapping.activeThreadId
    if (mustBootstrap || threadId === null) {
      const retired = threadId === null ? mapping.retiredThreadIds : [...mapping.retiredThreadIds, threadId].slice(-16)
      const response = jsonObject(await client.request('thread/start', {
        cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      }, 20_000), 'thread start')
      const thread = jsonObject(response.thread, 'thread')
      threadId = requiredString(thread.id, 'thread id')
      if (requiredString(thread.cwd, 'thread workspace') !== cwd) {
        throw new Error('Codex App Server created a thread outside the canonical DSH workspace.')
      }
      this.resumedThreads.add(threadId)
      mapping = {
        ...mapping,
        generation: mapping.generation + 1,
        activeThreadId: threadId,
        retiredThreadIds: retired,
        workspaceIdentity: request.workspaceIdentity,
        cwd,
        latestTurnId: null,
        committedMessageId: null,
        pendingSync: null,
        dispatch: null,
      }
      writeMapping(request.session, mapping)
      const bootstrapMessages = collectPublicHistory(transcript, null, new Set(request.messages.map(message => message.id)), true)
      const bootstrap = boundedHistory(bootstrapMessages)
      const toMessageId = bootstrapMessages.at(-1)?.messageId ?? null
      if (bootstrap.items.length > 0) {
        if (toMessageId === null) throw new Error('Codex bootstrap has no terminal public message identity.')
        const hash = historyHash(bootstrap.items)
        mapping = {
          ...mapping,
          pendingSync: { hash, fromMessageId: null, toMessageId },
          bootstrap: {
            fromMessageId: bootstrapMessages[0]?.messageId ?? null,
            toMessageId,
            messageCount: bootstrap.items.length,
            truncated: bootstrap.truncated,
          },
        }
        writeMapping(request.session, mapping)
        await client.request('thread/inject_items', { threadId, items: bootstrap.items }, RPC_TIMEOUT_MS)
      } else {
        mapping = { ...mapping, bootstrap: { fromMessageId: null, toMessageId: null, messageCount: 0, truncated: false } }
      }
      mapping = { ...mapping, committedMessageId: toMessageId, pendingSync: null }
      writeMapping(request.session, mapping)
    }

    const currentIds = new Set(request.messages.map(message => message.id))
    const pending = collectPublicHistory(transcript, mapping.committedMessageId, currentIds, false)
    if (pending.length > 0) {
      const batch = boundedHistory(pending)
      const fromMessageId = mapping.committedMessageId
      const toMessageId = pending.at(-1)?.messageId
      if (toMessageId === undefined) throw new Error('Codex history batch has no terminal public message identity.')
      const pendingSync = { hash: historyHash(batch.items), fromMessageId, toMessageId }
      mapping = { ...mapping, pendingSync }
      writeMapping(request.session, mapping)
      try {
        await client.request('thread/inject_items', { threadId, items: batch.items }, RPC_TIMEOUT_MS)
      } catch (error: unknown) {
        // pendingSync remains durable. It is enough to force a fresh internal
        // thread and canonical bootstrap; injection has no tool side effects.
        throw new Error(`Codex history synchronization is uncertain; the old internal thread will not be retried (${safeError(error)}).`)
      }
      mapping = { ...mapping, committedMessageId: toMessageId, pendingSync: null }
      writeMapping(request.session, mapping)
    } else {
      const currentMessageId = request.messages.at(-1)?.id ?? mapping.committedMessageId
      if (currentMessageId !== mapping.committedMessageId) {
        mapping = { ...mapping, committedMessageId: currentMessageId }
        writeMapping(request.session, mapping)
      }
    }

    const lastMessage = request.messages.at(-1)
    const messageId = lastMessage === undefined ? '' : String(lastMessage.id)
    if (messageId === '') throw new Error('Codex turn is missing its canonical DSH user message identity.')
    const clientUserMessageId = `dsh-${digest(JSON.stringify({ session: String(request.session.id), turn: request.turn, inputHash }))}`
    const dispatch = {
      status: 'intent' as const,
      threadId,
      turnId: null,
      dshTurn: request.turn,
      dshStep: request.step,
      model: request.selection.model,
      effort,
      inputHash,
      workspaceIdentity: request.workspaceIdentity,
      cwd,
      clientUserMessageId,
      messageId,
    }
    // Persist the intent before crossing the side-effecting turn/start boundary.
    writeMapping(request.session, { ...mapping, dispatch })
    const active: ActiveCodexTurn = { request, threadId, finalText: '' }
    this.activeTurns.set(threadId, active)
    let terminal: Record<string, unknown>
    let turnId: string
    try {
      const started = jsonObject(await client.request('turn/start', {
        threadId,
        clientUserMessageId,
        input: textInput.map(text => ({ type: 'text', text, text_elements: [] })),
        model: runtimeModel,
        effort,
      }, 30_000), 'turn start')
      const turn = jsonObject(started.turn, 'started turn')
      turnId = requiredString(turn.id, 'turn id')
      if (active.turnId !== undefined && active.turnId !== turnId) {
        throw new Error('Codex App Server acknowledged a different turn than its start notification.')
      }
      active.turnId = turnId
      mapping = { ...mapping, latestTurnId: turnId }
      writeMapping(request.session, { ...mapping, dispatch: { ...dispatch, status: 'accepted', turnId } })
      terminal = await this.waitForTurn(client, threadId, turnId, request)
    } catch (error: unknown) {
      const observedTurnId = active.turnId ?? null
      writeMapping(request.session, {
        ...mapping,
        ...(observedTurnId === null ? {} : { latestTurnId: observedTurnId }),
        dispatch: { ...dispatch, status: 'uncertain', turnId: observedTurnId },
      })
      throw error
    } finally {
      this.activeTurns.delete(threadId)
    }
    const status = terminal.status
    if (status !== 'completed') {
      writeMapping(request.session, { ...mapping, latestTurnId: turnId, dispatch: null })
      if (status === 'interrupted' && request.signal.aborted) throw request.signal.reason ?? new Error('Codex turn interrupted')
      throw new Error(`Codex turn ended with status "${String(status)}".`)
    }
    const text = typeof terminal.__dshText === 'string' ? terminal.__dshText : ''
    if (text.trim() === '') throw new Error('Codex completed without a public final answer.')
    writeMapping(request.session, {
      ...mapping,
      latestTurnId: turnId,
      committedMessageId: request.messages.at(-1)?.id ?? mapping.committedMessageId,
      dispatch: null,
    })
    request.publish.textDelta(text)
    return { text, reason: 'completed' }
  }

  private readonly resumedThreads = new Set<string>()

  /** Reconcile a persisted dispatch against authoritative App Server history. */
  private async reconcileDispatch(
    client: CodexAppServerConnection,
    request: ExternalTurnRequest,
    mapping: CodexSessionMappingState,
    cwd: string,
    inputHash: string,
    effort: string,
    messageId: string,
  ): Promise<ExternalTurnResult | undefined> {
    const dispatch = mapping.dispatch
    if (dispatch === null) return undefined
    const clientUserMessageId = dispatch.clientUserMessageId
    const sameRequest = matchesDispatch(dispatch, request, cwd, inputHash, effort, messageId)
    if (clientUserMessageId === undefined || clientUserMessageId === '') {
      throw new Error('A previous Codex turn has no verifiable App Server correlation ID; it was not resent.')
    }

    try {
      await this.resumeAndVerifyThread(client, dispatch.threadId, cwd)
    } catch (error: unknown) {
      if (!isMissingThreadError(error)) throw error
      await this.commitReconciliation(request, mapping, dispatch, 'unknown', null, { count: 0, kinds: [] }, true)
      if (sameRequest) throw new Error('The previous Codex turn is missing and was not replayed; start a new DSH turn to continue.')
      return undefined
    }

    let turn = await this.findDispatchedTurn(client, dispatch.threadId, dispatch.turnId, clientUserMessageId)
    if (turn === undefined) {
      await this.commitReconciliation(request, mapping, dispatch, 'unknown', null, { count: 0, kinds: [] }, true)
      if (sameRequest) throw new Error('Codex could not confirm the previous turn; it was retired and not replayed.')
      return undefined
    }
    const turnId = requiredString(turn.id, 'reconciled turn id')
    if (dispatch.turnId !== null && dispatch.turnId !== turnId) {
      throw new Error('Codex reconciliation found a different turn than the persisted dispatch; no new turn was sent.')
    }

    const status = turn.status
    if (status === 'inProgress') {
      const active: ActiveCodexTurn = {
        request, threadId: dispatch.threadId, turnId,
        finalText: finalAssistantTextFromTurn(turn) ?? '',
      }
      this.activeTurns.set(dispatch.threadId, active)
      try {
        const terminal = await this.waitForTurn(
          client,
          dispatch.threadId,
          turnId,
          request,
          async () => {
            const current = await this.findDispatchedTurn(client, dispatch.threadId, turnId, clientUserMessageId)
            if (current === undefined) throw new Error('The previously accepted Codex turn disappeared during reconciliation.')
            if (current.status === 'inProgress') return undefined
            turn = current
            return terminalFromTurn(current)
          },
        )
        turn = terminal
      } finally {
        this.activeTurns.delete(dispatch.threadId)
      }
    }
    const terminalStatus = externalTurnTerminalStatus(turn.status)
    if (terminalStatus === undefined) {
      throw new Error(`The previous Codex turn is still non-terminal (${String(turn.status)}); no second turn was sent.`)
    }
    const sideEffects = sideEffectSummary(turn)
    await this.commitReconciliation(
      request, mapping, dispatch, terminalStatus, turnId, sideEffects, false,
    )

    if (!sameRequest) return undefined
    if (terminalStatus !== 'completed') {
      throw new Error(`The previous Codex turn is confirmed as ${terminalStatus}; it was not replayed.`)
    }
    if (hasAssistantSettlement(
      this.ctx.sessionProjections.stateOf(request.session, 'codexSubscription'),
      dispatch.dshTurn,
      dispatch.dshStep,
    )) {
      throw new Error('The previous Codex result is already committed in this DSH Session; it was not replayed.')
    }
    const text = finalAssistantTextFromTurn(turn) ?? ''
    if (text.trim() === '') {
      throw new Error('The previous Codex turn completed without a recoverable public answer; it was not replayed.')
    }
    request.publish.textDelta(text)
    this.markReconciliationDelivered(request.session, reconciliationKey(
      this.ctx.sessionProjections.stateOf(request.session, 'codexSubscription')?.lastReconciliation ?? null,
    ))
    return { text, reason: 'completed' }
  }

  private async commitReconciliation(
    request: ExternalTurnRequest,
    mapping: CodexSessionMappingState,
    dispatch: NonNullable<CodexSessionMappingState['dispatch']>,
    status: NonNullable<CodexSessionMappingState['lastReconciliation']>['status'],
    turnId: string | null,
    sideEffects: { readonly count: number; readonly kinds: readonly ('commandExecution' | 'fileChange' | 'other')[] },
    retireThread: boolean,
  ): Promise<void> {
    const lastReconciliation: NonNullable<CodexSessionMappingState['lastReconciliation']> = {
      status,
      threadId: dispatch.threadId,
      turnId,
      clientUserMessageId: dispatch.clientUserMessageId ?? '',
      dshTurn: dispatch.dshTurn,
      ...(dispatch.dshStep === undefined ? {} : { dshStep: dispatch.dshStep }),
      messageId: dispatch.messageId ?? '',
      inputHash: dispatch.inputHash,
      model: dispatch.model,
      effort: dispatch.effort,
      workspaceIdentity: dispatch.workspaceIdentity,
      cwd: dispatch.cwd,
      sideEffectCount: sideEffects.count,
      sideEffectKinds: sideEffects.kinds,
    }
    const retiredThreadIds = retireThread
      ? [...mapping.retiredThreadIds, dispatch.threadId].slice(-16)
      : mapping.retiredThreadIds
    const next: CodexSessionMappingState = {
      ...mapping,
      activeThreadId: retireThread ? null : mapping.activeThreadId,
      retiredThreadIds,
      latestTurnId: retireThread ? null : turnId,
      committedMessageId: retireThread ? null : dispatch.messageId ?? mapping.committedMessageId,
      pendingSync: retireThread ? null : mapping.pendingSync,
      dispatch: null,
      lastReconciliation,
    }
    writeMapping(request.session, next)
    try {
      // One Session flush commits the reconciliation record and barrier release
      // together; if it fails, this runtime remains fail-closed.
      await this.ctx.sessions.flush(request.session)
    } catch (error: unknown) {
      this.failedReconciliationCommits.add(request.session)
      throw error
    }
  }

  private async recoverCompletedReconciliation(
    client: CodexAppServerConnection,
    request: ExternalTurnRequest,
    reconciliation: NonNullable<CodexSessionMappingState['lastReconciliation']>,
    cwd: string,
  ): Promise<ExternalTurnResult> {
    if (reconciliation.status !== 'completed') {
      throw new Error(`The previous Codex turn was reconciled as ${reconciliation.status}; it was not replayed.`)
    }
    const key = reconciliationKey(reconciliation)
    if (this.wasReconciliationDelivered(request.session, key)
      || hasAssistantSettlement(
        this.ctx.sessionProjections.stateOf(request.session, 'codexSubscription'),
        reconciliation.dshTurn,
        reconciliation.dshStep,
      )) {
      throw new Error('The previous Codex result was already delivered or committed; it was not replayed.')
    }
    await this.resumeAndVerifyThread(client, reconciliation.threadId, cwd)
    const turn = await this.findDispatchedTurn(
      client,
      reconciliation.threadId,
      reconciliation.turnId,
      reconciliation.clientUserMessageId,
    )
    if (turn?.status !== 'completed') {
      throw new Error('The completed Codex result is no longer available for safe recovery; no turn was replayed.')
    }
    const text = finalAssistantTextFromTurn(turn) ?? ''
    if (text.trim() === '') throw new Error('The completed Codex turn has no public answer to recover.')
    request.publish.textDelta(text)
    this.markReconciliationDelivered(request.session, key)
    return { text, reason: 'completed' }
  }

  private wasReconciliationDelivered(session: Session, key: string): boolean {
    return this.deliveredReconciliations.get(session)?.has(key) ?? false
  }

  private markReconciliationDelivered(session: Session, key: string): void {
    if (key === '') return
    let delivered = this.deliveredReconciliations.get(session)
    if (delivered === undefined) {
      delivered = new Set()
      this.deliveredReconciliations.set(session, delivered)
    }
    delivered.add(key)
  }

  private async resumeAndVerifyThread(
    client: CodexAppServerConnection,
    threadId: string,
    cwd: string,
  ): Promise<void> {
    await client.request('thread/resume', { threadId }, 20_000)
    const response = jsonObject(await client.request('thread/read', { threadId }, 20_000), 'reconciled thread')
    const thread = jsonObject(response.thread, 'reconciled thread metadata')
    if (requiredString(thread.cwd, 'reconciled thread workspace') !== cwd) {
      throw new Error('Codex thread workspace no longer matches the canonical DSH workspace.')
    }
    this.resumedThreads.add(threadId)
  }

  private async findDispatchedTurn(
    client: CodexAppServerConnection,
    threadId: string,
    expectedTurnId: string | null,
    clientUserMessageId: string,
  ): Promise<JsonObject | undefined> {
    const response = jsonObject(await client.request('thread/turns/list', {
      threadId,
      limit: 100,
      sortDirection: 'desc',
      itemsView: 'full',
    }, 20_000), 'thread turn history')
    if (!Array.isArray(response.data)) throw new Error('Codex did not return thread turn history for reconciliation.')
    const matches = response.data.flatMap((raw) => {
      const turn = jsonObject(raw, 'thread turn')
      const idMatch = expectedTurnId !== null && turn.id === expectedTurnId
      const messageMatch = Array.isArray(turn.items) && turn.items.some((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
        const candidate = item as Record<string, unknown>
        return candidate.type === 'userMessage' && candidate.clientId === clientUserMessageId
      })
      return idMatch || messageMatch ? [turn] : []
    })
    if (matches.length > 1) throw new Error('Codex history contains multiple turns for one DSH dispatch identity.')
    return matches[0]
  }

  private async waitForTurn(
    client: CodexAppServerConnection,
    threadId: string,
    turnId: string,
    request: ExternalTurnRequest,
    reconcile?: () => Promise<Record<string, unknown> | undefined>,
  ): Promise<Record<string, unknown>> {
    const done = Promise.withResolvers<Record<string, unknown>>()
    const previous = this.turnWaiters.get(threadId)
    if (previous !== undefined) throw new Error('Codex thread already has an active turn waiter.')
    this.turnWaiters.set(threadId, { turnId, resolve: done.resolve, reject: done.reject, request, completion: done.promise })
    const active = this.activeTurns.get(threadId)
    if (active?.turnId === turnId && active.terminal !== undefined) done.resolve(active.terminal)
    const onAbort = (): void => {
      void client.request('turn/interrupt', { threadId, turnId }, 8_000).catch(() => {})
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    if (reconcile !== undefined) {
      try {
        const terminal = await reconcile()
        if (terminal !== undefined) done.resolve(terminal)
      } catch (error: unknown) {
        done.reject(error instanceof Error ? error : new Error('Codex turn reconciliation failed.'))
      }
    }
    const timer = setTimeout(() => {
      void client.request('turn/interrupt', { threadId, turnId }, 8_000).catch(() => {})
      done.reject(new Error('Codex turn did not reach a terminal event before the deadline.'))
    }, 20 * 60_000)
    try {
      return await done.promise
    } catch (error: unknown) {
      throw error
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      this.turnWaiters.delete(threadId)
    }
  }

  private turnWaiters = new Map<string, {
    readonly turnId: string
    readonly resolve: (turn: Record<string, unknown>) => void
    readonly reject: (error: Error) => void
    readonly request: ExternalTurnRequest
    readonly completion: Promise<Record<string, unknown>>
  }>()

  private async onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const threadId = requiredString(params.threadId, 'approval thread id')
      const turnId = requiredString(params.turnId, 'approval turn id')
      const active = this.activeTurns.get(threadId)
      if (active === undefined || active.turnId !== turnId) throw new Error('Codex approval did not match an active DSH turn.')
      const requestId = typeof params.itemId === 'string' ? params.itemId : 'unknown-item'
      const kind = method.includes('commandExecution') ? 'command' : 'file change'
      const description = safeApprovalDescription(params)
      this.publishApproval(active, requestId, kind, 'requested', method)
      const choices = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
      const approval = this.ctx.get('approval')
      if (approval === undefined) {
        this.publishApproval(active, requestId, kind, 'rejected', method)
        return { decision: choices.includes('decline') ? 'decline' : 'cancel' }
      }
      const outcome = await approval.request({
        agent: active.request.agent,
        toolName: `codex.${kind.replace(' ', '-')}`,
        reason: `Codex request ${requestId}: ${description}`,
        signal: active.request.signal,
      })
      const allow = outcome === 'allowed-once' && choices.includes('accept')
      const decision = allow ? 'accept' : choices.includes('decline') ? 'decline' : 'cancel'
      this.publishApproval(active, requestId, kind, allow ? 'allowed' : 'rejected', 'approval/resolved')
      return { decision }
    }
    if (method === 'item/permissions/requestApproval') {
      const threadId = requiredString(params.threadId, 'permission thread id')
      const turnId = requiredString(params.turnId, 'permission turn id')
      const active = this.activeTurns.get(threadId)
      if (active === undefined || active.turnId !== turnId) throw new Error('Codex permission request did not match an active DSH turn.')
      this.publishApproval(active, 'permission-grant', 'permission', 'rejected', method)
      return { permissions: {}, scope: 'turn' }
    }
    // Unknown server requests are not acknowledged or silently granted.
    throw new Error('Unsupported Codex App Server request; operation was rejected.')
  }

  private publishApproval(
    active: ActiveCodexTurn,
    requestId: string,
    kind: string,
    status: 'requested' | 'allowed' | 'rejected',
    eventKind: string,
  ): void {
    const identity = this.activityIdentity(
      active,
      requestId,
      `approval:${requestId}`,
      eventKind,
      status,
      requestId,
    )
    if (identity === undefined) return
    active.request.publish.event({
      kind: 'approval', id: requestId, title: `Codex ${kind}`, status, identity,
    })
  }

}

/** Cordis plugin entry; registration is lazy and process cleanup is scope-owned. */
export const name = 'agent-codex'

export function apply(ctx: Context): void {
  const runtime = new CodexSubscriptionRuntime(ctx)
  ctx.inject(['settings'], (settingsCtx) => {
    runtime.attachSettings(settingsCtx.settings.register(
      CODEX_RUNTIME_SETTINGS_NAMESPACE,
      CodexRuntimeSettingsSchema,
      { base: { preference: 'auto' } },
    ))
  })
  ctx.provide('externalModelProviders', runtime)
  ctx.sessionProjections.register(codexSubscriptionProjection)
  ctx.on('agent/resolve-external-turn', async ({ selection, signal }, next) => {
    if (selection.provider !== PROVIDER_ID) return next()
    return runtime.executorFor(selection, signal)
  })
  ctx.effect(() => async () => { await runtime.dispose() }, 'agent-codex: owned App Server lifecycle')
}

/** Verify system App Server method availability without creating a thread or starting a turn. */
async function verifySystemRuntimeCapabilities(client: CodexAppServerConnection): Promise<void> {
  const accountResponse = jsonObject(await client.request('account/read', { refreshToken: false }, 15_000), 'account capability probe')
  const account = accountResponse.account
  if (typeof account === 'object' && account !== null && !Array.isArray(account)
    && (account as Record<string, unknown>).type === 'chatgpt') {
    const catalog = jsonObject(await client.request('model/list', { limit: 1 }, 15_000), 'model catalog capability probe')
    if (!Array.isArray(catalog.data)) throw new Error('System Codex did not return a model catalog.')
  }
  for (const probe of REQUIRED_SYSTEM_METHOD_PROBES) {
    try {
      await client.request(probe.method, probe.params, 5_000)
      if (!probe.allowSuccess) throw new Error(`System Codex accepted an unsafe or incomplete ${probe.method} capability probe.`)
    } catch (error: unknown) {
      if (!(error instanceof JsonRpcResponseError) || error.code === -32601) {
        throw new Error(`System Codex did not confirm required capability ${probe.method}.`)
      }
      if (probe.method === 'thread/start' && error.code !== -32602 && error.code !== -32600) {
        throw new Error('System Codex did not safely reject the non-mutating thread/start capability probe.')
      }
    }
  }
}

async function secureHome(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function canonicalWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Codex requires a canonical absolute local workspace.')
  const canonical = await realpath(path)
  if (canonical !== path) return canonical
  return path
}

function writeMapping(session: Session, state: CodexSessionMappingState): void {
  session.appendIgnorable('codex/subscription-state', { state })
}

interface PublicHistoryItem {
  readonly messageId: string
  readonly type: 'userMessage' | 'assistantMessage'
  readonly text: string
}

function collectPublicHistory(
  messages: readonly Message[],
  afterMessageId: string | null,
  currentMessageIds: ReadonlySet<string>,
  includeCodex: boolean,
): PublicHistoryItem[] {
  const result: PublicHistoryItem[] = []
  let start = 0
  if (afterMessageId !== null) {
    const cursor = messages.findIndex(message => String(message.id) === afterMessageId)
    if (cursor < 0) throw new Error('Codex transcript cursor is no longer present in the DSH Session.')
    start = cursor + 1
  }
  for (const message of messages.slice(start)) {
    const messageId = String(message.id)
    if (currentMessageIds.has(messageId)) continue
    if (message.role === 'user' && message.source.kind === 'user') {
      const text = textFromUserMessage(message).join('\n').trim()
      if (text !== '') result.push({ messageId, type: 'userMessage', text })
    } else if (message.role === 'assistant' && message.source.kind === 'model') {
      if (!includeCodex && message.source.provider === PROVIDER_ID) continue
      const text = textFromAssistantMessage(message).trim()
      if (text !== '') result.push({ messageId, type: 'assistantMessage', text })
    }
  }
  return result
}

function boundedHistory(history: readonly PublicHistoryItem[]): { items: JsonObject[]; truncated: boolean } {
  const chosen = [...history]
  let truncated = false
  while (chosen.length > MAX_HISTORY_ITEMS || chosen.reduce((sum, item) => sum + item.text.length, 0) > MAX_HISTORY_CHARS) {
    chosen.shift()
    truncated = true
  }
  const items = chosen.map(item => item.type === 'userMessage'
    ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: item.text }] }
    : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] })
  if (truncated) {
    items.unshift({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Earlier visible DSH history was omitted from this internal Codex thread; only the recent public transcript was synchronized.]' }] })
  }
  return { items, truncated }
}

function textFromUserMessage(message: Message): string[] {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
}

function textFromAssistantMessage(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function historyHash(items: readonly JsonObject[]): string {
  return digest(JSON.stringify(items))
}

function matchesDispatch(
  dispatch: NonNullable<CodexSessionMappingState['dispatch']>,
  request: ExternalTurnRequest,
  cwd: string,
  inputHash: string,
  effort: string,
  messageId: string,
): boolean {
  return dispatch.dshTurn === request.turn
    && (dispatch.dshStep === undefined || dispatch.dshStep === request.step)
    && dispatch.messageId === messageId
    && dispatch.inputHash === inputHash
    && dispatch.model === request.selection.model
    && dispatch.effort === effort
    && dispatch.workspaceIdentity === request.workspaceIdentity
    && dispatch.cwd === cwd
}

function matchesReconciliation(
  reconciliation: CodexSessionMappingState['lastReconciliation'],
  request: ExternalTurnRequest,
  cwd: string,
  inputHash: string,
  effort: string,
  messageId: string,
): boolean {
  return reconciliation !== null
    && reconciliation.dshTurn === request.turn
    && (reconciliation.dshStep === undefined || reconciliation.dshStep === request.step)
    && reconciliation.messageId === messageId
    && reconciliation.inputHash === inputHash
    && reconciliation.model === request.selection.model
    && reconciliation.effort === effort
    && reconciliation.workspaceIdentity === request.workspaceIdentity
    && reconciliation.cwd === cwd
}

function reconciliationKey(
  reconciliation: CodexSessionMappingState['lastReconciliation'],
): string {
  if (reconciliation === null) return ''
  return `${reconciliation.threadId}:${reconciliation.turnId ?? 'unknown'}:${reconciliation.clientUserMessageId}`
}

function hasAssistantSettlement(
  mapping: CodexSessionMappingState | undefined,
  turn: number,
  step: number | undefined,
): boolean {
  const settlement = mapping?.lastAssistantSettlement
  return settlement?.turn === turn && (step === undefined || settlement.step === step)
}

function sideEffectSummary(turn: Record<string, unknown>): {
  readonly count: number
  readonly kinds: readonly ('commandExecution' | 'fileChange' | 'other')[]
} {
  const items = Array.isArray(turn.items) ? turn.items : []
  let count = 0
  const kinds = new Set<'commandExecution' | 'fileChange' | 'other'>()
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const type = (item as Record<string, unknown>).type
    if (type === 'commandExecution') {
      count += 1
      kinds.add('commandExecution')
    } else if (type === 'fileChange') {
      const changes = (item as Record<string, unknown>).changes
      count += Array.isArray(changes) && changes.length > 0 ? changes.length : 1
      kinds.add('fileChange')
    } else if (typeof type === 'string'
      && (/tool.?call/iu.test(type) || ['browser', 'imageGeneration'].includes(type))) {
      count += 1
      kinds.add('other')
    }
  }
  return { count, kinds: [...kinds] }
}

function isMissingThreadError(error: unknown): boolean {
  if (error instanceof JsonRpcResponseError && error.code === -32004) return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /(?:thread|conversation).*(?:not found|does not exist|unknown)/iu.test(message)
}

function safeCommandSummary(command: string): string {
  return redactSensitiveText(command).replace(/\s+/gu, ' ').trim().slice(0, 500)
}

function safeWorkspaceRelativePath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const root = resolve(cwd)
  const target = resolve(root, value)
  const path = relative(root, target)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined
  return path.split(sep).join('/').slice(0, 500)
}

function commandTerminalStatus(item: Record<string, unknown>): 'completed' | 'failed' | 'interrupted' {
  if (item.status === 'interrupted') return 'interrupted'
  if (item.status === 'failed' || typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed'
  return 'completed'
}

function fileChangeStatus(value: unknown): 'created' | 'modified' | 'deleted' {
  if (value === 'add' || value === 'create' || value === 'created') return 'created'
  if (value === 'delete' || value === 'deleted' || value === 'remove') return 'deleted'
  return 'modified'
}

function externalTurnTerminalStatus(value: unknown): 'completed' | 'interrupted' | 'failed' | undefined {
  return value === 'completed' || value === 'interrupted' || value === 'failed' ? value : undefined
}

function notificationMatchesTurn(params: Record<string, unknown>, active: ActiveCodexTurn): boolean {
  if (typeof params.turnId === 'string') return params.turnId === active.turnId
  if (params.turn === null || typeof params.turn !== 'object' || Array.isArray(params.turn)) return false
  return (params.turn as Record<string, unknown>).id === active.turnId
}

function finalAssistantText(item: Record<string, unknown> | undefined): string | undefined {
  if (item?.type !== 'agentMessage' || item.phase !== 'final_answer') return undefined
  if (typeof item.text === 'string') return item.text
  if (!Array.isArray(item.content)) return undefined
  return item.content.flatMap((block) => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return []
    const entry = block as Record<string, unknown>
    return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
  }).join('')
}

function finalAssistantTextFromTurn(turn: Record<string, unknown>): string | undefined {
  if (!Array.isArray(turn.items)) return undefined
  return turn.items.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const text = finalAssistantText(item as Record<string, unknown>)
    return text === undefined ? [] : [text]
  }).join('')
}

function terminalFromTurn(turn: Record<string, unknown>): Record<string, unknown> | undefined {
  return turn.status === 'inProgress' ? undefined : { ...turn, __dshText: finalAssistantTextFromTurn(turn) ?? '' }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function safeApprovalDescription(params: Record<string, unknown>): string {
  const raw = typeof params.command === 'string'
    ? params.command
    : typeof params.reason === 'string'
      ? params.reason
      : typeof params.title === 'string' ? params.title : 'Codex requested permission to continue.'
  return redactSensitiveText(raw, false).slice(0, 800)
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Codex runtime operation failed.'
  return redactSensitiveText(text).slice(0, 500)
}

function redactSensitiveText(text: string, redactPaths = true): string {
  const redacted = text.replace(/https?:\/\/[^\s)]+/gi, '[authentication URL redacted]')
    .replace(/\b(authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, '$1: [redacted]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]*/gi, '$1: [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|token|code_verifier|oauth[_-]?code)\s*[:=]\s*["']?[^"'\s,;]+["']?/gi, '$1=[redacted]')
    .replace(/(?:Bearer\s+)\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[redacted]')
  return redactPaths ? redacted.replace(/(?:[A-Z]:\\|~\/|\/)[^\s"']+/gi, '[local path redacted]') : redacted
}

/** Keep only bounded, renderer-safe quota facts from the official protocol. */
function usageWindow(value: unknown): CodexUsageWindow | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const usedPercent = record.usedPercent
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    return undefined
  }
  const windowDurationMins = record.windowDurationMins
  const resetsAt = record.resetsAt
  return {
    usedPercent,
    ...(typeof windowDurationMins === 'number' && Number.isSafeInteger(windowDurationMins) && windowDurationMins > 0
      ? { windowDurationMins }
      : {}),
    ...(typeof resetsAt === 'number' && Number.isSafeInteger(resetsAt) && resetsAt >= 0 ? { resetsAt } : {}),
  }
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() =>{  reject(new Error(reason)) }, milliseconds) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
