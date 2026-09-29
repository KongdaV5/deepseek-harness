/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows expose only confirmed API-key state through accessible
 * solid configured or missing dots. A whole-section provider without a
 * configured key renders as its open setup card instead of a row, but only in
 * the first-run posture — no provider on the page can serve requests yet — and
 * only until the user closes that card; the add flow is a card carrying the
 * dormant-provider select. Each card kind owns its own open state, so closing
 * one never discards a draft in another. Every mutation writes through the
 * wire, while a provider removal first requires confirmation; the page
 * re-renders from pushed invalidations or the post-apply reload.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CodexRuntimePreference, CodexSubscriptionStatusView, LocalModelRuntimeProfile, LocalModelRuntimeSnapshot, LocalModelRuntimeState,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls this package's SlotMap merge (the two Models child slots).
import type {} from './slot-contract.ts'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { deriveKeyRef, protocolChoices, providerUsable } from './store.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** The Host operations the section and its cards invoke. */
  operations: ModelsOperations
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** The child slots this section declares and dispatches (see ./slot-contract.ts). */
type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'

/** The child-slot dispatch function the renderer binds for the section. */
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call) plus the child-slot
 * dispatch seat. The seat is required: the renderer binds it at the render
 * call itself — unlike the inject face it is never absent at runtime — and a
 * direct render that forgets it fails to compile instead of mounting nothing.
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>

type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
}

/** Values that vary around the shared provider-editor rendering. */
interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'schema' | 'operations' | 't' | 'readOnly' | 'onClose'
> {
  target: EditorTarget
}

/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...props}
    />
  )
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param operations - the page's Host operations.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  operations: ModelsOperations,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  if (target.credentialRef !== undefined) {
    const credential = await operations.removeCredential(target.credentialRef)
    if (credential !== undefined) return credential
  }
  const written = await operations.writeSettings(
    target.settingsNs,
    [{ op: 'unset', path: [...target.settingsPath] }],
    undefined,
  )
  if (written.kind !== 'written') return written.message
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable) return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

/**
 * The provider-card seat's credential fact: the reference this page would use
 * for the row — the profile's `apiKeyEnv`, or the page's derived
 * `<ROUTE>_API_KEY` while the profile names none — confirmed configured. The
 * derived half is what keeps the seat consistent with the editor on the
 * add-provider draft, whose dormant row names no reference yet.
 */
function keyConfiguredOf(row: ProviderRow): boolean {
  return row.apiKeyEnv !== undefined
    ? row.credential?.configured === true
    : row.derivedCredential?.configured === true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Only declared routes may expose route-owned fields.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/** Whether a configured provider URL names the managed local-model endpoint. */
function isManagedLocalEndpoint(baseUrl: string | undefined, endpoint: string | undefined): boolean {
  if (baseUrl === undefined || endpoint === undefined) return false
  try {
    const base = new URL(baseUrl)
    const managed = new URL(endpoint)
    return base.origin === managed.origin
      && base.pathname.replace(/\/+$/u, '') === managed.pathname.replace(/\/+$/u, '')
  } catch {
    return false
  }
}

const runtimeStateCopy: Record<LocalModelRuntimeState, keyof typeof en> = {
  stopped: 'localRuntimeStopped',
  starting: 'localRuntimeStarting',
  running: 'localRuntimeRunning',
  stopping: 'localRuntimeStopping',
  error: 'localRuntimeFailed',
}

function providerBaseUrl(
  row: ProviderRow,
  namespaces: ReadonlyMap<string, import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView>,
  schema: SettingsSchemaOperations,
): string | undefined {
  const namespace = namespaces.get(row.entry.settingsNs)
  const value = namespace === undefined ? undefined : schema.getPath(namespace.value, row.entry.settingsPath)
  return typeof value === 'object' && value !== null && 'baseURL' in value && typeof value.baseURL === 'string'
    ? value.baseURL
    : undefined
}

function localStatusClass(state: LocalModelRuntimeState | 'unknown'): string | undefined {
  switch (state) {
    case 'running': return styles['runtimeDotRunning']
    case 'starting': return styles['runtimeDotStarting']
    case 'stopping': return styles['runtimeDotStopping']
    case 'error': return styles['runtimeDotError']
    case 'stopped':
    case 'unknown': return styles['runtimeDotStopped']
  }
}

function localProviderStatus(
  baseUrl: string | undefined,
  snapshot: LocalModelRuntimeSnapshot | undefined,
): { readonly state: LocalModelRuntimeState | 'unknown'; readonly label: keyof typeof en } | undefined {
  if (baseUrl === undefined) return undefined
  let local = false
  try {
    const url = new URL(baseUrl)
    local = url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
        || url.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname))
  } catch { local = false }
  if (!local) return undefined
  if (snapshot === undefined || !isManagedLocalEndpoint(baseUrl, snapshot.endpoint)) {
    return { state: 'unknown', label: 'localRuntimeUnmanaged' }
  }
  return { state: snapshot.state, label: runtimeStateCopy[snapshot.state] }
}

