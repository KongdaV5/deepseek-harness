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

import type { TaskAwareCompactionDiagnostics, TaskAwareDiagnosticsListener } from './types.ts'

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
 *
 * The store is also the one place a reader can *observe* those observations.
 * Subscription is observation only: it is layered over the same commit path, it
 * never emits the current value on registration (a reader that wants the current
 * value reads {@link read}), and a listener can neither delay nor fail the write
 * that notified it.
 */
export class TaskAwareDiagnosticsStore {
  private readonly latest = new Map<string, TaskAwareCompactionDiagnostics>()
  private readonly listeners = new Map<string, Set<TaskAwareDiagnosticsListener>>()

  /**
   * @param onListenerError - reports one observer failure so the owner can log
   * it; the committed observation, the writer, and sibling listeners are never
   * affected by it. Defaults to dropping the failure.
   */
  constructor(
    private readonly onListenerError: (sessionId: string, error: unknown) => void = () => {},
  ) {}

  /**
   * Read the most recent observation for one Session.
   * @param sessionId - the Session identity.
   * @returns the observation, or `undefined` when the policy has not run for it.
   */
  read(sessionId: string): TaskAwareCompactionDiagnostics | undefined {
    return this.latest.get(sessionId)
  }

  /**
   * Observe one Session's latest observation until the returned disposer runs.
   *
   * Registration itself is silent: it does not deliver the current observation,
   * so a caller that must not miss a change can register first and then read,
   * with no await between, and see every change that lands in between.
   * @param sessionId - the Session identity to observe.
   * @param listener - receives each complete replacement, or `undefined` on removal.
   * @returns an idempotent disposer; calling it more than once is a no-op.
   */
  subscribe(sessionId: string, listener: TaskAwareDiagnosticsListener): () => void {
    let listeners = this.listeners.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    let observing = true
    return () => {
      if (!observing) return
      observing = false
      const current = this.listeners.get(sessionId)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(sessionId)
    }
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
    // The observation above is already committed: everything below observes it
    // and can change neither it nor this call's outcome.
    const observing = this.listeners.size > 0
    while (this.latest.size > RETAINED_SESSIONS) {
      const oldest = this.latest.keys().next()
      /* v8 ignore next -- the loop condition proves at least one key exists */
      if (oldest.done === true) break
      this.latest.delete(oldest.value)
      if (observing) this.notify(oldest.value, undefined)
    }
    if (observing) this.notify(sessionId, diagnostics)
  }

  /** Drop every retained observation, so a disposed policy reports nothing. */
  clear(): void {
    if (this.listeners.size === 0) {
      this.latest.clear()
      return
    }
    // Every Session that held a value now holds none, so each observer is told
    // exactly that rather than being left to believe the old value is current.
    for (const sessionId of [...this.latest.keys()]) this.notify(sessionId, undefined)
    this.latest.clear()
  }

  private notify(sessionId: string, diagnostics: TaskAwareCompactionDiagnostics | undefined): void {
    const listeners = this.listeners.get(sessionId)
    if (listeners === undefined) return
    // Snapshot the set so one observer unsubscribing mid-notification cannot
    // disturb the delivery another observer is still owed.
    for (const listener of [...listeners]) {
      try {
        listener(diagnostics)
      } catch (error) {
        // A listener is an observer. Its failure is reported for logging and
        // then dropped: it must never reach the writer, the compaction, or a
        // sibling listener that has yet to be called.
        this.onListenerError(sessionId, error)
      }
    }
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
