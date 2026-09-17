import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import * as AgentRunStateCommand from '@deepseek-ai/dsh-agent-run-state/command'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('loads the service through the real Loader and serves the durable projection', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-run-state-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-agent-run-state'",
    '  config:',
    '    slowAfterMs: 1000',
    '    stalledAfterMs: 5000',
    "- name: '@deepseek-ai/dsh-agent-run-state/command'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-agent-run-state', AgentRunStateService],
    ['@deepseek-ai/dsh-agent-run-state/command', AgentRunStateCommand],
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

  const session = context.sessions.create(SessionId('loader'))
  session.append('turn/start', { turn: 1 })
  expect(context.agentRunState.diagnostics(session).run).toMatchObject({ turn: 1, phase: 'starting' })
  const agent = { session } as unknown as Agent
  await expect(context.commands.execute(
    agent,
    '/agent_run_state',
    [],
    new AbortController().signal,
  )).resolves.toMatchObject({ result: { kind: 'success' } })
})
