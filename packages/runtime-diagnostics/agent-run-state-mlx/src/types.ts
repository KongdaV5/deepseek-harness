/** Public configuration and input types for the MLX backend observer. */

import type { AttemptId, BackendAttribution } from '@deepseek-ai/dsh-agent-run-state'

/** Request attribution remains unknown unless an operator declares an exclusive single-flight endpoint. */
export type MlxRequestAttributionMode = 'unknown' | 'exclusive-single-flight'

/** Deployment-owned observer inputs. */
export interface Config {
  /** Unique observer identity within one Agent Run State service. */
  readonly observerId: string
  /** Absolute MLX stdout/stderr log path followed from its current end. */
  readonly logPath: string
  /** File-stat interval used to read appended log records. */
  readonly logPollIntervalMs: number
  /** Optional MLX HTTP health endpoint. */
  readonly healthUrl?: string
  /** Health-probe interval; required even when probing is disabled. */
  readonly healthPollIntervalMs: number
  /** Per-probe timeout before process health becomes degraded. */
  readonly healthTimeoutMs: number
  /** Correlation policy for unstructured request logs. */
  readonly requestAttribution: MlxRequestAttributionMode
  /** Exact DSH provider accepted for lifecycle correlation. */
  readonly provider: string
  /** Exact MLX model ids accepted for lifecycle correlation. */
  readonly models: string[]
}

/** Exact active DSH attempt offered to backend-log correlation. */
export interface MlxAttemptLease {
  readonly attemptId: AttemptId
  readonly provider: string
  readonly model: string
}

/** Process exit supplied by an owner that directly observed the child settlement. */
export interface MlxProcessExit {
  readonly time: number
  readonly message: string
}

/** Current log attribution selected at an explicit backend request marker. */
export type MlxLogAttribution = BackendAttribution
