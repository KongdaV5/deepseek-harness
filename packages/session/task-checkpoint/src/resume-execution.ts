/** Explicit safe-resume orchestration and minimal model-context construction. */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type TaskCheckpointService from './index.ts'
import type {
  MinimalResumeContext,
  ResultManifest,
  ResumeDecision,
  TaskCheckpoint,
  TaskExecutionMetadata,
  TaskOutputVerificationIssue,
  TaskResumeExecutionResult,
  TaskResumeRequest,
} from './types.ts'

/** Source id used to recognize the one resume message at the pre-model durability barrier. */
export const TASK_RESUME_MESSAGE_SOURCE = 'dsh-task-checkpoint/resume'

function refusal(
  taskId: TaskResumeRequest['taskId'],
  decision: ResumeDecision,
  outputIssues: readonly TaskOutputVerificationIssue[] = [],
  context?: MinimalResumeContext['budget'],
): TaskResumeExecutionResult {
  return {
    status: 'refused',
    taskId,
    decision,
    outputIssues,
    ...(context === undefined ? {} : { context }),
  }
}

function needsValidation(checkpoint: TaskCheckpoint | undefined, reason: string): ResumeDecision {
  return {
    eligibility: 'NEEDS_VALIDATION',
    reason,
    pendingSteps: checkpoint?.pendingSteps ?? [],
    modelRelation: checkpoint?.modelRelation ?? 'same-model',
  }
}

function currentExecution(agent: Agent, requested?: TaskExecutionMetadata): TaskExecutionMetadata | undefined {
  const provider = agent.options.provider
  const model = agent.options.model
  if (provider === undefined || model === undefined) return undefined
  if (requested !== undefined && (requested.provider !== provider || requested.model !== model)) return undefined
  return requested ?? {
    provider,
    model,
    ...(agent.options.reasoningEffort === undefined
      ? {}
      : { requestedReasoning: String(agent.options.reasoningEffort) }),
  }
}

function evidenceReference(step: TaskCheckpoint['completedSteps'][number]): string {
  const evidence = step.evidence
  if (evidence.kind === 'tool-result') return `session-event:${evidence.eventSeq};call:${evidence.callId}`
  if (evidence.kind === 'result-validation') {
    return `result:${evidence.outputId};manifest-revision:${evidence.manifestRevision}`
  }
  return `${evidence.validator}:${evidence.reference}`
}

/**
 * Render a deliberately bounded resume prompt. Historical reasoning, full
 * Session logs, and raw tool output are represented only by explicit omissions.
 */
export function buildMinimalResumeMessage(
  checkpoint: TaskCheckpoint,
  outputs: readonly ResultManifest[],
  maxTokens: number,
  estimate: (message: ReturnType<typeof createUserMessage>) => number,
): { readonly message: ReturnType<typeof createUserMessage>; readonly context: MinimalResumeContext } {
  const completedOutputs = outputs.filter(output => output.status === 'completed').map(output => ({
    output_id: output.outputId,
    path: output.path,
    status: output.status,
    size: output.size,
    checksum: output.checksum,
    validation: output.validation.status,
  }))
  const partialOutputs = outputs.filter(output => output.status === 'partial').map(output => ({
    output_id: output.outputId,
    path: output.path,
    status: 'partial' as const,
    size: output.size,
    checksum: output.checksum,
    validation: output.validation.status,
  }))
  const document = {
    type: 'task_resume_context',
    version: 1,
    instruction: 'Continue only the pending steps. Never repeat a completed step.',
    task: {
      task_id: checkpoint.taskId,
      objective: checkpoint.resumeContext.objective,
      constraints: checkpoint.resumeContext.constraints,
      decisions: checkpoint.resumeContext.decisions,
    },
    progress: {
      completed_steps: checkpoint.completedSteps.map(step => ({
        id: step.id,
        title: step.title,
        evidence_reference: evidenceReference(step),
      })),
      current_step: checkpoint.currentStep,
      pending_steps: checkpoint.pendingSteps,
    },
    outputs: {
      completed_outputs: completedOutputs,
      partial_outputs: partialOutputs,
    },
    failure: checkpoint.failureContext === undefined
      ? null
      : {
        primary_error: checkpoint.failureContext.primaryError,
        failed_step: checkpoint.failureContext.currentStepId,
      },
    critical_context: checkpoint.resumeContext.criticalContext,
  }
  const includedSections = [
    'task',
    'progress',
    ...(outputs.length === 0 ? [] : ['outputs']),
    ...(checkpoint.failureContext === undefined ? [] : ['failure']),
    ...(checkpoint.resumeContext.criticalContext.length === 0 ? [] : ['critical_context']),
  ]
  const omittedSections = ['historical_reasoning', 'full_session_log', 'raw_tool_output']
  const text = JSON.stringify(document, undefined, 2)
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: TASK_RESUME_MESSAGE_SOURCE,
      form: 'notice',
      summary: `Resume task ${checkpoint.taskId} from its next pending step`,
    },
  })
  const estimatedTokens = estimate(message)
  return {
    message,
    context: {
      text,
      budget: { estimatedTokens, maxTokens, includedSections, omittedSections },
    },
  }
}

