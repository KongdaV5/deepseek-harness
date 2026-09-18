/**
 * Host-side durable Session event vocabulary for task checkpoints and result
 * manifests.
 *
 * These two events are the Final Product v1 task authority. They were removed
 * from the current upstream vocabulary, which made every legacy Session
 * carrying them unreadable; this declaration restores them as first-party known
 * events so the existing v3 read path admits a legacy log unchanged.
 *
 * Restoring the vocabulary is deliberately narrower than restoring the
 * subsystem: this package adds no producer, so no current build writes these
 * events, and no legacy log is rewritten or converted to another envelope.
 *
 * The declaration also opts both events into
 * `IgnorableSessionEventMap`, which is the only thing that makes a type
 * eligible for `Session.appendIgnorable`. That is the seam a future producer
 * must use: these events stay required for a reader that knows them, while a
 * reader without the task layer may omit them.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/domain
 */

import type { ResultManifest, TaskCheckpoint } from './types.ts'

/** Whole task checkpoint revision carried by a durable Session event. */
export interface TaskCheckpointEventData {
  readonly kind: 'task/checkpoint'
  readonly version: 1
  readonly checkpoint: TaskCheckpoint
}

/** Whole result-manifest revision carried by a durable Session event. */
export interface ResultManifestEventData {
  readonly kind: 'task/result-manifest'
  readonly version: 1
  readonly manifest: ResultManifest
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole durable task-progress snapshot for one recoverable task, written by
     * the Final Product and now read for compatibility. It is authoritative:
     * the snapshot carries the task identity, revision, status, completed and
     * pending steps, output references, resume context, and root failure that a
     * reader needs to reconstruct task progress, so an older runtime must not
     * silently skip it.
     */
    'task/checkpoint': TaskCheckpointEventData
    /**
     * Whole durable result-artifact snapshot for one task output, written by the
     * Final Product and now read for compatibility. It stays separate from task
     * progress: a manifest revision describes a published deliverable (path,
     * size, checksum, structural validation), which is evidence a task step may
     * reference rather than task state itself.
     */
    'task/result-manifest': ResultManifestEventData
  }

  /**
   * Both task events are optional-subsystem metadata for a reader without the
   * DS Harness task layer: task progress and result manifests are recomputed
   * from live runs, never replayed into model-visible history, so a reader that
   * skips them still reconstructs the same canonical Session and conversation.
   * That is what lets a current producer write them through
   * `Session.appendIgnorable` as events an older or narrower reader may omit,
   * while they stay authoritative known events for this harness.
   *
   * Legacy logs are unaffected: existing events keep their exact bytes, and an
   * event written without the marker remains required-on-read.
   */
  interface IgnorableSessionEventMap {
    'task/checkpoint': TaskCheckpointEventData
    'task/result-manifest': ResultManifestEventData
  }
}
