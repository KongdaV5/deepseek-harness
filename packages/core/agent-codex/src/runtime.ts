/** Official Codex App Server lifecycle, subscription state, and external-turn execution. */

import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
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
import { secureCodexHome, verifyCodexHome } from './home.ts'
import { CodexCompatibilityMaintenance, CodexIncompatibleError, codexThreadInterop, compatibilityDigest } from './compatibility.ts'
import type { CodexCompatibilityReport } from './compatibility.ts'
import {
  bundledCodexRuntime, CodexAppServerClient, inspectCodexRuntime, jsonObject, requiredString, resolveSystemCodexRuntime,
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
const UNAVAILABLE_USAGE: CodexUsageStatus = { state: 'unavailable' }
type JsonObject = Record<string, unknown>

interface CodexRuntimeSettings {
  preference: CodexRuntimePreference
  /** Non-secret account lifecycle generation shared by runtime instances and persisted across restarts. */
  authGeneration?: string
  /** Non-secret marker that keeps an interrupted authentication transaction fail-closed. */
  authTransition?: AuthTransitionRecord | null
}

interface AuthTransitionRecord {
  readonly id: string
  readonly kind: 'login' | 'logout' | 'invalidated'
}

const CodexRuntimeSettingsSchema: z<CodexRuntimeSettings> = z.object({
  preference: z.union(['auto', 'system', 'bundled']).default('auto'),
  authGeneration: z.string().min(1).required(false),
  authTransition: z.union([
    z.object({ id: z.string().min(1), kind: z.union(['login', 'logout', 'invalidated']) }),
    z.const(null),
  ]).required(false),
})

interface ActiveCodexTurn {
  readonly request: ExternalTurnRequest
  readonly threadId: string
  readonly lease: AuthBoundOperationLease
  turnId?: string
  finalText: string
  terminal?: JsonObject
}

interface AuthBoundOperationLease {
  readonly authGeneration: string
  readonly authStateEpoch: number
  readonly settings: SettingsScope<CodexRuntimeSettings>
  readonly settingsOwner: object
  client?: CodexAppServerConnection
  clientOwner?: object
  readonly release: () => void
}

type LoginAttemptPhase = 'starting' | 'pending' | 'completing' | 'cancelling' | 'committed' | 'cancelled' | 'failed'

interface PendingLoginAttempt {
  readonly token: string
  readonly settings: SettingsScope<CodexRuntimeSettings>
  readonly settingsOwner: object
  readonly client: CodexAppServerConnection
  readonly clientOwner: object
  readonly epoch: number
  phase: LoginAttemptPhase
  loginId?: string
  completion?: Promise<void>
  committedGeneration?: string
}

interface AuthStateSnapshot {
  readonly epoch: number
  readonly settings: SettingsScope<CodexRuntimeSettings> | undefined
  readonly settingsOwner: object
  readonly client: CodexAppServerConnection | undefined
  readonly clientOwner: object | undefined
  readonly attempt?: PendingLoginAttempt
  readonly phase?: LoginAttemptPhase
}

class StaleAuthStateResultError extends Error {
  constructor() {
    super('Codex authentication context changed while the operation was in progress.')
    this.name = 'StaleAuthStateResultError'
  }
}

const CODEX_HOME_ALLOWED_ROOT_ENV = 'DSH_DESKTOP_CODEX_HOME_ALLOWED_ROOT'

interface CodexModelEntry extends ExternalModelCatalogEntry {
  /** App Server's model field, distinct from the catalog ID used by DSH. */
  readonly runtimeModel: string
}

/** Host lifecycle hooks replaceable by deterministic tests. */
export interface CodexRuntimeInternals {
  readonly inspectRuntime?: typeof inspectCodexRuntime
  readonly verifyCompatibility?: (
    runtime: CodexRuntimeDescriptor, client: CodexAppServerConnection, root: string, initialized: JsonObject, protocolOnly: boolean,
  ) => Promise<CodexCompatibilityReport>
  readonly spawn?: (spec: SubprocessSpawnSpec) => ReturnType<Context['subprocess']['spawn']>
  readonly openLoginUrl?: (url: string) => Promise<void>
  readonly ensureHome?: (path: string, allowedRoot: string) => Promise<void>
  readonly resolveHomePath?: (...segments: string[]) => string
  readonly resolveAllowedHomeRoot?: () => string
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
  private clientOwner: object | undefined
  private startupPromise: Promise<CodexAppServerConnection> | undefined
  private activeRuntime: CodexRuntimeDescriptor | undefined
  private runtimeSettings: SettingsScope<CodexRuntimeSettings> | undefined
  private settingsOwner: object = {}
  private authStateEpoch = 0
  private pendingAuthTransition: AuthTransitionRecord | undefined
  private authSettingsWriteTail: Promise<void> = Promise.resolve()
  private runtimeInventory: SystemCodexRuntimeResolution | undefined
  private compatibility: CodexCompatibilityReport | undefined
  private readonly inspectRuntime: typeof inspectCodexRuntime
  private initializedResponse: JsonObject | undefined
  private catalogDigest: string | undefined
  private readonly verifyCompatibility: NonNullable<CodexRuntimeInternals['verifyCompatibility']>
  private runtimeSelectionNote: string | undefined
  private runtimeState: CodexRuntimeState = 'stopped'
  private accountState: CodexAccountState = 'not-connected'
  private statusError: string | undefined
  private modelCount = 0
  private usage: CodexUsageStatus = UNAVAILABLE_USAGE
  private rateLimitReadAt = 0
  private loginAttempt: PendingLoginAttempt | undefined
  private disposed = false
  private authGeneration: string | undefined
  private authGenerationInitialization: Promise<void> | undefined
  private authGenerationInitializationError: Error | undefined
  private authLifecycleBlocked = false
  private activeAuthOperations = 0
  private exclusiveRemoteTransition = false
  private exclusiveTransitionReleased: Promise<void> = Promise.resolve()
  private resolveExclusiveTransitionRelease: (() => void) | undefined
  private activeTurns = new Map<string, ActiveCodexTurn>()
  private readonly failedReconciliationCommits = new WeakSet<Session>()
  private readonly deliveredReconciliations = new WeakMap<Session, Set<string>>()
  private readonly spawn: (spec: SubprocessSpawnSpec) => ReturnType<Context['subprocess']['spawn']>
  private readonly openLoginUrl: (url: string) => Promise<void>
  private readonly ensureHome: (path: string, allowedRoot: string) => Promise<void>
  private readonly resolveHomePath: (...segments: string[]) => string
  private readonly resolveAllowedHomeRoot: () => string
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
    this.ensureHome = internals.ensureHome ?? secureCodexHome
    this.inspectRuntime = internals.inspectRuntime ?? inspectCodexRuntime
    this.verifyCompatibility = internals.verifyCompatibility ?? ((runtime, client, root, initialized, protocolOnly) =>
      new CodexCompatibilityMaintenance(root).light(runtime, client, initialized, protocolOnly))
    this.resolveHomePath = internals.resolveHomePath ?? dshHomePath
    this.resolveAllowedHomeRoot = internals.resolveAllowedHomeRoot ?? (() => {
      const root = process.env[CODEX_HOME_ALLOWED_ROOT_ENV]
      if (root === undefined || !isAbsolute(root)) {
        throw new Error('Codex runtime requires an absolute trusted DS Harness data root.')
      }
      return root
    })
    this.resolveSystemRuntime = internals.resolveSystemRuntime ?? resolveSystemCodexRuntime
    this.startClient = internals.startClient
      ?? ((runtime, home, cwd, callbacks) => CodexAppServerClient.start(this.spawn, home, cwd, callbacks, runtime))
  }

  /** Attach the persistent runtime and authentication lifecycle settings.
   * @param scope - the DSH settings scope that owns runtime preference and authentication state.
   */
  attachSettings(scope: SettingsScope<CodexRuntimeSettings>): void {
    if (this.runtimeSettings === scope && this.authGenerationInitialization !== undefined) return
    this.authStateEpoch++
    const owner = {}
    this.runtimeSettings = scope
    this.settingsOwner = owner
    const persisted = scope.get().authGeneration
    const transition = scope.get().authTransition ?? undefined
    this.pendingAuthTransition = transition
    this.authLifecycleBlocked = transition !== undefined
    this.loginAttempt = undefined
    this.accountState = transition === undefined ? 'not-connected' : 'reauth-required'
    this.modelCount = 0
    this.usage = UNAVAILABLE_USAGE
    this.rateLimitReadAt = 0
    if (persisted !== undefined) {
      this.authGeneration = persisted
      this.authGenerationInitialization = Promise.resolve()
      this.authGenerationInitializationError = undefined
      return
    }
    const initial = randomUUID()
    this.authGeneration = undefined
    this.authGenerationInitializationError = undefined
    this.authGenerationInitialization = this.updateAuthSettings(scope, owner, { authGeneration: initial }).then(() => {
      if (this.runtimeSettings !== scope || this.settingsOwner !== owner) {
        throw new StaleAuthStateResultError()
      }
      if (scope.get().authGeneration !== initial) {
        throw new Error('Codex authentication lifecycle could not be persisted.')
      }
      this.authGeneration = initial
    }).catch((error: unknown) => {
      if (this.runtimeSettings === scope && this.settingsOwner === owner) {
        this.authGeneration = undefined
        this.authLifecycleBlocked = true
        this.authGenerationInitializationError = error instanceof Error
          ? error
          : new Error('Codex authentication lifecycle could not be persisted.')
      }
    })
  }

  private updateAuthSettings(
    scope: SettingsScope<CodexRuntimeSettings>,
    owner: object,
    patch: Partial<CodexRuntimeSettings>,
  ): Promise<void> {
    const update = this.authSettingsWriteTail.catch(() => {}).then(async () => {
      if (this.runtimeSettings !== scope || this.settingsOwner !== owner) throw new StaleAuthStateResultError()
      await scope.update(patch)
    })
    this.authSettingsWriteTail = update.catch(() => {})
    return update
  }

  private snapshotAuthState(
    attempt?: PendingLoginAttempt,
    phase?: LoginAttemptPhase,
  ): AuthStateSnapshot {
    return {
      epoch: this.authStateEpoch,
      settings: this.runtimeSettings,
      settingsOwner: this.settingsOwner,
      client: this.client,
      clientOwner: this.clientOwner,
      ...(attempt === undefined ? {} : { attempt }),
      ...(phase === undefined ? {} : { phase }),
    }
  }

  private isCurrentAuthSnapshot(snapshot: AuthStateSnapshot): boolean {
    return !this.disposed
      && this.authStateEpoch === snapshot.epoch
      && this.runtimeSettings === snapshot.settings
      && this.settingsOwner === snapshot.settingsOwner
      && this.client === snapshot.client
      && this.clientOwner === snapshot.clientOwner
      && (snapshot.attempt === undefined || (
        this.loginAttempt === snapshot.attempt
        && (snapshot.phase === undefined || snapshot.attempt.phase === snapshot.phase)
      ))
  }

  private assertCurrentAuthSnapshot(snapshot: AuthStateSnapshot): void {
    if (!this.isCurrentAuthSnapshot(snapshot)) throw new StaleAuthStateResultError()
  }

  private async requestForAuthSnapshot(
    snapshot: AuthStateSnapshot,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.assertCurrentAuthSnapshot(snapshot)
    const client = snapshot.client
    if (client === undefined) throw new Error('Codex App Server is not connected.')
    try {
      const result = await client.request(method, params, timeoutMs)
      this.assertCurrentAuthSnapshot(snapshot)
      return result
    } catch (error: unknown) {
      this.assertCurrentAuthSnapshot(snapshot)
      throw error
    }
  }

  private async ensureAuthGeneration(): Promise<string> {
    const owner = this.settingsOwner
    const initialization = this.authGenerationInitialization
    if (initialization === undefined) throw new Error('Codex runtime settings are unavailable.')
    await initialization
    if (this.settingsOwner !== owner) throw new StaleAuthStateResultError()
    if (this.authGenerationInitializationError !== undefined) {
      throw new Error('Codex authentication lifecycle could not be persisted.')
    }
    if (this.authGeneration === undefined) throw new Error('Codex authentication lifecycle is unavailable.')
    return this.authGeneration
  }

  private isCurrentLoginAttempt(attempt: PendingLoginAttempt): boolean {
    return this.loginAttempt === attempt
  }

  private isCurrentPendingLoginAttempt(attempt: PendingLoginAttempt): boolean {
    return this.isCurrentLoginAttempt(attempt) && attempt.phase === 'pending'
  }

  private isCommittedLoginAttempt(attempt: PendingLoginAttempt): boolean {
    return attempt.phase === 'committed'
  }

  private isCurrentAuthTransition(transition: AuthTransitionRecord): boolean {
    return this.pendingAuthTransition?.id === transition.id
  }

  private hasPendingAuthTransition(): boolean {
    return this.pendingAuthTransition !== undefined
  }

  private loginStartResult(attempt: PendingLoginAttempt): { readonly status: 'signing-in' | 'connected' } {
    if (attempt.phase === 'committed' && attempt.committedGeneration === this.authGeneration
      && attempt.epoch === this.authStateEpoch && !this.authLifecycleBlocked) {
      return { status: 'connected' }
    }
    if (attempt.phase === 'pending' && this.isCurrentLoginAttempt(attempt)
      && attempt.epoch === this.authStateEpoch && this.pendingAuthTransition?.id === attempt.token) {
      return { status: 'signing-in' }
    }
    throw new Error('The ChatGPT login attempt was cancelled, failed, or superseded.')
  }

  private async commitAuthGeneration(
    transition: AuthTransitionRecord,
    scope: SettingsScope<CodexRuntimeSettings>,
    owner: object,
    attempt?: PendingLoginAttempt,
  ): Promise<string> {
    await this.ensureAuthGeneration()
    if (this.runtimeSettings !== scope || this.settingsOwner !== owner
      || !this.isCurrentAuthTransition(transition)
      || (attempt !== undefined && (!this.isCurrentLoginAttempt(attempt)
        || attempt.phase !== 'completing' || attempt.epoch !== this.authStateEpoch
        || this.client !== attempt.client || this.clientOwner !== attempt.clientOwner))) {
      throw new StaleAuthStateResultError()
    }
    const next = randomUUID()
    try {
      await this.updateAuthSettings(scope, owner, { authGeneration: next, authTransition: null })
      if (this.runtimeSettings !== scope || this.settingsOwner !== owner
        || scope.get().authGeneration !== next
        || (this.isCurrentAuthTransition(transition) && scope.get().authTransition != null)) {
        throw new Error('Codex authentication lifecycle update was not committed.')
      }
    } catch (error: unknown) {
      if (this.runtimeSettings === scope && this.settingsOwner === owner
        && this.isCurrentAuthTransition(transition)) {
        this.authLifecycleBlocked = true
      }
      throw error
    }
    this.authGeneration = next
    if (this.isCurrentAuthTransition(transition)) {
      this.pendingAuthTransition = undefined
      this.authLifecycleBlocked = false
    }
    return next
  }

  private async beginAuthTransition(
    transition: AuthTransitionRecord,
    scope: SettingsScope<CodexRuntimeSettings>,
    owner: object,
  ): Promise<void> {
    this.pendingAuthTransition = transition
    this.authLifecycleBlocked = true
    await this.updateAuthSettings(scope, owner, { authTransition: transition })
    if (this.runtimeSettings !== scope || this.settingsOwner !== owner
      || !this.isCurrentAuthTransition(transition)
      || scope.get().authTransition?.id !== transition.id) {
      throw new StaleAuthStateResultError()
    }
  }

  private bindAuthLease(lease: AuthBoundOperationLease, client: CodexAppServerConnection): void {
    this.assertAuthLeaseBindings(lease)
    if (this.client !== client || this.clientOwner === undefined) throw new StaleAuthStateResultError()
    lease.client = client
    lease.clientOwner = this.clientOwner
  }

  private assertAuthLeaseCurrent(lease: AuthBoundOperationLease): void {
    if (!this.isAuthLeaseCurrent(lease)) throw new StaleAuthStateResultError()
  }

  private assertAuthLeaseBindings(lease: AuthBoundOperationLease): void {
    if (this.disposed || this.authLifecycleBlocked || this.pendingAuthTransition !== undefined
      || this.authStateEpoch !== lease.authStateEpoch
      || this.runtimeSettings !== lease.settings || this.settingsOwner !== lease.settingsOwner
      || (lease.client !== undefined && (this.client !== lease.client || this.clientOwner !== lease.clientOwner))) {
      throw new StaleAuthStateResultError()
    }
  }

  private isAuthLeaseCurrent(lease: AuthBoundOperationLease): boolean {
    return !this.disposed && !this.authLifecycleBlocked && this.pendingAuthTransition === undefined
      && this.authStateEpoch === lease.authStateEpoch
      && this.runtimeSettings === lease.settings && this.settingsOwner === lease.settingsOwner
      && (lease.client === undefined || (this.client === lease.client && this.clientOwner === lease.clientOwner))
  }

  private async requestForAuthLease(
    lease: AuthBoundOperationLease,
    client: CodexAppServerConnection,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.assertAuthLeaseCurrent(lease)
    if (lease.client !== client) throw new StaleAuthStateResultError()
    try {
      const result = await client.request(method, params, timeoutMs)
      this.assertAuthLeaseCurrent(lease)
      return result
    } catch (error: unknown) {
      this.assertAuthLeaseCurrent(lease)
      throw error
    }
  }

  /** Acquire synchronously before any remote-thread operation awaits or reads the Session mapping. */
  private acquireAuthBoundOperation(): AuthBoundOperationLease {
    if (this.exclusiveRemoteTransition || this.loginAttempt !== undefined || this.authLifecycleBlocked
      || this.pendingAuthTransition !== undefined) {
      throw new Error('A Codex account transition is in progress; retry after it completes.')
    }
    const authGeneration = this.authGeneration
    const settings = this.runtimeSettings
    if (authGeneration === undefined || settings === undefined || this.authGenerationInitializationError !== undefined) {
      throw new Error('Codex authentication lifecycle is unavailable.')
    }
    this.activeAuthOperations++
    let released = false
    return {
      authGeneration,
      authStateEpoch: this.authStateEpoch,
      settings,
      settingsOwner: this.settingsOwner,
      release: () => {
        if (released) return
        released = true
        this.activeAuthOperations--
      },
    }
  }

  /** Exclude auth/runtime transitions until every shared remote-thread lease and active turn has ended. */
  private beginExclusiveRemoteTransition(allowPendingLogin = false): () => void {
    if (this.exclusiveRemoteTransition || this.activeAuthOperations > 0 || this.activeTurns.size > 0
      || (this.loginAttempt !== undefined && !allowPendingLogin)) {
      throw new Error('Finish or cancel the active Codex operation before changing accounts or runtimes.')
    }
    this.exclusiveRemoteTransition = true
    this.exclusiveTransitionReleased = new Promise((resolve) => {
      this.resolveExclusiveTransitionRelease = resolve
    })
    let released = false
    return () => {
      if (released) return
      released = true
      this.exclusiveRemoteTransition = false
      this.resolveExclusiveTransitionRelease?.()
      this.resolveExclusiveTransitionRelease = undefined
    }
  }

  /** Change runtime preference only while no auth-bound operation is active; this preserves authGeneration.
   * @param preference - the requested automatic, verified system, or bundled runtime.
   * @returns the refreshed renderer-safe Codex subscription status.
   * @throws when an authentication transition, login, or remote-thread operation is active.
   */
  async selectRuntime(preference: unknown): Promise<CodexSubscriptionStatus> {
    if (preference !== 'auto' && preference !== 'system' && preference !== 'bundled') {
      throw new Error('Choose Automatic, System Codex, or Bundled Codex.')
    }
    const releaseTransition = this.beginExclusiveRemoteTransition()
    try {
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
      return await this.status()
    } finally {
      releaseTransition()
    }
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
    if (this.disposed) return this.statusProjection()
    let snapshot = this.snapshotAuthState()
    try {
      await this.ensureStarted()
      snapshot = this.snapshotAuthState()
      if (!this.isCurrentAuthSnapshot(snapshot)) return this.statusProjection()
      if (this.loginAttempt !== undefined) return this.statusProjection()
      if (this.pendingAuthTransition !== undefined || this.authLifecycleBlocked) {
        this.accountState = 'reauth-required'
        return this.statusProjection()
      }
      this.runtimeState = 'auth-check'
      await this.refreshAccount(snapshot)
      if (!this.isCurrentAuthSnapshot(snapshot)) return this.statusProjection()
      if (this.accountState === 'connected') {
        this.runtimeState = 'catalog-loading'
        const models = await this.readModels(undefined, snapshot)
        if (!this.isCurrentAuthSnapshot(snapshot)) return this.statusProjection()
        this.modelCount = models.length
        await this.refreshRateLimits(false, snapshot)
        if (!this.isCurrentAuthSnapshot(snapshot)) return this.statusProjection()
      } else {
        this.modelCount = 0
        this.usage = UNAVAILABLE_USAGE
        this.rateLimitReadAt = 0
      }
      this.runtimeState = 'ready'
      this.statusError = undefined
    } catch (error: unknown) {
      if (this.isCurrentAuthSnapshot(snapshot)) {
        this.runtimeState = this.client === undefined && this.runtimeState !== 'error' ? 'crashed' : 'error'
        this.statusError = safeError(error)
        if (this.accountState !== 'connected') this.accountState = 'error'
      }
    }
    return this.statusProjection()
  }

  private statusProjection(): CodexSubscriptionStatus {
    if (this.disposed) return {
      enabled: true, runtime: 'stopped', account: 'error', login: 'idle', modelCount: 0,
      usage: UNAVAILABLE_USAGE, error: 'Codex runtime is shutting down.', ...this.runtimeStatusFields(),
    }
    return {
      enabled: true,
      runtime: this.runtimeState,
      ...this.runtimeStatusFields(),
      account: this.accountState,
      login: this.loginAttempt === undefined ? 'idle' : 'signing-in',
      modelCount: this.modelCount,
      usage: this.usage,
      ...(this.statusError === undefined ? {} : { error: this.statusError }),
    }
  }

  /** Start the official ChatGPT sign-in; only its successful completion rotates authGeneration.
   * @returns Whether the official browser sign-in is pending or already connected.
   * @throws when a remote-thread operation or another account/runtime transition is active.
   */
  async connectChatGPT(): Promise<{ readonly status: 'signing-in' | 'connected' }> {
    const releaseTransition = this.beginExclusiveRemoteTransition()
    let attempt: PendingLoginAttempt | undefined
    let authUrl: string | undefined
    try {
      const client = await this.ensureStarted()
      if (this.pendingAuthTransition === undefined && !this.authLifecycleBlocked) {
        const observation = this.snapshotAuthState()
        await this.refreshAccount(observation)
        this.assertCurrentAuthSnapshot(observation)
        if (this.accountState === 'connected') return { status: 'connected' }
      }
      const settings = this.runtimeSettings
      if (settings === undefined) throw new Error('Codex runtime settings are unavailable.')
      const clientOwner = this.clientOwner
      if (clientOwner === undefined) throw new StaleAuthStateResultError()
      const token = randomUUID()
      this.authStateEpoch++
      attempt = {
        token,
        settings,
        settingsOwner: this.settingsOwner,
        client,
        clientOwner,
        epoch: this.authStateEpoch,
        phase: 'starting',
      }
      this.loginAttempt = attempt
      const transition: AuthTransitionRecord = { id: token, kind: 'login' }
      this.pendingAuthTransition = transition
      this.authLifecycleBlocked = true
      this.accountState = 'reauth-required'
      this.runtimeState = 'auth-check'
      this.modelCount = 0
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
      await this.beginAuthTransition(transition, settings, attempt.settingsOwner)
      const snapshot = this.snapshotAuthState(attempt, 'starting')
      const response = jsonObject(await this.requestForAuthSnapshot(
        snapshot,
        'account/login/start',
        { type: 'chatgpt' },
        20_000,
      ), 'login response')
      if (response.type !== 'chatgpt') throw new Error('Codex App Server did not start the official ChatGPT login flow.')
      authUrl = requiredString(response.authUrl, 'official ChatGPT login URL')
      const parsed = new URL(authUrl)
      if (parsed.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname)) {
        throw new Error('Codex App Server returned an unapproved authentication destination')
      }
      attempt.loginId = requiredString(response.loginId, 'official login transaction id')
      attempt.phase = 'pending'
    } catch (error: unknown) {
      if (attempt !== undefined && this.isCurrentLoginAttempt(attempt)) {
        attempt.phase = 'failed'
        this.loginAttempt = undefined
        this.authLifecycleBlocked = true
        this.accountState = 'reauth-required'
        this.runtimeState = 'error'
        this.statusError = safeError(error)
      }
      throw new Error(safeError(error))
    } finally {
      releaseTransition()
    }

    try {
      await this.openLoginUrl(authUrl)
    } catch (error: unknown) {
      if (this.isCommittedLoginAttempt(attempt)) return this.loginStartResult(attempt)
      if (this.isCurrentPendingLoginAttempt(attempt)) {
        attempt.phase = 'failed'
        this.loginAttempt = undefined
        this.authLifecycleBlocked = true
        this.accountState = 'reauth-required'
        this.runtimeState = 'error'
        this.statusError = safeError(error)
        throw new Error(this.statusError)
      }
      if (attempt.completion !== undefined) {
        await attempt.completion
        if (this.isCommittedLoginAttempt(attempt)) return this.loginStartResult(attempt)
      }
      throw new Error(safeError(error))
    }
    return this.loginStartResult(attempt)
  }

  /** Cancel only the pending login transaction; cancellation does not rotate authGeneration.
   * @returns The refreshed renderer-safe subscription state.
   * @throws when a pending login cannot be cancelled because a remote operation or transition is active.
   */
  async cancelLogin(): Promise<CodexSubscriptionStatus> {
    const attempt = this.loginAttempt
    if (attempt === undefined || attempt.phase !== 'pending' || attempt.loginId === undefined) return this.status()
    const releaseTransition = this.beginExclusiveRemoteTransition(true)
    this.authStateEpoch++
    attempt.phase = 'cancelling'
    const snapshot = this.snapshotAuthState(attempt, 'cancelling')
    try {
      await this.requestForAuthSnapshot(snapshot, 'account/login/cancel', { loginId: attempt.loginId }, 10_000)
      this.assertCurrentAuthSnapshot(snapshot)
      attempt.phase = 'cancelled'
      this.loginAttempt = undefined
      this.accountState = 'reauth-required'
      this.modelCount = 0
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
      this.runtimeState = 'ready'
      return this.statusProjection()
    } catch (error: unknown) {
      if (this.isCurrentLoginAttempt(attempt) && attempt.phase === 'cancelling') {
        attempt.phase = 'failed'
        this.loginAttempt = undefined
        this.authLifecycleBlocked = true
        this.accountState = 'reauth-required'
        this.runtimeState = 'error'
        this.statusError = safeError(error)
      }
      throw error
    } finally {
      releaseTransition()
    }
  }

  /** Restart only the DSH-owned App Server; authentication generation and Session mappings remain stable.
   * @returns The refreshed renderer-safe subscription state.
   * @throws when a login, account transition, or remote-thread operation is active.
   */
  async reconnect(): Promise<CodexSubscriptionStatus> {
    const releaseTransition = this.beginExclusiveRemoteTransition()
    try {
      await this.stopClient()
      return await this.status()
    } finally {
      releaseTransition()
    }
  }

  /** Use official logout and rotate authGeneration only after it succeeds; never edit auth files directly.
   * @returns The refreshed renderer-safe subscription state.
   * @throws when a remote-thread operation is active, logout fails, or the new generation cannot persist.
   */
  async disconnect(): Promise<CodexSubscriptionStatus> {
    const releaseTransition = this.beginExclusiveRemoteTransition()
    try {
      const settings = this.runtimeSettings
      if (settings === undefined) throw new Error('Codex runtime settings are unavailable.')
      this.authStateEpoch++
      const transition = { id: randomUUID(), kind: 'logout' as const }
      const owner = this.settingsOwner
      this.pendingAuthTransition = transition
      this.authLifecycleBlocked = true
      this.accountState = 'reauth-required'
      this.modelCount = 0
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
      await this.beginAuthTransition(transition, settings, owner)
      await this.ensureStarted()
      const logoutSnapshot = this.snapshotAuthState()
      await this.requestForAuthSnapshot(logoutSnapshot, 'account/logout', {}, 15_000)
      this.assertCurrentAuthSnapshot(logoutSnapshot)
      await this.commitAuthGeneration(transition, settings, owner)
      if (this.hasPendingAuthTransition()) throw new StaleAuthStateResultError()
      this.accountState = 'reauth-required'
      this.loginAttempt = undefined
      this.modelCount = 0
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
      if (this.client === logoutSnapshot.client && this.clientOwner === logoutSnapshot.clientOwner) {
        this.runtimeState = 'ready'
        this.statusError = undefined
      }
      return this.statusProjection()
    } finally {
      releaseTransition()
    }
  }

  /** Discover model IDs and reasoning capabilities from the active official runtime.
   * @param signal - Optional cancellation signal for discovery.
   * @returns The available Codex model catalog entries.
   */
  async listModels(signal?: AbortSignal): Promise<readonly ExternalModelCatalogEntry[]> {
    signal?.throwIfAborted()
    if (this.loginAttempt !== undefined) throw new Error('Wait for the ChatGPT login transition to complete.')
    await this.ensureStarted()
    const snapshot = this.snapshotAuthState()
    await this.refreshAccount(snapshot)
    this.assertCurrentAuthSnapshot(snapshot)
    if (this.accountState !== 'connected') throw new Error('Connect a ChatGPT subscription to discover Codex models.')
    const models = await this.readModels(signal, snapshot)
    this.assertCurrentAuthSnapshot(snapshot)
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
    if (this.disposed) return
    const client = this.client
    const pending = [...this.turnWaiters.entries()]
    const pendingInterrupts = client === undefined ? [] : pending.filter(([, waiter]) =>
      this.isAuthLeaseCurrent(waiter.lease) && waiter.lease.client === client,
    )
    const interrupts = client === undefined ? [] : pendingInterrupts.map(([threadId, waiter]) =>
      this.requestForAuthLease(waiter.lease, client, 'turn/interrupt', { threadId, turnId: waiter.turnId }, 5_000)
        .catch(() => undefined),
    )
    this.disposed = true
    if (client !== undefined && pendingInterrupts.length > 0) {
      await Promise.all(interrupts)
      await withDeadline(
        Promise.allSettled(pendingInterrupts.map(([, waiter]) => waiter.completion)),
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

  private ensureStarted(): Promise<CodexAppServerConnection> {
    if (this.disposed) return Promise.reject(new Error('Codex runtime is shutting down.'))
    if (this.startupPromise !== undefined) return this.startupPromise
    if (this.client !== undefined) return Promise.resolve(this.client)
    const startup = this.startRuntimeSelection()
    this.startupPromise = startup
    void startup.then(() => {
      if (this.startupPromise === startup) this.startupPromise = undefined
    }, () => {
      if (this.startupPromise === startup) this.startupPromise = undefined
    })
    return startup
  }

  private async startRuntimeSelection(): Promise<CodexAppServerConnection> {
    const startupEpoch = this.authStateEpoch
    const settings = this.runtimeSettings
    const settingsOwner = this.settingsOwner
    const isCurrentStartup = (): boolean => !this.disposed && this.authStateEpoch === startupEpoch
      && this.runtimeSettings === settings && this.settingsOwner === settingsOwner
    const assertCurrentStartup = (): void => {
      if (!isCurrentStartup()) throw new StaleAuthStateResultError()
    }
    await this.ensureAuthGeneration()
    assertCurrentStartup()
    this.runtimeState = 'starting'
    const allowedHomeRoot = this.resolveAllowedHomeRoot()
    const requestedHome = this.resolveHomePath('codex-subscription', 'codex-home')
    await this.ensureHome(requestedHome, allowedHomeRoot)
    assertCurrentStartup()
    const home = await verifyCodexHome(requestedHome, allowedHomeRoot)
    assertCurrentStartup()
    const preference = this.runtimeSettings?.get().preference ?? 'auto'
    const system = this.systemRuntime()
    const bundled = bundledCodexRuntime()
    const candidates = preference === 'bundled'
      ? [bundled]
      : preference === 'system'
        ? system.runtime === undefined ? [] : [system.runtime]
        : system.runtime === undefined ? [bundled] : [system.runtime, bundled]

    if (preference === 'system' && candidates.length === 0) {
      if (isCurrentStartup()) {
        this.runtimeState = 'error'
        this.statusError = system.unavailableReason ?? 'The verified system Codex runtime is unavailable.'
      }
      throw new Error(this.statusError)
    }
    if (preference === 'auto' && system.runtime === undefined) {
      this.runtimeSelectionNote = system.unavailableReason ?? 'Using the bundled Codex runtime.'
    }
    let lastFailure: Error | undefined
    for (const runtime of candidates) {
      try {
        const verifiedHome = await verifyCodexHome(requestedHome, allowedHomeRoot)
        assertCurrentStartup()
        if (verifiedHome !== home) throw new Error('Codex runtime home changed during App Server startup.')
        const starting = await this.startRuntime(runtime, verifiedHome, requestedHome, allowedHomeRoot)
        assertCurrentStartup()
        this.activeRuntime = runtime
        this.runtimeSelectionNote = runtime.source === 'bundled' && preference === 'auto' && lastFailure !== undefined
          ? 'System Codex did not pass its capability check; using the bundled runtime.'
          : undefined
        this.runtimeState = 'auth-check'
        return starting
      } catch (error: unknown) {
        assertCurrentStartup()
        lastFailure = error instanceof Error ? error : new Error('Codex runtime startup failed.')
        if (preference !== 'auto' || runtime.source !== 'system' || !(lastFailure instanceof CodexIncompatibleError)) {
          this.runtimeState = 'error'
          this.statusError = safeError(lastFailure)
          throw new Error(this.statusError)
        }
      }
    }
    assertCurrentStartup()
    this.runtimeState = 'error'
    this.statusError = safeError(lastFailure ?? new Error('No supported Codex App Server runtime is available.'))
    throw new Error(this.statusError)
  }

  private async startRuntime(
    runtime: CodexRuntimeDescriptor,
    home: string,
    requestedHome: string,
    allowedHomeRoot: string,
  ): Promise<CodexAppServerConnection> {
    this.resumedThreads.clear()
    const owner = {}
    const startupEpoch = this.authStateEpoch
    const owned: { client?: CodexAppServerConnection } = {}
    const callbacks: CodexServerCallbacks = {
      onNotification: (method, params) => {
        if (owned.client !== undefined && this.client === owned.client && this.clientOwner === owner) {
          this.onNotification(method, params)
        }
      },
      onRequest: (method, params) => {
        if (owned.client === undefined || this.client !== owned.client || this.clientOwner !== owner) {
          return Promise.reject(new Error('Codex App Server request belongs to an inactive client.'))
        }
        return this.onServerRequest(method, params)
      },
      onExit: (error) => {
        if (owned.client !== undefined && this.client === owned.client && this.clientOwner === owner) {
          this.authStateEpoch++
          this.client = undefined
          this.clientOwner = undefined
          this.activeRuntime = undefined
          this.runtimeInventory = undefined
          this.resumedThreads.clear()
          this.runtimeState = 'crashed'
          this.accountState = this.pendingAuthTransition === undefined ? 'error' : 'reauth-required'
          this.statusError = error === undefined ? 'Codex App Server disconnected.' : safeError(error)
          for (const [threadId, waiter] of this.turnWaiters) {
            const active = this.activeTurns.get(threadId)
            if (active?.turnId === waiter.turnId) waiter.reject(new Error('Codex App Server exited during an active turn.'))
          }
        }
      },
    }
    this.runtimeState = 'initializing'
    const verifiedHome = await verifyCodexHome(requestedHome, allowedHomeRoot)
    if (verifiedHome !== home) throw new Error('Codex runtime home changed immediately before App Server startup.')
    try { await this.inspectRuntime(runtime) }
    catch { throw new CodexIncompatibleError('executable identity before spawn') }
    if (this.authStateEpoch !== startupEpoch) throw new StaleAuthStateResultError()
    const starting = this.startClient(runtime, verifiedHome, verifiedHome, callbacks)
    owned.client = starting
    this.client = starting
    this.clientOwner = owner
    try {
      const initialized = await withDeadline(starting.initialize(), 18_000, 'Codex App Server initialization timed out')
      if (this.client !== starting || this.clientOwner !== owner || this.authStateEpoch !== startupEpoch) {
        throw new StaleAuthStateResultError()
      }
      const protocolOnly = this.pendingAuthTransition !== undefined || this.authLifecycleBlocked
      const checkedClient: CodexAppServerConnection = { initialize: () => starting.initialize(), dispose: () => starting.dispose(),
        request: async (method, params, timeout) => {
          if (this.client !== starting || this.clientOwner !== owner || this.authStateEpoch !== startupEpoch) {
            throw new StaleAuthStateResultError()
          }
          const result = await starting.request(method, params, timeout)
          if (this.client !== starting || this.clientOwner !== owner || this.authStateEpoch !== startupEpoch) {
            throw new StaleAuthStateResultError()
          }
          return result
        } }
      const compatibility = await this.verifyCompatibility(runtime, checkedClient, allowedHomeRoot, initialized, protocolOnly)
      if (!protocolOnly && compatibility.lightStatus !== 'PASS') throw new CodexIncompatibleError('required Light capabilities')
      if (this.client !== starting || this.clientOwner !== owner || this.authStateEpoch !== startupEpoch) {
        throw new StaleAuthStateResultError()
      }
      this.compatibility = compatibility
      this.initializedResponse = initialized
      this.catalogDigest = undefined
      this.ctx.emit('llm/model-catalog-updated')
      return starting
    } catch (error: unknown) {
      if (this.client === starting && this.clientOwner === owner) {
        this.client = undefined
        this.clientOwner = undefined
        this.activeRuntime = undefined
      }
      await starting.dispose().catch(() => {})
      throw error instanceof Error ? error : new Error('Codex runtime compatibility check failed.')
    }
  }

  private async stopClient(): Promise<void> {
    this.authStateEpoch++
    this.runtimeInventory = undefined
    // Resumed-thread knowledge belongs to one App Server process, not the persistent DSH Session mapping.
    this.resumedThreads.clear()
    const client = this.client
    if (client === undefined) { this.clientOwner = undefined; this.activeRuntime = undefined; this.runtimeState = 'stopped'; return }
    this.runtimeState = 'stopping'
    this.client = undefined
    this.clientOwner = undefined
    this.activeRuntime = undefined
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error('Codex App Server restarted during an active turn.'))
    }
    this.turnWaiters.clear()
    await client.dispose()
    this.runtimeState = 'stopped'
  }

  private async refreshAccount(snapshot = this.snapshotAuthState()): Promise<CodexAccountState> {
    if (this.pendingAuthTransition !== undefined || this.authLifecycleBlocked) {
      throw new Error('A Codex authentication transition must be completed before account status can be refreshed.')
    }
    let accountState: CodexAccountState
    try {
      accountState = await this.readAccountState(snapshot)
    } catch (error: unknown) {
      if (!this.isCurrentAuthSnapshot(snapshot)) throw new StaleAuthStateResultError()
      this.accountState = 'error'
      throw error
    }
    this.assertCurrentAuthSnapshot(snapshot)
    this.accountState = accountState
    if (accountState !== 'connected') {
      this.usage = UNAVAILABLE_USAGE
      this.rateLimitReadAt = 0
    }
    return accountState
  }

  private async readAccountState(snapshot = this.snapshotAuthState()): Promise<CodexAccountState> {
    const response = jsonObject(await this.requestForAuthSnapshot(
      snapshot,
      'account/read',
      { refreshToken: false },
      15_000,
    ), 'account state')
    this.assertCurrentAuthSnapshot(snapshot)
    let account: JsonObject | undefined
    if (response.account !== null && response.account !== undefined) {
      account = jsonObject(response.account, 'account')
    }
    if (account === undefined) {
      return response.requiresOpenaiAuth === true ? 'reauth-required' : 'not-connected'
    }
    if (account.type === 'chatgpt') {
      // Do not return account email or any protocol fields to the renderer.
      return 'connected'
    }
    if (account.type === 'apiKey') {
      return 'not-connected'
    }
    return response.requiresOpenaiAuth === true ? 'reauth-required' : 'error'
  }

  /** Read the official account quota snapshot at most once per five minutes. */
  private async refreshRateLimits(force = false, snapshot = this.snapshotAuthState()): Promise<void> {
    const client = snapshot.client
    if (client === undefined || this.accountState !== 'connected' || this.pendingAuthTransition !== undefined
      || this.authLifecycleBlocked) {
      if (this.isCurrentAuthSnapshot(snapshot)) this.usage = UNAVAILABLE_USAGE
      return
    }
    const now = Date.now()
    if (!force && now - this.rateLimitReadAt < RATE_LIMIT_REFRESH_MS) return
    try {
      const response = jsonObject(await this.requestForAuthSnapshot(
        snapshot,
        'account/rateLimits/read',
        {},
        15_000,
      ), 'account rate limits')
      const buckets = response.rateLimitsByLimitId
      const bucketMap = buckets !== null && typeof buckets === 'object' && !Array.isArray(buckets)
        ? buckets as Record<string, unknown>
        : undefined
      const codexBucket = bucketMap?.codex
      const quota = jsonObject(codexBucket ?? response.rateLimits, 'account rate-limit snapshot')
      const primary = usageWindow(quota.primary)
      const secondary = usageWindow(quota.secondary)
      this.assertCurrentAuthSnapshot(snapshot)
      this.usage = primary === undefined && secondary === undefined
        ? UNAVAILABLE_USAGE
        : {
          state: 'available',
          ...(primary === undefined ? {} : { primary }),
          ...(secondary === undefined ? {} : { secondary }),
        }
      this.rateLimitReadAt = now
    } catch {
      // Quota visibility is informational; it must not turn account/runtime
      // status into an authentication failure or block a turn.
      if (!this.isCurrentAuthSnapshot(snapshot)) throw new StaleAuthStateResultError()
      this.usage = UNAVAILABLE_USAGE
    }
  }

  private async readModels(
    signal?: AbortSignal,
    existingSnapshot?: AuthStateSnapshot,
  ): Promise<CodexModelEntry[]> {
    await this.ensureStarted()
    signal?.throwIfAborted()
    const snapshot = existingSnapshot ?? this.snapshotAuthState()
    this.assertCurrentAuthSnapshot(snapshot)
    if (this.pendingAuthTransition !== undefined || this.authLifecycleBlocked) {
      throw new Error('A Codex authentication transition must be completed before reading models.')
    }
    const client = snapshot.client
    if (client === undefined) throw new Error('Codex App Server is not connected.')
    if (this.compatibility?.lightStatus !== 'PASS') {
      const runtime = this.activeRuntime
      const initialized = this.initializedResponse
      if (runtime === undefined || initialized === undefined) throw new Error('Codex compatibility is not ready.')
      const guardedClient: CodexAppServerConnection = { initialize: () => client.initialize(), dispose: () => client.dispose(),
        request: (method, params, timeout) => this.requestForAuthSnapshot(snapshot, method, params, timeout) }
      const evidence = await this.verifyCompatibility(runtime, guardedClient, this.resolveAllowedHomeRoot(), initialized, false)
      this.assertCurrentAuthSnapshot(snapshot)
      if (evidence.lightStatus !== 'PASS') throw new CodexIncompatibleError('required Light capabilities')
      this.compatibility = evidence
    }
    const models: CodexModelEntry[] = []
    const seen = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      signal?.throwIfAborted()
      const response = jsonObject(await this.requestForAuthSnapshot(
        snapshot,
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
      if (response.nextCursor === null) {
        this.assertCurrentAuthSnapshot(snapshot)
        const digest = compatibilityDigest(models.map(m => ({ id: m.id, model: m.runtimeModel, name: m.name, reasoning: m.reasoning })))
        if (digest !== this.catalogDigest) {
          this.catalogDigest = digest
          this.ctx.emit('llm/model-catalog-updated')
        }
        return models
      }
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
    if (method === 'account/updated') {
      if (params.authMode === null) this.invalidateAuthentication()
      return
    }
    if (method === 'account/login/completed') {
      const loginId = typeof params.loginId === 'string' ? params.loginId : undefined
      const attempt = this.loginAttempt
      if (attempt?.loginId === undefined || loginId !== attempt.loginId) return
      if (params.success !== true) {
        if (attempt.phase !== 'pending') return
        attempt.phase = 'failed'
        this.loginAttempt = undefined
        this.authLifecycleBlocked = true
        this.accountState = 'reauth-required'
        this.runtimeState = 'error'
        this.statusError = safeError(params.error)
        return
      }
      this.completeSuccessfulLogin(attempt)
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

  private invalidateAuthentication(): void {
    this.authStateEpoch++
    const attempt = this.loginAttempt
    if (attempt !== undefined && attempt.phase !== 'committed') {
      attempt.phase = 'failed'
      this.loginAttempt = undefined
    }
    const scope = this.runtimeSettings
    const owner = this.settingsOwner
    const transition: AuthTransitionRecord = { id: randomUUID(), kind: 'invalidated' }
    this.pendingAuthTransition = transition
    this.authLifecycleBlocked = true
    this.accountState = 'reauth-required'
    this.modelCount = 0
    this.usage = UNAVAILABLE_USAGE
    this.rateLimitReadAt = 0
    this.runtimeState = 'ready'
    this.statusError = undefined
    if (scope !== undefined) {
      void this.beginAuthTransition(transition, scope, owner).catch((error: unknown) => {
        if (this.runtimeSettings === scope && this.settingsOwner === owner
          && this.pendingAuthTransition?.id === transition.id) {
          this.runtimeState = 'error'
          this.statusError = safeError(error)
        }
      })
    }
  }

  private completeSuccessfulLogin(attempt: PendingLoginAttempt): void {
    if (!this.isCurrentLoginAttempt(attempt) || attempt.phase !== 'pending' || attempt.completion !== undefined) return
    attempt.phase = 'completing'
    attempt.completion = this.finishSuccessfulLogin(attempt)
  }

  private async finishSuccessfulLogin(attempt: PendingLoginAttempt): Promise<void> {
    let releaseTransition: (() => void) | undefined
    try {
      while (this.isCurrentLoginAttempt(attempt) && this.exclusiveRemoteTransition) {
        await this.exclusiveTransitionReleased
        this.assertCurrentAuthSnapshot(this.snapshotAuthState(attempt, 'completing'))
      }
      if (!this.isCurrentLoginAttempt(attempt) || attempt.phase !== 'completing') return
      releaseTransition = this.beginExclusiveRemoteTransition(true)
      const snapshot = this.snapshotAuthState(attempt, 'completing')
      if (await this.readAccountState(snapshot) !== 'connected') {
        throw new Error('Official ChatGPT login completed but the subscription account is not connected.')
      }
      this.assertCurrentAuthSnapshot(snapshot)
      const transition: AuthTransitionRecord = { id: attempt.token, kind: 'login' }
      const generation = await this.commitAuthGeneration(
        transition,
        attempt.settings,
        attempt.settingsOwner,
        attempt,
      )
      attempt.committedGeneration = generation
      attempt.phase = 'committed'
      if (attempt.epoch !== this.authStateEpoch || this.client !== attempt.client
        || this.clientOwner !== attempt.clientOwner || this.pendingAuthTransition !== undefined
        || this.authLifecycleBlocked) {
        if (this.isCurrentLoginAttempt(attempt)) this.loginAttempt = undefined
        return
      }
      // The persisted generation and cleared marker are the auth commit point.
      this.accountState = 'connected'
      this.loginAttempt = undefined
      this.runtimeState = 'catalog-loading'
      this.statusError = undefined
      const committedSnapshot = this.snapshotAuthState()
      const models = await this.readModels(undefined, committedSnapshot)
      if (!this.isCurrentAuthSnapshot(committedSnapshot)) return
      this.modelCount = models.length
      await this.refreshRateLimits(true, committedSnapshot)
      if (!this.isCurrentAuthSnapshot(committedSnapshot)) return
      this.runtimeState = 'ready'
    } catch (error: unknown) {
      if (this.isCurrentLoginAttempt(attempt) && attempt.phase === 'completing') {
        attempt.phase = 'failed'
        this.loginAttempt = undefined
        this.authLifecycleBlocked = true
        this.accountState = 'reauth-required'
        this.runtimeState = 'error'
        this.statusError = safeError(error)
      }
    } finally {
      releaseTransition?.()
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
    const lease = this.acquireAuthBoundOperation()
    try {
      return await this.executeTurnWithLease(request, runtimeModel, lease)
    } finally {
      lease.release()
    }
  }

  private async executeTurnWithLease(
    request: ExternalTurnRequest,
    runtimeModel: string,
    lease: AuthBoundOperationLease,
  ): Promise<ExternalTurnResult> {
    const client = await this.ensureStarted()
    this.bindAuthLease(lease, client)
    const accountSnapshot = this.snapshotAuthState()
    await this.refreshAccount(accountSnapshot)
    this.assertAuthLeaseCurrent(lease)
    if (this.accountState !== 'connected') throw new Error('OpenAI Codex is not connected to a ChatGPT subscription.')
    const cwd = await canonicalWorkspace(request.cwd)
    this.assertAuthLeaseCurrent(lease)
    const workspace = await this.resolveWorkspace(request.session, cwd, request.signal)
    this.assertAuthLeaseCurrent(lease)
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

    const runtimeFingerprint = this.compatibility?.fingerprint
    if (runtimeFingerprint === undefined) throw new Error('Codex runtime compatibility evidence is unavailable.')
    if (mapping.authGeneration !== lease.authGeneration) {
      if (mapping.dispatch !== null) {
        // The old remote thread belongs to an unverified auth generation. Do not
        // resume/reconcile it under the current account, and never replay it.
        await this.commitReconciliation(
          request,
          mapping,
          mapping.dispatch,
          'unknown',
          null,
          { count: 0, kinds: [] },
          true,
          lease,
        )
        this.assertAuthLeaseCurrent(lease)
        throw new Error('The previous Codex turn belongs to a retired authentication generation; it was not resumed or replayed.')
      }
      const retiredThreadIds = mapping.activeThreadId === null
        ? mapping.retiredThreadIds
        : [...mapping.retiredThreadIds, mapping.activeThreadId].slice(-16)
      mapping = {
        ...mapping,
        generation: mapping.generation + 1,
        authGeneration: lease.authGeneration,
        activeThreadId: null,
        retiredThreadIds,
        workspaceIdentity: null,
        cwd: null,
        latestTurnId: null,
        committedMessageId: null,
        pendingSync: null,
        lastReconciliation: mapping.lastReconciliation === null
          ? null
          : { ...mapping.lastReconciliation, status: 'unknown' },
        bootstrap: null,
      }
      writeMapping(request.session, mapping)
      await this.ctx.sessions.flush(request.session)
      this.assertAuthLeaseCurrent(lease)
    }

    const recoveringReconciliation = matchesReconciliation(
      mapping.lastReconciliation, request, cwd, inputHash, effort, requestedMessageId,
    )
    const interop = mapping.activeThreadId === null ? 'resume'
      : codexThreadInterop(mapping.runtimeFingerprint, runtimeFingerprint,
        mapping.dispatch !== null || recoveringReconciliation)
    if (interop === 'retire') {
      const retiredId = mapping.activeThreadId
      if (retiredId === null) throw new Error('Codex retirement requires a thread mapping.')
      mapping = { ...mapping, activeThreadId: null, runtimeFingerprint,
        retiredThreadIds: [...mapping.retiredThreadIds, retiredId].slice(-16),
        generation: mapping.generation + 1, workspaceIdentity: null, cwd: null,
        latestTurnId: null, committedMessageId: null, pendingSync: null, bootstrap: null,
        lastReconciliation: mapping.lastReconciliation === null
          ? null : { ...mapping.lastReconciliation, status: 'unknown' } }
      writeMapping(request.session, mapping)
      await this.ctx.sessions.flush(request.session)
      this.assertAuthLeaseCurrent(lease)
    }

    // Resolve any persisted side-effecting dispatch before touching the thread.
    // Authoritative terminal state releases the barrier; ambiguous state never
    // causes the old turn to be replayed.
    if (mapping.dispatch !== null) {
      const recovered = await this.reconcileDispatch(
        client, request, mapping, cwd, inputHash, effort, requestedMessageId, lease,
      )
      this.assertAuthLeaseCurrent(lease)
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
        return this.recoverCompletedReconciliation(client, request, reconciliation, cwd, lease)
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
        await this.requestForAuthLease(lease, client, 'thread/resume', { threadId: mapping.activeThreadId }, 20_000)
        const resumed = jsonObject(await this.requestForAuthLease(
          lease,
          client,
          'thread/read',
          { threadId: mapping.activeThreadId },
          20_000,
        ), 'resumed thread')
        const resumedThread = jsonObject(resumed.thread, 'resumed thread metadata')
        if (requiredString(resumedThread.cwd, 'resumed thread workspace') !== cwd) {
          throw new Error('Codex thread workspace no longer matches the canonical DSH workspace.')
        }
        this.resumedThreads.add(mapping.activeThreadId)
      } catch (error: unknown) {
        if (!this.isAuthLeaseCurrent(lease)) throw error
        mustBootstrap = true
      }
    }
    let threadId = mapping.activeThreadId
    if (mustBootstrap || threadId === null) {
      const retired = threadId === null ? mapping.retiredThreadIds : [...mapping.retiredThreadIds, threadId].slice(-16)
      const response = jsonObject(await this.requestForAuthLease(lease, client, 'thread/start', {
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
        authGeneration: lease.authGeneration,
        activeThreadId: threadId,
        runtimeFingerprint,
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
        await this.requestForAuthLease(
          lease, client, 'thread/inject_items', { threadId, items: bootstrap.items }, RPC_TIMEOUT_MS,
        )
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
        await this.requestForAuthLease(
          lease, client, 'thread/inject_items', { threadId, items: batch.items }, RPC_TIMEOUT_MS,
        )
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
    const active: ActiveCodexTurn = { request, threadId, lease, finalText: '' }
    this.activeTurns.set(threadId, active)
    let terminal: Record<string, unknown>
    let turnId: string
    try {
      const started = jsonObject(await this.requestForAuthLease(lease, client, 'turn/start', {
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
      terminal = await this.waitForTurn(client, threadId, turnId, request, lease)
      this.assertAuthLeaseCurrent(lease)
    } catch (error: unknown) {
      const observedTurnId = active.turnId ?? null
      if (this.isAuthLeaseCurrent(lease)) {
        writeMapping(request.session, {
          ...mapping,
          ...(observedTurnId === null ? {} : { latestTurnId: observedTurnId }),
          dispatch: { ...dispatch, status: 'uncertain', turnId: observedTurnId },
        })
      }
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

  /** Thread IDs validated for one App Server client; replacement and owned exit clear this cache. */
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
    lease: AuthBoundOperationLease,
  ): Promise<ExternalTurnResult | undefined> {
    const dispatch = mapping.dispatch
    if (dispatch === null) return undefined
    const clientUserMessageId = dispatch.clientUserMessageId
    const sameRequest = matchesDispatch(dispatch, request, cwd, inputHash, effort, messageId)
    if (clientUserMessageId === undefined || clientUserMessageId === '') {
      throw new Error('A previous Codex turn has no verifiable App Server correlation ID; it was not resent.')
    }

    try {
      await this.resumeAndVerifyThread(client, dispatch.threadId, cwd, lease)
    } catch (error: unknown) {
      if (!this.isAuthLeaseCurrent(lease)) throw error
      if (!isMissingThreadError(error)) throw error
      await this.commitReconciliation(request, mapping, dispatch, 'unknown', null, { count: 0, kinds: [] }, true, lease)
      if (sameRequest) throw new Error('The previous Codex turn is missing and was not replayed; start a new DSH turn to continue.')
      return undefined
    }

    let turn = await this.findDispatchedTurn(client, dispatch.threadId, dispatch.turnId, clientUserMessageId, lease)
    if (turn === undefined) {
      await this.commitReconciliation(
        request, mapping, dispatch, 'unknown', null, { count: 0, kinds: [] }, true, lease,
      )
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
        request, threadId: dispatch.threadId, lease, turnId,
        finalText: finalAssistantTextFromTurn(turn) ?? '',
      }
      this.activeTurns.set(dispatch.threadId, active)
      try {
        const terminal = await this.waitForTurn(
          client,
          dispatch.threadId,
          turnId,
          request,
          lease,
          async () => {
            const current = await this.findDispatchedTurn(client, dispatch.threadId, turnId, clientUserMessageId, lease)
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
      lease,
    )

    this.assertAuthLeaseCurrent(lease)
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
    lease: AuthBoundOperationLease,
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
      authGeneration: lease.authGeneration,
      activeThreadId: retireThread ? null : mapping.activeThreadId,
      retiredThreadIds,
      latestTurnId: retireThread ? null : turnId,
      committedMessageId: retireThread ? null : dispatch.messageId ?? mapping.committedMessageId,
      pendingSync: retireThread ? null : mapping.pendingSync,
      dispatch: null,
      lastReconciliation,
    }
    this.assertAuthLeaseCurrent(lease)
    writeMapping(request.session, next)
    try {
      // One Session flush commits the reconciliation record and barrier release
      // together; if it fails, this runtime remains fail-closed.
      await this.ctx.sessions.flush(request.session)
      this.assertAuthLeaseCurrent(lease)
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
    lease: AuthBoundOperationLease,
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
    await this.resumeAndVerifyThread(client, reconciliation.threadId, cwd, lease)
    const turn = await this.findDispatchedTurn(
      client,
      reconciliation.threadId,
      reconciliation.turnId,
      reconciliation.clientUserMessageId,
      lease,
    )
    this.assertAuthLeaseCurrent(lease)
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
    lease: AuthBoundOperationLease,
  ): Promise<void> {
    await this.requestForAuthLease(lease, client, 'thread/resume', { threadId }, 20_000)
    const response = jsonObject(await this.requestForAuthLease(lease, client, 'thread/read', { threadId }, 20_000), 'reconciled thread')
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
    lease: AuthBoundOperationLease,
  ): Promise<JsonObject | undefined> {
    const response = jsonObject(await this.requestForAuthLease(lease, client, 'thread/turns/list', {
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
    lease: AuthBoundOperationLease,
    reconcile?: () => Promise<Record<string, unknown> | undefined>,
  ): Promise<Record<string, unknown>> {
    const done = Promise.withResolvers<Record<string, unknown>>()
    const previous = this.turnWaiters.get(threadId)
    if (previous !== undefined) throw new Error('Codex thread already has an active turn waiter.')
    this.turnWaiters.set(threadId, { turnId, resolve: done.resolve, reject: done.reject, request, lease, completion: done.promise })
    const active = this.activeTurns.get(threadId)
    if (active?.turnId === turnId && active.terminal !== undefined) done.resolve(active.terminal)
    const onAbort = (): void => {
      void this.requestForAuthLease(lease, client, 'turn/interrupt', { threadId, turnId }, 8_000).catch(() => {})
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
      void this.requestForAuthLease(lease, client, 'turn/interrupt', { threadId, turnId }, 8_000).catch(() => {})
      done.reject(new Error('Codex turn did not reach a terminal event before the deadline.'))
    }, 20 * 60_000)
    try {
      const terminal = await done.promise
      this.assertAuthLeaseCurrent(lease)
      return terminal
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
    readonly lease: AuthBoundOperationLease
    readonly completion: Promise<Record<string, unknown>>
  }>()

  private async onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const threadId = requiredString(params.threadId, 'approval thread id')
      const turnId = requiredString(params.turnId, 'approval turn id')
      const active = this.activeTurns.get(threadId)
      if (active === undefined || active.turnId !== turnId) throw new Error('Codex approval did not match an active DSH turn.')
      this.assertAuthLeaseCurrent(active.lease)
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
      this.assertAuthLeaseCurrent(active.lease)
      if (this.activeTurns.get(threadId) !== active) {
        throw new StaleAuthStateResultError()
      }
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
      this.assertAuthLeaseCurrent(active.lease)
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
