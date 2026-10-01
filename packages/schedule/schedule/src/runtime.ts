/** Host timer over stored tasks; Session activation is a delivery operation. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
  }
}
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { isRecurringScheduleRecord, renderReminderFraming, renderRecurringReminderBatchFraming, resolveRecurringOccurrence } from './domain.ts'
import type { DeliveryRetentionBounds, RecurringScheduleRecord } from './types.ts'
import type { ScheduleTask } from './storage.ts'
import { appendDelivery } from './delivery-history.ts'
import { scheduleAdmissionFor } from './admissions.ts'

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Owns at most one timer across recomputations; delivery and management share the serialized operation. */
export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopping = false
  private requested = false

  /**
   * @param ctx - Host services used to resume and enqueue.
   * @param tasks - Current durable tasks.
   * @param transact - Serialize delivery against management writes.
   * @param commit - Persist task status, target, receipt, and history together after durable inbox delivery.
   */
  constructor(
    private readonly ctx: Context,
    private readonly tasks: () => readonly ScheduleTask[],
    private readonly transact: (work: () => Promise<void>) => Promise<void>,
    private readonly commit: (task: ScheduleTask) => Promise<void>,
    private readonly retention: DeliveryRetentionBounds,
  ) {}

  /**
   * Recompute the nearest obligation after startup or a durable change.
   * Dispatch failures are logged; refused admission does not retry automatically.
   */
  requestDrive(): void {
    if (this.stopping) return
    this.requested = true
    this.clearTimer()
    if (this.running !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(async () => {
        while (this.requested && !this.stopping) {
          this.requested = false
          await this.transact(async () => { await this.drive() })
        }
      })
    } catch (error: unknown) {
      // Ancestor unloading closes initiator admission before runtime cleanup runs.
      this.requested = false
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
      return
    }
    this.running = run
    void run.catch((error: unknown) => {
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
    }).finally(() => {
      this.running = undefined
      if (this.requested && !this.stopping) this.requestDrive()
    })
  }

  /** Stop the timer and drain an accepted delivery before storage closes. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    // requestDrive reports execution failures; teardown only waits for quiescence.
    await this.running?.catch(() => undefined)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async drive(): Promise<void> {
    this.clearTimer()
    const failed = new Set<string>()
    const handled = new Set<string>()
    const scanNow = Date.now()
    const due = this.tasks().filter(task => task.status === 'active' && Date.parse(task.record.scheduledAt) <= scanNow)
    for (const task of due) {
      if (this.stopping) return
      if (handled.has(task.record.id)) continue
      const group = isRecurringScheduleRecord(task.record)
        ? due.filter(candidate => candidate.sessionId === task.sessionId && isRecurringScheduleRecord(candidate.record))
        : [task]
      for (const member of group) handled.add(member.record.id)
      let admitted = group
      const committed = new Set<ScheduleTask['record']['id']>()
      try {
        const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId)
        if ('error' in resolved) throw resolved.error
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can run while Session restoration is awaited.
        if (this.stopping) return
        const now = Date.now()
        // Session restoration can span a wall-clock rollback; future members keep their timer obligation.
        admitted = group.filter(member => Date.parse(member.record.scheduledAt) <= now)
        if (admitted.length === 0) continue
        const recurring = admitted.filter((member): member is ScheduleTask & { record: RecurringScheduleRecord } =>
          isRecurringScheduleRecord(member.record))
        const occurrences = recurring.map(member => ({
          task: member, occurrence: resolveRecurringOccurrence(member.record, now),
        }))
        const admissions = this.ctx.sessionProjections.stateOf(resolved.agent.session, 'scheduleAdmissions')
        if (admissions === undefined) throw new Error('Schedule admission projection is unavailable')
        const flushSession = async (): Promise<string> => {
          const flushed = await this.ctx.sessions.flush(resolved.agent.session)
          if (!flushed) throw new Error('Session persistence did not acknowledge the reminder')
          return new Date(Date.now()).toISOString()
        }
        const enqueue = async (text: string): Promise<{ messageId: MessageId; deliveredAt: string }> => {
          const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'schedule' } })
          // followup synchronously appends the inbox splice before flush observes the Session.
          resolved.agent.followup(message)
          return { messageId: message.id, deliveredAt: await flushSession() }
        }
        if (!isRecurringScheduleRecord(task.record)) {
          const known = scheduleAdmissionFor(admissions, task.record.id, task.record.scheduledAt)
          const delivery = known === undefined
            ? await enqueue(renderReminderFraming(task.record))
            : { messageId: known.messageId, deliveredAt: await flushSession() }
          if (known !== undefined) {
            this.ctx.logger.info(`schedule: recovered admitted occurrence ${JSON.stringify(task.record.id)} without a second Session followup`)
          }
          await this.commit({
            ...task, status: 'inactive',
            ...appendDelivery(task, {
              scheduledAt: task.record.scheduledAt,
              deliveredAt: delivery.deliveredAt,
              messageId: delivery.messageId,
            }, this.retention),
          })
          committed.add(task.record.id)
        } else {
          const known = occurrences.flatMap((entry) => {
            const admission = scheduleAdmissionFor(admissions, entry.task.record.id, entry.occurrence.occurrenceAt)
            return admission === undefined ? [] : [{ ...entry, admission }]
          })
          const knownIds = new Set(known.map(({ task: member }) => member.record.id))
          const pending = occurrences.filter(({ task: member }) => !knownIds.has(member.record.id))
          if (known.length > 0) {
            const deliveredAt = await flushSession()
            for (const { task: member, occurrence, admission } of known) {
              await this.commit({
                ...member,
                record: { ...member.record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt },
                status: occurrence.nextScheduledAt === undefined ? 'inactive' : 'active',
                ...appendDelivery(member, {
                  scheduledAt: occurrence.occurrenceAt,
                  deliveredAt,
                  messageId: admission.messageId,
                }, this.retention),
              })
              committed.add(member.record.id)
              this.ctx.logger.info(`schedule: recovered admitted occurrence ${JSON.stringify(member.record.id)} without a second Session followup`)
            }
          }
          if (pending.length > 0) {
            const delivery = await enqueue(renderRecurringReminderBatchFraming(pending.map(({ task: member, occurrence }) => ({
              record: member.record, occurrenceAt: occurrence.occurrenceAt,
            }))))
            for (const { task: member, occurrence } of pending) {
              await this.commit({
                ...member,
                record: { ...member.record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt },
                status: occurrence.nextScheduledAt === undefined ? 'inactive' : 'active',
                ...appendDelivery(member, {
                  scheduledAt: occurrence.occurrenceAt,
                  deliveredAt: delivery.deliveredAt,
                  messageId: delivery.messageId,
                }, this.retention),
              })
              committed.add(member.record.id)
            }
          }
        }
      } catch (error: unknown) {
        // Successful commits and targets made future by clock rollback keep their timer obligation.
        const pending = admitted.filter(member => !committed.has(member.record.id))
        const failedAt = Date.now()
        for (const member of pending) {
          if (Date.parse(member.record.scheduledAt) <= failedAt) failed.add(member.record.id)
        }
        const ids = pending.map(member => member.record.id)
        this.ctx.logger.warn(`schedule: reminders ${JSON.stringify(ids)} were not acknowledged: ${String(error)}`)
      }
    }
    if (this.stopping) return
    const next = this.tasks().filter(task => task.status === 'active' && !failed.has(task.record.id))
      .reduce<number | undefined>((at, task) => {
        const target = Date.parse(task.record.scheduledAt)
        return at === undefined ? target : Math.min(at, target)
      }, undefined)
    if (next !== undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive() },
        Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)))
      this.timer.unref()
    }
  }
}