/** Verify every referenced output against its latest durable manifest. */
export async function verifyTaskOutputs(
  checkpoint: TaskCheckpoint,
  manifests: readonly ResultManifest[],
): Promise<readonly TaskOutputVerificationIssue[]> {
  const issues: TaskOutputVerificationIssue[] = []
  for (const outputId of checkpoint.outputs) {
    const manifest = manifests.find(candidate => candidate.outputId === outputId)
    if (manifest === undefined) {
      issues.push({ outputId, code: 'MISSING_MANIFEST', message: `output ${outputId} has no Result Manifest` })
      continue
    }
    if (manifest.status !== 'completed' && manifest.status !== 'partial') {
      issues.push({
        outputId,
        code: 'INVALID_MANIFEST_STATE',
        message: `output ${outputId} has non-resumable status ${manifest.status}`,
      })
      continue
    }
    let content: Buffer
    let info: Awaited<ReturnType<typeof stat>>
    try {
      ;[content, info] = await Promise.all([readFile(manifest.path), stat(manifest.path)])
    } catch {
      issues.push({ outputId, code: 'MISSING_FILE', message: `output ${outputId} is missing at ${manifest.path}` })
      continue
    }
    if (manifest.size !== undefined && info.size !== manifest.size) {
      issues.push({ outputId, code: 'SIZE_CHANGED', message: `output ${outputId} size differs from its manifest` })
      continue
    }
    if (manifest.checksum !== undefined) {
      const checksum = createHash('sha256').update(content).digest('hex')
      if (checksum !== manifest.checksum.value) {
        issues.push({ outputId, code: 'CHECKSUM_CHANGED', message: `output ${outputId} checksum differs from its manifest` })
      }
    }
  }
  return issues
}

