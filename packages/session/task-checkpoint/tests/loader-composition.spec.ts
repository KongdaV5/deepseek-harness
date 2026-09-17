import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TaskCheckpointService from '@deepseek-ai/dsh-task-checkpoint'
import { FakeTask, FakeTaskStep } from '@deepseek-ai/dsh-task-checkpoint/testing'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'

class LoaderResumeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('loads the plugin and serves task diagnostics from durable events', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-checkpoint-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-task-checkpoint'",
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-task-checkpoint', TaskCheckpointService],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const session = context.sessions.create(SessionId('composed-task'))
    const task = new FakeTask(context.taskCheckpoints, session, {
      runId: runIdFor(session.id, 1),
      execution: { provider: 'local', model: 'mlx-model', backend: 'mlx' },
      objective: 'prove Loader composition',
      steps: [FakeTaskStep('one')],
    })
    expect(context.taskCheckpoints.diagnostics(session)).toMatchObject({
      task: { taskId: task.checkpoint.taskId },
      resume: { eligibility: 'SAFE_TO_RESUME' },
    })
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  })

  it('loads the full capability and executes an explicit persisted resume Run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-resume-loader-'))
    const persistenceRoot = join(root, 'sessions')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(persistenceRoot)}`,
      '    compression: none',
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-task-checkpoint'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
      '  config:',
      '    agents: []',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-token-meter', TokenMeter],
      ['@deepseek-ai/dsh-task-checkpoint', TaskCheckpointService],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const adapter = new LoaderResumeAdapter()
    context.llm.registerAdapter(['local'], adapter)
    const agent = await context.agentLoop.create(SessionId('loader-resume'), { provider: 'local', model: 'mlx-model' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'old context' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const execution = { provider: 'local', model: 'mlx-model', backend: 'mlx' }
    const task = new FakeTask(context.taskCheckpoints, agent.session, {
      runId: runIdFor(agent.session.id, 1),
      execution,
      objective: 'resume through Loader',
      steps: [FakeTaskStep('one'), FakeTaskStep('two')],
      now: 1,
    })
    task.completeCurrent(2)
    task.fail({ code: 'TRANSPORT', message: 'stopped', severity: 'degraded', origin: 'transport', time: 3 }, 3)
    const resumed = await context.taskCheckpoints.resume(agent, {
      taskId: task.checkpoint.taskId,
      maxContextTokens: 2_000,
      requestedAt: 4,
      execution,
    })
    expect(resumed).toMatchObject({ status: 'started', runId: runIdFor(agent.session.id, 2) })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(context.taskCheckpoints.diagnostics(agent.session).resume).toMatchObject({ requested: true, started: true })
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  })
})
