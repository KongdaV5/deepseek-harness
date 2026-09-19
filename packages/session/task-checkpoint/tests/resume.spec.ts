/**
 * The Stage 8 guarded-resume decision matrix (cases A–P) plus the ordering rules
 * that make each class reachable for exactly one reason. The policy is pure, so
 * these tests assert the decision *and* the structured evidence behind it: a
 * class without its reason code, plan, or hazard list would not be actionable.
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  buildResumeContext,
  decideGuardedResume,
  taskIdFromString,
  taskOutputIdFromString,
  taskStepIdFromString,
} from '@deepseek-ai/dsh-task-checkpoint'
import type {
  GuardedResumeDecision,
  GuardedResumeInput,
  ResultManifest,
  SuccessfulTaskToolResult,
  TaskCheckpoint,
  TaskRepairHazard,
} from '@deepseek-ai/dsh-task-checkpoint'

const sessionId = SessionId('task-resume')
const task = taskIdFromString('task-1')
const otherTask = taskIdFromString('task-2')
const step1 = taskStepIdFromString('step-1')
const step2 = taskStepIdFromString('step-2')
const output = taskOutputIdFromString('output-1')

/** The Run identity of one committed turn. */
const run = (turn: number) => runIdFor(sessionId, turn)

const execution = { provider: 'deepseek', model: 'chat' }

/** A whole valid Task revision attributed to the Run of turn 4. */
function checkpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return {
    version: 1,
    taskId: task,
    revision: 2,
    taskType: 'report',
    sessionId,
    originRunId: run(3),
    latestRunId: run(4),
    status: 'running',
    originalExecution: execution,
    latestExecution: execution,
    modelRelation: 'same-model',
    completedSteps: [],
    pendingSteps: [{ id: step1, title: 'Draft' }, { id: step2, title: 'Review' }],
    createdAt: 1,
    lastActivityAt: 2,
    resumeContext: {
      objective: 'write the report',
      constraints: ['no network'],
      decisions: ['use markdown'],
      criticalContext: ['customer is legal'],
    },
    outputs: [],
    ...overrides,
  }
}

/** A completed step citing a durable tool result. */
const toolStep = {
  id: step1,
  title: 'Draft',
  completedAt: 10,
  evidence: { kind: 'tool-result' as const, eventSeq: 5 as never, callId: 'call-1' },
}

/** One durable successful tool result as the task projection records it. */
const durableSuccess: SuccessfulTaskToolResult[] = [{ eventSeq: 5 as never, callId: 'call-1' }]

/** A hazard on the addressed Task. */
const hazard = (code: TaskRepairHazard['code']): TaskRepairHazard[] =>
  [{ taskId: task, callId: 'call-1', code, eventSeq: 7 as never }]

/** A settled manifest for the governed output. */
const manifest: ResultManifest = {
  version: 1,
  outputId: output,
  revision: 1,
  taskId: task,
  runId: run(4),
  path: 'report.md',
  status: 'completed',
  createdAt: 1,
  updatedAt: 3,
  completedAt: 3,
  size: 12,
  checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
  execution,
  validation: { status: 'passed', checks: [{ id: 'non-empty', status: 'passed' }] },
}

/** Decide one input with every optional fact defaulted to a safe Session. */
function decide(overrides: Partial<GuardedResumeInput> = {}): GuardedResumeDecision {
  return decideGuardedResume({
    results: [],
    hazards: [],
    successfulToolResults: [],
    sessionId,
    lastTurn: 4,
    openRun: false,
    ...overrides,
  })
}

/** The class/reason pair, which is the whole contract a caller branches on. */
const pair = (decision: GuardedResumeDecision) => ({ decision: decision.decision, reason: decision.reason })

