/**
 * The Explicitly guarded-resume policy: a deterministic, read-only decision about
 * whether a durable Task may continue in a new Run.
 *
 * The policy never executes, never allocates, and never names a future turn.
 * It answers one question from durable facts alone — a Task checkpoint, its
 * governed results, projected repair hazards, and the Session's committed
 * turn boundary — and returns a classified decision with structured evidence.
 * Backend health is deliberately not an input: an unavailable adapter cannot
 * make a durable Task unsafe, and a healthy one cannot make it safe.
 *
 * A Task and a Run are different things. A failed, interrupted, or blocked Run
 * does not make the Task failed, and one Task may span several Runs, so the
 * decision is about *unfinished work*, not about the last Run's outcome.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/resume
 */

import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResultManifest,
  RunId,
  SuccessfulTaskToolResult,
  TaskCheckpoint,
  TaskExecutionMetadata,
  TaskId,
  TaskRepairHazard,
  TaskResumeContextBudget,
  TaskStep,
  TaskStepId,
} from './types.ts'

/**
 * The four semantic decision classes. They are intentionally not a boolean:
 * `requires_confirmation` is a real outcome that a human or a later authority
 * must resolve, and `not_applicable` says the policy has nothing to decide
 * rather than that it decided "no".
 */
export type GuardedResumeDecisionClass =
  /** A pending-only plan exists; a caller may admit the next Run. */
  | 'allowed'
  /** Structured evidence demands explicit confirmation before any new Run. */
  | 'requires_confirmation'
  /** A hard, structured hazard forbids an automatic new Run. */
  | 'blocked'
  /** Task-driven resume does not apply to this Session or Task state. */
  | 'not_applicable'

/** Why the policy landed on its decision class. */
export type GuardedResumeReason =
  /** The Session holds no Task checkpoint; a Task is never inferred from prose. */
  | 'NO_CHECKPOINT'
  /** The Task finished; finished work is never reopened automatically. */
  | 'TASK_COMPLETED'
  /** The Task was cancelled; cancellation is a user decision, not a retry input. */
  | 'TASK_CANCELLED'
  /** The Task is explicitly blocked and its blocker is still recorded. */
  | 'TASK_BLOCKED'
  /** The Task failed with a fatal structured error and is not automatically retried. */
  | 'TASK_FAILED_FATAL'
  /** The Task failed with a recoverable error; only explicit recovery may continue it. */
  | 'TASK_FAILED_RECOVERABLE'
  /** A side-effecting tool may have run without a durable outcome. */
  | 'TOOL_OUTCOME_UNKNOWN'
  /** No unfinished step remains; the state is inconsistent with a resumable Task. */
  | 'NO_PENDING_WORK'
  /** A durable turn is still open, so a second Run cannot be attributed. */
  | 'RUN_STILL_OPEN'
  /** The checkpoint and the Session disagree about identity or executed history. */
  | 'SESSION_DIVERGED'
  /** The proposed execution differs from the Task's original model. */
  | 'MODEL_CHANGED'
  /** A governed output has no durable manifest at all. */
  | 'MISSING_RESULT_MANIFEST'
  /** A governed output has a manifest that is neither completed nor explicitly partial. */
  | 'UNSETTLED_RESULT_MANIFEST'
  /** A completed step's stored evidence no longer resolves to durable success. */
  | 'MISSING_COMPLETED_EVIDENCE'
  /** The structured resume context does not fit its admitted budget. */
  | 'CONTEXT_OVER_BUDGET'
  /** A pending-only plan is safe to admit. */
  | 'PENDING_ONLY'

/** Read-only facts one resume decision is computed from. */
export interface GuardedResumeInput {
  /** Latest durable Task revision, when the Session is Task-tracked at all. */
  readonly checkpoint?: TaskCheckpoint
  /** Every durable result manifest revision in the Session. */
  readonly results: readonly ResultManifest[]
  /** Projected repair hazards, one per tool call whose side effect is ambiguous. */
  readonly hazards: readonly TaskRepairHazard[]
  /** Projected proof of the tool results that durably succeeded. */
  readonly successfulToolResults: readonly SuccessfulTaskToolResult[]
  /** The owning Session identity, used to derive the committed Run. */
  readonly sessionId: SessionId
  /** Highest committed turn in the Session; `0` before the first turn. */
  readonly lastTurn: number
  /** Whether a committed turn is still open (no matching `turn/end`). */
  readonly openRun: boolean
  /** The execution a caller proposes to resume with, when it already knows one. */
  readonly requestedExecution?: TaskExecutionMetadata
  /** The structured budget of the context a caller proposes to resume with. */
  readonly context?: TaskResumeContextBudget
}

