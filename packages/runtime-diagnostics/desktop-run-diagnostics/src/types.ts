/** Versioned, client-safe values carried by the Desktop Run diagnostics Remote. */

import type { AgentRunState } from '@deepseek-ai/dsh-agent-run-state/types'
import type { CompactionPolicyDiagnostics } from '@deepseek-ai/dsh-reasoning-policy/types'
import type { TaskDiagnostics, TaskId, TaskResumeExecutionResult } from '@deepseek-ai/dsh-task-checkpoint/types'

/** Current wire representation version for the read-only Desktop diagnostics view. */
export const DESKTOP_RUN_DIAGNOSTICS_VERSION = 1 as const

/** One whole, detached diagnostics cut for a single session. */
export interface DesktopRunDiagnosticsSnapshot {
  readonly version: typeof DESKTOP_RUN_DIAGNOSTICS_VERSION
  /** Monotonic only inside one active Remote stream. */
  readonly revision: number
  /** Host timestamp at which this view was assembled. */
  readonly observedAt: number
  /** Composed preset identity when the session recorded one. */
  readonly preset?: string
  /** Latest terminal-safe Run projection. Raw unknown backend evidence never crosses this boundary. */
  readonly run: AgentRunState | null
  readonly checkpoint?: TaskDiagnostics
  readonly compaction?: CompactionPolicyDiagnostics
}

/** Explicit user request to let the Host revalidate and resume a named Task. */
export interface DesktopRunResumeRequest {
  readonly taskId: TaskId
}

/** Host-owned outcome of an explicit resume request. */
export type DesktopRunResumeResult = TaskResumeExecutionResult
