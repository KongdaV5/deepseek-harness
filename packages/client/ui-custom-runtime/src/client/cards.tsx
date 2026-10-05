/** View-only runtime controls inside the canonical Models footer. */
import { useEffect } from 'react'
import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { RuntimeSettingsModel } from './model.ts'
import type { CopyKey } from './locales.ts'
import css from './cards.module.css'
/** Slot-bound observable read face and explicit interaction commands. */
export interface RuntimeCardsInjected {
  hooks: { runtime: RuntimeSettingsModel }
  model: RuntimeSettingsModel
  t(key: CopyKey): string
}
/** Render observed status without inferring healthy state from configured intent.
 * @param props - Renderer-bound observable hook, copy, and explicit controls.
 * @returns Local and subscription control cards.
 */
export function RuntimeCards({ useRuntime, model, t }: InjectFace<RuntimeCardsInjected>) {
  const state = useRuntime(value => value)
  useEffect(() => { void model.refresh() }, [model])
  const action = (operation: () => Promise<unknown>) => { void model.run(operation) }
  const local = state.local
  const localState = local === undefined
    ? state.loading ? 'checking' : 'unavailable'
    : !local.enabled ? 'disabled'
      : !local.available ? 'unavailable'
        : local.state === 'running' ? 'ready'
          : local.state === 'error' ? 'runtimeError'
            : local.state
  return <section className={css.section} aria-label={t('title')}>
    <h3>{t('title')}</h3>
    {state.error === undefined ? null : <p role="alert">{state.error}</p>}
    <fieldset className={css.card} disabled={state.loading || state.local?.enabled !== true}><legend>{t('local')}</legend>
      <p className={css.hint}>{t('localHint')}</p>
      <p role="status"><strong>{t('localRuntime')}</strong> · {t(localState)}</p>
      {local?.endpoint === undefined ? null : <p className={css.endpoint}>{t('endpoint')}: <code>{local.endpoint}</code></p>}
      {state.local?.error === undefined ? null : <p role="alert">{state.local.error}</p>}
      <ul className={css.profiles} aria-label={t('profiles')}>
        {local?.profiles.map((profile) => {
          const isCurrent = local.profile === profile.id
          const isRunning = isCurrent && local.state === 'running'
          const profileState = !profile.available ? 'unavailable'
            : isCurrent ? !local.enabled ? 'disabled'
              : !local.available ? 'unavailable'
                : local.state === 'running' ? 'running'
                  : local.state === 'error' ? 'runtimeError' : local.state
              : 'stopped'
          const canManage = local.enabled && profile.available && profile.manageable
          return <li key={profile.id} className={css.profile} data-state={profileState}>
            <div className={css.profileInfo}>
              <strong className={css.profileName}>{profile.name}</strong>
              <div className={css.badges}>
                <span className={css.badge}>{t(profile.modality)}</span>
                {isCurrent && <span className={css.badge} data-kind="current">{t('current')}</span>}
                <span className={css.badge} data-state={profileState}>{t(profileState)}</span>
              </div>
              {!profile.available && <span className={css.profileError}>{profile.unavailableReason ?? t('unavailable')}</span>}
            </div>
            <div className={css.actions}>
              {isRunning && local.canStop && profile.manageable
                ? <>
                  <Button aria-label={`${t('restart')} ${profile.name}`} disabled={!canManage}
                    onClick={() => { action(() => model.operations.restart(profile.id)) }}>{t('restart')}</Button>
                  <Button aria-label={`${t('stop')} ${profile.name}`} disabled={!canManage}
                    onClick={() => { action(() => model.operations.stop()) }}>{t('stop')}</Button>
                </>
                : <Button aria-label={`${t('start')} ${profile.name}`} disabled={!canManage}
                  onClick={() => { action(() => model.operations.start(profile.id)) }}>{t('start')}</Button>}
            </div>
          </li>
        })}
      </ul>
    </fieldset>
    <fieldset className={css.card} disabled={state.loading || state.codex?.enabled !== true}><legend>{t('codex')}</legend>
      <p className={css.hint}>{t('codexHint')}</p>
      <p role="status">{state.codex === undefined ? t('unknown') : <>
        {t(state.codex.runtime)} · {t(state.codex.login === 'signing-in' ? 'signing-in' : state.codex.account)}
      </>}</p>
      {state.codex?.error === undefined ? null : <p role="alert">{state.codex.error}</p>}
      <SegmentedControl id="custom-codex-runtime" label={t('runtime')} value={state.codex?.runtimePreference ?? 'auto'}
        options={[{ value: 'auto', label: t('auto') }, { value: 'system', label: t('system'), disabled: !state.codex?.systemRuntimeAvailable }, { value: 'bundled', label: t('bundled') }]}
        disabled={state.loading} onChange={(preference) => { action(() => model.operations.select(preference)) }} />
      <div role="tabpanel" id={`custom-codex-runtime-${state.codex?.runtimePreference ?? 'auto'}-panel`} aria-labelledby={`custom-codex-runtime-${state.codex?.runtimePreference ?? 'auto'}`}>
        {t('source')}: {state.codex?.runtimeSource === undefined ? t('unknown') : t(state.codex.runtimeSource)} · {state.codex?.runtimeVersion ?? t('unknown')}
      </div>
      {state.codex?.runtimeSelectionNote === undefined ? null : <p role="status">{state.codex.runtimeSelectionNote}</p>}
      {state.codex?.account !== 'connected' ? null : <p>{t('modelsAvailable')}: {state.codex.modelCount}</p>}
      {state.codex?.usage.state === 'available' && (state.codex.usage.primary !== undefined || state.codex.usage.secondary !== undefined)
        ? (['primary', 'secondary'] as const).map((kind) => {
          const window = state.codex?.usage[kind]
          if (window === undefined) return null
          const reset = window.resetsAt === undefined ? undefined : new Date(window.resetsAt * 1000)
          return <p key={kind}>
            {t(kind === 'primary' ? 'primaryUsage' : 'secondaryUsage')}: {window.usedPercent}%
            {window.windowDurationMins === undefined ? null : ` · ${window.windowDurationMins} ${t('minutes')}`}
            {reset === undefined ? null : <> · {t('resets')}: <time dateTime={reset.toISOString()}>{reset.toLocaleString()}</time></>}
          </p>
        })
        : <p>{t('unavailableUsage')}</p>}
      <Button onClick={() => { action(() => model.operations.reconnect()) }}>{t('reconnect')}</Button>
      <Button disabled={state.codex?.account === 'connected' || state.codex?.login === 'signing-in'} onClick={() => { action(() => model.operations.connect()) }}>{t('connect')}</Button>
      <Button disabled={state.codex?.login !== 'signing-in'} onClick={() => { action(() => model.operations.cancelLogin()) }}>{t('cancelLogin')}</Button>
      <Button disabled={state.codex?.account !== 'connected'} onClick={() => { action(() => model.operations.disconnect()) }}>{t('disconnect')}</Button>
    </fieldset>
    <Button disabled={state.loading} onClick={() => { void model.refresh() }}>{t('refresh')}</Button>
  </section>
}
