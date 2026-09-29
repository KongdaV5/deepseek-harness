/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm/listProviders` joined with `llm/listConfigurableProviders`),
 * the settings namespaces (shared settings mirror),
 * and the referenced credentials (`credentials/describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CodexRuntimePreference, CodexSubscriptionStatusView, CredentialInfo, LocalModelProfileId, LocalModelRuntimeSnapshot,
  LlmConfigurableProvider, LlmProviderInfo, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row after joining the configurable directory with live routes. */
export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
  readonly error?: string
}

/**
 * Join declared configurable providers with the currently registered routes.
 * @param registered - live provider routes in registration order.
 * @param directory - declared configurable providers in declaration order.
 * @returns declared rows followed by live routes with no declaration.
 */
export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
    ...entry.error === undefined ? {} : { error: entry.error },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows
}

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ProviderDirectoryEntry
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialInfo | undefined
  /**
   * Credential state for the page's derived `<ROUTE>_API_KEY`, described only
   * while the profile names no reference — the provider-card seat's
   * `keyConfigured` fact for dormant and keyless rows, matching the editor's
   * own derivation rule.
   */
  derivedCredential?: CredentialInfo
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Latest process and endpoint probe from the existing local-model manager. */
  localRuntime?: LocalModelRuntimeSnapshot
  /** Latest local runtime control error, if an action or probe failed. */
  localRuntimeError?: string | null
  /** Whether a start, stop, or restart Remote call is still pending. */
  localRuntimeBusy?: boolean
  /** Renderer-safe state for the isolated official Codex App Server integration. */
  codexSubscription?: CodexSubscriptionStatusView
  /** Last status/action error from the Codex subscription integration. */
  codexSubscriptionError?: string | null
  /** Whether an explicit login/reconnect/disconnect action is pending. */
  codexSubscriptionBusy?: boolean
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0
  private runtimeRequestPending = false
  private codexStatusRequestPending = false

  /**
   * @param ctx - the page plugin's context, whose `remote.llm` and
   * `remote.credentials` namespaces carry the directory and credential reads.
   * @param schema - settings-owned schema and immutable path operations.
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the mirror's
   * settings answer in parallel, then one batched credential describe over
   * every referenced ref. Provider failure or absence of an initial settings
   * answer keeps the last good rows and surfaces an error; a failed settings
   * refresh reuses the mirror's held view.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    const [registered, declared] = await Promise.all([
      this.ctx.remote.llm.listProviders(),
      this.ctx.remote.llm.listConfigurableProviders(),
      this.describeFace.ensure(),
    ])
    if (!registered.ok) { this.failLoad(generation, registered.error.message); return }
    if (!declared.ok) { this.failLoad(generation, declared.error.message); return }
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      this.failLoad(generation, mirrored.error ?? 'settings are unavailable in this browser')
      return
    }
    const providers = joinProviderDirectory(registered.value, declared.value)
    const writable = mirrored.view.writable
    const views: readonly SettingsNamespaceView[] = mirrored.view.namespaces
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.map(row => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
    let credentials: Record<string, CredentialInfo> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      const response = await this.ctx.remote.credentials.describe(refs)
      // Credential state is an enrichment for the Models page: a failure
      // degrades the badge instead of failing the load. The onboarding
      // projection below retains the failure distinction.
      if (response.ok) credentials = response.value
      else credentialError = response.error.message
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map((row) => {
        const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
        const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
        return {
          ...row,
          ...named === undefined ? {} : { credential: named },
          ...derived === undefined ? {} : { derivedCredential: derived },
        }
      })
      s.namespaces = namespaces
    })
  }

  /** Poll the Host-owned status without mirroring browser-local timer state into the component.
   * @param intervalMs - Delay between status requests in milliseconds.
   * @returns A function that stops this polling loop.
   */
  startLocalRuntimePolling(intervalMs = 4000): () => void {
    const localModels: unknown = Reflect.get(this.ctx.remote, 'localModels')
    const status: unknown = typeof localModels === 'object' && localModels !== null
      ? Reflect.get(localModels, 'status')
      : undefined
    if (typeof status !== 'function') return () => undefined
    let active = true
    let disabled = false
    const poll = async (): Promise<void> => {
      if (!active || disabled) return
      await this.refreshLocalRuntime()
      disabled = this.store.getSnapshot().localRuntime?.enabled === false
      if (disabled) clearInterval(timer)
    }
    const timer = setInterval(() => { void poll() }, intervalMs)
    void poll()
    return () => {
      active = false
      clearInterval(timer)
    }
  }

  /** Start the lazy Codex runtime only while its existing Models settings card is mounted.
   * @param intervalMs - Delay between status requests in milliseconds.
   * @returns A function that stops this polling loop.
   */
  startCodexSubscriptionPolling(intervalMs = 5000): () => void {
    let active = true
    let disabled = false
    const poll = async (): Promise<void> => {
      if (!active || disabled) return
      disabled = await this.refreshCodexSubscription() === false
      if (disabled) clearInterval(timer)
    }
    const timer = setInterval(() => { void poll() }, intervalMs)
    void poll()
    return () => {
      active = false
      clearInterval(timer)
    }
  }

  /** Read only the renderer-safe runtime/account/model-count projection.
   * @returns Whether the Codex runtime remains enabled, or undefined when status is unavailable.
   */
  async refreshCodexSubscription(): Promise<boolean | undefined> {
    if (this.codexStatusRequestPending) return undefined
    this.codexStatusRequestPending = true
    try {
      const response = await this.ctx.remote.settings.codexSubscriptionStatus()
      if (response.ok) {
        const previous = this.store.getSnapshot().codexSubscription
        if (response.value.enabled || previous !== undefined) {
          this.store.update((state) => {
            state.codexSubscription = response.value
            state.codexSubscriptionError = null
          })
        }
        return response.value.enabled
      } else {
        this.store.update((state) => { state.codexSubscriptionError = response.error.message })
      }
    } catch (error) {
      this.store.update((state) => { state.codexSubscriptionError = errorMessage(error) })
    } finally {
      this.codexStatusRequestPending = false
    }
    return undefined
  }

  /** Explicitly open the official ChatGPT subscription sign-in flow. */
  connectCodexSubscription(): Promise<void> {
    return this.runCodexSubscriptionAction(async () => {
      const response = await this.ctx.remote.settings.connectCodexSubscription()
      return response.ok ? undefined : response.error.message
    })
  }

  /** Cancel the active official browser login transaction.
   * @returns A promise that settles after the cancellation and status refresh.
   */
  cancelCodexSubscriptionLogin(): Promise<void> {
    return this.runCodexSubscriptionAction(async () => {
      const response = await this.ctx.remote.settings.cancelCodexSubscriptionLogin()
      return response.ok ? undefined : response.error.message
    })
  }

  /** Restart only the Codex App Server process owned by this DSH instance.
   * @returns A promise that settles after reconnection and status refresh.
   */
  reconnectCodexSubscription(): Promise<void> {
    return this.runCodexSubscriptionAction(async () => {
      const response = await this.ctx.remote.settings.reconnectCodexSubscription()
      return response.ok ? undefined : response.error.message
    })
  }

  /** Log out from the dedicated DSH Codex home.
   * @returns A promise that settles after logout and status refresh.
   */
  disconnectCodexSubscription(): Promise<void> {
    return this.runCodexSubscriptionAction(async () => {
      const response = await this.ctx.remote.settings.disconnectCodexSubscription()
      return response.ok ? undefined : response.error.message
    })
  }

  /** Persist and activate the selected Codex App Server source at an idle boundary.
   * @param preference - the selected automatic, system, or bundled runtime source.
   */
  selectCodexRuntime(preference: CodexRuntimePreference): Promise<void> {
    return this.runCodexSubscriptionAction(async () => {
      const response = await this.ctx.remote.settings.selectCodexRuntime(preference)
      return response.ok ? undefined : response.error.message
    })
  }

  private async runCodexSubscriptionAction(action: () => Promise<string | undefined>): Promise<void> {
    this.store.update((state) => {
      state.codexSubscriptionBusy = true
      state.codexSubscriptionError = null
    })
    try {
      const failure = await action()
      if (failure !== undefined) {
        this.store.update((state) => { state.codexSubscriptionError = failure })
      }
      await this.refreshCodexSubscription()
    } catch (error) {
      this.store.update((state) => { state.codexSubscriptionError = errorMessage(error) })
    } finally {
      this.store.update((state) => { state.codexSubscriptionBusy = false })
    }
  }

  /** Read LaunchAgent state and the local model endpoint afresh. */
  async refreshLocalRuntime(): Promise<void> {
    if (this.runtimeRequestPending) return
    this.runtimeRequestPending = true
    try {
      const response = await this.ctx.remote.localModels.status()
      if (response.ok) {
        this.store.update((state) => {
          state.localRuntime = response.value
          state.localRuntimeError = null
        })
      } else {
        this.store.update((state) => { state.localRuntimeError = response.error.message })
      }
    } catch (error) {
      this.store.update((state) => { state.localRuntimeError = errorMessage(error) })
    } finally {
      this.runtimeRequestPending = false
    }
  }

  /** Start one allowlisted profile and publish its health-confirmed answer.
   * @param profile - The allowlisted local model profile to start.
   */
  startLocalModel(profile: LocalModelProfileId): Promise<void> {
    return this.runLocalRuntimeAction(() => this.ctx.remote.localModels.start(profile))
  }

  /** Stop the managed model after its job and shared port are released. */
  stopLocalModel(): Promise<void> {
    return this.runLocalRuntimeAction(() => this.ctx.remote.localModels.stop())
  }

  /** Restart the selected profile after the current model has fully stopped.
   * @param profile - The allowlisted local model profile to restart.
   */
  restartLocalModel(profile: LocalModelProfileId): Promise<void> {
    return this.runLocalRuntimeAction(() => this.ctx.remote.localModels.restart(profile))
  }

  private async runLocalRuntimeAction(
    action: () => ReturnType<ClientContext['remote']['localModels']['start']>,
  ): Promise<void> {
    this.store.update((state) => {
      state.localRuntimeBusy = true
      state.localRuntimeError = null
    })
    try {
      const response = await action()
      if (response.ok) {
        this.store.update((state) => {
          state.localRuntime = response.value
          state.localRuntimeError = null
        })
      } else {
        this.store.update((state) => { state.localRuntimeError = response.error.message })
        await this.refreshLocalRuntime()
      }
    } catch (error) {
      this.store.update((state) => { state.localRuntimeError = errorMessage(error) })
    } finally {
      this.store.update((state) => { state.localRuntimeBusy = false })
    }
  }

  /** Publish one load's failure text, unless a newer load already took over. */
  private failLoad(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'error'
      s.error = message
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
