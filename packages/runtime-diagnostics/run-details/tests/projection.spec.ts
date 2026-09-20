/**
 * The Run Details transport's value is its restraint, so these tests pin what it
 * must NOT do as much as what it must serve: it hides instead of rendering a
 * placeholder when no Run exists, takes run identity from Stage 7 rather than
 * minting one, keeps `unknown` unknown, never lets backend evidence upgrade a
 * run, keeps main-run reasoning separate from a compaction's auxiliary
 * reasoning, and carries nothing a transient compaction status left behind.
 */

import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session/types'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { taskIdFromString, taskStepIdFromString } from '@deepseek-ai/dsh-task-checkpoint'
import type { TaskCheckpoint } from '@deepseek-ai/dsh-task-checkpoint'
import { emptyRunDetailsState, runDetailsProjectionDefinition } from '@deepseek-ai/dsh-run-details'
import { runDetailsStateSchema, runDetailsViewSchema } from '@deepseek-ai/dsh-run-details'
import type { RunDetailsState, RunDetailsView } from '@deepseek-ai/dsh-run-details/types'

/**
 * Build one committed log-only event; `data` stays typed at the call site.
 * `time` defaults off the seq so a log reads as one millisecond-spaced stream,
 * and is overridable so a test can hold the clock still.
 */
function event<T extends SessionEventType>(
  type: T,
  seq: number,
  data: SessionEventMap[T],
  time = 1_000 + seq * 1_000,
): SessionEvent {
  return { type, seq: SessionSeq(seq), time, data } as unknown as SessionEvent
}

const SESSION = SessionId('session-run-details')

/** Fold a whole log through the registered unit. */
function fold(events: readonly SessionEvent[]): RunDetailsState {
  let state = emptyRunDetailsState(SESSION)
  for (const next of events) state = runDetailsProjectionDefinition.apply(state, next)
  return state
}

/** Fold a log and read the served cut. */
function view(events: readonly SessionEvent[]): RunDetailsView {
  const cut = fold(events).cut
  expect(runDetailsViewSchema.safeParse(cut).success).toBe(true)
  return cut
}

const turnStart = (seq: number, turn: number): SessionEvent => event('turn/start', seq, { turn })
const stepStart = (seq: number, turn: number, step: number): SessionEvent => event('step/start', seq, { turn, step })
const stepEnd = (seq: number, turn: number, step: number): SessionEvent => event('step/end', seq, { turn, step })
const turnEnd = (seq: number, turn: number, kind: string): SessionEvent =>
  event('turn/end', seq, { turn, reason: { kind } as SessionEventMap['turn/end']['reason'] })

const failure = { message: 'provider unavailable', code: 'PROVIDER_UNAVAILABLE' }

const retry = (seq: number, retryId: string): SessionEvent => event('llm/retry', seq, {
  retryId: RetryId(retryId),
  turn: 1,
  step: 1,
  provider: 'deepseek',
  mode: 'normal',
  policyKey: 'policy',
  retry: 1,
  maxRetries: 3,
  delayMs: 100,
  failure,
})

const header = (seq: number, effort: string, adapterDefault = false): SessionEvent =>
  event('request/header', seq, {
    header: {
      config: { reasoningEffort: effort } as SessionEventMap['request/header']['header']['config'],
      ...adapterDefault ? { adapterDefaults: { reasoningEffort: true } } : {},
    },
    reason: 'initial',
  })

/** A `compaction/summary` carrying the Stage 10 policy audit. */
const summaryWithAudit = (seq: number): SessionEvent => event('compaction/summary', seq, {
  compactionId: 'compaction-1',
  summary: [],
  shadowedRange: { start: SessionSeq(1), end: SessionSeq(2) },
  shadowedSeqs: [SessionSeq(1), SessionSeq(2)],
  shadowedTokenCount: 100,
  provider: 'deepseek',
  model: 'deepseek-chat',
  policyAudit: {
    policyId: 'compaction-task-aware-policy',
    policyVersion: '1',
    trigger: 'context-overflow',
    candidateAttempts: 2,
    authorityAsOfSeq: 12,
    protectionHash: 'digest',
    auxiliaryReasoning: { requested: 'low', resolved: 'low', source: 'policy' },
  },
} as unknown as SessionEventMap['compaction/summary'])

const TASK = taskIdFromString('task-1')
const PENDING_STEP = taskStepIdFromString('step-draft')

/**
 * A whole valid durable checkpoint naming the Run this Session reached.
 *
 * `latestRunId` is derived from the turn the caller says the Session reached,
 * because that equality is what Stage 8's decision compares: a fixture that
 * hard-coded it would silently turn every case into `SESSION_DIVERGED`.
 */