function LocalRuntimePanel({
  snapshot, error, busy, controller, t,
}: {
  snapshot: LocalModelRuntimeSnapshot
  error: string | null | undefined
  busy: boolean | undefined
  controller: ModelsSettingsStore
  t: ModelsSectionInjected['t']
}): ReactNode {
  if (!snapshot.enabled) return null
  const transitioning = snapshot.state === 'starting' || snapshot.state === 'stopping'
  const actionPending = busy === true || transitioning
  return (
    <section className={styles['runtimePanel']} aria-labelledby="local-runtime-title">
      <div className={styles['runtimeHeader']}>
        <h3 id="local-runtime-title" className={styles['runtimeTitle']}>{t('localRuntimeTitle')}</h3>
        <span className={styles['runtimeEndpoint']}>{snapshot.endpoint}</span>
      </div>
      <p className={styles['runtimeDescription']}>{t('localRuntimeDescription')}</p>
      {snapshot.error === undefined && error == null ? null : (
        <p role="alert" className={styles['runtimeError']}>
          {snapshot.error ?? error}
        </p>
      )}
      <ul className={styles['runtimeProfiles']}>
        {snapshot.profiles.map(profile => (
          <LocalRuntimeProfileRow
            key={profile.id}
            profile={profile}
            snapshot={snapshot}
            busy={actionPending}
            controller={controller}
            t={t}
          />
        ))}
      </ul>
    </section>
  )
}

function LocalRuntimeProfileRow({
  profile, snapshot, busy, controller, t,
}: {
  profile: LocalModelRuntimeProfile
  snapshot: LocalModelRuntimeSnapshot
  busy: boolean
  controller: ModelsSettingsStore
  t: ModelsSectionInjected['t']
}): ReactNode {
  const current = snapshot.profile === profile.id
  const state: LocalModelRuntimeState = current ? snapshot.state : 'stopped'
  const running = current && state === 'running'
  const canStart = profile.manageable && profile.available === true && snapshot.available
  const disabled = busy || !canStart
  const actionLabel = running
    ? t('localRuntimeStop')
    : snapshot.state === 'running' ? t('localRuntimeSwitch') : t('localRuntimeStart')
  return (
    <li className={styles['runtimeProfile']}>
      <div className={styles['runtimeProfileIdentity']}>
        <span className={`${styles['runtimeDot']} ${localStatusClass(state)}`} aria-hidden="true" />
        <span className={styles['runtimeProfileName']}>{profile.name}</span>
        <span className={styles['runtimeModality']}>{t(profile.modality === 'image' ? 'localRuntimeImage' : 'localRuntimeText')}</span>
        <span className={styles['runtimeState']}>{t(runtimeStateCopy[state])}</span>
      </div>
      <span className={styles['runtimeActions']}>
        {running ? (
          <>
            <button type="button" className={styles['runtimeButton']} disabled={busy} onClick={() => { void controller.stopLocalModel() }}>
              {t('localRuntimeStop')}
            </button>
            <button type="button" className={styles['runtimeButton']} disabled={busy} onClick={() => { void controller.restartLocalModel(profile.id) }}>
              {t('localRuntimeRestart')}
            </button>
          </>
        ) : snapshot.state === 'error' && snapshot.canStop ? (
          <button type="button" className={styles['runtimeButton']} disabled={busy} onClick={() => { void controller.stopLocalModel() }}>
            {t('localRuntimeStop')}
          </button>
        ) : (
          <button
            type="button"
            className={styles['runtimeButton']}
            disabled={disabled}
            title={canStart ? undefined : profile.unavailableReason ?? t('localRuntimeProfileUnavailable')}
            onClick={() => { void controller.startLocalModel(profile.id) }}
          >
            {canStart ? actionLabel : t('localRuntimeUnavailable')}
          </button>
        )}
      </span>
    </li>
  )
}

