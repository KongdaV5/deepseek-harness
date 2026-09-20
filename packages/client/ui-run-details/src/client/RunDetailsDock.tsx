/**
 * RunDetailsDock: the read-only Run Details strip docked above the message
 * composer (input dock strip).
 *
 * Everything it renders arrives through projection seats — `runDetails` for the
 * Run's own facts and `taskCheckpoint` for durable task continuity — so the
 * strip computes nothing of its own and can never disagree with the host fold.
 * It renders **no controls**: there is no retry, resume, cancel, or compact verb
 * here, and no handler a click could reach, so the surface cannot mutate the Run
 * it describes.
 *
 * Two absences are the point. A session with no Run renders nothing at all
 * rather than a "Run: None" placeholder, and an unobserved backend reads
 * `Unknown` rather than being upgraded to reachable, idle, or healthy.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `runDetails` projection-key merge and its payload contract.
import type { RunDetailsRunView } from '@deepseek-ai/dsh-run-details/client'
// Type-only: the `taskCheckpoint` projection-key merge and its payload contract.
import type { TaskCheckpoint, TaskCheckpointProjection } from '@deepseek-ai/dsh-task-checkpoint/client'
import css from './RunDetailsDock.module.css'

/** Props for the dock entry: the session standard kit plus the locale seat. */
export type RunDetailsDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'runDetails'>

/** One label/value line; `testId` lets the spec address the value without copy. */
function Row({ label, testId, children }: { label: string; testId?: string; children: React.ReactNode }) {
  return (
    <div className={css.row}>
      <span className={css.label}>{label}</span>
      <span className={css.value} {...testId === undefined ? {} : { 'data-testid': testId }}>{children}</span>
    </div>
  )
}

/** Shorten a derived Run id for display without hiding the whole value. */
function shortRunId(runId: string): string {
  // `run:v1:<len>:<sessionId>:<turn>` — the Session and the turn are what a
  // reader needs, so the strip keeps both and drops the scheme and length.
  const parts = runId.split(':')
  return parts.length > 3 ? parts.slice(3).join('#') : runId
}

/** The compact summary line: phase and health side by side. */
function Headline({ details, t }: { details: RunDetailsRunView; t: RunDetailsDockProps['t'] }) {
  return (
    <div className={css.headline}>
      <span className={css.runId} data-testid="run-details-run-id" title={details.runId}>
        {shortRunId(details.runId)}
      </span>
      <span className={css.badge} data-phase={details.phase} data-testid="run-details-phase">
        {t(`phase.${details.phase}`)}
      </span>
      <span className={css.badge} data-health={details.health} data-testid="run-details-health">
        {t(`health.${details.health}`)}
      </span>
    </div>
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

export interface RunDetailsPanelProps {
  /** The served Run cut; the dock adapter has already ruled out the idle case. */
  details: RunDetailsRunView
  /** Durable task continuity, or undefined when the projection is not serving. */
  task: TaskCheckpointProjection | undefined
  /** The dock entry's locale seat, passed down as a plain prop. */
  t: RunDetailsDockProps['t']
}

/** The strip body: one summary line plus one label/value line per fact group. */
export function RunDetailsPanel({ details, task, t }: RunDetailsPanelProps) {
  const auxiliary = auxiliaryText(details, t)
  return (
    <section className={css.root} data-testid="run-details" aria-label={t('aria')}>
      <Headline details={details} t={t} />
      <div className={css.rows}>
        <Row label={t('label.steps')} testId="run-details-steps">
          {t('steps.count', { count: details.stepCount })}
          {details.openStep === null ? '' : ` · ${t('steps.open', { step: details.openStep })}`}
        </Row>
        <Row label={t('label.retries')} testId="run-details-retries">
          {details.maxRetryCount === undefined
            ? t('retries.count', { count: details.retryCount })
            : t('retries.limit', { count: details.retryCount, max: details.maxRetryCount })}
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
        {auxiliary === null ? null : (
          <Row label={t('label.compactionReasoning')} testId="run-details-compaction-reasoning">
            {auxiliary}
          </Row>
        )}
        <Row label={t('label.task')} testId="run-details-task">
          {taskText(task, t)}
        </Row>
        {task === undefined || task.repairHazards.length === 0 ? null : (
          <Row label={t('label.task')} testId="run-details-hazards">
            {t('task.hazards', { count: task.repairHazards.length })}
          </Row>
        )}
        {details.primaryError === undefined ? null : (
          <Row label={t('label.error')} testId="run-details-error">
            {t('error.code', { code: details.primaryError.code })}
          </Row>
        )}
      </div>
    </section>
  )
}

/**
 * Dock adapter: reads the two projections and renders nothing when there is no
 * Run. `undefined` (not yet served) and `hasRun: false` (no durable turn) are
 * both absences, and neither produces a placeholder.
 */
export function RunDetailsDock({ useProjection, t }: RunDetailsDockProps) {
  const details = useProjection('runDetails')
  const task = useProjection('taskCheckpoint')
  if (details === undefined || !details.hasRun) return null
  return <RunDetailsPanel details={details} task={task} t={t} />
}
