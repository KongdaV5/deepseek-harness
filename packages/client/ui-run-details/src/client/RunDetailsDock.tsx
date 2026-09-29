/**
 * RunDetailsDock: the collapsible, read-only Run Details strip docked above the message
 * composer (input dock strip).
 *
 * Everything it renders arrives through projection seats — `runDetails` for the
 * Run's own facts and `taskCheckpoint` for durable task continuity — so the
 * strip computes nothing of its own and can never disagree with the host fold.
 * Its only control is a native disclosure summary. There is no retry, resume,
 * cancel, or compact verb here, so the surface cannot mutate the Run it describes.
 *
 * Two absences are the point. A session with no Run renders nothing at all
 * rather than a "Run: None" placeholder, and an unobserved backend reads
 * `Unknown` rather than being upgraded to reachable, idle, or healthy.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `runDetails` projection-key merge and its payload contract.
import type { RunDetailsRunView, RunGuardedResumeFacts } from '@deepseek-ai/dsh-run-details/client'
// Type-only: the `taskCheckpoint` projection-key merge and its payload contract.
import type { TaskCheckpoint, TaskCheckpointProjection } from '@deepseek-ai/dsh-task-checkpoint/client'
import type { SessionExternalActivity } from '@deepseek-ai/dsh-api-session-controller/types'
// Type-only: pulls the Session standard `sessionId` seat and the global `useResource` seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the resource model's global `useResource` seat and its `runtime-diagnostics` protocol merge.
import type {} from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/client'
import {
  transientCompaction,
  transientCompactionAddress,
  type TransientCompaction,
} from './transient.ts'
import css from './RunDetailsDock.module.css'

/** Props for the dock entry: the session standard kit plus the locale seat. */
export type RunDetailsDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'runDetails'>

/** One label/value line; `testId` lets the spec address the value without copy. */
function Row({ label, testId, title, children }: {
  label: string
  testId?: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <div className={css.row}>
      <span className={css.label}>{label}</span>
      <span className={css.value} data-testid={testId} title={title}>{children}</span>
    </div>
  )
}

/** The one-line status summary; Session identity stays in the disclosure. */
function Summary({ details, t }: { details: RunDetailsRunView; t: RunDetailsDockProps['t'] }) {
  return (
    <summary className={css.summary} data-testid="run-details-toggle">
      <span className={css.phase} data-phase={details.phase} data-testid="run-details-phase">
        {details.phase === 'completed' && (
          <svg className={css.completedIcon} viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.25 8.25 3.1 3.1 6.4-6.7" />
          </svg>
        )}
        <span>{t(`phase.${details.phase}`)}</span>
      </span>
      <span className={css.health} data-health={details.health} data-testid="run-details-health">
        {t(`health.${details.health}`)}
      </span>
      <span className={css.summarySteps} data-testid="run-details-summary-steps">
        {t('steps.count', { count: details.stepCount })}
      </span>
      <span className={css.summarySpacer} />
      <span className={css.summaryLabel}>
        <span className={css.closedLabel}>{t('details.label')}</span>
        <span className={css.openLabel}>{t('title')}</span>
      </span>
      <svg className={css.chevron} viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4 6 4 4 4-4" />
      </svg>
    </summary>
  )
}

/** Main-run reasoning, with an adapter-materialized effort called out. */
function reasoningText(details: RunDetailsRunView, t: RunDetailsDockProps['t']): string {
  const reasoning = details.reasoning
  if (reasoning === null) return t('reasoning.none')
  const effort = reasoning.resolved ?? reasoning.requested ?? t('reasoning.none')
  return reasoning.adapterMaterialized ? `${effort} (${t('reasoning.adapter')})` : effort
}

/** The compaction's auxiliary reasoning, never mixed into the main-run field. */
function auxiliaryText(details: RunDetailsRunView, t: RunDetailsDockProps['t']): string | null {
  const compaction = details.compaction
  if (compaction === null) return null
  const effort = compaction.resolvedReasoning ?? compaction.requestedReasoning
  return effort ?? t('reasoning.none')
}

