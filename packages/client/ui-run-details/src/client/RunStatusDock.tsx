/** Compact current-run strip plus a user-opened, read-only details dialog. */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopRunDiagnosticsSnapshot } from '@deepseek-ai/dsh-desktop-run-diagnostics/client'
import type { RunDetailsInjected } from './slots.ts'
import type { RunDetailsKey } from './locales.ts'
import css from './RunStatusDock.module.css'

type RunStatusDockProps = PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'runDetails'>
  & InjectFace<RunDetailsInjected>

function valueOf(value: string | number | undefined, unknown: string): string {
  return value === undefined || value === '' || value === 'unknown' ? unknown : String(value)
}

function phaseLabel(
  snapshot: DesktopRunDiagnosticsSnapshot,
  t: (key: RunDetailsKey, values?: Record<string, string | number>) => string,
): string {
  const run = snapshot.run
  if (run === null) {
    if (snapshot.checkpoint?.task?.status === 'paused') return t('status.paused')
    return snapshot.checkpoint?.resume.eligibility === 'SAFE_TO_RESUME'
      ? t('status.resume')
      : t('value.unknown')
  }
  if (run.primaryError?.code === 'RESOURCE_LIMIT') return t('status.resourceLimit')
  if (run.cancellation?.status === 'requested') return t('status.stopping')
  if (run.cancellation?.status === 'unconfirmed') return t('status.cancelUnconfirmed')
  if (run.cancellation?.status === 'confirmed') return t('status.stopped')
  if (snapshot.preset === 'benchmark') return t('status.benchmark')
  switch (run.phase) {
    case 'starting':
    case 'preparing_context': return t('status.preparing')
    case 'prefill': return t('status.prefill')
    case 'reasoning': return t('status.reasoning', { reasoning: run.reasoning.resolvedReasoning ?? t('value.unknown') })
    case 'generating': return t('status.generating')
    case 'tool_wait': return t('status.tool')
    case 'compacting': return t('status.compacting')
    case 'waiting_retry': return t('status.retry', {
      current: run.retryCount,
      maximum: run.maxRetryCount ?? t('value.unknown'),
    })
    case 'cancelled': return t('status.stopped')
    case 'completed': return t('status.completed')
    case 'failed': return t('status.failed')
    case 'unknown': return t('value.unknown')
    default: return t('value.unknown')
  }
}

function canResume(snapshot: DesktopRunDiagnosticsSnapshot): boolean {
  const task = snapshot.checkpoint?.task
  const run = snapshot.run
  if (snapshot.checkpoint?.resume.eligibility !== 'SAFE_TO_RESUME' || task === undefined) return false
  return run?.phase === 'failed' || run?.phase === 'cancelled' || task.status === 'paused' || task.status === 'failed'
}

function DetailSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className={css.section}><h3>{title}</h3><dl>{children}</dl></section>
}

