/**
 * Read-only, versioned Desktop transport for the local Agent Run projection.
 * It composes existing services; it owns no Run, retry, health, Session, or
 * compaction policy state.
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-run-state'
import type { CompactionPolicyDiagnostics } from '@deepseek-ai/dsh-reasoning-policy/types'
import type { TaskDiagnostics, TaskResumeExecutionResult } from '@deepseek-ai/dsh-task-checkpoint/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  DESKTOP_RUN_DIAGNOSTICS_VERSION,
  type DesktopRunDiagnosticsSnapshot,
  type DesktopRunResumeRequest,
  type DesktopRunResumeResult,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Versioned, read-only Desktop diagnostics service. */
    desktopRunDiagnostics: DesktopRunDiagnosticsService
  }
}

/** Deployment-owned transport pacing and explicit Resume Context limit. */
export interface Config {
  /** Minimum interval that coalesces activity-driven views delivered to one subscriber. */
  readonly coalesceMs: number
  /** Host-side elapsed-health refresh interval while at least one client watches. */
  readonly elapsedRefreshMs: number
  /** Maximum Context tokens admitted by the existing TaskCheckpoint resume executor. */
  readonly maxResumeContextTokens: number
}

interface TaskCheckpointReader {
  diagnostics(session: Agent['session']): TaskDiagnostics
  resume(agent: Agent, request: { readonly taskId: DesktopRunResumeRequest['taskId']; readonly maxContextTokens: number }): Promise<TaskResumeExecutionResult>
}

interface ReasoningPolicyReader {
  compactionDiagnostics(session: Agent['session']): CompactionPolicyDiagnostics | undefined
}

function waitFor(signal: AbortSignal, milliseconds: number, wake?: (resolve: () => void) => () => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, milliseconds)
    const abort = () => { finish() }
    const disposeWake = wake?.(finish)
    signal.addEventListener('abort', abort, { once: true })
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      disposeWake?.()
      resolve()
    }
  })
}

/**
 * Host Remote namespace that exposes the existing diagnostics projections to
 * the Desktop renderer. All reads are detached. Resume remains a separate,
 * user-initiated Host command which delegates to TaskCheckpoint validation.
 */
export class DesktopRunDiagnosticsService extends TypertRemoteService {
  static inject = ['agentRunState']
  static Config = z.object({
    coalesceMs: z.number().step(1).min(1).required(),
    elapsedRefreshMs: z.number().step(1).min(1).required(),
    maxResumeContextTokens: z.number().step(1).min(1).required(),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'desktopRunDiagnostics', { namespace: 'desktopRunDiagnostics' })
  }

  /** Read the latest detached diagnostic cut for one live session Agent. */
  @Remote('snapshot')
  snapshot(agent: Agent): DesktopRunDiagnosticsSnapshot {
    return this.view(agent, 0)
  }

  /**
   * Stream coalesced diagnostic cuts. The Host, not the renderer, refreshes
   * elapsed-only health; activity facts are never delayed in the owner.
   */
  @Remote({ mode: 'stream' })
  async *watch(agent: Agent, signal: AbortSignal): AsyncIterable<DesktopRunDiagnosticsSnapshot> {
    let dirty = true
    let wake: (() => void) | undefined
    const unsubscribe = this.ctx.agentRunState.subscribe(agent.session, () => {
      dirty = true
      wake?.()
    })
    let revision = 0
    try {
      while (!signal.aborted) {
        if (!dirty) {
          await waitFor(signal, this.config.elapsedRefreshMs, (resolve) => {
            wake = resolve
            return () => { if (wake === resolve) wake = undefined }
          })
        }
        if (signal.aborted) return
        dirty = false
        yield this.view(agent, ++revision)
        await waitFor(signal, this.config.coalesceMs)
      }
    } finally {
      unsubscribe()
    }
  }

  /** Explicit user-authorized Resume; TaskCheckpoint revalidates at execution time. */
  @Remote('resume')
  async resume(agent: Agent, request: DesktopRunResumeRequest): Promise<DesktopRunResumeResult> {
    const checkpoints = this.taskCheckpoints()
    if (checkpoints === undefined) throw new Error('desktop run diagnostics: TaskCheckpoint is unavailable')
    return await checkpoints.resume(agent, {
      taskId: request.taskId,
      maxContextTokens: this.config.maxResumeContextTokens,
    })
  }

  private view(agent: Agent, revision: number): DesktopRunDiagnosticsSnapshot {
    const checkpoints = this.taskCheckpoints()
    const reasoning = this.reasoningPolicy()
    const compaction = reasoning?.compactionDiagnostics(agent.session)
    return {
      version: DESKTOP_RUN_DIAGNOSTICS_VERSION,
      revision,
      observedAt: Date.now(),
      ...agent.session.header.agentPreset === undefined ? {} : { preset: agent.session.header.agentPreset },
      // The owner projection may retain raw observer evidence containing an
      // arbitrary Error object. Desktop needs only the classified, terminal-
      // safe Run view; unknown unattributed evidence stays owner-side.
      run: this.ctx.agentRunState.diagnostics(agent.session).run,
      ...checkpoints === undefined ? {} : { checkpoint: checkpoints.diagnostics(agent.session) },
      ...compaction === undefined ? {} : { compaction },
    }
  }

  private taskCheckpoints(): TaskCheckpointReader | undefined {
    return this.ctx.get('taskCheckpoints') as unknown as TaskCheckpointReader | undefined
  }

  private reasoningPolicy(): ReasoningPolicyReader | undefined {
    return this.ctx.get('reasoningPolicy') as unknown as ReasoningPolicyReader | undefined
  }
}

export default DesktopRunDiagnosticsService
