import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as reasoningPolicy from '../src/index.ts'

const PROVIDER = 'local-qwen'
const MODEL = '/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'

let root: string | undefined
let context: Context | undefined

class LoaderRecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 65_536 },
      reasoning: {
        efforts: ['none', 'low', 'medium', 'xhigh'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('xhigh'),
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: 'loaded' }
    yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('loads IQ3_S policy by Loader, normalizes high, and exposes only transient diagnostics', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-reasoning-policy-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-agent-run-state'",
    '  config:',
    '    slowAfterMs: 1000',
    '    stalledAfterMs: 5000',
    "- name: '@deepseek-ai/dsh-reasoning-policy'",
    '  config:',
    '    observerId: loader-iq3s',
    '    governedProviders: [local-qwen]',
    '    capabilities:',
    '      - provider: local-qwen',
    `        model: ${JSON.stringify(MODEL)}`,
    '        supported: [none, low, medium, xhigh]',
    '        aliases: { off: none }',
    '        fallbacks: { high: xhigh }',
    '        wireValues: { none: none, low: low, medium: medium, high: high, xhigh: xhigh }',
    '        requestOverrideSupported: true',
    '        backendDefault: xhigh',
    '        confidence: confirmed',
    '        source: gguf-live-audit',
    '    globalDefault: xhigh',
    '    taskPolicies: { simple: low, normal: medium, complex: xhigh, long-output: xhigh }',
    '    contextPressure:',
    '      providerSafetyMargin: 4096',
    '      reserve: { none: 1024, low: 2048, medium: 6144, high: 8192, xhigh: 12288 }',
    '      complexReserve: 2048',
    '      longOutputIncrement: 4096',
    '      maxReserve: 16384',
    '      thresholds: { watch: 0.55, prepare: 0.7, compact: 0.8, critical: 0.9 }',
    '    compaction: { enabled: true, autoTrigger: false, preserveBenchmarkContext: true }',
    "- name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    auto: false',
    '    maxSummaryValidationRetries: 1',
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
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-agent-run-state', AgentRunStateService],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
    ['@deepseek-ai/dsh-reasoning-policy', reasoningPolicy],
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

  const adapter = new LoaderRecordingAdapter()
  context.llm.registerAdapter([PROVIDER], adapter)
  const agent = await context.agentLoop.create(SessionId('loader-iq3s'), { provider: PROVIDER, model: MODEL })
  context.reasoningPolicy.setUserOverride(agent, 'high')
  const idle = waitForIdle(context, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'diagnose this complex issue '.repeat(200) }], source: { kind: 'user' } }))
  await idle

  expect(adapter.calls).toHaveLength(1)
  expect(adapter.calls[0]?.reasoningEffort).toBe('xhigh')
  const run = context.agentRunState.diagnostics(agent.session).run
  expect(run?.reasoning).toMatchObject({
    requestedReasoning: 'high',
    policySelected: 'high',
    resolvedReasoning: 'xhigh',
    wireValue: 'xhigh',
    source: 'gguf-backend-capability-fallback',
  })
  expect(run?.context).toMatchObject({ pressureState: 'normal', expectedOutputReserve: 14_336 })
  expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)

  await context.compaction.compactNow(agent, new AbortController().signal)
  const followupIdle = waitForIdle(context, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue the complex diagnosis with the next implementation decision' }], source: { kind: 'user' } }))
  await followupIdle

  expect(adapter.calls.map(call => call.reasoningEffort)).toEqual(['xhigh', 'low', 'xhigh'])
  expect(context.reasoningPolicy.compactionDiagnostics(agent.session)).toMatchObject({
    reasoning: { requested: 'low', resolved: 'low', wireValue: 'low', source: 'compaction-policy' },
    attempt: { ordinal: 1, validation: 'passed' },
  })
})
