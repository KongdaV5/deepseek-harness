/** Host-side durable Session event vocabulary for task checkpoints and result manifests. */

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
    /** Required durable task-progress snapshot; older runtimes must not silently ignore it. */
    'task/checkpoint': TaskCheckpointEventData
    /** Required durable result-artifact snapshot, separate from task progress. */
    'task/result-manifest': ResultManifestEventData
  }
}
