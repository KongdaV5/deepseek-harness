/** Production governed-result publication through the shared atomic writer. */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { RunId } from '@deepseek-ai/dsh-agent-run-state'
import type { Session } from '@deepseek-ai/dsh-session'
import type TaskCheckpointService from './index.ts'
import { createTaskOutputId } from './identity.ts'
import type {
  ResultManifest,
  ResultValidationCheck,
  TaskExecutionMetadata,
  TaskId,
  TaskOutputId,
} from './types.ts'

/** Immutable published bytes exposed to one deterministic validator. */
export interface PublishedResultSnapshot {
  readonly path: string
  readonly content: string
  readonly size: number
  readonly checksum: string
}

/** One production result validator; thrown validators become failed checks. */
export interface TaskResultValidator {
  readonly id: string
  validate(snapshot: PublishedResultSnapshot): Promise<Omit<ResultValidationCheck, 'id'>> | Omit<ResultValidationCheck, 'id'>
}

/** Explicit publication request for one Task-governed local file. */
export interface PublishTaskResultOptions {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly execution: TaskExecutionMetadata
  readonly path: string
  readonly content: string
  readonly mode: number
  readonly dirMode?: number
  readonly validators?: readonly TaskResultValidator[]
  readonly outputId?: TaskOutputId
  readonly now?: number
}

/**
 * Local production publisher. It writes atomically, re-reads the final path,
 * hashes and validates those exact bytes, and only then records completion.
 */
export class TaskResultPublisher {
  constructor(
    private readonly service: TaskCheckpointService,
    private readonly session: Session,
  ) {}

  async publish(options: PublishTaskResultOptions): Promise<ResultManifest> {
    await writeFileAtomic(options.path, options.content, {
      mode: options.mode,
      ...(options.dirMode === undefined ? {} : { dirMode: options.dirMode }),
    })
    const [buffer, info] = await Promise.all([readFile(options.path), stat(options.path)])
    const snapshot: PublishedResultSnapshot = {
      path: options.path,
      content: buffer.toString('utf8'),
      size: info.size,
      checksum: createHash('sha256').update(buffer).digest('hex'),
    }
    const checks: ResultValidationCheck[] = [{
      id: 'non-empty',
      status: info.size > 0 ? 'passed' : 'failed',
      ...(info.size > 0 ? {} : { message: 'result is empty' }),
    }]
    for (const validator of options.validators ?? []) {
      try {
        const result = await validator.validate(snapshot)
        checks.push({ id: validator.id, ...result })
      } catch (error) {
        checks.push({
          id: validator.id,
          status: 'failed',
          message: error instanceof Error ? error.message : 'validator threw a non-Error value',
        })
      }
    }
    const passed = checks.every(check => check.status === 'passed')
    const now = options.now ?? Date.now()
    const outputId = options.outputId ?? createTaskOutputId()
    const prior = this.service.getResult(this.session, outputId)
    const manifest: ResultManifest = {
      version: 1,
      outputId,
      revision: (prior?.revision ?? 0) + 1,
      taskId: options.taskId,
      runId: options.runId,
      path: options.path,
      status: passed ? 'completed' : 'partial',
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      ...(passed ? { completedAt: now } : {}),
      size: info.size,
      checksum: { algorithm: 'sha256', value: snapshot.checksum },
      execution: options.execution,
      validation: { status: passed ? 'passed' : 'failed', checks },
    }
    return this.service.saveResultManifest(this.session, manifest)
  }
}
