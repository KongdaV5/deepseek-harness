/** View-only runtime controls inside the canonical Models footer. */
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
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
  const [draft, setDraft] = useState({ id: '', name: '', modelId: '', modality: 'text' as 'text' | 'image' })
  const [touched, setTouched] = useState({ id: false, name: false, modelId: false })
  const [isAdding, setIsAdding] = useState(false)
  const [profileError, setProfileError] = useState<string>()
  const [profileAdded, setProfileAdded] = useState(false)
  const local = state.local
  useEffect(() => { void model.refresh() }, [model])
  const action = (operation: () => Promise<unknown>) => { void model.run(operation) }
  const id = draft.id.trim()
  const name = draft.name.trim()
  const modelId = draft.modelId.trim()
  const idIsValid = /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id)
  const idIsDuplicate = local?.profiles.some(profile => profile.id === id) ?? false
  const nameIsValid = name.length > 0 && name.length <= 120
  const pathIsValid = modelId.startsWith('/')
  const idHasError = touched.id && (!idIsValid || idIsDuplicate)
  const nameHasError = touched.name && !nameIsValid
  const pathHasError = touched.modelId && !pathIsValid
  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTouched({ id: true, name: true, modelId: true })
    if (!idIsValid || !nameIsValid || !pathIsValid) return
    if (local?.profiles.some(profile => profile.id === id)) return
    action(async () => {
      setIsAdding(true)
      setProfileError(undefined)
      setProfileAdded(false)
      try {
        await model.operations.addProfile({ id, name, modality: draft.modality, modelId })
        setDraft({ id: '', name: '', modelId: '', modality: 'text' })
        setTouched({ id: false, name: false, modelId: false })
        setProfileAdded(true)
      } catch (error: unknown) {
        setProfileError(error instanceof Error ? error.message : String(error))
      } finally {
        setIsAdding(false)
      }
    })
  }
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
      <form className={css.addForm} onSubmit={submitProfile} aria-busy={isAdding}>
        <h4>{t('addModel')}</h4>
        <p className={css.hint}>{t('addModelHint')}</p>
        {profileError === undefined ? null : <p className={css.fieldError} role="alert">{profileError}</p>}
        {profileAdded && <p role="status">{t('modelAdded')}</p>}
        <label className={css.addField}>{t('profileId')}
          <Input autoComplete="off" required maxLength={64} value={draft.id} aria-invalid={idHasError}
            aria-describedby={idHasError ? 'custom-local-profile-id-error' : undefined}
            onBlur={() => { setTouched(value => ({ ...value, id: true })) }}
            onChange={(event) => {
              const value = event.currentTarget.value
              setProfileError(undefined)
              setProfileAdded(false)
              setDraft(current => ({ ...current, id: value }))
            }} />
          {idHasError && <span className={css.fieldError} id="custom-local-profile-id-error">
            {t(idIsDuplicate ? 'duplicateProfileId' : 'invalidProfileId')}
          </span>}
        </label>
        <label className={css.addField}>{t('modelName')}
          <Input autoComplete="off" required maxLength={120} value={draft.name} aria-invalid={nameHasError}
            aria-describedby={nameHasError ? 'custom-local-profile-name-error' : undefined}
            onBlur={() => { setTouched(value => ({ ...value, name: true })) }}
            onChange={(event) => {
              const value = event.currentTarget.value
              setProfileError(undefined)
              setProfileAdded(false)
              setDraft(current => ({ ...current, name: value }))
            }} />
          {nameHasError && <span className={css.fieldError} id="custom-local-profile-name-error">{t('invalidModelName')}</span>}
        </label>
        <label className={`${css.addField} ${css.pathField}`}>{t('modelPath')}
          <Input autoComplete="off" required spellCheck={false} placeholder="/Users/you/Models/model.gguf" value={draft.modelId}
            aria-invalid={pathHasError} aria-describedby={pathHasError ? 'custom-local-profile-path-error' : undefined}
            onBlur={() => { setTouched(value => ({ ...value, modelId: true })) }}
            onChange={(event) => {
              const value = event.currentTarget.value
              setProfileError(undefined)
              setProfileAdded(false)
              setDraft(current => ({ ...current, modelId: value }))
            }} />
          {pathHasError && <span className={css.fieldError} id="custom-local-profile-path-error">{t('invalidModelPath')}</span>}
        </label>
        <label className={css.addField}>{t('modality')}
          <select className={css.select} value={draft.modality}
            onChange={(event) => { const modality = event.currentTarget.value as 'text' | 'image'; setProfileError(undefined); setProfileAdded(false); setDraft(value => ({ ...value, modality })) }}>
            <option value="text">{t('text')}</option>
            <option value="image">{t('image')}</option>
          </select>
        </label>
        <Button variant="primary" disabled={state.loading || isAdding || !idIsValid || !nameIsValid || !pathIsValid
          || idIsDuplicate} type="submit">{t(isAdding ? 'addingModel' : 'addModel')}</Button>
      </form>
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