/**
 * The *in-flight* compaction status, read from the transient transport.
 *
 * This is the row that keeps a running compaction from being confused with a
 * committed one: the durable `policyAudit` above describes a summary that has
 * already been published, while this describes what the policy is doing now.
 * The status is rendered as the raw structured code the policy reported rather
 * than paraphrased, and a transport that failed renders its own classified code
 * instead of the last value it managed to deliver.
 */
function transientText(transient: Exclude<TransientCompaction, { state: 'hidden' }>, t: RunDetailsDockProps['t']): string {
  switch (transient.state) {
    case 'loading': return t('transient.loading')
    case 'none': return t('transient.none')
    case 'failed': return transient.detail === undefined
      ? t('transient.failed', { code: transient.code })
      : t('transient.failedDetail', { code: transient.code, detail: transient.detail })
    case 'live':
      return transient.candidateAttempt === undefined
        ? t('transient.live', { status: transient.status })
        : t('transient.live', { status: transient.status }) + t('transient.attempt', { count: transient.candidateAttempt })
  }
}

/** Durable task continuity, read from the separate task projection. */
function taskText(
  task: TaskCheckpointProjection | undefined,
  t: RunDetailsDockProps['t'],
): string | null {
  const latest = task?.latestTaskId
  if (latest === undefined) return t('task.none')
  const checkpoint: TaskCheckpoint | undefined = task?.tasks.find(candidate => candidate.taskId === latest)
  if (checkpoint === undefined) return t('task.none')
  return `${checkpoint.taskId} · ${t('task.status', { status: checkpoint.status })}`
}

/**
 * The guarded-resume decision as read-only text.
 *
 * The class is rendered through its locale label, but the reason is kept as the
 * raw Stage 8 code: it is the structured fact the decision was computed from, so
 * showing it verbatim lets a reader match the strip against the host fold rather
 * than trust a paraphrase. Nothing here is derived beyond that — the panel still
 * computes no policy of its own and offers no way to act on the decision.
 */
function guardedResumeText(resume: RunGuardedResumeFacts, t: RunDetailsDockProps['t']): string {
  const parts = [
    t('guardedResume.summary', {
      decision: t(`guardedResume.decision.${resume.decision}`),
      reason: resume.reason,
    }),
  ]
  if (resume.planStepCount > 0) parts.push(t('guardedResume.plan', { count: resume.planStepCount }))
  if (resume.hazardCodes.length > 0) parts.push(t('guardedResume.hazards', { count: resume.hazardCodes.length }))
  return parts.join(' · ')
}

export interface RunDetailsPanelProps {
  /** The served Run cut; the dock adapter has already ruled out the idle case. */
  details: RunDetailsRunView
  /** Durable task continuity, or undefined when the projection is not serving. */
  task: TaskCheckpointProjection | undefined
  /** The transient in-flight compaction state, from its own resource address. */
  transient: TransientCompaction
  /** Live external-runtime activity, never represented as local tool execution. */
  externalActivities?: readonly SessionExternalActivity[]
  /** The dock entry's locale seat, passed down as a plain prop. */
  t: RunDetailsDockProps['t']
}