function CodexSubscriptionPanel({
  snapshot, error, busy, controller, t,
}: {
  snapshot: CodexSubscriptionStatusView
  error: string | null | undefined
  busy: boolean | undefined
  controller: ModelsSettingsStore
  t: ModelsSectionInjected['t']
}): ReactNode {
  if (!snapshot.enabled) return null
  const accountKey: keyof typeof en = snapshot.login === 'signing-in'
    ? 'codexSigningIn'
    : snapshot.account === 'connected'
      ? 'codexConnected'
      : snapshot.account === 'reauth-required'
        ? 'codexReauthRequired'
        : snapshot.account === 'error'
          ? 'codexAccountError'
          : 'codexNotConnected'
  const runtimeKey: keyof typeof en = snapshot.runtime === 'ready'
    ? 'codexRuntimeReady'
    : snapshot.runtime === 'crashed'
      ? 'codexRuntimeCrashed'
      : snapshot.runtime === 'error'
        ? 'codexRuntimeError'
        : snapshot.runtime === 'stopped'
          ? 'codexRuntimeStopped'
          : 'codexRuntimeStarting'
  const actionPending = busy === true
  return (
    <section className={styles['runtimePanel']} aria-labelledby="codex-subscription-title" aria-busy={actionPending}>
      <div className={styles['runtimeHeader']}>
        <h3 id="codex-subscription-title" className={styles['runtimeTitle']}>{t('codexTitle')}</h3>
        <span className={styles['runtimeEndpoint']}>{t('codexSubtitle')}</span>
      </div>
      <div className={styles['runtimeProfileIdentity']} role="status" aria-live="polite">
        <span className={`${styles['runtimeDot']} ${snapshot.account === 'connected' ? styles['runtimeDotRunning'] : snapshot.account === 'error' ? styles['runtimeDotError'] : styles['runtimeDotStopped']}`} aria-hidden="true" />
        <span className={styles['runtimeState']}>{t(runtimeKey)}</span>
        <span className={styles['runtimeState']}>{t(accountKey)}</span>
        {snapshot.account === 'connected' ? (
          <>
            <span className={styles['runtimeState']}>{`${snapshot.modelCount} ${t('codexModelsAvailable')}`}</span>
            <span className={styles['runtimeState']}>{codexUsageSummary(snapshot.usage, t)}</span>
          </>
        ) : null}
      </div>
      <label className={styles['runtimePicker']}>
        <span>{t('codexRuntimeSetting')}</span>
        <select
          aria-label={t('codexRuntimeSetting')}
          value={snapshot.runtimePreference}
          disabled={actionPending}
          onChange={(event) => { void controller.selectCodexRuntime(event.currentTarget.value as CodexRuntimePreference) }}
        >
          <option value="auto">{`${t('codexRuntimeAutomatic')} · ${snapshot.runtimeSource === 'system'
            ? `${t('codexRuntimeSystem')} ${snapshot.runtimeVersion ?? ''}`
            : `${t('codexRuntimeBundled')} ${snapshot.runtimeVersion ?? snapshot.bundledRuntimeVersion}`}`}</option>
          <option value="system" disabled={!snapshot.systemRuntimeAvailable}>
            {`${t('codexRuntimeSystem')}${snapshot.systemRuntimeVersion === undefined ? '' : ` · ${snapshot.systemRuntimeVersion}`}`}
          </option>
          <option value="bundled">{`${t('codexRuntimeBundled')} · ${snapshot.bundledRuntimeVersion}`}</option>
        </select>
      </label>
      {snapshot.runtimeSelectionNote === undefined ? null : (
        <p className={styles['runtimeDescription']} role="status">{snapshot.runtimeSelectionNote}</p>
      )}
      {snapshot.error === undefined && error == null ? null : (
        <p role="alert" className={styles['runtimeError']}>{snapshot.error ?? error}</p>
      )}
      <span className={styles['runtimeActions']}>
        {snapshot.login === 'signing-in' ? (
          <button type="button" className={styles['runtimeButton']} disabled={actionPending} onClick={() => { void controller.cancelCodexSubscriptionLogin() }}>
            {t('codexCancelLogin')}
          </button>
        ) : snapshot.account === 'connected' ? (
          <>
            <button type="button" className={styles['runtimeButton']} disabled={actionPending} onClick={() => { void controller.reconnectCodexSubscription() }}>
              {t('codexReconnect')}
            </button>
            <button type="button" className={styles['runtimeButton']} disabled={actionPending} onClick={() => { void controller.disconnectCodexSubscription() }}>
              {t('codexDisconnect')}
            </button>
          </>
        ) : (
          <button type="button" className={styles['runtimeButton']} disabled={actionPending} onClick={() => { void controller.connectCodexSubscription() }}>
            {snapshot.account === 'reauth-required' ? t('codexConnectAgain') : t('codexConnect')}
          </button>
        )}
      </span>
    </section>
  )
}

