/** Deterministic task, step, and atomic result-publisher fixtures. */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ClassifiedRunError, RunId } from '@deepseek-ai/dsh-agent-run-state'
import type { Session } from '@deepseek-ai/dsh-session'
import TaskCheckpointService, { createTaskId, createTaskOutputId, taskStepIdFromString } from './index.ts'
import type {
  ResultManifest,
  TaskCheckpoint,
  TaskExecutionMetadata,
  TaskOutputId,
  TaskStep,
  TaskStepId as TaskStepIdType,
} from './types.ts'

/**
 * Build one deterministic structured test step.
 * @param id - stable non-empty step identity.
 * @param title - human-readable step title, defaulting to `id`.
 * @returns structured fake Task step.
 */
export function FakeTaskStep(id: string, title = id): TaskStep {
  return { id: taskStepIdFromString(id), title }
}

/** Options for starting a deterministic fake task. */
export interface FakeTaskOptions {
  readonly taskType?: string
  readonly runId: RunId
  readonly execution: TaskExecutionMetadata
  readonly steps: readonly TaskStep[]
  readonly objective: string
  readonly now?: number
}

/** Runtime-owned test fixture that advances only at explicit validation boundaries. */
export class FakeTask {
  /** Latest checkpoint committed by this fixture. */
  checkpoint: TaskCheckpoint

  constructor(
    private readonly service: TaskCheckpointService,
    private readonly session: Session,
    options: FakeTaskOptions,
  ) {
    const now = options.now ?? 1
    const taskId = createTaskId()
    this.checkpoint = service.saveCheckpoint(session, {
      version: 1,
      taskId,
      revision: 1,
      taskType: options.taskType ?? 'fake-task',
      sessionId: session.id,
      originRunId: options.runId,
      latestRunId: options.runId,
      status: 'running',
      originalExecution: options.execution,
      latestExecution: options.execution,
      modelRelation: 'same-model',
      completedSteps: [],
      ...(options.steps[0] === undefined ? {} : { currentStep: options.steps[0] }),
      pendingSteps: options.steps,
      createdAt: now,
      lastActivityAt: now,
      resumeContext: {
        objective: options.objective,
        constraints: [],
        decisions: [],
        criticalContext: [],
      },
      outputs: [],
    })
  }

  /**
   * Mark the current step complete with explicit runtime validation evidence.
   * @param now - deterministic completion timestamp.
   * @returns committed next checkpoint.
   */
  completeCurrent(now: number): TaskCheckpoint {
    const current = this.checkpoint.currentStep
    if (current === undefined) throw new Error('fake task has no current step')
    const pending = this.checkpoint.pendingSteps.filter(step => step.id !== current.id)
    const { currentStep: _currentStep, failureContext: _failureContext, ...prior } = this.checkpoint
    this.checkpoint = this.service.saveCheckpoint(this.session, {
      ...prior,
      revision: this.checkpoint.revision + 1,
      completedSteps: [...this.checkpoint.completedSteps, {
        ...current,
        completedAt: now,
        evidence: { kind: 'runtime-validation', validator: 'fake-runtime', reference: `validated:${current.id}` },
      }],
      ...(pending[0] === undefined ? {} : { currentStep: pending[0] }),
      pendingSteps: pending,
      lastSuccessAt: now,
      lastActivityAt: now,
    })
    return this.checkpoint
  }

  /**
   * Attach a separately governed output reference.
   * @param outputId - manifest identity owned by this Task.
   * @param now - deterministic activity timestamp.
   * @returns committed next checkpoint.
   */
  attachOutput(outputId: TaskOutputId, now: number): TaskCheckpoint {
    this.checkpoint = this.service.saveCheckpoint(this.session, {
      ...this.checkpoint,
      revision: this.checkpoint.revision + 1,
      outputs: [...this.checkpoint.outputs, outputId],
      lastActivityAt: now,
    })
    return this.checkpoint
  }

  /**
   * Preserve completed/pending work while recording a terminal Run failure.
   * @param primaryError - classified root Run error.
   * @param now - deterministic failure timestamp.
   * @returns committed failed checkpoint.
   */
  fail(primaryError: ClassifiedRunError, now: number): TaskCheckpoint {
    this.checkpoint = this.service.saveCheckpoint(this.session, {
      ...this.checkpoint,
      revision: this.checkpoint.revision + 1,
      status: 'failed',
      lastActivityAt: now,
      failureContext: {
        primaryError,
        failedAt: now,
        ...(this.checkpoint.currentStep === undefined ? {} : { currentStepId: this.checkpoint.currentStep.id }),
      },
    })
    return this.checkpoint
  }

