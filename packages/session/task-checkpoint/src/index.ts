/**
 * Event-sourced task checkpoint and result-manifest Service. The plugin owns
 * two whole-snapshot Session event streams, two projections, evidence-gated
 * checkpoint writes, explicit resume execution, and read-only diagnostics.
 * It does not retry a tool, restart a backend, or select model policy.
 *
 * @module @deepseek-ai/dsh-task-checkpoint
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { classifyRunError, clientCancelledError, runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { TaskExecutionMetadata } from './types.ts'
import type {
  ResultManifest,
  ResultManifestProjectionState,
  TaskCheckpoint,
  TaskCheckpointProjectionState,
  TaskDiagnostics,
  TaskId,
} from './types.ts'
import './domain.ts'
import { resultManifestSchema, taskCheckpointSchema } from './schema.ts'
import {
  assertResultManifestTransition,
  assertTaskCheckpointTransition,
  resultManifestProjectionDefinition,
  taskCheckpointProjectionDefinition,
} from './projection.ts'
import { classifyResumeEligibility } from './resume.ts'
import { executeTaskResume, TASK_RESUME_MESSAGE_SOURCE } from './resume-execution.ts'
import { TaskResultPublisher } from './result-publisher.ts'
import type { TaskOutputId, TaskResumeExecutionResult, TaskResumeRequest } from './types.ts'

export * from './identity.ts'
export * from './projection.ts'
export * from './resume.ts'
export * from './resume-execution.ts'
export * from './result-publisher.ts'
export * from './schema.ts'
export type * from './domain.ts'
export type * from './types.ts'

/** Stable failure codes from the task-checkpoint write boundary. */
export type TaskCheckpointErrorCode =
  | 'TASK_PROJECTION_UNAVAILABLE'
  | 'TASK_PROJECTION_INVALID'
  | 'TASK_SESSION_MISMATCH'
  | 'TASK_ALREADY_ACTIVE'
  | 'TASK_NOT_FOUND'
  | 'TASK_EVIDENCE_INVALID'
  | 'TASK_RESULT_INVALID'

/** Write rejection with a stable machine-readable code. */
export class TaskCheckpointError extends Error {
  constructor(readonly code: TaskCheckpointErrorCode, message: string) {
    super(message)
    this.name = 'TaskCheckpointError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskCheckpoints: TaskCheckpointService
  }
}

function taskState(ctx: Context, session: Session): TaskCheckpointProjectionState {
  const state = ctx.sessionProjections.stateOf(session, 'taskCheckpoint')
  if (state === undefined) throw new TaskCheckpointError('TASK_PROJECTION_UNAVAILABLE', 'task checkpoint projection is unavailable')
  if (state.failure !== null) throw new TaskCheckpointError('TASK_PROJECTION_INVALID', state.failure)
  return state
}

function resultState(ctx: Context, session: Session): ResultManifestProjectionState {
  const state = ctx.sessionProjections.stateOf(session, 'taskResults')
  if (state === undefined) throw new TaskCheckpointError('TASK_PROJECTION_UNAVAILABLE', 'task result projection is unavailable')
  if (state.failure !== null) throw new TaskCheckpointError('TASK_PROJECTION_INVALID', state.failure)
  return state
}

function isOpen(status: TaskCheckpoint['status']): boolean {
  return status !== 'completed' && status !== 'cancelled'
}

function verifyStepEvidence(
  tasks: TaskCheckpointProjectionState,
  results: ResultManifestProjectionState,
  checkpoint: TaskCheckpoint,
): void {
  for (const step of checkpoint.completedSteps) {
    const evidence = step.evidence
    if (evidence.kind === 'runtime-validation') continue
    if (evidence.kind === 'tool-result') {
      const result = tasks.successfulToolResults.find(candidate => candidate.eventSeq === evidence.eventSeq)
      if (result?.callId !== evidence.callId) {
        throw new TaskCheckpointError(
          'TASK_EVIDENCE_INVALID',
          `completed step ${step.id} does not cite a successful matching tool/result`,
        )
      }
      continue
    }
    const manifest = results.manifests.find(candidate => candidate.outputId === evidence.outputId)
    if (manifest?.revision !== evidence.manifestRevision || manifest.validation.status !== 'passed') {
      throw new TaskCheckpointError(
        'TASK_EVIDENCE_INVALID',
        `completed step ${step.id} does not cite a passed result-manifest revision`,
      )
    }
  }
}