/** The deterministic policy result, carrying the evidence it was computed from. */
export interface GuardedResumeDecision {
  readonly decision: GuardedResumeDecisionClass
  readonly reason: GuardedResumeReason
  /** One sentence explaining the class from durable facts, never from model prose. */
  readonly detail: string
  readonly taskId?: TaskId
  readonly checkpointRevision?: number
  /** The Run the Task's latest durable revision is attributed to. */
  readonly latestRunId?: RunId
  /** The committed Run the Session had reached when the decision was made. */
  readonly durableRunId?: RunId
  /** The step the Task was last working on, when one remains unfinished. */
  readonly currentStep?: TaskStep
  /** Every unfinished step, in Task order. */
  readonly pendingSteps: readonly TaskStep[]
  /** Hazard evidence relevant to this Task, whether or not it changed the class. */
  readonly hazards: readonly TaskRepairHazard[]
  /** Unfinished work the caller may admit; empty unless the class is `allowed`. */
  readonly plan: readonly TaskStepId[]
}

/** The Task-scoped hazards, which other Tasks' hazards never influence. */
function taskHazards(input: GuardedResumeInput, taskId: TaskId): readonly TaskRepairHazard[] {
  return input.hazards.filter(hazard => hazard.taskId === taskId)
}

/**
 * Whether one completed step's stored evidence still resolves to durable success.
 *
 * `runtime-validation` evidence keeps its stored validator reference; only the
 * runtime that produced it can reinterpret it, so this policy leaves it alone.
 */
function evidenceIsDurable(
  input: GuardedResumeInput,
  step: TaskCheckpoint['completedSteps'][number],
): boolean {
  const evidence = step.evidence
  if (evidence.kind === 'runtime-validation') return true
  if (evidence.kind === 'tool-result') {
    return input.successfulToolResults
      .some(result => result.eventSeq === evidence.eventSeq && result.callId === evidence.callId)
  }
  const manifest = input.results.find(candidate => candidate.outputId === evidence.outputId)
  return manifest?.revision === evidence.manifestRevision && manifest.validation.status === 'passed'
}

/** Build one decision value with the task-scoped evidence already attached. */
function decide(
  input: GuardedResumeInput,
  checkpoint: TaskCheckpoint | undefined,
  decision: GuardedResumeDecisionClass,
  reason: GuardedResumeReason,
  detail: string,
): GuardedResumeDecision {
  return {
    decision,
    reason,
    detail,
    ...checkpoint === undefined ? {} : { taskId: checkpoint.taskId, checkpointRevision: checkpoint.revision },
    ...checkpoint === undefined ? {} : { latestRunId: checkpoint.latestRunId },
    ...input.lastTurn < 1 ? {} : { durableRunId: runIdFor(input.sessionId, input.lastTurn) },
    ...checkpoint?.currentStep === undefined ? {} : { currentStep: checkpoint.currentStep },
    pendingSteps: checkpoint?.pendingSteps ?? [],
    hazards: checkpoint === undefined ? [] : taskHazards(input, checkpoint.taskId),
    plan: decision === 'allowed' && checkpoint !== undefined
      ? checkpoint.pendingSteps.map(step => step.id)
      : [],
  }
}

/**
 * Classify whether a durable Task may continue in a new Run.
 *
 * Checks run in a deliberate order. Terminal states settle first so no later
 * hazard reclassifies them; the unknown-side-effect hazard then outranks every
 * recoverable state, because an undisturbed external effect cannot be undone by
 * a policy decision. Everything after that is fail-closed reconciliation:
 * inconsistent or unverifiable durable facts never become an automatic Run.
 *
 * @param input - durable Task, result, hazard, and turn-boundary facts.
 * @returns the classified decision with a pending-only plan when allowed.
 */
