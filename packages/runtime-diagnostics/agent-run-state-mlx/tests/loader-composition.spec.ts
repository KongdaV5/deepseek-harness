import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import MLXBackendObserver from '@deepseek-ai/dsh-agent-run-state-mlx'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('loads the MLX provider through the real Loader and publishes backend-neutral diagnostics', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-run-state-mlx-loader-'))
  const configPath = join(root, 'cordis.yml')
  const logPath = join(root, 'mlx.log')
  await writeFile(logPath, '')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-agent-run-state'",
    '  config:',
    '    slowAfterMs: 1000',
    '    stalledAfterMs: 5000',
    "- name: '@deepseek-ai/dsh-agent-run-state-mlx'",
    '  config:',
    '    observerId: mlx-loader',
    `    logPath: ${JSON.stringify(logPath)}`,
    '    logPollIntervalMs: 10',
    '    healthPollIntervalMs: 10000',
    '    healthTimeoutMs: 1000',
    '    requestAttribution: unknown',
    '    provider: local-qwen',
    '    models:',
    '      - /models/qwen-mlx',
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
    ['@deepseek-ai/dsh-agent-run-state', AgentRunStateService],
    ['@deepseek-ai/dsh-agent-run-state-mlx', MLXBackendObserver],
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

  const session = context.sessions.create(SessionId('mlx-loader'))
  context.mlxBackendObserver.ingestLogLine(
    '2026-09-13 01:00:00,000 - INFO - Prompt processing progress: 512/15572',
  )
  expect(context.agentRunState.diagnostics(session).unattributedBackendObservations[0]).toMatchObject({
    observerId: 'mlx-loader',
    attribution: { kind: 'unknown' },
    activity: 'prefill',
    prefill: {
      current: 512,
      total: 15_572,
      source: 'backend-log',
      confidence: 'provisional',
    },
  })
})