/** The disclosure body: core Run facts first, lower-level diagnostics on demand. */
export function RunDetailsPanel({ details, task, transient, externalActivities = [], t }: RunDetailsPanelProps) {
  const auxiliary = auxiliaryText(details, t)
  return (
    <details className={css.root} data-testid="run-details" aria-label={t('aria')}>
      <Summary details={details} t={t} />
      <div className={css.detailsBody}>
        <div className={css.rows}>
          <Row label={t('label.session')} testId="run-details-session" title={details.sessionId}>
            {details.sessionId}
          </Row>
          <Row label={t('label.steps')} testId="run-details-steps">
            {t('steps.count', { count: details.stepCount })}
            {details.openStep === null ? '' : ` · ${t('steps.open', { step: details.openStep })}`}
          </Row>
          <Row label={t('label.retries')} testId="run-details-retries">
            {details.maxRetryCount === undefined
              ? t('retries.count', { count: details.retryCount })
              : t('retries.limit', { count: details.retryCount, max: details.maxRetryCount })}
          </Row>
          <Row label={t('label.task')} testId="run-details-task">
            {taskText(task, t)}
          </Row>
          {task === undefined || task.repairHazards.length === 0 ? null : (
            <Row label={t('label.task')} testId="run-details-hazards">
              {t('task.hazards', { count: task.repairHazards.length })}
            </Row>
          )}
        </div>
        <details className={css.advanced}>
          <summary className={css.advancedSummary} data-testid="run-details-advanced-toggle">
            <span>{t('advanced.label')}</span>
            <svg className={css.advancedChevron} viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </summary>
          <div className={css.rows}>
            <Row label={t('label.runId')} testId="run-details-run-id" title={details.runId}>
              {details.runId}
            </Row>
            <Row label={t('label.backend')} testId="run-details-backend">
              {t('backend.unknown')}
            </Row>
            <Row label={t('label.reasoning')} testId="run-details-reasoning">
              {reasoningText(details, t)}
            </Row>
            {details.compaction === null ? null : (
              <Row label={t('label.compaction')} testId="run-details-compaction">
                {t('compaction.summary', {
                  trigger: details.compaction.trigger,
                  attempts: details.compaction.candidateAttempts,
                })}
              </Row>
            )}
            {transient.state === 'hidden' ? null : (
              <Row label={t('label.compactionLive')} testId="run-details-compaction-live">
                {transientText(transient, t)}
              </Row>
            )}
            {auxiliary === null ? null : (
              <Row label={t('label.compactionReasoning')} testId="run-details-compaction-reasoning">
                {auxiliary}
              </Row>
            )}
            {details.guardedResume === null ? null : (
              <Row label={t('label.guardedResume')} testId="run-details-guarded-resume">
                {guardedResumeText(details.guardedResume, t)}
              </Row>
            )}
            {details.primaryError === undefined ? null : (
              <Row label={t('label.error')} testId="run-details-error">
                {t('error.code', { code: details.primaryError.code })}
              </Row>
            )}
          </div>
        </details>
        {externalActivities.length === 0 ? null : (
          <section className={css.externalActivities} aria-label={t('activity.title')}>
            <div className={css.activityHeading}>{t('activity.title')}</div>
            <ul className={css.activityList} data-testid="run-details-external-activities">
              {externalActivities.map(activity => (
                <li className={css.activity} key={activity.id} data-kind={activity.kind}>
                  <span className={css.activityLabel}>
                    {activity.label ?? t(`activity.kind.${activity.kind}`)}
                  </span>
                  <span className={css.activityStatus}>
                    {t(`activity.status.${activity.status}`)}
                  </span>
                  {activity.path === undefined ? null : (
                    <code className={css.activityPath} title={activity.path}>{activity.path}</code>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  )
}

/**
 * Dock adapter: reads the two projections and one resource address, and renders
 * nothing when there is no Run. `undefined` (not yet served) and `hasRun: false`
 * (no durable turn) are both absences, and neither produces a placeholder.
 *
 * The third read is the transient compaction observation. It is a *read* of a
 * transport the host owns, not a third authority: the address is derived from
 * the Session the dock already has, and when no transport is mounted the
 * resource answers `none` and the row is simply absent.
 */
export function RunDetailsDock({ useProjection, useResource, useExternalActivities, sessionId, t }: RunDetailsDockProps) {
  const details = useProjection('runDetails')
  const task = useProjection('taskCheckpoint')
  const externalActivities = useExternalActivities(value => value)
  const transient = transientCompaction(
    useResource<'runtime-diagnostics'>(transientCompactionAddress(sessionId)),
  )
  if (details === undefined || !details.hasRun) return null
  return (
    <RunDetailsPanel
      details={details}
      task={task}
      transient={transient}
      externalActivities={externalActivities}
      t={t}
    />
  )
}