function checkpoint(overrides: Partial<TaskCheckpoint> = {}, turn = 1): TaskCheckpoint {
  return {
    version: 1,
    taskId: TASK,
    revision: 1,
    taskType: 'report',
    sessionId: SESSION,
    originRunId: runIdFor(SESSION, turn),
    latestRunId: runIdFor(SESSION, turn),
    status: 'running',
    originalExecution: { provider: 'deepseek', model: 'chat' },
    latestExecution: { provider: 'deepseek', model: 'chat' },
    modelRelation: 'same-model',
    completedSteps: [],
    pendingSteps: [{ id: PENDING_STEP, title: 'Draft' }],
    createdAt: 1_000,
    lastActivityAt: 1_000,
    resumeContext: { objective: 'write the report', constraints: [], decisions: [], criticalContext: [] },
    outputs: [],
    ...overrides,
  }
}

const checkpointEvent = (seq: number, value: TaskCheckpoint = checkpoint()): SessionEvent =>
  event('task/checkpoint', seq, { kind: 'task/checkpoint', version: 1, checkpoint: value })

/** A durable failed tool result, which Stage 8's own fold turns into repair evidence. */
const toolFailure = (seq: number, callId: string, code: string): SessionEvent =>
  event('tool/result', seq, {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      isError: true,
      content: [{ type: 'text', text: 'result' }],
    }),
    error: { name: 'ToolError', code },
  })

/** One closed durable turn, so the Session's last turn is not left open. */
const closedTurn = (seq: number, turn: number): SessionEvent[] => [
  turnStart(seq, turn),
  turnEnd(seq + 1, turn, 'completed'),
]

/** Read the guarded-resume row from a log, failing the test when it is absent. */
function guardedResumeOf(events: readonly SessionEvent[]): NonNullable<
  Extract<RunDetailsView, { hasRun: true }>['guardedResume']
> {
  const cut = view(events)
  if (!cut.hasRun) throw new Error('expected a run')
  if (cut.guardedResume === null) throw new Error('expected a guarded-resume decision')
  return cut.guardedResume
}