  /**
   * Preserve a user-cancelled checkpoint without arming automatic resume.
   * @param now - deterministic cancellation timestamp.
   * @returns committed cancelled checkpoint.
   */
  cancel(now: number): TaskCheckpoint {
    this.checkpoint = this.service.saveCheckpoint(this.session, {
      ...this.checkpoint,
      revision: this.checkpoint.revision + 1,
      status: 'cancelled',
      lastActivityAt: now,
    })
    return this.checkpoint
  }

  /**
   * Record a later Run/model selection without starting resume execution.
   * @param runId - newly selected Run identity.
   * @param execution - provider/model/backend/reasoning metadata for that Run.
   * @param now - deterministic selection timestamp.
   * @returns committed paused checkpoint.
   */
  recordResumeSelection(runId: RunId, execution: TaskExecutionMetadata, now: number): TaskCheckpoint {
    this.checkpoint = this.service.saveCheckpoint(this.session, {
      ...this.checkpoint,
      revision: this.checkpoint.revision + 1,
      latestRunId: runId,
      latestExecution: execution,
      modelRelation: execution.model === this.checkpoint.originalExecution.model ? 'same-model' : 'model-changed',
      status: 'paused',
      lastActivityAt: now,
    })
    return this.checkpoint
  }

  /**
   * Finish only after every structured step and governed output is complete.
   * @param now - deterministic completion timestamp.
   * @returns committed completed checkpoint.
   */
  complete(now: number): TaskCheckpoint {
    if (this.checkpoint.pendingSteps.length !== 0) throw new Error('fake task still has pending steps')
    const { currentStep: _currentStep, ...prior } = this.checkpoint
    this.checkpoint = this.service.saveCheckpoint(this.session, {
      ...prior,
      revision: this.checkpoint.revision + 1,
      status: 'completed',
      lastActivityAt: now,
    })
    return this.checkpoint
  }
}

/** Injectable atomic writer used by the deterministic publisher fixture. */
export type FakeAtomicWriter = (path: string, content: string) => Promise<void>

/** Options for publishing and structurally validating one test result. */
export interface FakePublishOptions {
  readonly taskId: TaskCheckpoint['taskId']
  readonly runId: RunId
  readonly execution: TaskExecutionMetadata
  readonly path: string
  readonly content: string
  readonly requiredSections?: readonly string[]
  readonly outputId?: TaskOutputId
  readonly now?: number
}

/**
 * Test-only publisher that uses the shared atomic writer, validates the final
 * file, and records a manifest only after publication succeeds.
 */
export class FakeResultPublisher {
  constructor(
    private readonly service: TaskCheckpointService,
    private readonly session: Session,
    private readonly atomicWrite: FakeAtomicWriter = (path, content) => writeFileAtomic(path, content, { mode: 0o600 }),
  ) {}

  /**
   * Atomically publish, inspect, validate, and record one fake result.
   * @param options - Task linkage, final path/content, and required sections.
   * @returns committed completed or partial Result Manifest.
   */
  async publish(options: FakePublishOptions): Promise<ResultManifest> {
    const now = options.now ?? 1
    await this.atomicWrite(options.path, options.content)
    const finalContent = await readFile(options.path)
    const info = await stat(options.path)
    const required = options.requiredSections ?? []
    const checks = [
      { id: 'non-empty', status: info.size > 0 ? 'passed' : 'failed', ...info.size > 0 ? {} : { message: 'result is empty' } },
      ...required.map(section => ({
        id: `section:${section}`,
        status: finalContent.toString('utf8').includes(section) ? 'passed' as const : 'failed' as const,
        ...finalContent.toString('utf8').includes(section) ? {} : { message: `missing required section ${section}` },
      })),
    ] as const
    const passed = checks.every(check => check.status === 'passed')
    const outputId = options.outputId ?? createTaskOutputId()
    const manifest: ResultManifest = {
      version: 1,
      outputId,
      revision: 1,
      taskId: options.taskId,
      runId: options.runId,
      path: options.path,
      status: passed ? 'completed' : 'partial',
      createdAt: now,
      updatedAt: now,
      ...(passed ? { completedAt: now } : {}),
      size: info.size,
      ...(info.size > 0 ? {
        checksum: { algorithm: 'sha256', value: createHash('sha256').update(finalContent).digest('hex') },
      } : {}),
      execution: options.execution,
      validation: { status: passed ? 'passed' : 'failed', checks },
    }
    return this.service.saveResultManifest(this.session, manifest)
  }
}

/**
 * Type-level fixture helper for APIs accepting task-step ids.
 * @param value - normalized non-empty step identity.
 * @returns branded Task-step identity.
 */
export function fakeTaskStepId(value: string): TaskStepIdType {
  return taskStepIdFromString(value)
}
