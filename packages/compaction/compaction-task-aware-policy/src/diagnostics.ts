/**
 * Transient, read-only task-aware compaction diagnostics.
 *
 * This module is a report, not a source of truth. It holds the most recent
 * observation per Session so a later reader — a Run Details surface, a support
 * bundle, a test — can see what the policy decided and why, without the policy
 * becoming an authority anything else validates against. Every value here is
 * already gone from durable memory the moment a new compaction starts, which is
 * exactly the property that keeps it safe to read.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/diagnostics
 */

import type { TaskAwareCompactionDiagnostics } from './types.ts'

/** How many Sessions' most recent observations are retained. */
const RETAINED_SESSIONS = 64

/** The mutable part of a diagnostics record, so a caller can update one field. */
export type TaskAwareDiagnosticsUpdate = Partial<TaskAwareCompactionDiagnostics>

/**
 * The bounded, process-local latest-observation store.
 *
 * Insertion order is the eviction order, so a long-lived process that touches
 * many Sessions keeps the most recently seen ones and drops the oldest rather
 * than growing without bound.
 */
export class TaskAwareDiagnosticsStore {
  private readonly latest = new Map<string, TaskAwareCompactionDiagnostics>()

  /**
   * Read the most recent observation for one Session.
   * @param sessionId - the Session identity.
   * @returns the observation, or `undefined` when the policy has not run for it.
   */
  read(sessionId: string): TaskAwareCompactionDiagnostics | undefined {
    return this.latest.get(sessionId)
  }

  /**
   * Record one observation, replacing any earlier one for that Session.
   * @param sessionId - the Session identity.
   * @param diagnostics - the complete observation to retain.
   */
  write(sessionId: string, diagnostics: TaskAwareCompactionDiagnostics): void {
    // Delete first so a re-written key becomes the most recently inserted and
    // is therefore the last to be evicted.
    this.latest.delete(sessionId)
    this.latest.set(sessionId, diagnostics)
    while (this.latest.size > RETAINED_SESSIONS) {
      const oldest = this.latest.keys().next()
      /* v8 ignore next -- the loop condition proves at least one key exists */
      if (oldest.done === true) break
      this.latest.delete(oldest.value)
    }
  }

  /** Drop every retained observation, so a disposed policy reports nothing. */
  clear(): void {
    this.latest.clear()
  }
}

/**
 * The observation a Session has before anything has happened.
 *
 * `mainRunReasoningUnchanged` starts `true` because no auxiliary request has
 * yet had the opportunity to change anything; it is a claim the policy must
 * keep true, not a claim it makes in advance of doing work.
 * @param previous - the observation being replaced, so protected counts survive a phase change.
 * @returns the idle observation.
 */
export function idleDiagnostics(
  previous?: TaskAwareCompactionDiagnostics,
): TaskAwareCompactionDiagnostics {
  return {
    status: 'idle',
    protectedEvidenceCount: previous?.protectedEvidenceCount ?? 0,
    mainRunReasoningUnchanged: true,
  }
}
