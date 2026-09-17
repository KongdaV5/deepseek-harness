import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { interruptedTurnClosers, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TaskCheckpointService, { createTaskOutputId } from '@deepseek-ai/dsh-task-checkpoint'
import { FakeResultPublisher, FakeTask, FakeTaskStep } from '@deepseek-ai/dsh-task-checkpoint/testing'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const execution = { provider: 'local', model: 'model-a', backend: 'mlx', requestedReasoning: 'high', resolvedReasoning: 'high' }

async function harness(id = `task-${Math.random()}`, seed?: readonly SessionEvent[]) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TaskCheckpointService)
  contexts.push(ctx)
  const session = ctx.sessions.create(SessionId(id), seed === undefined ? {} : { seed })
  return { ctx, session, service: ctx.taskCheckpoints }
}

function fakeTask(service: TaskCheckpointService, session: Session, count = 3) {
  return new FakeTask(service, session, {
    runId: runIdFor(session.id, 1),
    execution,
    objective: 'finish the structured task',
    steps: Array.from({ length: count }, (_, index) => FakeTaskStep(`step-${index + 1}`)),
  })
}

function resourceLimit(time: number) {
  return {
    code: 'RESOURCE_LIMIT',
    message: 'Metal resource limit exceeded',
    severity: 'fatal',
    origin: 'backend',
    time,
  } as const
}