export function decideGuardedResume(input: GuardedResumeInput): GuardedResumeDecision {
  const checkpoint = input.checkpoint
  if (checkpoint === undefined) {
    return decide(input, undefined, 'not_applicable', 'NO_CHECKPOINT', 'The Session holds no Task checkpoint.')
  }
  // Identity settles first: every later check assumes the checkpoint describes
  // *this* Session, so a checkpoint that was folded in from another one — a fork
  // whose lineage it never adopted, or a foreign log — is never interpreted as
  // this Session's unfinished work.
  if (checkpoint.sessionId !== input.sessionId) {
    return decide(
      input,
      checkpoint,
      'requires_confirmation',
      'SESSION_DIVERGED',
      `The Task checkpoint belongs to session "${String(checkpoint.sessionId)}", not "${String(input.sessionId)}".`,
    )
  }
  if (checkpoint.status === 'completed') {
    return decide(input, checkpoint, 'not_applicable', 'TASK_COMPLETED', 'The Task is already completed.')
  }
  if (checkpoint.status === 'cancelled') {
    return decide(input, checkpoint, 'not_applicable', 'TASK_CANCELLED', 'The Task was cancelled by its user.')
  }
  const hazards = taskHazards(input, checkpoint.taskId)
  if (checkpoint.status === 'blocked') {
    return decide(
      input,
      checkpoint,
      'blocked',
      'TASK_BLOCKED',
      'The Task is explicitly blocked and its recorded blocker is unresolved.',
    )
  }
  if (checkpoint.status === 'failed') {
    if (checkpoint.failureContext?.primaryError.severity === 'fatal') {
      return decide(
        input,
        checkpoint,
        'blocked',
        'TASK_FAILED_FATAL',
        `The Task failed fatally with ${checkpoint.failureContext.primaryError.code}.`,
      )
    }
    return decide(
      input,
      checkpoint,
      'requires_confirmation',
      'TASK_FAILED_RECOVERABLE',
      'The Task failed without a fatal classification; only an explicit recovery may continue it.',
    )
  }
  if (hazards.some(hazard => hazard.code === 'TOOL_OUTCOME_UNKNOWN')) {
    return decide(
      input,
      checkpoint,
      'requires_confirmation',
      'TOOL_OUTCOME_UNKNOWN',
      'A recorded tool call has no durable outcome; external state must be confirmed before any retry.',
    )
  }
  if (checkpoint.pendingSteps.length === 0) {
    return decide(
      input,
      checkpoint,
      'blocked',
      'NO_PENDING_WORK',
      'The Task is not terminal yet records no unfinished step to continue.',
    )
  }
  if (input.openRun) {
    return decide(
      input,
      checkpoint,
      'blocked',
      'RUN_STILL_OPEN',
      'A durable turn is still open, so a new Run cannot be attributed to this Task.',
    )
  }
  const durableRunId = input.lastTurn < 1 ? undefined : runIdFor(input.sessionId, input.lastTurn)
  if (durableRunId === undefined || durableRunId !== checkpoint.latestRunId) {
    return decide(
      input,
      checkpoint,
      'requires_confirmation',
      'SESSION_DIVERGED',
      'Durable execution advanced beyond the Run this checkpoint explains, so the Session must be reconciled first.',
    )
  }
  if (input.requestedExecution !== undefined
    && input.requestedExecution.model !== checkpoint.originalExecution.model) {
    return decide(
      input,
      checkpoint,
      'requires_confirmation',
      'MODEL_CHANGED',
      `The proposed model ${input.requestedExecution.model} differs from the Task's original model ${checkpoint.originalExecution.model}.`,
    )
  }
  for (const outputId of checkpoint.outputs) {
    const manifest = input.results.find(candidate => candidate.outputId === outputId)
    if (manifest === undefined) {
      return decide(
        input,
        checkpoint,
        'requires_confirmation',
        'MISSING_RESULT_MANIFEST',
        `Governed output ${String(outputId)} has no durable Result Manifest.`,
      )
    }
    if (manifest.status !== 'completed' && manifest.status !== 'partial') {
      return decide(
        input,
        checkpoint,
        'requires_confirmation',
        'UNSETTLED_RESULT_MANIFEST',
        `Governed output ${String(outputId)} has unsettled status ${manifest.status}.`,
      )
    }
  }
  const unsupported = checkpoint.completedSteps.find(step => !evidenceIsDurable(input, step))
  if (unsupported !== undefined) {
    return decide(
      input,
      checkpoint,
      'requires_confirmation',
      'MISSING_COMPLETED_EVIDENCE',
      `Completed step ${String(unsupported.id)} no longer resolves to durable success evidence.`,
    )
  }
  if (input.context !== undefined && input.context.estimatedTokens > input.context.maxTokens) {
    return decide(
      input,
      checkpoint,
      'blocked',
      'CONTEXT_OVER_BUDGET',
      `The resume context estimates ${String(input.context.estimatedTokens)} tokens against a budget of ${String(input.context.maxTokens)}.`,
    )
  }
  const unstarted = hazards.some(hazard => hazard.code === 'TOOL_NOT_STARTED')
  return decide(
    input,
    checkpoint,
    'allowed',
    'PENDING_ONLY',
    unstarted
      ? 'The interrupted tool never started, and only unfinished steps remain.'
      : 'The Task records unfinished steps and no known unsafe side effect.',
  )
}

