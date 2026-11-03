import { basename } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CodexAppServerClient, codexServerArgv } from '../src/app-server.ts'

describe('Codex App Server process launch', () => {
  it('launches the pinned package-local native App Server with only the dedicated Codex home override', async () => {
    let settleDone!: (outcome: SubprocessOutcome) => void
    const done = new Promise<SubprocessOutcome>((resolve) => { settleDone = resolve })
    const child: SubprocessHandle = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      control: undefined,
      collected: {},
      done,
      terminate: vi.fn(() => { settleDone({ exitCode: 0, signal: 'SIGTERM' }) }),
      waitForExit: vi.fn(async () => true),
    }
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => child)
    const client = CodexAppServerClient.start(spawn, '/isolated/codex-home', '/isolated/codex-home', {
      onNotification: vi.fn(),
      onRequest: vi.fn(async () => ({})),
      onExit: vi.fn(),
    })

    expect(spawn).toHaveBeenCalledOnce()
    const spec = spawn.mock.calls[0]?.[0]
    expect(spec?.argv).toEqual(codexServerArgv())
    expect(basename(spec?.argv[0] ?? '')).toBe(process.platform === 'win32' ? 'codex.exe' : 'codex')
    expect(spec?.argv[0]).toContain('/node_modules/@openai/codex')
    expect(spec?.argv[0]).toContain('/vendor/')
    expect(spec?.cwd).toBe('/isolated/codex-home')
    expect(spec?.env).toEqual({ CODEX_HOME: '/isolated/codex-home' })
    expect(spec?.stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })

    await client.dispose()
  })
})
