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
  return <section className={css.section} aria-label={t('title')}>
    <h3>{t('title')}</h3>
    {state.error === undefined ? null : <p role="alert">{state.error}</p>}
    <fieldset className={css.card} disabled={state.loading || state.local?.enabled !== true}><legend>{t('local')}</legend>
      <p className={css.hint}>{t('localHint')}</p>
      <p>{state.local === undefined ? t('unknown') : t(state.local.state)} · {state.local?.endpoint ?? ''}</p>
      {state.local?.error === undefined ? null : <p role="alert">{state.local.error}</p>}
      {state.local?.profiles.filter(profile => profile.manageable).map(profile => <Button key={profile.id} disabled={!state.local?.enabled || !profile.available} onClick={() => { action(() => model.operations.start(profile.id)) }}>{t('start')} {profile.name}{profile.available ? '' : ` · ${t('unavailable')}`}</Button>)}
      <Button disabled={!state.local?.canStop} onClick={() => { action(() => model.operations.stop()) }}>{t('stop')}</Button>
    </fieldset>
    <fieldset className={css.card} disabled={state.loading || state.codex?.enabled !== true}><legend>{t('codex')}</legend>
      <p className={css.hint}>{t('codexHint')}</p>
      <p>{state.codex === undefined ? t('unknown') : t(state.codex.account)} · {state.codex?.runtimeVersion ?? ''}</p>
      {state.codex?.error === undefined ? null : <p role="alert">{state.codex.error}</p>}
      <SegmentedControl id="custom-codex-runtime" label={t('runtime')} value={state.codex?.runtimePreference ?? 'auto'}
        options={[{ value: 'auto', label: t('auto') }, { value: 'system', label: t('system'), disabled: !state.codex?.systemRuntimeAvailable }, { value: 'bundled', label: t('bundled') }]}
        disabled={state.loading} onChange={(preference) => { action(() => model.operations.select(preference)) }} />
      <div role="tabpanel" id={`custom-codex-runtime-${state.codex?.runtimePreference ?? 'auto'}-panel`} aria-labelledby={`custom-codex-runtime-${state.codex?.runtimePreference ?? 'auto'}`}>
        {t('source')}: {state.codex?.runtimeSource === undefined ? t('unknown') : t(state.codex.runtimeSource)} · {state.codex?.runtimeVersion ?? t('unknown')}
      </div>
      <p>{state.codex?.usage.state === 'available' && state.codex.usage.primary !== undefined ? `${t('usage')}: ${state.codex.usage.primary.usedPercent}%` : t('unavailableUsage')}</p>
      <Button onClick={() => { action(() => model.operations.reconnect()) }}>{t('reconnect')}</Button>
      <Button disabled={state.codex?.account === 'connected' || state.codex?.login === 'signing-in'} onClick={() => { action(() => model.operations.connect()) }}>{t('connect')}</Button>
      <Button disabled={state.codex?.login !== 'signing-in'} onClick={() => { action(() => model.operations.cancelLogin()) }}>{t('cancelLogin')}</Button>
      <Button disabled={state.codex?.account !== 'connected'} onClick={() => { action(() => model.operations.disconnect()) }}>{t('disconnect')}</Button>
    </fieldset>
    <Button disabled={state.loading} onClick={() => { void model.refresh() }}>{t('refresh')}</Button>
  </section>
}