describe('guarded resume decision matrix', () => {
  it('A: no checkpoint is not_applicable and never reconstructs a Task', () => {
    const decision = decide()

    expect(pair(decision)).toEqual({ decision: 'not_applicable', reason: 'NO_CHECKPOINT' })
    expect(decision.taskId).toBeUndefined()
    expect(decision.pendingSteps).toEqual([])
    expect(decision.plan).toEqual([])
    // The Run identity of the committed boundary is still reported as evidence.
    expect(decision.durableRunId).toBe(run(4))
  })

  it('B: a completed Task does not resume', () => {
    const decision = decide({ checkpoint: checkpoint({ status: 'completed', pendingSteps: [] }) })

    expect(pair(decision)).toEqual({ decision: 'not_applicable', reason: 'TASK_COMPLETED' })
    expect(decision.plan).toEqual([])
  })

  it('C: a cancelled Task does not resume', () => {
    const decision = decide({ checkpoint: checkpoint({ status: 'cancelled' }) })

    expect(pair(decision)).toEqual({ decision: 'not_applicable', reason: 'TASK_CANCELLED' })
    expect(decision.plan).toEqual([])
  })

  it('D: a paused Task with pending work and no hazard is allowed', () => {
    const decision = decide({ checkpoint: checkpoint({ status: 'paused' }) })

    expect(pair(decision)).toEqual({ decision: 'allowed', reason: 'PENDING_ONLY' })
    expect(decision.plan).toEqual([step1, step2])
    expect(decision.latestRunId).toBe(run(4))
    expect(decision.checkpointRevision).toBe(2)
  })

  it('E: a partial Task with valid completed evidence is allowed', () => {
    const decision = decide({
      checkpoint: checkpoint({
        status: 'partial',
        completedSteps: [toolStep],
        pendingSteps: [{ id: step2, title: 'Review' }],
      }),
      successfulToolResults: durableSuccess,
    })

    expect(pair(decision)).toEqual({ decision: 'allowed', reason: 'PENDING_ONLY' })
    // The plan is unfinished work only; the completed step is never re-listed.
    expect(decision.plan).toEqual([step2])
  })

  it('F: a running Task whose latest Run closed as interrupted is allowed', () => {
    // The process may have died before another checkpoint was written, so a
    // `running` status with a closed, interrupted latest Run is not corruption.
    const decision = decide({
      checkpoint: checkpoint({ status: 'running' }),
      lastTurn: 4,
      openRun: false,
    })

    expect(pair(decision)).toEqual({ decision: 'allowed', reason: 'PENDING_ONLY' })
    expect(decision.detail).toContain('unfinished steps')
  })

  it('G: an unknown tool outcome requires confirmation instead of a retry', () => {
    const decision = decide({
      checkpoint: checkpoint({ status: 'running' }),
      hazards: hazard('TOOL_OUTCOME_UNKNOWN'),
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'TOOL_OUTCOME_UNKNOWN' })
    expect(decision.plan).toEqual([])
    expect(decision.hazards.map(item => item.code)).toEqual(['TOOL_OUTCOME_UNKNOWN'])
  })

  it('H: a tool that never started does not by itself prevent resume', () => {
    const decision = decide({
      checkpoint: checkpoint({ status: 'running' }),
      hazards: hazard('TOOL_NOT_STARTED'),
    })

    expect(pair(decision)).toEqual({ decision: 'allowed', reason: 'PENDING_ONLY' })
    // The unstarted-tool fact stays visible without changing the class.
    expect(decision.hazards.map(item => item.code)).toEqual(['TOOL_NOT_STARTED'])
    expect(decision.detail).toContain('never started')
    expect(decision.plan).toEqual([step1, step2])
  })

  it('I: a blocked Task is never automatically allowed', () => {
    const decision = decide({ checkpoint: checkpoint({ status: 'blocked' }) })

    expect(pair(decision)).toEqual({ decision: 'blocked', reason: 'TASK_BLOCKED' })
    expect(decision.plan).toEqual([])
  })

  it('J: a fatal structured failure is blocked', () => {
    const decision = decide({
      checkpoint: checkpoint({
        status: 'failed',
        failureContext: {
          primaryError: { code: 'WORKER_CRASH', message: 'worker died', severity: 'fatal', origin: 'backend', time: 5 },
          failedAt: 5,
        },
      }),
    })

    expect(pair(decision)).toEqual({ decision: 'blocked', reason: 'TASK_FAILED_FATAL' })
    expect(decision.plan).toEqual([])
  })

  it('K: a later unexplained Session Run requires reconciliation', () => {
    const decision = decide({
      // The checkpoint stops at turn 3 while the Session already reached turn 4.
      checkpoint: checkpoint({ latestRunId: run(3) }),
      lastTurn: 4,
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'SESSION_DIVERGED' })
    expect(decision.plan).toEqual([])
    expect(decision.durableRunId).toBe(run(4))
    expect(decision.latestRunId).toBe(run(3))
  })

  it('K2: a Run the Session never committed at all requires reconciliation', () => {
    const decision = decide({
      // The Session is the same one, but no turn has committed yet, so the
      // checkpoint's Run cannot be attributed to anything durable.
      checkpoint: checkpoint({ latestRunId: run(3) }),
      lastTurn: 0,
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'SESSION_DIVERGED' })
    expect(decision.durableRunId).toBeUndefined()
    expect(decision.latestRunId).toBe(run(3))
  })

  it('K3: a checkpoint that belongs to another Session is not this Session\'s work', () => {
    const decision = decide({
      checkpoint: checkpoint({ sessionId: SessionId('task-elsewhere') }),
      lastTurn: 9,
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'SESSION_DIVERGED' })
    expect(decision.detail).toContain('task-elsewhere')
  })

  it('L: no pending work fails closed', () => {
    const decision = decide({ checkpoint: checkpoint({ status: 'running', pendingSteps: [] }) })

    expect(pair(decision)).toEqual({ decision: 'blocked', reason: 'NO_PENDING_WORK' })
    expect(decision.plan).toEqual([])
  })

  it('M: a missing referenced Result Manifest requires confirmation', () => {
    const decision = decide({ checkpoint: checkpoint({ outputs: [output] }) })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'MISSING_RESULT_MANIFEST' })
  })

  it('N: missing required completed tool evidence requires confirmation', () => {
    const decision = decide({
      checkpoint: checkpoint({
        status: 'partial',
        completedSteps: [toolStep],
        pendingSteps: [{ id: step2, title: 'Review' }],
      }),
      // The citation exists but nothing durable backs it.
      successfulToolResults: [],
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'MISSING_COMPLETED_EVIDENCE' })
    expect(decision.detail).toContain('no longer resolves to durable success evidence')
  })

  it('O: backend observation is not an input and cannot change a safe decision', () => {
    // Backend health is deliberately absent from the input contract: a durable
    // Task decision must not depend on an adapter this target does not have.
    expectTypeOf<GuardedResumeInput>().not.toHaveProperty('backend')
    expectTypeOf<GuardedResumeInput>().not.toHaveProperty('backendHealth')
    expectTypeOf<GuardedResumeInput>().not.toHaveProperty('healthy')

    const decision = decide({ checkpoint: checkpoint({ status: 'paused' }) })
    expect(decision.decision).toBe('allowed')
  })

  it('P: an absent failedAttemptId does not affect the decision', () => {
    const withoutAttempt = checkpoint({
      status: 'failed',
      failureContext: {
        primaryError: { code: 'PROVIDER_TIMEOUT', message: 'timeout', severity: 'degraded', origin: 'provider', time: 5 },
        failedAt: 5,
      },
    })
    const withAttempt = {
      ...withoutAttempt,
      failureContext: { ...withoutAttempt.failureContext!, failedAttemptId: 'attempt-1' },
    } as TaskCheckpoint

    // Both are recoverable failures; the attempt identity changes nothing.
    expect(pair(decide({ checkpoint: withoutAttempt })))
      .toEqual(pair(decide({ checkpoint: withAttempt })))
    expect(pair(decide({ checkpoint: withoutAttempt })))
      .toEqual({ decision: 'requires_confirmation', reason: 'TASK_FAILED_RECOVERABLE' })
  })
})

