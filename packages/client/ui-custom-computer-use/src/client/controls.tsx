/** Minimal settings/status and conversation Stop contributions. */
import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComputerUseModel } from './model.ts'
import type { CopyKey } from './locales.ts'
import css from './controls.module.css'
/** Explicit view-only capabilities injected by the client plugin. */
export interface ControlsInjected { hooks: { computerUse: ComputerUseModel }; model: ComputerUseModel; t(key: CopyKey): string }
/** Host-authoritative Stop remains clickable during permission checks or drain.
 * @param props - Observable Host facts and explicit user operations.
 * @returns The labeled status and explicit Stop action.
 */
export function ComputerUseStop({ useComputerUse, model, t, presentation = 'settings' }: InjectFace<ControlsInjected> & {
  presentation?: 'settings' | 'toolbar'
}) {
  const state = useComputerUse(value => value)
  const toolbar = presentation === 'toolbar'
  return <div className={toolbar ? css.toolbar : css.settingsStop} role="group" aria-label={t('title')}>
    <span className={toolbar ? css.toolbarStatus : css.settingsStatus} role="status">{state.error !== undefined ? t('failed') : state.status === undefined ? t('loading') :
      `${t('status.computerUse')} · ${t('status.lease')}: ${t(state.status.lease.state)} · ${t('status.globalStop')}: ${t(state.status.lease.stop)}${state.status.lease.owner === undefined ? '' : ` · ${state.status.lease.owner.sessionId}`}`}</span>
    <Button size={toolbar ? 'sm' : 'md'} className={toolbar ? css.toolbarStop : undefined}
      onClick={() => { void model.run(() => model.operations.stop()) }}>{t('stop')}</Button>
  </div>
}

/** Keep Host stop status in the persistent composer action row. */
export function ComputerUseActivity(props: PropsRuntime<'conversation.input.activity'> & InjectFace<ControlsInjected>) {
  const { useComputerUse, model, t } = props
  return <ComputerUseStop useComputerUse={useComputerUse} model={model} t={t} presentation="toolbar" />
}
/** Settings read permission grants only on an explicit button press.
 * @param props - Redacted facts and user control closures.
 * @returns Permission and stop controls; enablement remains the Plugins bundle list.
 */
export function ComputerUseSettings(props: InjectFace<ControlsInjected>) {
  const { useComputerUse, model, t } = props
  const state = useComputerUse(value => value)
  useEffect(() => { void model.refresh() }, [model])
  return <section className={css.card} aria-label={t('title')}>
    <h3>{t('title')}</h3><p>{t('localOnly')}</p><p>{t('takeover')}</p>
    {state.error !== undefined ? <p role="alert">{t('failed')}</p> : null}
    {state.status === undefined ? <p>{t('loading')}</p> : <>
      <p role="status">{t(state.status.driver)}</p>
      <p>{t('accessibility')}: {t(state.status.accessibility)} · {t('recording')}: {t(state.status.screenRecording)}</p>
      <p>{state.status.permissionOwner}</p>
      {state.status.lease.state === 'poisoned' ? <p role="alert">{t('poison')}</p> : null}
    </>}
    <div className={css.row}>
      <Button disabled={state.status?.driver !== 'ready'} onClick={() => { void model.run(() => model.operations.checkPermissions()) }}>{t('check')}</Button>
      <Button disabled={state.status?.driver !== 'ready'} onClick={() => { void model.run(() => model.operations.requestPermissions()) }}>{t('request')}</Button>
      <Button disabled={state.status?.lease.state !== 'released' || state.status.lease.stop !== 'stopped'}
        onClick={() => { void model.run(() => model.operations.resume()) }}>{t('resume')}</Button>
    </div>
    <ComputerUseStop {...props} />
  </section>
}
