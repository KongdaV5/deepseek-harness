import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as policy from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

class RepeatedTransportFailureAdapter extends LlmAdapter {
  requests = 0
  private readonly policy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['TRANSPORT'],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'agent-run-policy loader fixture')

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    throw new LlmError('temporary connection failure', 'TRANSPORT')
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('caps a provider policy through the real Loader while retries remain in one Run', { timeout: 60_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-run-policy-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-run-state'",
    '  config:',
    '    slowAfterMs: 1000',
    '    stalledAfterMs: 5000',
    "- name: '@deepseek-ai/dsh-agent-run-policy'",
    '  config:',
    '    observerId: loader-policy',
    '    providers:',
    '      - local',
    '    maxRetryCount: 2',
    '    cancellationConfirmationMs: 500',
    "- name: '@deepseek-ai/dsh-llm-retry'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
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
    ['@deepseek-ai/dsh-agent-run-state', AgentRunStateService],
    ['@deepseek-ai/dsh-agent-run-policy', policy],
    ['@deepseek-ai/dsh-llm-retry', retry],
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

  const adapter = new RepeatedTransportFailureAdapter()
  context.llm.registerAdapter(['local'], adapter)
  const agent = await context.agentLoop.create(SessionId('bounded-loader'), { provider: 'local', model: 'mlx' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const retries = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
  expect(adapter.requests).toBe(3)
  expect(retries).toHaveLength(2)
  const run = context.agentRunState.diagnostics(agent.session).run
  expect(run?.runId).toContain('bounded-loader')
  expect(run).toMatchObject({
    retryCount: 2,
    maxRetryCount: 2,
    retryReason: 'TRANSPORT',
    phase: 'failed',
  })
})