function codexUsageSummary(
  usage: CodexSubscriptionStatusView['usage'],
  t: ModelsSectionInjected['t'],
): string {
  if (usage.state !== 'available') return t('codexUsageUnavailable')
  const windows = [usage.primary, usage.secondary].flatMap((window) => {
    if (window === undefined) return []
    const minutes = window.windowDurationMins
    const duration = minutes === undefined
      ? t('codexUsageWindow')
      : minutes % 10_080 === 0
        ? `${minutes / 10_080}w`
        : minutes % 1_440 === 0
          ? `${minutes / 1_440}d`
          : minutes % 60 === 0
            ? `${minutes / 60}h`
            : `${minutes}m`
    return [`${duration} ${window.usedPercent}% ${t('codexUsageUsed')}`]
  })
  return windows.length === 0 ? t('codexUsageUnavailable') : `${t('codexUsageLabel')}: ${windows.join(' · ')}`
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, operations, schema, t, renderSlot } = props
  if (
    controller === undefined || useSnapshot === undefined || operations === undefined
    || schema === undefined || t === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, operations, schema, t }} renderSlot={renderSlot} />
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace; renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, operations, schema, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  useEffect(() => {
    const stopLocalPolling = controller.startLocalRuntimePolling()
    const stopCodexPolling = controller.startCodexSubscriptionPolling()
    return () => {
      stopLocalPolling()
      stopCodexPolling()
    }
  }, [controller])
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [declaring, setDeclaring] = useState(false)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => { setSavedTarget(target) })
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    setEditing(undefined)
    setAdding(false)
    setDeclaring(false)
    if (changed) announceSaved(target)
  }

  /**
   * Close a setup card, which owns none of the state above: the row-editor,
   * add, and declare cards each own one of those, so clearing them here would
   * discard a draft the user opened beside this card. Dismissal is this card's
   * own — the provider falls back to an ordinary row for the rest of the
   * session, and reopens through Edit.
   */
  const closeSetup = (changed: boolean, target: ProviderIdentity): void => {
    setDismissedSetup(previous => new Set([...previous, target.provider]))
    if (changed) announceSaved(target)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(operations, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  // One fact decides both first-run postures on this page and the onboarding
  // step: whether the user already has a provider to talk to.
  const anyUsable = state.rows.some(providerUsable)
  const configured = state.rows.filter(row => row.configured)
  const configurable = state.rows.filter(row => state.namespaces.has(row.entry.settingsNs))
  const addable = configurable.filter(row => !row.configured)
  const addTarget = adding ? editing : undefined
  const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
  // The draft's directory row, for the card extension seat. A refresh can drop
  // the row mid-draft (the route was adopted or withdrawn elsewhere); the
  // draft card stays while the seat simply has no row to dispatch.
  const addRow = addTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === addTarget.provider)
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the entry point stays disabled.
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'), schema)

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {state.status === 'idle' || state.status === 'loading'
        ? <p className={styles['loading']} role="status" aria-live="polite">{t('loading')}</p>
        : null}
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      {state.localRuntime?.enabled === true
        ? (
          <LocalRuntimePanel
            snapshot={state.localRuntime}
            error={state.localRuntimeError}
            busy={state.localRuntimeBusy}
            controller={controller}
            t={t}
          />
        )
        : null}
      {state.codexSubscription?.enabled === true
        ? (
          <CodexSubscriptionPanel
            snapshot={state.codexSubscription}
            error={state.codexSubscriptionError}
            busy={state.codexSubscriptionBusy}
            controller={controller}
            t={t}
          />
        )
        : null}
      <ul className={styles['rows']}>
        {configured.map((row) => {
          const target = targetOf(row)
          const namespace = state.namespaces.get(target.settingsNs)
          /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
          if (namespace === undefined) return null
          const error = row.entry.error === undefined
            ? null
            : <p role="alert" className={styles['error']}>{row.entry.error}</p>
          if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
            // First-run posture: the provider exists but has no key — the
            // setup card IS its presence on the page, until the user closes it.
            return (
              <li key={row.entry.provider} className={styles['setupCard']}>
                {error}
                {renderProviderEditor({
                  target,
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeSetup(changed, target) },
                })}
                {renderSlot(
                  'settings.models.provider-card',
                  { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                  { entryKey: row.entry.settingsNs },
                )}
              </li>
            )
          }
          const open = !adding && editing?.provider === row.entry.provider
          const credentialConfigured = row.credential?.configured === true
          const credentialMissing = !credentialConfigured
            && row.apiKeyEnv !== undefined
            && row.credential?.configured === false
          const localStatus = localProviderStatus(providerBaseUrl(row, state.namespaces, schema), state.localRuntime)
          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowIdentity']}>
                  <span className={styles['rowName']}>{row.entry.displayName}</span>
                  {/* Only the adapter can tell a hand-declared route from a
                      shipped one it also has a stored profile for, so the tag
                      follows its answer and stays off when it gives none. */}
                  {row.entry.declared === true
                    ? <span className={styles['rowTag']}>{t('customTag')}</span>
                    : null}
                  {localStatus !== undefined
                    ? (
                      <span
                        className={`${styles['runtimeDot']} ${localStatusClass(localStatus.state)}`}
                        role="img"
                        aria-label={t(localStatus.label)}
                        title={t(localStatus.label)}
                      />
                    )
                    : credentialConfigured
                      ? (
                        <span
                          className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                          role="img"
                          aria-label={t('credentialConfigured')}
                          title={t('credentialConfigured')}
                        />
                      )
                      : credentialMissing
                        ? (
                          <span
                            className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                            role="img"
                            aria-label={t('credentialMissing')}
                            title={t('credentialMissing')}
                          />
                        )
                        : null}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    aria-label={providerCopy(t('editProvider'), target)}
                    onClick={() => {
                      setSavedTarget(undefined)
                      // One card at a time: leaving `declaring` set would show
                      // the create card beside this editor, and closing either
                      // one discards the other's draft.
                      setDeclaring(false)
                      setAdding(false)
                      setEditing(open ? undefined : target)
                    }}
                  >
                    {t('edit')}
                  </button>
                  {row.removable
                    ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        aria-label={providerCopy(t('removeProvider'), target)}
                        disabled={!state.writable}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setDeleteFailure(undefined)
                          setDeleteTarget(target)
                        }}
                      >
                        {t('remove')}
                      </button>
                    )
                    : null}
                </span>
              </div>
              {error}
              {renderSlot(
                'settings.models.provider-card',
                { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                { entryKey: row.entry.settingsNs },
              )}
              {open
                ? renderProviderEditor({
                  target,
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeEditor(changed, target) },
                })
                : null}
            </li>
          )
        })}
      </ul>
      <div className={styles['addBlock']}>
        {addTarget !== undefined && addNamespace !== undefined
          ? (
            <div className={styles['addCard']}>
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>{t('provider')}</span>
                <select
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={addTarget.provider}
                  aria-label={t('provider')}
                  onChange={(event) => {
                    const row = addable.find(candidate => candidate.entry.provider === event.target.value)
                    /* v8 ignore next -- the select only lists addable rows */
                    if (row === undefined) return
                    setEditing(targetOf(row))
                  }}
                >
                  {addable.map(row => (
                    <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
                  ))}
                </select>
              </div>
              <ProviderEditor
                key={addTarget.provider}
                provider={addTarget.provider}
                displayName={addTarget.displayName}
                hideTitle
                namespace={addNamespace}
                schema={schema}
                settingsPath={addTarget.settingsPath}
                operations={operations}
                t={t}
                readOnly={!state.writable}
                onClose={(changed) => { closeEditor(changed, addTarget) }}
              />
              {addRow === undefined
                ? null
                : renderSlot(
                  'settings.models.provider-card',
                  { provider: addRow.entry, configured: addRow.configured, keyConfigured: keyConfiguredOf(addRow) },
                  { entryKey: addRow.entry.settingsNs },
                )}
            </div>
          )
          : declaring
            ? (
              <div className={styles['addCard']}>
                <CustomProviderCard
                  taken={state.rows.map(row => row.entry.provider)}
                  protocols={protocols}
                  /* v8 ignore next -- the card only opens from a button disabled without this namespace */
                  revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0}
                  operations={operations}
                  t={t}
                  readOnly={!state.writable}
                  onClose={(changed) => {
                    setDeclaring(false)
                    if (changed) void controller.load()
                  }}
                />
              </div>
            )
            : (
              // One row for the two ways to gain a provider: adopt one the
              // adapter already knows, or declare one it does not. Side by side
              // and equal-width so they read as siblings and line up with the
              // rows above, rather than two pills of different lengths.
              <div className={styles['addActions']}>
                {configurable.length > 0 && (
                  <button
                    type="button"
                    className={styles['addButton']}
                    disabled={addable.length === 0 || !state.writable}
                    onClick={() => {
                      const first = addable[0]
                      /* v8 ignore next -- the button is disabled while nothing is addable */
                      if (first === undefined) return
                      setSavedTarget(undefined)
                      setDeclaring(false)
                      setAdding(true)
                      setEditing(targetOf(first))
                    }}
                  >
                    <IconPlusOutline16 size={14} />
                    {t('add')}
                  </button>
                )}
                {state.namespaces.has('llm-pi-ai') && (
                  <button
                    type="button"
                    className={styles['addButton']}
                    disabled={protocols.length === 0 || !state.writable}
                    onClick={() => {
                      setSavedTarget(undefined)
                      setAdding(false)
                      setEditing(undefined)
                      setDeclaring(true)
                    }}
                  >
                    <IconPlusOutline16 size={14} />
                    {t('customAdd')}
                  </button>
                )}
              </div>
            )}
      </div>
      {renderSlot('settings.models.footer', {})}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