/** Closed inputs for one bounded resume context document. */
export interface ResumeContextOptions {
  /** Token ceiling the document must fit inside. */
  readonly maxTokens: number
  /**
   * Pure estimator supplied by the caller. Tokenization belongs to the token
   * meter, so this module never imports one; the value is only ever compared
   * against `maxTokens`.
   */
  readonly estimate: (text: string) => number
}

/** One bounded resume context document plus the budget it was measured against. */
export interface ResumeContext {
  /** The rendered structured document a caller may admit as resume input. */
  readonly text: string
  /** Auditable size and section selection for that document. */
  readonly budget: TaskResumeContextBudget
}

/** One completed step's durable evidence, rendered as a citation. */
function evidenceCitation(step: TaskCheckpoint['completedSteps'][number]): string {
  const evidence = step.evidence
  if (evidence.kind === 'tool-result') return `session-event:${String(evidence.eventSeq)};call:${evidence.callId}`
  if (evidence.kind === 'result-validation') {
    return `result:${String(evidence.outputId)};manifest-revision:${String(evidence.manifestRevision)}`
  }
  return `${evidence.validator}:${evidence.reference}`
}

/**
 * Render the bounded resume context for one Task.
 *
 * The document carries the Task's own `resumeContext` — objective, constraints,
 * decisions, and critical context — so a resumed Run does not have to
 * rediscover facts the checkpoint already owns. Completion is represented by
 * evidence citations, and historical reasoning, the full Session log, and raw
 * tool output are named as explicit omissions instead of being truncated.
 *
 * Trimming is deliberately absent: if the document does not fit, the caller
 * gets a budget showing that it did not, because silently discarding
 * `criticalContext` to fit would resume from a Task the user never approved.
 *
 * @param checkpoint - the durable Task revision to render.
 * @param results - durable result manifests, filtered to the Task's outputs.
 * @param options - token ceiling and the caller's pure estimator.
 * @returns the rendered document and its measured budget.
 */
export function buildResumeContext(
  checkpoint: TaskCheckpoint,
  results: readonly ResultManifest[],
  options: ResumeContextOptions,
): ResumeContext {
  const owned = results.filter(result => checkpoint.outputs.includes(result.outputId))
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
        evidence_reference: evidenceCitation(step),
      })),
      current_step: checkpoint.currentStep ?? null,
      pending_steps: checkpoint.pendingSteps,
    },
    outputs: owned.map(result => ({
      output_id: result.outputId,
      path: result.path,
      status: result.status,
      size: result.size ?? null,
      checksum: result.checksum?.value ?? null,
      validation: result.validation.status,
    })),
    failure: checkpoint.failureContext === undefined
      ? null
      : {
        primary_error: checkpoint.failureContext.primaryError,
        failed_step: checkpoint.failureContext.currentStepId ?? null,
      },
    critical_context: checkpoint.resumeContext.criticalContext,
  }
  const includedSections = [
    'task',
    'progress',
    ...owned.length === 0 ? [] : ['outputs'],
    ...checkpoint.failureContext === undefined ? [] : ['failure'],
    ...checkpoint.resumeContext.criticalContext.length === 0 ? [] : ['critical_context'],
  ]
  const text = JSON.stringify(document, undefined, 2)
  return {
    text,
    budget: {
      estimatedTokens: options.estimate(text),
      maxTokens: options.maxTokens,
      includedSections,
      omittedSections: ['historical_reasoning', 'full_session_log', 'raw_tool_output'],
    },
  }
}
