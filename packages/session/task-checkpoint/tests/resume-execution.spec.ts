import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as agentRunPolicy from '@deepseek-ai/dsh-agent-run-policy'
import AgentRunStateService, { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import LlmRuntime, {
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TaskCheckpointService, {
  buildMinimalResumeMessage,
  createTaskId,
  createTaskOutputId,
  TASK_RESUME_MESSAGE_SOURCE,
  verifyTaskOutputs,
} from '@deepseek-ai/dsh-task-checkpoint'
import { FakeTask, FakeTaskStep } from '@deepseek-ai/dsh-task-checkpoint/testing'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'

type ScriptEntry = readonly StreamChunk[] | Error | 'hang'

function textResponse(text: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ResumeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly started = Promise.withResolvers<undefined>()
  private starts = 0
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['RESOURCE_LIMIT', 'TRANSPORT'],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'task resume fixture')

  constructor(private readonly script: ScriptEntry[]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override providerRetryPolicy(): ResolvedRetryPolicy { return this.retryPolicy }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.starts += 1
    if (this.starts === 2) this.started.resolve(undefined)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('resume fixture script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        const fail = () => { reject(new Error('aborted')) }
        if (options.signal?.aborted) fail()
        else options.signal?.addEventListener('abort', fail, { once: true })
      })
      return
    }
    yield* entry
  }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(root: string, adapter: ResumeAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  await ctx.plugin(agentRunPolicy, {
    observerId: `resume-policy-${contexts.length}`,
    providers: ['local'],
    maxRetryCount: 2,
    cancellationConfirmationMs: 100,
  })
  await ctx.plugin(llmRetry)
  await ctx.plugin(TaskCheckpointService)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['local'], adapter)
  return ctx
}

async function harness(script: ScriptEntry[], id = `resume-${Math.random()}`) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-resume-'))
  roots.push(root)
  const adapter = new ResumeAdapter(script)
  const ctx = await mount(root, adapter)
  const sessionId = SessionId(id)
  const agent = await ctx.agentLoop.create(sessionId, { provider: 'local', model: 'model-a' })
  return { root, adapter, ctx, agent }
}

const execution = { provider: 'local', model: 'model-a', backend: 'mlx', requestedReasoning: 'high', resolvedReasoning: 'high' }

async function failedTask(ctx: Context, agent: Agent, count = 4): Promise<FakeTask> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'OLD_SESSION_REASONING_AND_RAW_LOG' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const task = new FakeTask(ctx.taskCheckpoints, agent.session, {
    runId: runIdFor(agent.session.id, 1),
    execution,
    objective: 'finish the structured task without repeating completed work',
    steps: Array.from({ length: count }, (_, index) => FakeTaskStep(`step-${index + 1}`, `Step ${index + 1}`)),
    now: 1,
  })
  task.completeCurrent(2)
  task.completeCurrent(3)
  task.fail({
    code: 'RESOURCE_LIMIT', message: 'Metal resource limit exceeded', severity: 'fatal', origin: 'backend', time: 4,
  }, 4)
  return task
}

interface ResumeDocument {
  readonly progress: {
    readonly completed_steps: readonly { readonly id: string; readonly evidence_reference?: string }[]
    readonly pending_steps: readonly { readonly id: string; readonly title: string }[]
  }
}

function resumeDocument(request: GenerateOptions): ResumeDocument {
  const block = request.messages
    .flatMap(message => message.content)
    .find(candidate => candidate.type === 'text' && candidate.text.includes('"type": "task_resume_context"'))
  if (block?.type !== 'text') throw new Error('resume context missing from request')
  return JSON.parse(block.text) as ResumeDocument
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* exhaust the stream */ }
}

