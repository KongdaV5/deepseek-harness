import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter, createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionCandidatePolicy, CompactionBeginInput, CompactionPolicyTransaction } from '@deepseek-ai/dsh-compaction'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

let root: string | undefined
let context: Context | undefined

class SiblingPolicy extends Service implements CompactionCandidatePolicy {
  readonly id = 'loader-policy'
  readonly version = '1'
  readonly inputs: CompactionBeginInput[] = []

  constructor(ctx: Context) {
    super(ctx, 'compactionCandidatePolicy')
  }

  assess() { return { admitted: true } as const }

  begin(input: CompactionBeginInput): CompactionPolicyTransaction {
    this.inputs.push(input)
    return {
      decorateRequest: () => ({}),
      validateCandidate: () => ({ kind: 'accept' }),
      rebaseAfterOwnedRecovery: () => {},
      assertPublishable: () => {},
      audit: () => ({ policyId: this.id, policyVersion: this.version, trigger: input.trigger, candidateAttempts: 1 }),
    }
  }
}

class SummaryAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 65536 } })
  }

  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'Saved checkpoint.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-token-meter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
    ['test:sibling-policy', SiblingPolicy],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it.each(['pressure', 'context-overflow'] as const)('publishes a %s summary through a policy mounted in a sibling plugin fiber', async (trigger) => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: 'test:sibling-policy'",
      "- name: '@deepseek-ai/dsh-compaction-basic'",
      '  config:',
      '    auto: true',
      '    headroomTokens: 0',
      '    thresholdRatio: 0.01',
      '    maxTokens: 256',
      '    retainTokens: 0',
      '    modelPolicies:',
      '      - provider: test',
      '        model: summary',
      '        summarizationProvider: auxiliary',
      '        summarizationModel: small-summary',
      '        maxTokens: 128',
    ])
    loaded.llm.registerAdapter(['test', 'auxiliary'], new SummaryAdapter())
    const session = Session.create(SessionId('sibling-policy-compaction'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Keep the work already completed. '.repeat(500) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'test', model: 'summary' } },
      reason: 'initial',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Continue from that work.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const owner = { session, options: { provider: 'test', model: 'summary' } } as Agent
    const signal = new AbortController().signal
    if (trigger === 'pressure') {
      await agentEvents(loaded, owner).waterfall('agent/pre-step', {
        turn: 1, step: 1, messages: [], signal,
      }, async () => ({ kind: 'enter', messages: [] }))
    } else {
      const result = await agentEvents(loaded, owner).waterfall('agent/request-error', {
        turn: 1, step: 1, provider: 'test', retryPolicy: undefined, signal,
        failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'context full' },
      }, async () => undefined)
      expect(result).toEqual({ kind: 'retry' })
    }
    expect(session.ownEvents().map(event => event.type)).toEqual(expect.arrayContaining([
      'compaction/start', 'compaction/summary', 'compaction/end',
    ]))
    const summary = session.ownEvents().find(event => event.type === 'compaction/summary')
    expect(summary?.data).toMatchObject({ provider: 'auxiliary', model: 'small-summary', maxTokens: 128 })
    const policy = loaded.get('compactionCandidatePolicy') as unknown as SiblingPolicy
    expect(policy.inputs[0]).toMatchObject({
      summarizationTarget: { provider: 'auxiliary', model: 'small-summary' }, maxTokens: 128,
    })
    expect(summary?.data.shadowedSeqs).toContain(first.seq)
    expect(summary?.data['plugin:task-compaction-audit']).toMatchObject({
      audit: { policyId: 'loader-policy', trigger },
    })
  })

  it('loads the shipped token-meter, pruning, and compaction-basic YAML order', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '  config:',
      '    thresholdChars: 100',
      '    headChars: 20',
      '    tailChars: 10',
      "- name: '@deepseek-ai/dsh-compaction-basic'",
      '  config:',
      '    thresholdRatio: 0.5',
      '    headroomTokens: 4000',
      '    modelPolicies:',
      '      - provider: mock',
      '        model: small',
      '        headroomTokens: 0',
      '        maxTokens: 32',
      '    retainRatio: 0.125',
      '    auto: false',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('toolResultPruner')).toBeInstanceOf(ToolResultPruner)
    expect(loaded.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    expect((loaded.compaction as BasicCompactionEngine).config).toMatchObject({
      thresholdRatio: 0.5,
      headroomTokens: 4000,
      modelPolicies: [{ provider: 'mock', model: 'small', headroomTokens: 0, maxTokens: 32 }],
      retainRatio: 0.125,
      auto: false,
    })
  })

  it('rejects stale token-meter config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(SessionProjectionRegistry)
    await expect(context.plugin(TokenMeter, {
      contextWindow: 4096,
    } as never)).rejects.toThrow(/TokenMeterConfig: unknown key "contextWindow"/)
  })

  it('rejects stale compaction-basic config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      models: { legacy: { thresholdRatio: 0.5 } },
    } as never)).rejects.toThrow(/BasicCompactionConfig: unknown key "models"/)
  })

  it('rejects a capacity-independent merged ratio conflict during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      retainRatio: 0.2,
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        thresholdRatio: 0.1,
      }],
    })).rejects.toThrow(/modelPolicies\[0\]: retainRatio \(0.2\).*thresholdRatio \(0.1\)/)
  })

  it('rejects an incomplete model-policy summarization pair during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      summarizationProvider: 'default-provider',
      summarizationModel: 'default-model',
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        summarizationModel: '',
      }],
    })).rejects.toThrow(/modelPolicies\[0\].*must be set together/)
  })
})