describe('guarded resume ordering and evidence', () => {
  it('settles terminal states before any hazard reclassifies them', () => {
    const decision = decide({
      checkpoint: checkpoint({ status: 'completed', pendingSteps: [] }),
      hazards: hazard('TOOL_OUTCOME_UNKNOWN'),
    })

    expect(pair(decision)).toEqual({ decision: 'not_applicable', reason: 'TASK_COMPLETED' })
  })

  it('keeps an explicit Task blocker stronger than a repair hazard', () => {
    const decision = decide({
      checkpoint: checkpoint({ status: 'blocked' }),
      hazards: hazard('TOOL_OUTCOME_UNKNOWN'),
    })

    expect(pair(decision)).toEqual({ decision: 'blocked', reason: 'TASK_BLOCKED' })
  })

  it('reports a recoverable failure as needing explicit recovery', () => {
    const decision = decide({
      checkpoint: checkpoint({
        status: 'failed',
        failureContext: {
          primaryError: { code: 'TOOL_FAILED', message: 'tool failed', severity: 'degraded', origin: 'tool', time: 5 },
          failedAt: 5,
        },
      }),
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'TASK_FAILED_RECOVERABLE' })
  })

  it('refuses to attribute a new Run while a durable turn is still open', () => {
    const decision = decide({ checkpoint: checkpoint(), openRun: true })

    expect(pair(decision)).toEqual({ decision: 'blocked', reason: 'RUN_STILL_OPEN' })
    expect(decision.plan).toEqual([])
  })

  it('requires confirmation when the proposed model differs from the original', () => {
    const decision = decide({
      checkpoint: checkpoint(),
      requestedExecution: { provider: 'deepseek', model: 'reasoner' },
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'MODEL_CHANGED' })
  })

  it('requires confirmation for an unsettled governed result', () => {
    const decision = decide({
      checkpoint: checkpoint({ outputs: [output] }),
      results: [{ ...manifest, status: 'running', validation: { status: 'pending', checks: [] } }],
    })

    expect(pair(decision)).toEqual({ decision: 'requires_confirmation', reason: 'UNSETTLED_RESULT_MANIFEST' })
  })

  it('blocks a resume context that exceeds its own admitted budget', () => {
    const decision = decide({
      checkpoint: checkpoint(),
      context: { estimatedTokens: 101, maxTokens: 100, includedSections: [], omittedSections: [] },
    })

    expect(pair(decision)).toEqual({ decision: 'blocked', reason: 'CONTEXT_OVER_BUDGET' })
    expect(decision.plan).toEqual([])
  })

  it('ignores another Task\u2019s hazards', () => {
    const decision = decide({
      checkpoint: checkpoint(),
      hazards: [{ taskId: otherTask, callId: 'call-1', code: 'TOOL_OUTCOME_UNKNOWN', eventSeq: 7 as never }],
    })

    expect(pair(decision)).toEqual({ decision: 'allowed', reason: 'PENDING_ONLY' })
    expect(decision.hazards).toEqual([])
  })

  it('never places a completed step in the allowed plan', () => {
    const completed = checkpoint({
      status: 'partial',
      completedSteps: [toolStep],
      pendingSteps: [{ id: step2, title: 'Review' }],
      outputs: [output],
    })
    const decision = decide({
      checkpoint: completed,
      results: [manifest],
      successfulToolResults: durableSuccess,
    })

    expect(decision.decision).toBe('allowed')
    expect(decision.plan).toEqual([step2])
    expect(decision.plan).not.toContain(step1)
  })
})