describe('run details transport', () => {
  it('serves no Run at all for an empty log, so a client has nothing to placeholder', () => {
    const cut = view([])
    expect(cut).toEqual({ sessionId: SESSION, hasRun: false })
  })

  it('reports hasRun false while no durable turn has opened', () => {
    const cut = view([header(0, 'high')])
    expect(cut.hasRun).toBe(false)
  })

  it('surfaces a Run once its durable turn opens', () => {
    const cut = view([turnStart(0, 1)])
    expect(cut.hasRun).toBe(true)
    if (!cut.hasRun) return
    expect(cut.active).toBe(true)
    expect(cut.turn).toBe(1)
    expect(cut.phase).toBe('starting')
    expect(cut.stepCount).toBe(0)
    expect(cut.openStep).toBeNull()
  })

  it('takes run identity from Stage 7 and never mints its own', () => {
    const cut = view([turnStart(0, 3)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.runId).toBe(runIdFor(SESSION, 3))
    expect(String(cut.runId).startsWith('run:v1:')).toBe(true)
  })

  it('advances the phase only as far as durable boundaries prove', () => {
    const cut = view([turnStart(0, 1), stepStart(1, 1, 0)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.phase).toBe('executing')
    expect(cut.stepCount).toBe(1)
    expect(cut.openStep).toBe(0)
  })

  it('keeps a closed Run as history, marked inactive with its terminal reason', () => {
    const cut = view([turnStart(0, 1), stepStart(1, 1, 0), stepEnd(2, 1, 0), turnEnd(3, 1, 'completed')])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.active).toBe(false)
    expect(cut.phase).toBe('completed')
    expect(cut.terminalReason).toBe('completed')
    expect(cut.repairClosure).toBe(false)
    expect(cut.openStep).toBeNull()
  })

  it('reports the retry count the durable retry chain records', () => {
    const cut = view([turnStart(0, 1), stepStart(1, 1, 0), retry(2, 'chain-a')])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.retryCount).toBe(1)
    expect(cut.maxRetryCount).toBe(3)
    expect(cut.retryReason).toBe('PROVIDER_UNAVAILABLE')
  })

  it('keeps backend evidence unknown instead of upgrading an unobserved backend', () => {
    const cut = view([turnStart(0, 1), stepStart(1, 1, 0)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.backend.reachability).toBe('unknown')
    expect(cut.backend.activity).toBe('unknown')
    expect(cut.backend.directness).toBe('unavailable')
    expect(cut.backend.source).toBe('none')
  })

  it('never reports healthy from absent backend evidence', () => {
    // A run whose last meaningful activity is long past is `stalled`, never
    // `healthy`: no observer proved progress, and silence is not health.
    const quiet = event('user/message', 300, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'again' }],
    } as unknown as SessionEventMap['user/message'])
    const cut = view([turnStart(0, 1), stepStart(1, 1, 0), stepEnd(2, 1, 0), quiet])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.health).not.toBe('healthy')
    expect(cut.health).toBe('stalled')
  })

  it('re-derives elapsed-time health on events the Run itself does not track', () => {
    const state = fold([turnStart(0, 1), stepStart(1, 1, 0)])
    const quiet = event('user/message', 9, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    } as unknown as SessionEventMap['user/message'], 1_000)
    const later = runDetailsProjectionDefinition.apply(state, quiet)
    // Same clock, same Run: nothing to republish.
    expect(later).toBe(state)
  })

  it('reads main-run reasoning from the durable request header', () => {
    const cut = view([header(0, 'high'), turnStart(1, 1)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.reasoning).toEqual({
      requested: 'high',
      resolved: 'high',
      adapterMaterialized: false,
      atSeq: 0,
      at: 1_000,
    })
  })

  it('marks an adapter-materialized effort as requested by nobody', () => {
    const cut = view([header(0, 'high', true), turnStart(1, 1)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.reasoning).toEqual({
      resolved: 'high',
      adapterMaterialized: true,
      atSeq: 0,
      at: 1_000,
    })
  })

  it('keeps a compaction auxiliary effort out of the main-run reasoning', () => {
    const cut = view([header(0, 'high'), turnStart(1, 1), summaryWithAudit(2)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.reasoning?.requested).toBe('high')
    expect(cut.compaction).toEqual({
      policyId: 'compaction-task-aware-policy',
      policyVersion: '1',
      trigger: 'context-overflow',
      candidateAttempts: 2,
      authorityAsOfSeq: 12,
      protectionHash: 'digest',
      requestedReasoning: 'low',
      resolvedReasoning: 'low',
      reasoningSource: 'policy',
      atSeq: 2,
      at: 3_000,
    })
  })

  it('serves no compaction facts before a summary commits one', () => {
    const cut = view([turnStart(0, 1)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.compaction).toBeNull()
    expect(cut.reasoning).toBeNull()
  })

  it('carries no transient compaction status: only a committed audit travels', () => {
    // `compaction/start` opens a transaction whose progress is process-local;
    // nothing about it may reach the wire, so the fold ignores it entirely.
    const start = event('compaction/start', 2, {
      compactionId: 'compaction-1',
      trigger: 'context-overflow',
      beforeTokens: 10_000,
      maxTokens: 2_000,
    } as unknown as SessionEventMap['compaction/start'], 3_000)
    const state = fold([turnStart(0, 1), stepStart(1, 1, 0)])
    expect(runDetailsProjectionDefinition.apply(state, start)).toBe(state)
  })

  it('returns the same state reference for every event it does not track', () => {
    const state = fold([turnStart(0, 1)])
    const unrelated = event('user/message', 1, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    } as unknown as SessionEventMap['user/message'], 1_000)
    expect(runDetailsProjectionDefinition.apply(state, unrelated)).toBe(state)
  })

  it('keeps the served cut reference stable while nothing it reports changes', () => {
    const state = fold([turnStart(0, 1)])
    const again = runDetailsProjectionDefinition.apply(state, event('user/message', 1, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    } as unknown as SessionEventMap['user/message'], 1_000))
    expect(again).toBe(state)
    expect(again.cut).toBe(state.cut)
  })

  it('validates its own fold state, so a persisted row can seed the next fold', () => {
    const state = fold([
      header(0, 'high'),
      turnStart(1, 1),
      stepStart(2, 1, 0),
      retry(3, 'chain-a'),
      summaryWithAudit(4),
      turnEnd(5, 1, 'completed'),
    ])
    expect(runDetailsStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true)
  })

  it('emits no Session event and reads no observer while folding', () => {
    // The fold is a pure state transition: it returns a value and touches
    // nothing else, which is what keeps this surface read-only.
    const state = fold([turnStart(0, 1)])
    expect(Object.keys(state)).toEqual([
      'sessionId', 'lifecycle', 'task', 'results', 'reasoning', 'compaction', 'cut',
    ])
  })
})

/**
 * Stage 8's guarded-resume decision, consumed read-only.
 *
 * Every case here is decided by Stage 8's own `decideGuardedResume` over the
 * durable authority this fold continues; this surface only carries the answer.
 * So the assertions are about *which* Stage 8 class each durable state reaches,
 * and about the two things a panel must never do — invent a decision from
 * authority it could not read, and turn a never-started tool into an unknown
 * outcome.
 */
