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
}