function DetailRow({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return <div className={css.row}><dt>{label}</dt><dd>{value}</dd></div>
}

function RunDetails({ snapshot, t }: { readonly snapshot: DesktopRunDiagnosticsSnapshot; readonly t: RunStatusDockProps['t'] }) {
  const run = snapshot.run
  const unknown = t('value.unknown')
  const checkpoint = snapshot.checkpoint
  const compaction = snapshot.compaction
  if (run === null) {
    return (
      <DetailSection title={t('section.status')}>
        <DetailRow label={t('field.phase')} value={unknown} />
        <DetailRow label={t('field.resume')} value={checkpoint?.resume.eligibility ?? unknown} />
      </DetailSection>
    )
  }
  const prefill = run.backend.prefill
  return (
    <div className={css.details}>
      <DetailSection title={t('section.status')}>
        <DetailRow label={t('field.phase')} value={valueOf(run.phase, unknown)} />
        <DetailRow label={t('field.health')} value={valueOf(run.health, unknown)} />
      </DetailSection>
      <DetailSection title={t('section.identity')}>
        <DetailRow label={t('field.session')} value={run.sessionId} />
        <DetailRow label={t('field.run')} value={run.runId} />
        <DetailRow label={t('field.attempt')} value={run.attempt?.attemptId ?? unknown} />
        <DetailRow label={t('field.profile')} value={snapshot.preset ?? unknown} />
      </DetailSection>
      <DetailSection title={t('section.route')}>
        <DetailRow label={t('field.provider')} value={valueOf(run.provider, unknown)} />
        <DetailRow label={t('field.model')} value={valueOf(run.model, unknown)} />
      </DetailSection>
      <DetailSection title={t('section.reasoning')}>
        <DetailRow label={t('field.requested')} value={valueOf(run.reasoning.requestedReasoning, unknown)} />
        <DetailRow label={t('field.selected')} value={valueOf(run.reasoning.policySelected, unknown)} />
        <DetailRow label={t('field.resolved')} value={valueOf(run.reasoning.resolvedReasoning, unknown)} />
        <DetailRow label={t('field.wire')} value={valueOf(run.reasoning.wireValue, unknown)} />
        <DetailRow label={t('field.source')} value={valueOf(run.reasoning.source, unknown)} />
        <DetailRow label={t('field.confidence')} value={valueOf(run.reasoning.capabilityConfidence, unknown)} />
      </DetailSection>
      <DetailSection title={t('section.context')}>
        <DetailRow label={t('field.window')} value={valueOf(run.context.contextWindow, unknown)} />
        <DetailRow label={t('field.projected')} value={valueOf(run.context.projectedTokens, unknown)} />
        <DetailRow label={t('field.budget')} value={valueOf(run.context.effectivePromptBudget, unknown)} />
        <DetailRow label={t('field.pressure')} value={valueOf(run.context.pressureState, unknown)} />
      </DetailSection>
      <DetailSection title={t('section.health')}>
        <DetailRow label={t('field.process')} value={valueOf(run.backend.processHealth, unknown)} />
        <DetailRow label={t('field.modelHealth')} value={valueOf(run.backend.modelHealth, unknown)} />
        <DetailRow label={t('field.generation')} value={valueOf(run.backend.generationHealth, unknown)} />
        <DetailRow label={t('field.attribution')} value={valueOf(run.backend.attribution.kind, unknown)} />
        <DetailRow label={t('field.lastActivity')} value={valueOf(run.lastActivityAt, unknown)} />
        <DetailRow label={t('field.lastBackendActivity')} value={valueOf(run.lastBackendActivityAt, unknown)} />
        {prefill !== undefined && (
          <DetailRow
            label={t('status.prefill')}
            value={`${valueOf(prefill.current, unknown)} / ${valueOf(prefill.total, unknown)} · ${valueOf(prefill.source, unknown)} · ${valueOf(prefill.confidence, unknown)}`}
          />
        )}
      </DetailSection>
      <DetailSection title={t('section.retry')}>
        <DetailRow label={t('field.current')} value={run.retryCount} />
        <DetailRow label={t('field.maximum')} value={valueOf(run.maxRetryCount, unknown)} />
        <DetailRow label={t('field.reason')} value={valueOf(run.retryReason, unknown)} />
      </DetailSection>
      <DetailSection title={t('section.cancellation')}>
        <DetailRow label={t('field.cancellation')} value={run.cancellation?.status ?? t('value.none')} />
      </DetailSection>
      {compaction !== undefined && (
        <DetailSection title={t('section.compaction')}>
          <DetailRow label={t('field.compactionAttempt')} value={compaction.attempt?.ordinal ?? unknown} />
          <DetailRow label={t('field.compactionReasoning')} value={compaction.reasoning?.resolved ?? unknown} />
          <DetailRow label={t('field.validation')} value={compaction.attempt?.validation ?? unknown} />
          {compaction.attempt?.validation === 'failed' && <DetailRow label={t('field.reason')} value={compaction.attempt.failureReason ?? t('compaction.failed')} />}
        </DetailSection>
      )}
      {checkpoint !== undefined && checkpoint.task !== undefined && (
        <DetailSection title={t('section.checkpoint')}>
          <DetailRow label={t('field.completedSteps')} value={checkpoint.checkpoint?.completedSteps.length ?? 0} />
          <DetailRow label={t('field.pendingSteps')} value={checkpoint.checkpoint?.pendingSteps.length ?? 0} />
          <DetailRow label={t('field.currentStep')} value={checkpoint.checkpoint?.currentStep?.title ?? t('value.none')} />
          <DetailRow label={t('field.resume')} value={checkpoint.resume.eligibility} />
          {checkpoint.resume.eligibility === 'BLOCKED_UNKNOWN_SIDE_EFFECT' && <DetailRow label={t('field.reason')} value={t('resume.blocked')} />}
        </DetailSection>
      )}
      {(run.primaryError !== undefined || run.secondaryErrors.length > 0) && (
        <DetailSection title={t('section.error')}>
          {run.primaryError !== undefined && <DetailRow label={t('field.primary')} value={`${run.primaryError.code}: ${run.primaryError.message}`} />}
          {run.secondaryErrors.length > 0 && <DetailRow label={t('field.secondary')} value={run.secondaryErrors.map(error => `${error.code}: ${error.message}`).join('; ')} />}
        </DetailSection>
      )}
    </div>
  )
}

/** Render one compact status control and an explicitly opened Run Details dialog. */
export function RunStatusDock({ useRunDiagnostics, resume, t }: RunStatusDockProps) {
  const snapshot = useRunDiagnostics(value => value)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState<string | undefined>()
  const label = useMemo(() => snapshot === undefined ? undefined : phaseLabel(snapshot, t), [snapshot, t])
  const contextHint = snapshot?.run?.context.pressureState
  const resumeAvailable = snapshot !== undefined && canResume(snapshot)

  const requestResume = useCallback(async () => {
    const taskId = snapshot?.checkpoint?.task?.taskId
    if (taskId === undefined || pending) return
    setPending(true)
    setNote(undefined)
    const result = await resume({ taskId })
    setPending(false)
    if (!result.ok) {
      setNote(t('resume.failed', { message: result.error.message }))
      return
    }
    if (result.value.status === 'refused') {
      setNote(t('resume.refused', { reason: result.value.decision.reason }))
      return
    }
    setNote(t('resume.started'))
  }, [pending, resume, snapshot, t])

  // `run: null` means there is no current Run, not that the backend is known
  // to be idle or healthy. Keep that Unknown fact in diagnostics, but do not
  // reserve composer space for it unless a paused or safely resumable Task
  // needs an explicit user action.
  const inactiveWithoutAction = snapshot?.run === null && !resumeAvailable
  if (snapshot === undefined || label === undefined || inactiveWithoutAction) return null
  return (
    <div className={css.dock} data-run-status-dock>
      <button
        type="button"
        className={css.status}
        onClick={() => { setOpen(true) }}
        aria-label={t('action.open')}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span aria-live="polite">{label}</span>
        {contextHint === 'prepare' && <span className={css.hint}>{t('status.contextPrepare')}</span>}
        {contextHint === 'critical' && <span className={css.warning}>{t('status.contextCritical')}</span>}
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('title')}
        closeLabel={t('action.close')}
        {...css.modal === undefined ? {} : { className: css.modal }}
        {...css.modalContent === undefined ? {} : { contentClassName: css.modalContent }}
        {...!resumeAvailable ? {} : {
          footer: (
            <button type="button" className={css.resume} disabled={pending} onClick={() => { void requestResume() }}>
              {pending ? t('action.resuming') : t('action.resume')}
            </button>
          ),
        }}
      >
        <RunDetails snapshot={snapshot} t={t} />
        {note !== undefined && <p className={css.note} role="status">{note}</p>}
      </Modal>
    </div>
  )
}