/** Execute one explicit resume transaction against an already composed live Agent. */
export function executeTaskResume(
  ctx: Context,
  service: TaskCheckpointService,
  agent: Agent,
  request: TaskResumeRequest,
): Promise<TaskResumeExecutionResult> {
  if (!Number.isSafeInteger(request.maxContextTokens) || request.maxContextTokens < 1) {
    throw new Error('task resume maxContextTokens must be a positive safe integer')
  }
  return agent.runMaintenance(async (signal) => {
    const session = agent.session
    const execution = currentExecution(agent, request.execution)
    if (execution === undefined) {
      const checkpoint = service.get(session, request.taskId)
      return refusal(request.taskId, needsValidation(
        checkpoint,
        'The live Agent provider/model is unresolved or does not match the supplied execution metadata.',
      ))
    }

    const evaluate = () => service.diagnostics(session, {
      taskId: request.taskId,
      requestedExecution: execution,
      trigger: 'user',
    })
    let diagnostics = evaluate()
    if (diagnostics.resume.eligibility !== 'SAFE_TO_RESUME') {
      return refusal(request.taskId, diagnostics.resume)
    }
    const initialTask = diagnostics.task
    if (initialTask === undefined) {
      return refusal(request.taskId, needsValidation(undefined, 'The Task checkpoint is unavailable for resume validation.'))
    }
    signal.throwIfAborted()
    let outputIssues = await verifyTaskOutputs(initialTask, diagnostics.outputs)
    if (outputIssues.length > 0) {
      const firstIssue = outputIssues[0]
      return refusal(request.taskId, needsValidation(initialTask, firstIssue?.message ?? 'Task output validation failed.'), outputIssues)
    }

    const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (boundary === undefined || boundary.openTurnStartSeq !== null) {
      return refusal(request.taskId, needsValidation(
        diagnostics.task,
        boundary === undefined
          ? 'The Agent turn-boundary projection is unavailable.'
          : 'The Session still has an open Run and cannot start a resume Run.',
      ))
    }
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      return refusal(request.taskId, needsValidation(
        diagnostics.task,
        'The Agent already has pending input; resume ordering cannot be attributed safely.',
      ))
    }

    const runId = runIdFor(session.id, boundary.lastTurn + 1)
    const recoveringUnstartedResume = initialTask.latestResume?.runId === runId
      && diagnostics.resume.started === false
    if (recoveringUnstartedResume
      && JSON.stringify(initialTask.latestExecution) !== JSON.stringify(execution)) {
      return refusal(request.taskId, needsValidation(
        diagnostics.task,
        'The unstarted resume Run was reserved with different execution metadata.',
      ))
    }
    if (runId === initialTask.latestRunId && !recoveringUnstartedResume) {
      return refusal(request.taskId, needsValidation(
        diagnostics.task,
        'The next turn would not create a distinct Run identity.',
      ))
    }
    const tokenMeter = ctx.get('tokenMeter')
    if (tokenMeter === undefined) {
      return refusal(request.taskId, needsValidation(
        diagnostics.task,
        'The token-meter capability is unavailable; resume context cannot be budgeted safely.',
      ))
    }
    const built = buildMinimalResumeMessage(
      initialTask,
      diagnostics.outputs,
      request.maxContextTokens,
      message => tokenMeter.estimateMessage(message),
    )
    if (built.context.budget.estimatedTokens > request.maxContextTokens) {
      return refusal(
        request.taskId,
        needsValidation(diagnostics.task, 'The minimal resume context exceeds its explicit token budget.'),
        [],
        built.context.budget,
      )
    }

    // Prove that a Session persistence listener is present before staging a
    // new durable revision. The model-facing boundary performs another flush.
    if (!await ctx.sessions.flush(session)) {
      return refusal(request.taskId, needsValidation(
        diagnostics.task,
        'No Session persistence checkpoint participated; resume execution is fail-closed.',
      ))
    }
    signal.throwIfAborted()

    // Re-read all authoritative facts after every awaited operation. The final
    // output read and inbox check precede the synchronous checkpoint+enqueue pair.
    diagnostics = evaluate()
    if (diagnostics.resume.eligibility !== 'SAFE_TO_RESUME') {
      return refusal(request.taskId, diagnostics.resume)
    }
    const checkpoint = diagnostics.task
    if (checkpoint === undefined) {
      return refusal(request.taskId, needsValidation(undefined, 'The Task checkpoint disappeared during resume validation.'))
    }
    outputIssues = await verifyTaskOutputs(checkpoint, diagnostics.outputs)
    signal.throwIfAborted()
    if (outputIssues.length > 0) {
      const firstIssue = outputIssues[0]
      return refusal(request.taskId, needsValidation(checkpoint, firstIssue?.message ?? 'Task output validation failed.'), outputIssues)
    }
    const latestBoundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (latestBoundary === undefined || latestBoundary.openTurnStartSeq !== null
      || latestBoundary.lastTurn !== boundary.lastTurn
      || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      return refusal(request.taskId, needsValidation(
        diagnostics.task,
        'The Agent or Session changed while resume validation was in progress.',
      ))
    }

    const completed = new Set(checkpoint.completedSteps.map(step => step.id))
    const executionPlan = checkpoint.pendingSteps.map(step => step.id)
    /* v8 ignore next 5 -- schema validation requires completedSteps and
       pendingSteps to be disjoint. Keep the synchronous boundary assertion so
       a malformed future projection still fails closed before enqueue. */
    if (executionPlan.some(stepId => completed.has(stepId))) {
      return refusal(request.taskId, needsValidation(
        checkpoint,
        'The resume execution plan intersects completed steps.',
      ))
    }
    const requestedAt = request.requestedAt ?? Date.now()
    const next = recoveringUnstartedResume
      ? checkpoint
      : service.saveCheckpoint(session, {
        ...checkpoint,
        revision: checkpoint.revision + 1,
        latestRunId: runId,
        latestExecution: execution,
        /* v8 ignore next -- eligibility deliberately blocks model changes
             until a future validation authority approves them. Retain the
             persisted relation for that approved future execution path. */
        modelRelation: execution.model === checkpoint.originalExecution.model ? 'same-model' : 'model-changed',
        status: 'running',
        lastActivityAt: Math.max(checkpoint.lastActivityAt, requestedAt),
        latestResume: {
          requestedAt,
          runId,
          executionPlan,
          context: built.context.budget,
        },
      })
    agent.followup(built.message)
    return {
      status: 'started',
      taskId: checkpoint.taskId,
      runId,
      checkpointRevision: next.revision,
      context: built.context.budget,
      pendingSteps: checkpoint.pendingSteps,
    }
  })
}
