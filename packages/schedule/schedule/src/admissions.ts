/** Session projection for Schedule occurrences already admitted to an Agent inbox. */

import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ScheduleAdmission, ScheduleAdmissionProjectionState, ScheduleId } from './types.ts'

const admissionSchema = z.object({
  id: z.string().min(1).transform(value => value as ScheduleId),
  occurrenceAt: z.string().min(1),
  messageId: z.string().min(1).nullable().transform(value => value as MessageId | null),
  admittedAt: z.number().int().nonnegative(),
}).strict()

const stateSchema = z.object({
  entries: z.array(admissionSchema).superRefine((entries, context) => {
    const ids = new Set<string>()
    for (const entry of entries) {
      if (ids.has(entry.id)) {
        context.addIssue({ code: 'custom', message: 'schedule admission projection has duplicate task ids' })
        return
      }
      ids.add(entry.id)
    }
  }),
  uncertain: z.boolean(),
}).strict() satisfies z.ZodType<ScheduleAdmissionProjectionState>

const EMPTY: ScheduleAdmissionProjectionState = { entries: [], uncertain: false }

interface OccurrenceIdentity {
  readonly id: ScheduleId
  readonly occurrenceAt: string
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function parseJsonString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

function oneShotIdentity(text: string): OccurrenceIdentity[] | undefined {
  if (!text.startsWith('[SCHEDULE REMINDER]\nThis is a scheduled message from the user\n')) return undefined
  const id = parseJsonString(/^schedule_id_json: (.*)$/mu.exec(text)?.[1])
  const occurrenceAt = /^occurrence_at: (.*)$/mu.exec(text)?.[1]
  if (id === undefined || !canonicalInstant(occurrenceAt)) return undefined
  return [{ id: id as ScheduleId, occurrenceAt }]
}

function recurringIdentities(text: string): OccurrenceIdentity[] | undefined {
  if (!text.startsWith('[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\n')) return undefined
  const value = /^reminders_json: (.*)$/mu.exec(text)?.[1]
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    const identities: OccurrenceIdentity[] = []
    for (const row of parsed) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
      const candidate = row as Record<string, unknown>
      if (typeof candidate['schedule_id'] !== 'string' || candidate['schedule_id'] === ''
        || !canonicalInstant(candidate['occurrence_at'])) return undefined
      identities.push({ id: candidate['schedule_id'] as ScheduleId, occurrenceAt: candidate['occurrence_at'] })
    }
    return identities
  } catch {
    return undefined
  }
}

function reminderIdentities(message: UserMessage): OccurrenceIdentity[] | undefined {
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return oneShotIdentity(text) ?? recurringIdentities(text)
}

function admit(
  state: ScheduleAdmissionProjectionState,
  identity: OccurrenceIdentity,
  messageId: MessageId,
  admittedAt: number,
): ScheduleAdmissionProjectionState {
  const index = state.entries.findIndex(entry => entry.id === identity.id)
  const previous = index < 0 ? undefined : state.entries[index]
  if (previous?.occurrenceAt === identity.occurrenceAt) {
    if (previous.messageId === null || previous.messageId === messageId) return state
    return {
      ...state,
      entries: state.entries.map((entry, entryIndex) => entryIndex === index
        ? { ...entry, messageId: null }
        : entry),
    }
  }
  const next: ScheduleAdmission = { ...identity, messageId, admittedAt }
  return {
    ...state,
    entries: previous === undefined
      ? [...state.entries, next]
      : state.entries.map((entry, entryIndex) => entryIndex === index ? next : entry),
  }
}

/** Rebuild exact admitted occurrence identities from durable inbox splices. */
export const scheduleAdmissionsProjection = {
  key: 'scheduleAdmissions',
  stateVersion: 1,
  stateSchema,
  init: () => EMPTY,
  apply: (state, event) => {
    if (state.uncertain || event.type !== 'agent/inbox/spliced') return state
    let next = state
    for (const message of event.data.inserted) {
      if (message.source.kind !== 'schedule') continue
      const identities = reminderIdentities(message)
      if (identities === undefined) return { ...next, uncertain: true }
      for (const identity of identities) next = admit(next, identity, message.id, event.time)
    }
    return next
  },
} satisfies ProjectionDefinition<'scheduleAdmissions', ScheduleAdmissionProjectionState>

/** A non-ambiguous admitted occurrence with its canonical Session message identity. */
export type ScheduleAdmissionMatch = ScheduleAdmission & { readonly messageId: MessageId }

/** Locate one occurrence admission without consulting or scanning the Session event log. */
export function scheduleAdmissionFor(
  state: ScheduleAdmissionProjectionState,
  id: ScheduleId,
  occurrenceAt: string,
): ScheduleAdmissionMatch | undefined {
  if (state.uncertain) throw new Error('Schedule admission history is incomplete; a second delivery is unsafe')
  const entry = state.entries.find(candidate => candidate.id === id)
  if (entry?.occurrenceAt !== occurrenceAt) return undefined
  if (entry.messageId === null) throw new Error(`Schedule occurrence ${JSON.stringify(id)} has conflicting inbox admissions`)
  return { ...entry, messageId: entry.messageId }
}
