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
  const currentProfile = local?.profile === null || local?.profile === undefined
    ? undefined
    : local.profiles.find(profile => profile.id === local.profile)?.name
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
      <p role="status"><strong>{t('localRuntime')}</strong> · {t(localState)}{currentProfile === undefined ? '' : ` · ${currentProfile}`}</p>
      {state.local?.error === undefined ? null : <p role="alert">{state.local.error}</p>}
      {state.local?.profiles.map(profile => <div key={profile.id} className={css.profile}>
        <span>{profile.name} · {t(profile.modality)}{state.local?.profile === profile.id ? ` · ${t('current')}` : ''}</span>
        {profile.available ? null : <span>{profile.unavailableReason ?? t('unavailable')}</span>}
        <Button disabled={!state.local?.enabled || !profile.available || !profile.manageable}
          onClick={() => { action(() => model.operations.start(profile.id)) }}>{t('start')} {profile.name}</Button>
        {state.local?.profile === profile.id && state.local.canStop && profile.manageable && <Button
          onClick={() => { action(() => model.operations.restart(profile.id)) }}>{t('restart')} {profile.name}</Button>}
      </div>)}
      <Button disabled={!state.local?.canStop} onClick={() => { action(() => model.operations.stop()) }}>{t('stop')}</Button>
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
