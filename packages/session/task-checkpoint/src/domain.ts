/** Native task authority metadata, optional only to readers without the task layer.
 * Incoming legacy V3 identities are converted by the Session format catalog;
 * current producers write the ordinary optional event identities through the
 * sole Session writer. Whole revisions remain authoritative to installed consumers.
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
    /** Whole task-progress revision; restore preserves identity, completed work and authority. */
    'task/checkpoint': TaskCheckpointEventData
    /** Whole output revision, separately owned from the task checkpoint referencing it. */
    'task/result-manifest': ResultManifestEventData
  }

  /** Metadata omission preserves conversation history but grants no task continuation authority.
   * Known readers validate these events even when marked optional. Incoming
   * conversion preserves required legacy events without adding an optional marker.
   */
  interface IgnorableSessionEventMap {
    'task/checkpoint': TaskCheckpointEventData
    'task/result-manifest': ResultManifestEventData
  }
}