describe('run details guarded resume', () => {
  const SAFE = [turnStart(0, 1), turnEnd(1, 1, 'completed'), checkpointEvent(2)]

  it('reports an allowed decision for a safe unfinished Task, with its plan size', () => {
    const decision = guardedResumeOf(SAFE)
    expect(decision).toEqual({
      decision: 'allowed',
      reason: 'PENDING_ONLY',
      detail: 'The Task records unfinished steps and no known unsafe side effect.',
      taskId: TASK,
      checkpointRevision: 1,
      pendingStepCount: 1,
      hazardCodes: [],
      planStepCount: 1,
    })
  })

  it('keeps an unknown tool outcome at requires_confirmation', () => {
    const decision = guardedResumeOf([...SAFE, toolFailure(3, 'call-1', TOOL_OUTCOME_UNKNOWN)])
    expect(decision.decision).toBe('requires_confirmation')
    expect(decision.reason).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(decision.hazardCodes).toEqual(['TOOL_OUTCOME_UNKNOWN'])
    // The class is not `allowed`, so no plan is advertised for a Task whose
    // external effect has not been confirmed.
    expect(decision.planStepCount).toBe(0)
  })

  it('never reports a never-started tool as an unknown outcome', () => {
    // Stage 8 keeps `TOOL_NOT_STARTED` admissible: an undisturbed effect needs
    // no confirmation. The evidence still travels verbatim so a reader can tell
    // the two hazards apart, and the reason code must stay `PENDING_ONLY`.
    const decision = guardedResumeOf([...SAFE, toolFailure(3, 'call-1', TOOL_NOT_STARTED)])
    expect(decision.decision).toBe('allowed')
    expect(decision.reason).toBe('PENDING_ONLY')
    expect(decision.hazardCodes).toEqual(['TOOL_NOT_STARTED'])
    expect(decision.hazardCodes).not.toContain('TOOL_OUTCOME_UNKNOWN')
  })

  it('reports a blocked Task as blocked', () => {
    const decision = guardedResumeOf([
      turnStart(0, 1),
      turnEnd(1, 1, 'completed'),
      checkpointEvent(2, checkpoint({ status: 'blocked' })),
    ])
    expect(decision.decision).toBe('blocked')
    expect(decision.reason).toBe('TASK_BLOCKED')
  })

  it('preserves Stage 8 not_applicable semantics for a terminal Task', () => {
    // A completed Task is schema-valid only with no step still in flight, so the
    // fixture must drop the default pending step the `checkpoint` helper adds.
    const completed = guardedResumeOf([
      ...closedTurn(0, 1),
      checkpointEvent(2, checkpoint({ status: 'completed', pendingSteps: [] })),
    ])
    expect(completed.decision).toBe('not_applicable')
    expect(completed.reason).toBe('TASK_COMPLETED')
    expect(completed.planStepCount).toBe(0)
    const cancelled = guardedResumeOf([
      ...closedTurn(0, 1),
      checkpointEvent(2, checkpoint({ status: 'cancelled' })),
    ])
    expect(cancelled.decision).toBe('not_applicable')
    expect(cancelled.reason).toBe('TASK_CANCELLED')
  })

  it('serves no decision when the Session tracks no Task', () => {
    const cut = view([...closedTurn(0, 1)])
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.guardedResume).toBeNull()
  })

  it('serves no decision over a Task authority it could not read as one cut', () => {
    // A checkpoint that opens above revision 1 poisons Stage 8's fold, which
    // retains the failure. Deciding over that fold would be deciding over a
    // value the log does not actually hold, so the surface serves nothing.
    const state = fold([...closedTurn(0, 1), checkpointEvent(2, checkpoint({ revision: 2 }))])
    expect(state.task.failure).not.toBeNull()
    const cut = state.cut
    if (!cut.hasRun) throw new Error('expected a run')
    expect(cut.guardedResume).toBeNull()
    expect(runDetailsStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true)
  })

  it('updates the decision when durable authority moves, through the same state', () => {
    // The decision is derived state, not a cache: a later durable revision that
    // blocks the Task must produce a new cut the change feed can publish.
    const allowed = fold(SAFE)
    const blockedEvent = checkpointEvent(3, checkpoint({ revision: 2, status: 'blocked', lastActivityAt: 2_000 }))
    const next = runDetailsProjectionDefinition.apply(allowed, blockedEvent)
    expect(next).not.toBe(allowed)
    expect(next.cut).not.toBe(allowed.cut)
    if (!next.cut.hasRun) throw new Error('expected a run')
    expect(next.cut.guardedResume?.decision).toBe('blocked')
    expect(runDetailsViewSchema.safeParse(next.cut).success).toBe(true)
  })
})