/** Cordis service for explicit safe-boundary writes and read-only task diagnostics. */
export default class TaskCheckpointService extends Service {
  /** Service name for dependency injection. */
  static override readonly name = 'taskCheckpoints'
  /** Session/projection APIs are required; token-meter is checked only by explicit resume. */
  static readonly inject = ['sessionProjections', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'taskCheckpoints')
    ctx.sessionProjections.register(taskCheckpointProjectionDefinition)
    ctx.sessionProjections.register(resultManifestProjectionDefinition)
    // Replace the old model-visible surface with the deliberately minimal
    // resume context. Raw append-origin transcript events remain in JSONL.
    ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
      const resume = messages.find(message => message.source.kind === 'plugin'
        && message.source.plugin === TASK_RESUME_MESSAGE_SOURCE)
      if (resume === undefined) return next()
      if (messages.length !== 1) return { kind: 'reject' }
      const events = agent.session.snapshotEvents()
      const nodes = [...agent.session.surface.nodes].filter(seq => events[seq]?.type !== 'system/message')
      const startSeq = nodes[0]
      const endSeq = nodes.at(-1)
      if (startSeq === undefined || endSeq === undefined) {
        agent.session.append('user/message', resume, { surfaceOp: 'append' })
      } else {
        agent.session.append('user/message', resume, {
          surfaceOp: { op: 'replace', startSeq, endSeq },
          sourceEventSeqs: nodes,
        })
      }
      await ctx.sessions.flush(agent.session)
      return {
        kind: 'enter',
        startsRequestSeries: true,
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'Continue the task from the structured resume context.' }],
          source: {
            kind: 'plugin',
            plugin: TASK_RESUME_MESSAGE_SOURCE,
            form: 'notice',
            summary: 'Start the explicitly requested resume Run',
          },
        })],
      }
    })

    // The trigger message is appended after pre-step middleware returns. This
    // focused barrier persists it, the replacement, and the new Run prefix
    // before the adapter receives a resume request.
    ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === undefined) return next()
      const session = ctx.sessions.get(options.sessionId)
      if (session === undefined) return next()
      const task = taskState(ctx, session).tasks.find(candidate => candidate.latestResume !== undefined
        && candidate.latestResume.runId === candidate.latestRunId)
      const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
      if (task?.latestResume === undefined || boundary === undefined
        || runIdFor(session.id, boundary.lastTurn) !== task.latestResume.runId) return next()
      return (async function* () {
        await ctx.sessions.flush(session)
        yield* next()
      })()
    })

    // A resumed Run owns a new Task revision only when it ends unsuccessfully.
    // Completed turns do not imply that a runtime-confirmed Task step completed.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const primaryError = event.data.reason.kind === 'error'
        ? classifyRunError({ origin: 'provider', error: event.data.reason.error, time: event.time })
        : event.data.reason.kind === 'aborted'
          ? clientCancelledError(event.time)
          : undefined
      if (primaryError === undefined) return
      const runId = runIdFor(session.id, event.data.turn)
      // Session append observers cannot append recursively. Re-read the
      // projection on the next microtask so a newer Task boundary wins.
      queueMicrotask(() => {
        const checkpoint = taskState(ctx, session).tasks.find(task => task.latestRunId === runId
          && task.latestResume?.runId === runId && task.status === 'running')
        if (checkpoint === undefined) return
        this.saveCheckpoint(session, {
          ...checkpoint,
          revision: checkpoint.revision + 1,
          status: event.data.reason.kind === 'aborted' ? 'cancelled' : 'failed',
          lastActivityAt: Math.max(checkpoint.lastActivityAt, event.time),
          failureContext: {
            primaryError,
            failedAt: event.time,
            ...(checkpoint.currentStep === undefined ? {} : { currentStepId: checkpoint.currentStep.id }),
          },
        })
      })
    })
  }

  /**
   * Commit one whole checkpoint at a runtime-confirmed safe boundary.
   * Completion evidence is resolved against durable Session/result facts.
   * @param session - Session that owns the durable Task.
   * @param candidate - complete next checkpoint revision.
   * @returns validated checkpoint after its event commits.
   */
  saveCheckpoint(session: Session, candidate: TaskCheckpoint): TaskCheckpoint {
    const checkpoint = taskCheckpointSchema.parse(candidate)
    if (checkpoint.sessionId !== session.id) {
      throw new TaskCheckpointError('TASK_SESSION_MISMATCH', 'checkpoint sessionId does not match the owning Session')
    }
    const tasks = taskState(this.ctx, session)
    const results = resultState(this.ctx, session)
    const existing = tasks.tasks.find(task => task.taskId === checkpoint.taskId)
    if (existing === undefined) {
      const active = tasks.tasks.find(task => isOpen(task.status))
      if (active !== undefined) {
        throw new TaskCheckpointError('TASK_ALREADY_ACTIVE', `task ${active.taskId} is still active in this Session`)
      }
    }
    assertTaskCheckpointTransition(tasks, checkpoint)
    verifyStepEvidence(tasks, results, checkpoint)
    if (checkpoint.status === 'completed') {
      for (const outputId of checkpoint.outputs) {
        const manifest = results.manifests.find(item => item.outputId === outputId)
        if (manifest?.status !== 'completed') {
          throw new TaskCheckpointError('TASK_RESULT_INVALID', `task cannot complete while output ${outputId} is not completed`)
        }
      }
    }
    session.append('task/checkpoint', {
      kind: 'task/checkpoint',
      version: 1,
      checkpoint,
    })
    return checkpoint
  }

  /**
   * Commit one whole, separately versioned result manifest.
   * @param session - Session that owns the Task and result.
   * @param candidate - complete next result-manifest revision.
   * @returns validated manifest after its event commits.
   */
  saveResultManifest(session: Session, candidate: ResultManifest): ResultManifest {
    const manifest = resultManifestSchema.parse(candidate)
    const tasks = taskState(this.ctx, session)
    if (!tasks.tasks.some(task => task.taskId === manifest.taskId)) {
      throw new TaskCheckpointError('TASK_NOT_FOUND', `result refers to unknown task ${manifest.taskId}`)
    }
    const results = resultState(this.ctx, session)
    assertResultManifestTransition(results, manifest)
    session.append('task/result-manifest', {
      kind: 'task/result-manifest',
      version: 1,
      manifest,
    })
    return manifest
  }

  /**
   * Read one task checkpoint by stable task identity.
   * @param session - Session whose projection is read.
   * @param taskId - stable Task identity to select.
   * @returns latest checkpoint or `undefined` when the Task is absent.
   */
  get(session: Session, taskId: TaskId): TaskCheckpoint | undefined {
    return taskState(this.ctx, session).tasks.find(task => task.taskId === taskId)
  }

  /**
   * Read the latest durable manifest for one governed output identity.
   * @param session - Session whose durable result projection is read.
   * @param outputId - stable output identity to select.
   * @returns latest manifest or `undefined` when the output is absent.
   */
  getResult(session: Session, outputId: TaskOutputId): ResultManifest | undefined {
    return resultState(this.ctx, session).manifests.find(manifest => manifest.outputId === outputId)
  }

  /**
   * Create a local Result Publisher bound to one Session.
   * @param session - Session that receives published result-manifest revisions.
   * @returns publisher that uses atomic write, reread, checksum, and validation ordering.
   */
  resultPublisher(session: Session): TaskResultPublisher {
    return new TaskResultPublisher(this, session)
  }

  /**
   * Explicitly validate and queue one safe resume Run in a live idle Agent.
   * @param agent - live Agent whose current provider/model and ordering are revalidated.
   * @param request - user-authorized Task identity and maximum Resume Context budget.
   * @returns started Run/reservation details or a no-side-effect refusal decision.
   */
  resume(agent: Agent, request: TaskResumeRequest): Promise<TaskResumeExecutionResult> {
    return executeTaskResume(this.ctx, this, agent, request)
  }

  /**
   * Return the diagnostics/read transport for the latest or selected task.
   * This method classifies only; it never schedules resume execution.
   * @param session - Session whose durable Task state is read.
   * @param options - optional Task selection, proposed execution, and trigger authority.
   * @returns detached Task, checkpoint, resume, output, and repair-hazard view.
   */
  diagnostics(
    session: Session,
    options: {
      readonly taskId?: TaskId
      readonly requestedExecution?: TaskExecutionMetadata
      readonly trigger?: 'automatic' | 'user'
    } = {},
  ): TaskDiagnostics {
    const tasks = taskState(this.ctx, session)
    const results = resultState(this.ctx, session)
    const taskId = options.taskId ?? tasks.latestTaskId
    const task = taskId === undefined ? undefined : tasks.tasks.find(candidate => candidate.taskId === taskId)
    const outputs = task === undefined
      ? []
      : results.manifests.filter(output => output.taskId === task.taskId)
    const repairHazards = task === undefined
      ? []
      : tasks.repairHazards.filter(hazard => hazard.taskId === task.taskId)
    const latestResume = task?.latestResume
    let startedAt: number | undefined
    if (latestResume !== undefined) {
      for (const event of session.snapshotEvents()) {
        if (event.type === 'turn/start' && runIdFor(session.id, event.data.turn) === latestResume.runId) {
          startedAt = event.time
          break
        }
      }
    }
    return {
      ...(task === undefined ? {} : {
        task,
        checkpoint: {
          revision: task.revision,
          completedSteps: task.completedSteps,
          ...(task.currentStep === undefined ? {} : { currentStep: task.currentStep }),
          pendingSteps: task.pendingSteps,
          ...(task.lastSuccessAt === undefined ? {} : { lastSuccessAt: task.lastSuccessAt }),
        },
      }),
      resume: {
        ...classifyResumeEligibility({
          ...(task === undefined ? {} : { checkpoint: task }),
          outputs,
          repairHazards,
          ...(options.requestedExecution === undefined ? {} : { requestedExecution: options.requestedExecution }),
          ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
        }),
        requested: latestResume !== undefined,
        started: startedAt !== undefined,
        ...(latestResume === undefined ? {} : {
          runId: latestResume.runId,
          requestedAt: latestResume.requestedAt,
          contextEstimatedTokens: latestResume.context.estimatedTokens,
          contextIncludedSections: latestResume.context.includedSections,
          contextOmittedSections: latestResume.context.omittedSections,
        }),
        ...(startedAt === undefined ? {} : { startedAt }),
      },
      outputs,
      repairHazards,
    }
  }
}