describe('bounded resume context', () => {
  const countCharacters = (text: string) => text.length

  it('carries the Task-owned facts a resumed Run must not rediscover', () => {
    const { text, budget: measured } = buildResumeContext(checkpoint(), [], {
      maxTokens: 1000,
      estimate: countCharacters,
    })
    const document = JSON.parse(text) as Record<string, never>

    expect(document).toMatchObject({ type: 'task_resume_context', version: 1 })
    expect(text).toContain('write the report')
    expect(text).toContain('no network')
    expect(text).toContain('use markdown')
    expect(text).toContain('customer is legal')
    expect(text).toContain('Continue only the pending steps')
    expect(measured.maxTokens).toBe(1000)
    expect(measured.estimatedTokens).toBe(text.length)
  })

  it('names its omissions instead of truncating silently', () => {
    const { budget: measured } = buildResumeContext(checkpoint(), [], {
      maxTokens: 10,
      estimate: countCharacters,
    })

    expect(measured.omittedSections).toEqual(['historical_reasoning', 'full_session_log', 'raw_tool_output'])
    expect(measured.includedSections).toContain('critical_context')
    // The document is never trimmed to fit; the caller sees that it did not.
    expect(measured.estimatedTokens).toBeGreaterThan(measured.maxTokens)
  })

  it('reports section selection from the durable facts present', () => {
    const bare = buildResumeContext(checkpoint({ resumeContext: { objective: 'x', constraints: [], decisions: [], criticalContext: [] } }), [], {
      maxTokens: 100,
      estimate: countCharacters,
    })
    expect(bare.budget.includedSections).toEqual(['task', 'progress'])

    const governed = buildResumeContext(checkpoint({ outputs: [output] }), [manifest], {
      maxTokens: 100,
      estimate: countCharacters,
    })
    expect(governed.budget.includedSections).toEqual(['task', 'progress', 'outputs', 'critical_context'])
  })
})