describe('Phase 4 second-batch resume execution', () => {
  it('Case A: starts a new Run in the same Task and executes only step 3+', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin'), textResponse('resumed')], 'resume-a')
    const task = await failedTask(ctx, agent)
    const result = await ctx.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId, maxContextTokens: 4_000, requestedAt: 10, execution,
    })
    expect(result).toMatchObject({ status: 'started', runId: runIdFor(agent.session.id, 2), pendingSteps: [{ id: 'step-3' }, { id: 'step-4' }] })
    await agent.whenIdle()

    const latest = ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)!
    expect(latest.taskId).toBe(task.checkpoint.taskId)
    expect(latest.originRunId).toBe(runIdFor(agent.session.id, 1))
    expect(latest.latestRunId).toBe(runIdFor(agent.session.id, 2))
    expect(latest.latestResume?.executionPlan).toEqual(['step-3', 'step-4'])
    expect(adapter.requests, JSON.stringify(agent.session.snapshotEvents().slice(-12), undefined, 2)).toHaveLength(2)
    const document = resumeDocument(adapter.requests[1]!)
    expect(document.progress.pending_steps.map(step => step.id)).toEqual(['step-3', 'step-4'])
    expect(JSON.stringify(adapter.requests[1])).not.toContain('OLD_SESSION_REASONING_AND_RAW_LOG')
    expect(ctx.taskCheckpoints.diagnostics(agent.session).resume).toMatchObject({
      requested: true, started: true, runId: runIdFor(agent.session.id, 2), modelRelation: 'same-model',
    })
  })

  it('Case B: a second resume keeps revisions monotone and starts only at step 4', async () => {
    const { ctx, agent, adapter } = await harness([
      textResponse('origin'), textResponse('resume one'), textResponse('resume two'),
    ], 'resume-b')
    const task = await failedTask(ctx, agent)
    await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000, requestedAt: 10, execution })
    await agent.whenIdle()
    task.checkpoint = ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)!
    task.completeCurrent(11)
    task.fail({ code: 'TRANSPORT', message: 'later failure', severity: 'degraded', origin: 'transport', time: 12 }, 12)
    const before = task.checkpoint.revision
    const result = await ctx.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId, maxContextTokens: 4_000, requestedAt: 20, execution,
    })
    expect(result).toMatchObject({ status: 'started', runId: runIdFor(agent.session.id, 3), checkpointRevision: before + 1 })
    await agent.whenIdle()
    const document = resumeDocument(adapter.requests[2]!)
    expect(document.progress.completed_steps.map(step => step.id)).toEqual(['step-1', 'step-2', 'step-3'])
    expect(document.progress.pending_steps.map(step => step.id)).toEqual(['step-4'])
  })

  it('Case C: explicit user resume cannot override an unknown side effect', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin')], 'resume-c')
    const task = await failedTask(ctx, agent)
    const callId = ToolCallId('unknown-side-effect')
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'unknown' }], isError: true }),
      error: { name: 'Repair', code: TOOL_OUTCOME_UNKNOWN },
    }, { surfaceOp: 'append' })
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000, execution })
    expect(result).toMatchObject({ status: 'refused', decision: { eligibility: 'BLOCKED_UNKNOWN_SIDE_EFFECT' } })
    expect(adapter.requests).toHaveLength(1)
  })

  it('Case D: external modification of a completed result requires validation', async () => {
    const { ctx, agent, adapter, root } = await harness([textResponse('origin')], 'resume-d')
    const task = await failedTask(ctx, agent)
    const outputId = createTaskOutputId()
    const path = join(root, 'result.md')
    await ctx.taskCheckpoints.resultPublisher(agent.session).publish({
      taskId: task.checkpoint.taskId, runId: task.checkpoint.latestRunId, execution, outputId,
      path, content: 'good', mode: 0o600, now: 5,
    })
    task.attachOutput(outputId, 6)
    await writeFile(path, 'evil')
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000, execution })
    expect(result).toMatchObject({ status: 'refused', decision: { eligibility: 'NEEDS_VALIDATION' }, outputIssues: [{ code: 'CHECKSUM_CHANGED' }] })
    expect(adapter.requests).toHaveLength(1)
  })

  it('Case E: partial output is explicit resume input and final republish completes revision 2', async () => {
    const { ctx, agent, root } = await harness([textResponse('origin'), textResponse('resume')], 'resume-e')
    const task = await failedTask(ctx, agent)
    const outputId = createTaskOutputId()
    const path = join(root, 'draft.md')
    const publisher = ctx.taskCheckpoints.resultPublisher(agent.session)
    const partial = await publisher.publish({
      taskId: task.checkpoint.taskId, runId: task.checkpoint.latestRunId, execution, outputId,
      path, content: '# Draft\n', mode: 0o600, now: 5,
      validators: [{ id: 'final-section', validate: () => ({ status: 'failed', message: 'missing final section' }) }],
    })
    task.attachOutput(outputId, 6)
    expect(partial.status).toBe('partial')
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000, execution })
    expect(result.status).toBe('started')
    await agent.whenIdle()
    const completed = await publisher.publish({
      taskId: task.checkpoint.taskId, runId: runIdFor(agent.session.id, 2), execution, outputId,
      path, content: '# Draft\n# Final\n', mode: 0o600, now: 20,
      validators: [{ id: 'final-section', validate: snapshot => ({ status: snapshot.content.includes('# Final') ? 'passed' : 'failed' }) }],
    })
    expect(completed).toMatchObject({ revision: 2, status: 'completed', validation: { status: 'passed' } })
    expect(completed.checksum?.value).toMatch(/^[a-f0-9]{64}$/)
  })

  it('Case F: a changed live model defaults to NEEDS_VALIDATION', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin')], 'resume-f')
    const task = await failedTask(ctx, agent)
    Object.defineProperty(agent, 'options', { value: { provider: 'local', model: 'model-b' } })
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000 })
    expect(result).toMatchObject({ status: 'refused', decision: { eligibility: 'NEEDS_VALIDATION', modelRelation: 'model-changed' } })
    expect(adapter.requests).toHaveLength(1)
  })

  it('Case G: minimal context excludes old reasoning/logs and compresses completed evidence', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin'), textResponse('resume')], 'resume-g')
    const task = await failedTask(ctx, agent)
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000, execution })
    expect(result.status).toBe('started')
    await agent.whenIdle()
    const request = JSON.stringify(adapter.requests[1])
    expect(request).not.toContain('OLD_SESSION_REASONING_AND_RAW_LOG')
    expect(request).not.toContain('requestedReasoning')
    expect(request).not.toContain('resolvedReasoning')
    const document = resumeDocument(adapter.requests[1]!)
    expect(document.progress.completed_steps.at(0)?.evidence_reference).toBe('fake-runtime:validated:step-1')
    expect(document.progress.pending_steps).toEqual([
      { id: 'step-3', title: 'Step 3' }, { id: 'step-4', title: 'Step 4' },
    ])
    expect(result.status === 'started' && result.context.omittedSections).toEqual([
      'historical_reasoning', 'full_session_log', 'raw_tool_output',
    ])
  })

  it('Case H: a resumed RESOURCE_LIMIT remains fatal with zero retry and preserves progress', async () => {
    const fatal = new LlmError('Metal resource limit exceeded', 'RESOURCE_LIMIT')
    const { ctx, agent, adapter } = await harness([textResponse('origin'), fatal], 'resume-h')
    const task = await failedTask(ctx, agent)
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000, execution })
    expect(result.status).toBe('started')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(ctx.agentRunState.diagnostics(agent.session).run).toMatchObject({
      runId: runIdFor(agent.session.id, 2), phase: 'failed', retryCount: 0,
      primaryError: { code: 'RESOURCE_LIMIT', severity: 'fatal' },
    })
    expect(ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)).toMatchObject({
      status: 'failed',
      latestRunId: runIdFor(agent.session.id, 2),
      failureContext: { primaryError: { code: 'RESOURCE_LIMIT', severity: 'fatal' } },
      completedSteps: [{ id: 'step-1' }, { id: 'step-2' }], pendingSteps: [{ id: 'step-3' }, { id: 'step-4' }],
    })
  })

  it('Case I: user stop leaves the checkpoint and pending steps intact without auto continuation', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin'), 'hang'], 'resume-i')
    const task = await failedTask(ctx, agent)
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 4_000, execution })
    expect(result.status).toBe('started')
    await adapter.started.promise
    const staged = ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)!
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const after = ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)!
    expect(after.revision).toBe(staged.revision + 1)
    expect(after.status).toBe('cancelled')
    expect(after.failureContext?.primaryError.code).toBe('CLIENT_CANCELLED')
    expect(after.completedSteps.map(step => step.id)).toEqual(['step-1', 'step-2'])
    expect(after.pendingSteps.map(step => step.id)).toEqual(['step-3', 'step-4'])
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.agentRunState.diagnostics(agent.session).run?.phase).toBe('cancelled')
  })

  it('Case J: two process restarts expose the latest monotone revision without auto execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-resume-restart-'))
    roots.push(root)
    const id = SessionId('resume-j')
    const firstAdapter = new ResumeAdapter([textResponse('origin'), textResponse('resume one')])
    const first = await mount(root, firstAdapter)
    const firstAgent = await first.agentLoop.create(id, { provider: 'local', model: 'model-a' })
    const task = await failedTask(first, firstAgent)
    await first.taskCheckpoints.resume(firstAgent, {
      taskId: task.checkpoint.taskId, maxContextTokens: 4_000, requestedAt: 10, execution,
    })
    await firstAgent.whenIdle()
    task.checkpoint = first.taskCheckpoints.get(firstAgent.session, task.checkpoint.taskId)!
    task.completeCurrent(20)
    task.fail({ code: 'TRANSPORT', message: 'step four failed', severity: 'degraded', origin: 'transport', time: 21 }, 21)
    const beforeRestart = task.checkpoint
    await first.sessions.flush(firstAgent.session)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const secondAdapter = new ResumeAdapter([textResponse('resume two')])
    const second = await mount(root, secondAdapter)
    const secondAgent = (await second.agents.resume({
      resumeSessionId: id, agentOptions: { provider: 'local', model: 'model-a' },
    })).agent
    expect(second.taskCheckpoints.get(secondAgent.session, task.checkpoint.taskId)?.revision).toBe(beforeRestart.revision)
    const resumed = await second.taskCheckpoints.resume(secondAgent, {
      taskId: task.checkpoint.taskId, maxContextTokens: 4_000, requestedAt: 30, execution,
    })
    expect(resumed).toMatchObject({ status: 'started', runId: runIdFor(id, 3), checkpointRevision: beforeRestart.revision + 1 })
    await secondAgent.whenIdle()
    const running = second.taskCheckpoints.get(secondAgent.session, task.checkpoint.taskId)!
    const failedAgain = second.taskCheckpoints.saveCheckpoint(secondAgent.session, {
      ...running,
      revision: running.revision + 1,
      status: 'failed',
      lastActivityAt: 31,
      failureContext: {
        primaryError: { code: 'TRANSPORT', message: 'failed after restart', severity: 'degraded', origin: 'transport', time: 31 },
        failedAt: 31,
        currentStepId: running.currentStep!.id,
      },
    })
    await second.sessions.flush(secondAgent.session)
    await second.fiber.dispose()
    contexts.splice(contexts.indexOf(second), 1)

    const thirdAdapter = new ResumeAdapter([])
    const third = await mount(root, thirdAdapter)
    const thirdAgent = (await third.agents.resume({
      resumeSessionId: id, agentOptions: { provider: 'local', model: 'model-a' },
    })).agent
    expect(third.taskCheckpoints.get(thirdAgent.session, task.checkpoint.taskId)).toMatchObject({
      revision: failedAgain.revision,
      latestRunId: runIdFor(id, 3),
      completedSteps: [{ id: 'step-1' }, { id: 'step-2' }, { id: 'step-3' }],
      pendingSteps: [{ id: 'step-4' }],
    })
    expect(third.taskCheckpoints.diagnostics(thirdAgent.session).resume.eligibility).toBe('SAFE_TO_RESUME')
    expect(thirdAdapter.requests).toHaveLength(0)
  })

  it('refuses an over-budget minimal context without writing a new checkpoint', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin')], 'resume-budget')
    const task = await failedTask(ctx, agent)
    const revision = task.checkpoint.revision
    const result = await ctx.taskCheckpoints.resume(agent, { taskId: task.checkpoint.taskId, maxContextTokens: 1, execution })
    expect(result).toMatchObject({
      status: 'refused', decision: { eligibility: 'NEEDS_VALIDATION' }, context: { maxTokens: 1 },
    })
    expect(ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)?.revision).toBe(revision)
    expect(adapter.requests).toHaveLength(1)
  })

  it('requeues a persisted but unstarted resume reservation without minting another Run', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin'), textResponse('recovered')], 'resume-unstarted')
    const task = await failedTask(ctx, agent)
    const reservedRun = runIdFor(agent.session.id, 2)
    const reserved = ctx.taskCheckpoints.saveCheckpoint(agent.session, {
      ...task.checkpoint,
      revision: task.checkpoint.revision + 1,
      latestRunId: reservedRun,
      status: 'running',
      lastActivityAt: 10,
      latestResume: {
        requestedAt: 10,
        runId: reservedRun,
        executionPlan: task.checkpoint.pendingSteps.map(step => step.id),
        context: {
          estimatedTokens: 1,
          maxTokens: 4_000,
          includedSections: ['task', 'progress'],
          omittedSections: ['historical_reasoning'],
        },
      },
    })
    await ctx.sessions.flush(agent.session)
    const result = await ctx.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId, maxContextTokens: 4_000, requestedAt: 20, execution,
    })
    expect(result).toMatchObject({
      status: 'started', runId: reservedRun, checkpointRevision: reserved.revision,
    })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)?.revision).toBe(reserved.revision)
  })

  it('covers output verification failures and all compact evidence references', async () => {
    const { ctx, agent, root } = await harness([textResponse('origin')], 'resume-output-guards')
    const task = await failedTask(ctx, agent)
    const missingManifest = createTaskOutputId()
    const missingPath = join(root, 'missing.md')
    const invalidState = ctx.taskCheckpoints.saveResultManifest(agent.session, {
      version: 1,
      outputId: createTaskOutputId(),
      revision: 1,
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      path: missingPath,
      status: 'failed',
      createdAt: 5,
      updatedAt: 5,
      execution,
      validation: { status: 'failed', checks: [{ id: 'failed', status: 'failed' }] },
    })
    const partial = await ctx.taskCheckpoints.resultPublisher(agent.session).publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      outputId: createTaskOutputId(),
      path: join(root, 'partial.md'),
      content: 'draft',
      mode: 0o600,
      validators: [{ id: 'draft', validate: () => ({ status: 'failed' }) }],
      now: 6,
    })
    await rm(partial.path)
    const checkpoint = {
      ...task.checkpoint,
      outputs: [missingManifest, invalidState.outputId, partial.outputId],
    }
    expect(await verifyTaskOutputs(checkpoint, [invalidState, partial])).toMatchObject([
      { code: 'MISSING_MANIFEST' }, { code: 'INVALID_MANIFEST_STATE' }, { code: 'MISSING_FILE' },
    ])

    const sized = await ctx.taskCheckpoints.resultPublisher(agent.session).publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      outputId: createTaskOutputId(),
      path: join(root, 'sized.md'),
      content: 'four',
      mode: 0o600,
      now: 7,
    })
    await writeFile(sized.path, 'a different size')
    expect(await verifyTaskOutputs({ ...task.checkpoint, outputs: [sized.outputId] }, [sized]))
      .toMatchObject([{ code: 'SIZE_CHANGED' }])

    const withEvidence = {
      ...task.checkpoint,
      resumeContext: {
        ...task.checkpoint.resumeContext,
        constraints: ['keep identity'],
        decisions: ['resume explicitly'],
        criticalContext: ['use the validated output references'],
      },
      completedSteps: [
        {
          id: FakeTaskStep('tool').id,
          title: 'Tool evidence',
          completedAt: 1,
          evidence: { kind: 'tool-result', eventSeq: 7 as never, callId: 'call-7' } as const,
        },
        {
          id: FakeTaskStep('result').id,
          title: 'Result evidence',
          completedAt: 2,
          evidence: { kind: 'result-validation', outputId: partial.outputId, manifestRevision: 1 } as const,
        },
      ],
    }
    const built = buildMinimalResumeMessage(withEvidence, [
      { ...partial, status: 'completed', completedAt: 7, validation: { status: 'passed', checks: [] } },
      partial,
    ], 1_000, () => 123)
    expect(built.context.budget).toMatchObject({
      estimatedTokens: 123,
      includedSections: ['task', 'progress', 'outputs', 'failure', 'critical_context'],
    })
    expect(built.context.text).toContain('session-event:7;call:call-7')
    expect(built.context.text).toContain(`result:${partial.outputId};manifest-revision:1`)
    expect(built.context.text).toContain('"primary_error"')
    expect(built.context.text).toContain('"RESOURCE_LIMIT"')
  })

  it('production publisher records failed validators, generated identity, and zero-byte partials', async () => {
    const { ctx, agent, root } = await harness([textResponse('origin')], 'resume-publisher-guards')
    const task = await failedTask(ctx, agent)
    const publisher = ctx.taskCheckpoints.resultPublisher(agent.session)
    const thrown = await publisher.publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      path: join(root, 'thrown.md'),
      content: 'draft',
      mode: 0o600,
      dirMode: 0o700,
      validators: [
        { id: 'error', validate: () => { throw new Error('validator error') } },
        { id: 'non-error', validate: () => { throw 'validator string' } },
      ],
    })
    expect(thrown).toMatchObject({
      revision: 1,
      status: 'partial',
      validation: {
        checks: [
          { id: 'non-empty', status: 'passed' },
          { id: 'error', status: 'failed', message: 'validator error' },
          { id: 'non-error', status: 'failed', message: 'validator threw a non-Error value' },
        ],
      },
    })
    const empty = await publisher.publish({
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      execution,
      path: join(root, 'empty.md'),
      content: '',
      mode: 0o600,
      now: 20,
    })
    expect(empty).toMatchObject({ status: 'partial', size: 0, validation: { checks: [{ status: 'failed' }] } })
  })

  it('rejects invalid budgets and unresolved execution metadata before model work', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin')], 'resume-invalid-input')
    const task = await failedTask(ctx, agent)
    expect(() => ctx.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId, maxContextTokens: 0, execution,
    })).toThrow(/positive safe integer/)
    Object.defineProperty(agent, 'options', { value: { provider: 'local' } })
    await expect(ctx.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId, maxContextTokens: 1_000,
    })).resolves.toMatchObject({ status: 'refused', decision: { eligibility: 'NEEDS_VALIDATION' } })
    await expect(ctx.taskCheckpoints.resume(agent, {
      taskId: createTaskId(), maxContextTokens: 1_000,
    })).resolves.toMatchObject({
      status: 'refused',
      decision: { pendingSteps: [], modelRelation: 'same-model' },
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('rejects supplied provider/model metadata that does not match the live Agent', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('origin')], 'resume-execution-mismatch')
    const task = await failedTask(ctx, agent)
    await expect(ctx.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId,
      maxContextTokens: 1_000,
      execution: { ...execution, provider: 'other' },
    })).resolves.toMatchObject({ status: 'refused', decision: { eligibility: 'NEEDS_VALIDATION' } })
    expect(adapter.requests).toHaveLength(1)
  })

  it('fails closed on boundary, inbox, identity, token-meter, and persistence uncertainty', async () => {
    const boundaryHarness = await harness([textResponse('origin')], 'resume-boundary-unavailable')
    const boundaryTask = await failedTask(boundaryHarness.ctx, boundaryHarness.agent)
    const stateOf = boundaryHarness.ctx.sessionProjections.stateOf.bind(boundaryHarness.ctx.sessionProjections)
    const stateSpy = vi.spyOn(boundaryHarness.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'turnBoundary' ? undefined : stateOf(session, key)
    ))
    await expect(boundaryHarness.ctx.taskCheckpoints.resume(boundaryHarness.agent, {
      taskId: boundaryTask.checkpoint.taskId, maxContextTokens: 1_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { eligibility: 'NEEDS_VALIDATION' } })
    stateSpy.mockRestore()

    const openHarness = await harness([textResponse('origin')], 'resume-boundary-open')
    const openTask = await failedTask(openHarness.ctx, openHarness.agent)
    const openStateOf = openHarness.ctx.sessionProjections.stateOf.bind(openHarness.ctx.sessionProjections)
    const openSpy = vi.spyOn(openHarness.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'turnBoundary'
        ? { openTurnStartSeq: 1 as never, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 1 }
        : openStateOf(session, key)
    ))
    await expect(openHarness.ctx.taskCheckpoints.resume(openHarness.agent, {
      taskId: openTask.checkpoint.taskId, maxContextTokens: 1_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { reason: expect.stringContaining('open Run') } })
    openSpy.mockRestore()

    const inboxHarness = await harness([textResponse('origin')], 'resume-inbox')
    const inboxTask = await failedTask(inboxHarness.ctx, inboxHarness.agent)
    inboxHarness.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'already queued' }], source: { kind: 'user' } }))
    await expect(inboxHarness.ctx.taskCheckpoints.resume(inboxHarness.agent, {
      taskId: inboxTask.checkpoint.taskId, maxContextTokens: 1_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { reason: expect.stringContaining('pending input') } })

    const identityHarness = await harness([textResponse('origin')], 'resume-identity')
    const identityTask = await failedTask(identityHarness.ctx, identityHarness.agent)
    identityTask.recordResumeSelection(runIdFor(identityHarness.agent.session.id, 2), execution, 5)
    await expect(identityHarness.ctx.taskCheckpoints.resume(identityHarness.agent, {
      taskId: identityTask.checkpoint.taskId, maxContextTokens: 1_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { reason: expect.stringContaining('distinct Run') } })

    const meterHarness = await harness([textResponse('origin')], 'resume-no-meter')
    const meterTask = await failedTask(meterHarness.ctx, meterHarness.agent)
    const get = meterHarness.ctx.get.bind(meterHarness.ctx)
    const getSpy = vi.spyOn(meterHarness.ctx, 'get').mockImplementation((name: string) => (
      name === 'tokenMeter' ? undefined : get(name)
    ))
    await expect(meterHarness.ctx.taskCheckpoints.resume(meterHarness.agent, {
      taskId: meterTask.checkpoint.taskId, maxContextTokens: 1_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { reason: expect.stringContaining('token-meter') } })
    getSpy.mockRestore()

    const persistenceHarness = await harness([textResponse('origin')], 'resume-no-persistence')
    const persistenceTask = await failedTask(persistenceHarness.ctx, persistenceHarness.agent)
    const flushSpy = vi.spyOn(persistenceHarness.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(persistenceHarness.ctx.taskCheckpoints.resume(persistenceHarness.agent, {
      taskId: persistenceTask.checkpoint.taskId, maxContextTokens: 1_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { reason: expect.stringContaining('persistence') } })
    flushSpy.mockRestore()
  })

  it('revalidates eligibility, outputs, and Agent ordering after the persistence wait', async () => {
    const changedHarness = await harness([textResponse('origin')], 'resume-recheck-eligibility')
    const changedTask = await failedTask(changedHarness.ctx, changedHarness.agent)
    const changedFlush = changedHarness.ctx.sessions.flush.bind(changedHarness.ctx.sessions)
    const changedSpy = vi.spyOn(changedHarness.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      const participated = await changedFlush(session)
      const checkpoint = changedHarness.ctx.taskCheckpoints.get(session, changedTask.checkpoint.taskId)!
      changedHarness.ctx.taskCheckpoints.saveCheckpoint(session, {
        ...checkpoint, revision: checkpoint.revision + 1, status: 'blocked', lastActivityAt: checkpoint.lastActivityAt + 1,
      })
      return participated
    })
    await expect(changedHarness.ctx.taskCheckpoints.resume(changedHarness.agent, {
      taskId: changedTask.checkpoint.taskId, maxContextTokens: 2_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { eligibility: 'NOT_RESUMABLE' } })
    changedSpy.mockRestore()

    const outputHarness = await harness([textResponse('origin')], 'resume-recheck-output')
    const outputTask = await failedTask(outputHarness.ctx, outputHarness.agent)
    const outputId = createTaskOutputId()
    const outputPath = join(outputHarness.root, 'changing.md')
    await outputHarness.ctx.taskCheckpoints.resultPublisher(outputHarness.agent.session).publish({
      taskId: outputTask.checkpoint.taskId, runId: outputTask.checkpoint.latestRunId, execution, outputId,
      path: outputPath, content: 'good', mode: 0o600, now: 5,
    })
    outputTask.attachOutput(outputId, 6)
    const outputFlush = outputHarness.ctx.sessions.flush.bind(outputHarness.ctx.sessions)
    const outputSpy = vi.spyOn(outputHarness.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      const participated = await outputFlush(session)
      await writeFile(outputPath, 'evil')
      return participated
    })
    await expect(outputHarness.ctx.taskCheckpoints.resume(outputHarness.agent, {
      taskId: outputTask.checkpoint.taskId, maxContextTokens: 2_000, execution,
    })).resolves.toMatchObject({ status: 'refused', outputIssues: [{ code: 'CHECKSUM_CHANGED' }] })
    outputSpy.mockRestore()

    const orderHarness = await harness([textResponse('origin')], 'resume-recheck-order')
    const orderTask = await failedTask(orderHarness.ctx, orderHarness.agent)
    const orderFlush = orderHarness.ctx.sessions.flush.bind(orderHarness.ctx.sessions)
    const orderSpy = vi.spyOn(orderHarness.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      const participated = await orderFlush(session)
      orderHarness.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'raced input' }], source: { kind: 'user' } }))
      return participated
    })
    await expect(orderHarness.ctx.taskCheckpoints.resume(orderHarness.agent, {
      taskId: orderTask.checkpoint.taskId, maxContextTokens: 2_000, execution,
    })).resolves.toMatchObject({ status: 'refused', decision: { reason: expect.stringContaining('changed') } })
    orderSpy.mockRestore()
  })

  it('rejects changed metadata for an unstarted reservation and derives requested reasoning when absent', async () => {
    const { ctx, agent } = await harness([textResponse('origin')], 'resume-unstarted-metadata')
    const task = await failedTask(ctx, agent)
    const reservedRun = runIdFor(agent.session.id, 2)
    ctx.taskCheckpoints.saveCheckpoint(agent.session, {
      ...task.checkpoint,
      revision: task.checkpoint.revision + 1,
      latestRunId: reservedRun,
      status: 'running',
      lastActivityAt: 10,
      latestResume: {
        requestedAt: 10,
        runId: reservedRun,
        executionPlan: task.checkpoint.pendingSteps.map(step => step.id),
        context: { estimatedTokens: 1, maxTokens: 1_000, includedSections: ['task'], omittedSections: ['reasoning'] },
      },
    })
    await expect(ctx.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId,
      maxContextTokens: 1_000,
      execution: { ...execution, resolvedReasoning: 'medium' },
    })).resolves.toMatchObject({ status: 'refused', decision: { reason: expect.stringContaining('different execution metadata') } })

    const reasoningHarness = await harness([textResponse('origin'), textResponse('resume')], 'resume-reasoning-derived')
    const reasoningTask = await failedTask(reasoningHarness.ctx, reasoningHarness.agent)
    Object.defineProperty(reasoningHarness.agent, 'options', {
      value: { provider: 'local', model: 'model-a', reasoningEffort: 'high' },
    })
    const result = await reasoningHarness.ctx.taskCheckpoints.resume(reasoningHarness.agent, {
      taskId: reasoningTask.checkpoint.taskId, maxContextTokens: 2_000,
    })
    expect(result.status).toBe('started')
    await reasoningHarness.agent.whenIdle()
    expect(reasoningHarness.ctx.taskCheckpoints.get(reasoningHarness.agent.session, reasoningTask.checkpoint.taskId)?.latestExecution)
      .toEqual({ provider: 'local', model: 'model-a', requestedReasoning: 'high' })
  })

  it('projects a resume message over an empty surface and rejects mixed resume input', async () => {
    const empty = await harness([textResponse('projected')], 'resume-empty-surface')
    const resumeMessage = createUserMessage({
      content: [{ type: 'text', text: '{"type":"task_resume_context"}' }],
      source: { kind: 'plugin', plugin: TASK_RESUME_MESSAGE_SOURCE },
    })
    empty.agent.followup(resumeMessage)
    await empty.agent.whenIdle()
    expect(empty.adapter.requests).toHaveLength(1)

    const mixed = await harness([], 'resume-mixed-input')
    mixed.agent.inject(resumeMessage)
    mixed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ordinary' }], source: { kind: 'user' } }))
    await mixed.agent.whenIdle()
    expect(mixed.adapter.requests).toHaveLength(0)
    expect(mixed.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'blocked' } } })
  })

  it('accepts a resumable manifest that deliberately has no checksum', async () => {
    const { ctx, agent, root } = await harness([textResponse('origin')], 'resume-output-no-checksum')
    const task = await failedTask(ctx, agent)
    const outputId = createTaskOutputId()
    const path = join(root, 'unchecked.md')
    await writeFile(path, 'present')
    const manifest = ctx.taskCheckpoints.saveResultManifest(agent.session, {
      version: 1,
      outputId,
      revision: 1,
      taskId: task.checkpoint.taskId,
      runId: task.checkpoint.latestRunId,
      path,
      status: 'partial',
      size: 7,
      createdAt: 5,
      updatedAt: 5,
      execution,
      validation: { status: 'failed', checks: [{ id: 'known-partial', status: 'failed' }] },
    })
    expect(await verifyTaskOutputs({ ...task.checkpoint, outputs: [outputId] }, [manifest])).toEqual([])
  })

  it('leaves non-session and unknown-session LLM streams outside the resume durability barrier', async () => {
    const { ctx, adapter } = await harness([textResponse('standalone'), textResponse('unknown')], 'resume-stream-guards')
    await drain(ctx.llm.stream({ provider: 'local', model: 'model-a', messages: [] }))
    await drain(ctx.llm.stream({ provider: 'local', model: 'model-a', messages: [], sessionId: SessionId('missing') }))
    expect(adapter.requests).toHaveLength(2)
  })

  it('ignores a non-resume failure turn and records a resume failure without a current step', async () => {
    const ignored = await harness([new LlmError('ordinary failure', 'SERVER')], 'resume-terminal-ignored')
    ignored.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'ordinary failing Run' }], source: { kind: 'user' },
    }))
    await ignored.agent.whenIdle()
    expect(ignored.ctx.taskCheckpoints.diagnostics(ignored.agent.session).task).toBeUndefined()

    const { ctx, agent } = await harness([
      textResponse('origin'), new LlmError('Metal resource limit exceeded', 'RESOURCE_LIMIT'),
    ], 'resume-terminal-no-current')
    const task = await failedTask(ctx, agent)
    const saved = ctx.taskCheckpoints.get(agent.session, task.checkpoint.taskId)!
    const { currentStep: _currentStep, ...withoutCurrent } = saved
    const noCurrent = ctx.taskCheckpoints.saveCheckpoint(agent.session, {
      ...withoutCurrent,
      revision: saved.revision + 1,
      lastActivityAt: saved.lastActivityAt + 1,
      failureContext: {
        primaryError: saved.failureContext!.primaryError,
        failedAt: saved.failureContext!.failedAt,
      },
    })
    await expect(ctx.taskCheckpoints.resume(agent, {
      taskId: noCurrent.taskId, maxContextTokens: 2_000, execution,
    })).resolves.toMatchObject({ status: 'started' })
    await agent.whenIdle()
    const terminal = ctx.taskCheckpoints.get(agent.session, noCurrent.taskId)!
    expect(terminal).toMatchObject({ status: 'failed', failureContext: { primaryError: { code: 'RESOURCE_LIMIT' } } })
    expect(terminal).not.toHaveProperty('currentStep')
    expect(terminal.failureContext).not.toHaveProperty('currentStepId')
  })
})
