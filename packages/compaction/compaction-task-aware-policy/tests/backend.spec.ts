/** Actual RC.2 compaction transaction with the Custom authority policy. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '../../compaction-basic/src/summarizer.ts'
import { createUserMessage, LlmAdapter, ReasoningEffortId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TaskCheckpoint, { taskIdFromString, taskStepIdFromString } from '@deepseek-ai/dsh-task-checkpoint'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TaskPolicy from '../src/index.ts'

class Adapter extends LlmAdapter {
  supported = true
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 100000 },
      ...this.supported ? { reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('medium'), name: 'Medium' }] } } : {} }
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
class Backend extends BasicCompactionEngine {
  readonly calls: SummarizationInput[] = []
  mutate: (() => void) | undefined
  invalidFirst = false
  override async summarize(input: SummarizationInput): Promise<SummaryResult> {
    this.calls.push(input); this.mutate?.()
    return { summary: [{ type: 'text', text: 'Condensed historical conversation.' }],
      ...this.invalidFirst && this.calls.length === 1 ? { truncated: true } : {}, provider: 'fixture', model: 'fixture' }
  }
}
async function harness() {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(TokenMeter)
  await ctx.plugin(TaskCheckpoint); await ctx.plugin(TaskPolicy)
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('policy-backend'), { provider: 'fixture', model: 'fixture' })
  for (let i = 0; i < 2; i++) {
    const idle = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { dispose(); resolve() } })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'historical facts '.repeat(4000) }], source: { kind: 'user' } })); await idle
  }
  const checkpoint = ctx.taskCheckpoints.createCheckpoint(agent.session, {
    taskId: taskIdFromString('protected-task'), taskType: 'report', originTurn: 1,
    execution: { provider: 'fixture', model: 'fixture' }, pendingSteps: [{ id: taskStepIdFromString('review'), title: 'Review the report' }],
    resumeContext: { objective: 'Complete the report without repeating delivery', constraints: ['No replay'], decisions: [], criticalContext: [] },
  })
  return { ctx, agent, adapter, checkpoint, backend: new Backend(ctx, { auto: false }) }
}
it('publishes the code-authored protection through native V4 replacement and preserves authority', async () => {
  const { ctx, agent, checkpoint, backend } = await harness()
  const result = await backend.compactNow(agent, new AbortController().signal)
  expect(result).not.toBeNull(); expect(backend.calls).toHaveLength(1)
  expect(backend.calls[0]?.decoration?.reasoningEffort).toBe('low')
  const event = agent.session.snapshotEvents().find(e => e.type === 'compaction/summary')
  expect(event?.data).toHaveProperty('plugin:task-compaction-audit.sessionFormatVersion', 4)
  const surface = agent.session.surface.nodes.map(seq => agent.session.snapshotEvents()[seq])
  expect(JSON.stringify(surface)).toContain('protected-task')
  expect(ctx.taskCheckpoints.authoritySnapshot(agent.session).task).toEqual(checkpoint)
  const policy = ctx.get('compactionCandidatePolicy')
  expect(policy instanceof TaskPolicy && policy.diagnostics(agent.session.id)?.status).toBe('applied')
})
it('runs at most low then medium, with no change to the main request header', async () => {
  const { agent, backend } = await harness(); backend.invalidFirst = true
  const header = agent.session.requestHeader()
  await backend.compactNow(agent, new AbortController().signal)
  expect(backend.calls.map(c => c.decoration?.reasoningEffort)).toEqual(['low', 'medium'])
  expect(agent.session.requestHeader()).toEqual(header)
})
it('rejects an exact route without auxiliary reasoning before invoking the summarizer', async () => {
  const { agent, adapter, backend } = await harness(); adapter.supported = false
  await expect(backend.compactNow(agent, new AbortController().signal)).rejects.toThrow()
  expect(backend.calls).toHaveLength(0)
  expect(agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary')).toHaveLength(0)
  expect(agent.session.snapshotEvents().filter(e => e.type === 'compaction/start')).toHaveLength(1)
  expect(agent.session.snapshotEvents().filter(e => e.type === 'compaction/end')).toHaveLength(1)
})
it('refuses late authority mutation and never publishes a false applied observation', async () => {
  const { ctx, agent, checkpoint, backend } = await harness()
  backend.mutate = () => {
    agent.session.append('plugin:task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, resumeContext: { ...checkpoint.resumeContext, objective: 'Changed authority' } } })
  }
  const before = [...agent.session.surface.nodes]
  await expect(backend.compactNow(agent, new AbortController().signal)).rejects.toThrow()
  expect(agent.session.surface.nodes).toEqual(before)
  expect(agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary')).toHaveLength(0)
  const policy = ctx.get('compactionCandidatePolicy')
  expect(policy instanceof TaskPolicy && policy.diagnostics(agent.session.id)?.status).toBe('failed')
})