describe('Phase 4 deterministic task cases', () => {
  it('Case A: completes three evidenced steps and a validated result', async () => {
    const { service, session } = await harness('case-a')
    const task = fakeTask(service, session)
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-a-'))
    roots.push(root)
    const outputId = createTaskOutputId()
    const result = await new FakeResultPublisher(service, session).publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      outputId,
      path: join(root, 'result.md'),
      content: '# Result\ncomplete\n',
      requiredSections: ['# Result'],
      now: 2,
    })
    task.attachOutput(outputId, 3)
    task.completeCurrent(4)
    task.completeCurrent(5)
    task.completeCurrent(6)
    task.complete(7)

    expect(task.checkpoint.status).toBe('completed')
    expect(task.checkpoint.completedSteps.map(step => step.id)).toEqual(['step-1', 'step-2', 'step-3'])
    expect(result).toMatchObject({ status: 'completed', size: 18, validation: { status: 'passed' } })
    expect(service.diagnostics(session).resume.eligibility).toBe('COMPLETED')
  })

  it('Case B: preserves the last safe boundary and leaves the fatal step pending', async () => {
    const { service, session } = await harness('case-b')
    const task = fakeTask(service, session)
    task.completeCurrent(2)
    task.completeCurrent(3)
    task.fail(resourceLimit(4), 4)

    expect(task.checkpoint).toMatchObject({
      status: 'failed',
      currentStep: { id: 'step-3' },
      failureContext: { primaryError: { code: 'RESOURCE_LIMIT' }, currentStepId: 'step-3' },
    })
    expect(task.checkpoint.completedSteps.map(step => step.id)).toEqual(['step-1', 'step-2'])
    expect(task.checkpoint.pendingSteps.map(step => step.id)).toEqual(['step-3'])
    expect(service.diagnostics(session).resume.eligibility).toBe('SAFE_TO_RESUME')
  })

  it('Case C: rebuilds from the Session log and exposes only step 3+ in the resume plan', async () => {
    const first = await harness('case-c')
    const task = fakeTask(first.service, first.session, 4)
    task.completeCurrent(2)
    task.completeCurrent(3)
    task.fail(resourceLimit(4), 4)
    const events = first.session.snapshotEvents()
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-c-persistence-'))
    roots.push(root)
    const persistenceContext = new Context()
    contexts.push(persistenceContext)
    await persistenceContext.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const writer = await persistenceContext.sessionPersistence.create(first.session.header)
    await writer.append(events)
    await writer.flush()
    await writer.close()
    const reader = await persistenceContext.sessionPersistence.open(first.session.id, 'read')
    const stored = await reader.read()
    await reader.close()
    await first.ctx.fiber.dispose()

    const restored = await harness('case-c', stored.events)
    const diagnostics = restored.service.diagnostics(restored.session)
    expect(diagnostics.checkpoint?.completedSteps.map(step => step.id)).toEqual(['step-1', 'step-2'])
    expect(diagnostics.resume.pendingSteps.map(step => step.id)).toEqual(['step-3', 'step-4'])
    expect(diagnostics.resume.pendingSteps.some(step => step.id === 'step-1' || step.id === 'step-2')).toBe(false)
  })

  it('Case D: blocks a repaired tool call whose outcome is unknown', async () => {
    const first = await harness('case-d')
    fakeTask(first.service, first.session)
    first.session.append('turn/start', { turn: 1 })
    first.session.append('step/start', { turn: 1, step: 1 })
    first.session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: ToolCallId('unknown-call'), name: 'write', arguments: '{}' }],
      }),
    }, { surfaceOp: 'append' })
    first.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('unknown-call'), name: 'write', arguments: '{}' })
    const open = first.session.snapshotEvents()
    const repaired = [...open, ...interruptedTurnClosers(open)]
    await first.ctx.fiber.dispose()

    const restored = await harness('case-d', repaired)
    expect(restored.service.diagnostics(restored.session).resume).toMatchObject({
      eligibility: 'BLOCKED_UNKNOWN_SIDE_EFFECT',
    })
  })

  it('Case E: permits planning a tool that repair proves never started', async () => {
    const first = await harness('case-e')
    fakeTask(first.service, first.session)
    first.session.append('turn/start', { turn: 1 })
    first.session.append('step/start', { turn: 1, step: 1 })
    first.session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: ToolCallId('not-started-call'), name: 'write', arguments: '{}' }],
      }),
    }, { surfaceOp: 'append' })
    const open = first.session.snapshotEvents()
    const repaired = [...open, ...interruptedTurnClosers(open)]
    await first.ctx.fiber.dispose()

    const restored = await harness('case-e', repaired)
    expect(restored.service.diagnostics(restored.session).resume).toMatchObject({ eligibility: 'SAFE_TO_RESUME' })
  })

  it('Case F: records a zero-byte file as partial, never completed', async () => {
    const { service, session } = await harness('case-f')
    const task = fakeTask(service, session)
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-f-'))
    roots.push(root)
    const result = await new FakeResultPublisher(service, session).publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      path: join(root, 'empty.md'),
      content: '',
      now: 2,
    })
    expect(result).toMatchObject({ status: 'partial', size: 0, validation: { status: 'failed' } })
    expect(result.checksum).toBeUndefined()
  })

  it('Case G: reports Q01-Q04 of Q01-Q08 as partial', async () => {
    const { service, session } = await harness('case-g')
    const task = fakeTask(service, session)
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-g-'))
    roots.push(root)
    const result = await new FakeResultPublisher(service, session).publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      path: join(root, 'questions.md'),
      content: ['Q01', 'Q02', 'Q03', 'Q04'].join('\n'),
      requiredSections: Array.from({ length: 8 }, (_, index) => `Q0${index + 1}`),
      now: 2,
    })
    expect(result.status).toBe('partial')
    expect(result.validation.checks.filter(check => check.status === 'failed').map(check => check.id))
      .toEqual(['section:Q05', 'section:Q06', 'section:Q07', 'section:Q08'])
  })

  it('Case H: does not create a completed manifest when atomic publication fails before rename', async () => {
    const { service, session } = await harness('case-h')
    const task = fakeTask(service, session)
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-h-'))
    roots.push(root)
    const path = join(root, 'result.md')
    const publisher = new FakeResultPublisher(service, session, async (target, content) => {
      await writeFile(`${target}.staging`, content)
      throw new Error('simulated crash before atomic rename')
    })
    await expect(publisher.publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      path,
      content: 'not committed',
    })).rejects.toThrow('simulated crash')
    expect(service.diagnostics(session).outputs).toEqual([])
  })

  it('Case I: retains cancellation progress but refuses automatic resume', async () => {
    const { service, session } = await harness('case-i')
    const task = fakeTask(service, session)
    task.completeCurrent(2)
    task.completeCurrent(3)
    task.cancel(4)
    expect(service.diagnostics(session).resume.eligibility).toBe('NOT_RESUMABLE')
    expect(service.diagnostics(session, { trigger: 'user' }).resume.eligibility).toBe('SAFE_TO_RESUME')
    expect(service.diagnostics(session).checkpoint?.completedSteps.map(step => step.id)).toEqual(['step-1', 'step-2'])
  })

  it('Case J: records model A and model B separately and requires validation', async () => {
    const { service, session } = await harness('case-j')
    const task = fakeTask(service, session)
    const next = { ...execution, model: 'model-b', resolvedReasoning: 'medium' }
    task.recordResumeSelection(runIdFor(session.id, 2), next, 2)
    expect(task.checkpoint).toMatchObject({
      originRunId: runIdFor(session.id, 1),
      latestRunId: runIdFor(session.id, 2),
      originalExecution: { model: 'model-a', resolvedReasoning: 'high' },
      latestExecution: { model: 'model-b', resolvedReasoning: 'medium' },
      modelRelation: 'model-changed',
    })
    expect(service.diagnostics(session, { requestedExecution: next }).resume.eligibility).toBe('NEEDS_VALIDATION')
  })
})

describe('checkpoint evidence and transitions', () => {
  it('rejects unsupported model-only completion and stale revisions', async () => {
    const { service, session } = await harness('evidence')
    const task = fakeTask(service, session, 1)
    const current = task.checkpoint.currentStep!
    const { currentStep: _currentStep, ...prior } = task.checkpoint
    expect(() => service.saveCheckpoint(session, {
      ...prior,
      revision: 2,
      completedSteps: [{
        ...current,
        completedAt: 2,
        evidence: { kind: 'tool-result', eventSeq: 99 as never, callId: 'invented' },
      }],
      pendingSteps: [],
      lastSuccessAt: 2,
      lastActivityAt: 2,
    })).toThrow(/does not cite a successful matching tool\/result/)
    expect(() => service.saveCheckpoint(session, task.checkpoint)).toThrow(/advance by exactly one/)
  })

  it('keeps task and result events as separate durable streams', async () => {
    const { service, session } = await harness('separate-events')
    const task = fakeTask(service, session)
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-separate-'))
    roots.push(root)
    await new FakeResultPublisher(service, session).publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      path: join(root, 'result.md'),
      content: 'result',
    })
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['task/checkpoint', 'task/result-manifest'])
  })
})
