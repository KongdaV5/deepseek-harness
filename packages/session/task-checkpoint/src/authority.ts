/**
 * One consistent, detached, read-only cut of a Session's durable Task authority.
 *
 * Durable Task authority is append-only and lives in the Session log; the
 * projections the registry folds are the only sanctioned way to read it back.
 * Several consumers need *more than one* projection at once and must see them
 * at a single log position — a consumer that read the checkpoint at one cursor
 * and the result manifests at another could certify a combination that never
 * existed. This module produces that single cut.
 *
 * The cut is a reader, not an authority and not a writer. It cannot append an
 * event, advance a revision, or expose a writer capability, and it deliberately
 * reads the live projection registry rather than any persisted cache: a
 * safety decision must never be taken over a value that trails the log.
 *
 * @module @deepseek-ai/dsh-task-checkpoint/authority
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import { TaskContinuityError } from './errors.ts'
import type {
  ResultManifest,
  ResultManifestProjectionState,
  SuccessfulTaskToolResult,
  TaskCheckpoint,
  TaskCheckpointProjectionState,
  TaskId,
  TaskRepairHazard,
} from './types.ts'

/**
 * The raw projection readings one cut is built from.
 *
 * Every field is read from the live session-projection registry at the same
 * instant, so the resulting snapshot describes one log position rather than a
 * sequence of them.
 */
export interface TaskAuthorityReadings {
  /** The `taskCheckpoint` unit's host state. */
  readonly checkpoint: TaskCheckpointProjectionState
  /** The `taskResults` unit's host state. */
  readonly results: ResultManifestProjectionState
  /** The Session's commit cursor: the number of committed events behind this cut. */
  readonly sequence: number
  /** The last committed turn, or `0` before the first turn closes. */
  readonly lastTurn: number
  /** Whether a turn is currently open. */
  readonly openRun: boolean
}

/** Which Task a cut addresses. */
export interface TaskAuthoritySnapshotOptions {
  /**
   * The Task to address. Defaults to the projection's latest Task, so a caller
   * with no opinion always gets the one the Session is currently tracking.
   */
  readonly taskId?: TaskId
}

/**
 * One Session's durable Task authority, detached and read-only.
 *
 * The arrays are fresh copies of the projected values, so a caller may hold the
 * snapshot across asynchronous work without observing a later fold through it.
 * The contained Task and manifest values are the immutable projection values
 * themselves; nothing here is a mutable handle.
 */
export interface TaskAuthoritySnapshot {
  /** The addressed Task revision, or `undefined` when the Session tracks none. */
  readonly task?: TaskCheckpoint
  /** The projection's latest Task identity, whether or not it was addressed. */
  readonly latestTaskId?: TaskId
  /** Every durable result manifest revision in the Session, in fold order. */
  readonly results: readonly ResultManifest[]
  /** Every projected repair hazard, including hazards owned by another Task. */
  readonly repairHazards: readonly TaskRepairHazard[]
  /** Every projected successful tool result, in fold order. */
  readonly successfulToolResults: readonly SuccessfulTaskToolResult[]
  /** The log position this cut describes. */
  readonly asOfSeq: SessionSeq
  /** The last committed turn at {@link TaskAuthoritySnapshot.asOfSeq}. */
  readonly lastTurn: number
  /** Whether a turn was open at {@link TaskAuthoritySnapshot.asOfSeq}. */
  readonly openRun: boolean
}

/**
 * Build one detached cut from already-read projection state.
 *
 * Pure: it reads the supplied values and copies the arrays a caller may retain.
 * @param readings - the projections and cursor facts, all read at one position.
 * @param options - the Task to address; defaults to the projection's latest.
 * @returns the detached snapshot.
 */
export function taskAuthoritySnapshot(
  readings: TaskAuthorityReadings,
  options: TaskAuthoritySnapshotOptions = {},
): TaskAuthoritySnapshot {
  const taskId = options.taskId ?? readings.checkpoint.latestTaskId
  const task = taskId === undefined
    ? undefined
    : readings.checkpoint.tasks.find(candidate => candidate.taskId === taskId)
  return {
    ...task === undefined ? {} : { task },
    ...readings.checkpoint.latestTaskId === undefined
      ? {}
      : { latestTaskId: readings.checkpoint.latestTaskId },
    results: [...readings.results.manifests],
    repairHazards: [...readings.checkpoint.repairHazards],
    successfulToolResults: [...readings.checkpoint.successfulToolResults],
    asOfSeq: SessionSeq(readings.sequence),
    lastTurn: readings.lastTurn,
    openRun: readings.openRun,
  }
}

/** One Session's raw projection lookups, any of which may be absent. */
export interface TaskAuthorityLookups {
  /** The Session the lookups belong to, for the diagnostic. */
  readonly sessionId: string
  /** The `taskCheckpoint` unit's host state, when it is registered. */
  readonly checkpoint?: TaskCheckpointProjectionState | undefined
  /** The `taskResults` unit's host state, when it is registered. */
  readonly results?: ResultManifestProjectionState | undefined
  /** The Session's commit cursor, when one was read. */
  readonly sequence?: number | undefined
  /** The last committed turn, when the boundary projection was readable. */
  readonly lastTurn?: number | undefined
  /** Whether a turn is open, when the boundary projection was readable. */
  readonly openRun?: boolean | undefined
}

/**
 * Validate raw lookups into complete readings, failing closed when they are not.
 *
 * A reader that cannot prove what the durable authority is must not guess: an
 * absent projection is capability absence, and a failed fold means the log
 * holds a value this build cannot interpret.
 * @param lookups - the candidate readings, any field of which may be absent.
 * @returns the same readings as a complete value.
 * @throws TaskContinuityError with `TASK_AUTHORITY_UNAVAILABLE`.
 */
export function readableTaskAuthority(lookups: TaskAuthorityLookups): TaskAuthorityReadings {
  const { checkpoint, results, sequence, lastTurn, openRun } = lookups
  if (checkpoint === undefined || results === undefined
    || sequence === undefined || lastTurn === undefined || openRun === undefined) {
    throw new TaskContinuityError(
      'TASK_AUTHORITY_UNAVAILABLE',
      `session "${lookups.sessionId}": the taskCheckpoint, taskResults, and turnBoundary projections must all be registered to read task authority`,
    )
  }
  if (checkpoint.failure !== null) {
    throw new TaskContinuityError('TASK_AUTHORITY_UNAVAILABLE', checkpoint.failure)
  }
  if (results.failure !== null) {
    throw new TaskContinuityError('TASK_AUTHORITY_UNAVAILABLE', results.failure)
  }
  return { checkpoint, results, sequence, lastTurn, openRun }
}

/**
 * Whether a Task revision still resolves to the exact same durable value.
 *
 * Used by readers that captured authority earlier and must prove it has not
 * moved since; comparing the whole projected revision is deliberate, because a
 * same-revision-but-different-value state is exactly the corruption a
 * revision-number-only check would miss.
 * @param snapshot - the later cut.
 * @param taskId - the Task the earlier cut addressed.
 * @param revision - the exact revision the earlier cut protected.
 * @returns whether the addressed revision still resolves unchanged.
 */
export function taskRevisionResolves(
  snapshot: TaskAuthoritySnapshot,
  taskId: TaskId,
  revision: number,
): boolean {
  const task = snapshot.task
  return task !== undefined && task.taskId === taskId && task.revision === revision
}
