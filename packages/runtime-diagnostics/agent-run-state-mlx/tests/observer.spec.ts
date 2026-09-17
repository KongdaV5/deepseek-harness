import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRunStateService from '@deepseek-ai/dsh-agent-run-state'
import { FakeStream } from '@deepseek-ai/dsh-agent-run-state/testing'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import MLXBackendObserver, { MlxLogFileFollower } from '@deepseek-ai/dsh-agent-run-state-mlx'
import type { Config } from '@deepseek-ai/dsh-agent-run-state-mlx/types'

const PROVIDER = 'local-qwen'
const MODEL = '/models/qwen-mlx'
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url)

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class CallbackAdapter extends LlmAdapter {
  constructor(private readonly callback: () => void) { super() }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.callback()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(
  requestAttribution: 'unknown' | 'exclusive-single-flight' = 'exclusive-single-flight',
  healthUrl?: string,
  healthPollIntervalMs = 10_000,
  healthTimeoutMs = 1_000,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mlx-observer-'))
  roots.push(root)
  const logPath = join(root, 'mlx.log')
  await writeFile(logPath, '')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
  await ctx.plugin(MLXBackendObserver, {
    observerId: 'mlx-test',
    logPath,
    logPollIntervalMs: 10,
    healthPollIntervalMs,
    healthTimeoutMs,
    ...healthUrl === undefined ? {} : { healthUrl },
    requestAttribution,
    provider: PROVIDER,
    models: [MODEL],
  })
  const session = ctx.sessions.create(SessionId(`mlx-${roots.length}`))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: PROVIDER, model: MODEL } },
    reason: 'initial',
  })
  const agent = { session } as unknown as Agent
  const stream = new FakeStream(`mlx-${roots.length}`, 1, 1)
  ctx.emit('agent/assistant-stream', { agent, frame: stream.start() })
  return { ctx, session, agent, stream, logPath }
}

async function replayRequest(
  subject: Awaited<ReturnType<typeof harness>>,
  lines: readonly string[],
): Promise<void> {
  subject.ctx.llm.registerAdapter([PROVIDER], new CallbackAdapter(() => {
    for (const line of lines) subject.ctx.mlxBackendObserver.ingestLogLine(line)
  }))
  for await (const _chunk of subject.ctx.llm.stream({
    provider: PROVIDER,
    model: MODEL,
    messages: [],
    sessionId: subject.session.id,
  })) {
    // Exhausting the stream proves correlation covers the real LLM waterfall lifecycle.
  }
}

async function fixtureLines(name: string): Promise<string[]> {
  return (await readFile(fixture(name), 'utf8')).trimEnd().split('\n')
}

describe('real MLX log replay', () => {
  it('Case A: projects long advancing prefill as provisional activity without stalling', async () => {
    const subject = await harness()
    await replayRequest(subject, await fixtureLines('mlx-long-prefill.log'))
    const diagnostics = subject.ctx.agentRunState.diagnostics(
      subject.session,
      new Date(2026, 8, 12, 20, 35, 9, 0).getTime(),
    )
    expect(diagnostics.run).toMatchObject({
      phase: 'prefill',
      backend: {
        attribution: {
          kind: 'attempt',
          source: 'request-and-backend-lifecycle',
          confidence: 'provisional',
        },
        prefill: {
          current: 15_572,
          total: 15_572,
          source: 'backend-log',
          confidence: 'provisional',
        },
      },
    })
    expect(diagnostics.run?.backend.prefill?.speed).toBeGreaterThan(0)
    expect(diagnostics.run?.lastBackendActivityAt).toBe(new Date(2026, 8, 12, 20, 35, 7, 159).getTime())
    expect(diagnostics.run?.health).not.toBe('stalled')
  })

  it('Case B: lets assistant reasoning and generation supersede completed prefill', async () => {
    const subject = await harness()
    await replayRequest(subject, await fixtureLines('mlx-long-prefill.log'))
    subject.ctx.emit('agent/assistant-stream', {
      agent: subject.agent,
      frame: subject.stream.chunk(Date.now(), { type: 'reasoning-delta', index: 0, text: 'thinking' }),
    })
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run?.phase).toBe('reasoning')
    subject.ctx.emit('agent/assistant-stream', {
      agent: subject.agent,
      frame: subject.stream.chunk(Date.now(), { type: 'text-delta', index: 0, text: 'answer' }),
    })
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run?.phase).toBe('generating')
  })

  it('Cases C and D: keeps HTTP process health healthy while Metal kills generation', async () => {
    const subject = await harness()
    const lines = [
      ...(await fixtureLines('mlx-long-prefill.log')).slice(0, 3),
      ...(await fixtureLines('mlx-metal-resource-limit.log')),
    ]
    await replayRequest(subject, lines)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run).toMatchObject({
      health: 'fatal',
      backend: { processHealth: 'healthy', generationHealth: 'fatal' },
      primaryError: { code: 'RESOURCE_LIMIT', severity: 'fatal' },
    })
  })

  it('Case E: keeps client cancellation primary when a bound BrokenPipe follows', async () => {
    const subject = await harness()
    await replayRequest(subject, (await fixtureLines('mlx-long-prefill.log')).slice(0, 2))
    subject.session.append('step/end', { turn: 1, step: 1 })
    subject.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    for (const line of await fixtureLines('mlx-broken-pipe.log')) {
      subject.ctx.mlxBackendObserver.ingestLogLine(line, Date.now() + 1)
    }
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run).toMatchObject({
      phase: 'cancelled',
      primaryError: { code: 'CLIENT_CANCELLED' },
      secondaryErrors: [{ code: 'STREAM_DISCONNECTED' }],
    })
  })

  it('keeps a Metal root cause primary when BrokenPipe follows', async () => {
    const subject = await harness()
    await replayRequest(subject, [
      ...(await fixtureLines('mlx-long-prefill.log')).slice(0, 2),
      ...(await fixtureLines('mlx-metal-resource-limit.log')).slice(0, -1),
    ])
    for (const line of await fixtureLines('mlx-broken-pipe.log')) {
      subject.ctx.mlxBackendObserver.ingestLogLine(line, Date.now() + 1)
    }
    expect(subject.ctx.agentRunState.diagnostics(subject.session).run).toMatchObject({
      primaryError: { code: 'RESOURCE_LIMIT' },
      secondaryErrors: [{ code: 'STREAM_DISCONNECTED' }],
    })
  })

  it('Case F: leaves shared-endpoint progress unattributed', async () => {
    const subject = await harness('unknown')
    await replayRequest(subject, (await fixtureLines('mlx-long-prefill.log')).slice(0, 3))
    const diagnostics = subject.ctx.agentRunState.diagnostics(subject.session)
    expect(diagnostics.run?.backend.attribution).toEqual({ kind: 'unknown' })
    expect(diagnostics.unattributedBackendObservations).toHaveLength(1)
    expect(diagnostics.unattributedBackendObservations[0]?.prefill?.current).toBe(1_024)
  })
})

describe('live sources and strong evidence', () => {
  it('follows only appended complete UTF-8 records and survives truncation', async () => {
    const subject = await harness('unknown')
    await writeFile(subject.logPath, 'historical 1/2\n2026-09-13 00:00:00,000 - INFO - Prompt processing progress: 5/10')
    await subject.ctx.mlxBackendObserver.pollLog()
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations).toHaveLength(0)
    await writeFile(subject.logPath, '2026-09-13 00:00:01,000 - INFO - Prompt processing progress: 6/10\n')
    await subject.ctx.mlxBackendObserver.pollLog()
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.prefill?.current).toBe(6)
  })

  it('routes appended observer log records and follower faults through its source callbacks', async () => {
    const subject = await harness('unknown')
    await appendFile(subject.logPath, 'Prompt processing progress: 1/2\n')
    await subject.ctx.mlxBackendObserver.probe()
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.prefill?.current).toBe(1)
    await rm(subject.logPath)
    await mkdir(subject.logPath)
    await expect(subject.ctx.mlxBackendObserver.pollLog()).resolves.toBeUndefined()
  })

  it('keeps health failures degraded and accepts explicit process/model/worker fatal evidence', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const subject = await harness('unknown', 'http://127.0.0.1:8080/health')
    const observer = subject.ctx.mlxBackendObserver
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    await observer.pollHealth()
    await observer.pollHealth()
    await observer.pollHealth()
    observer.ingestLogLine('worker uncaught exception: worker stopped', 10)
    observer.ingestLogLine('model load failed: invalid weights', 11)
    observer.observeProcessExit({ time: 12, message: 'MLX backend exited with code 1' })
    const latest = subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(latest).toMatchObject({
      processHealth: 'fatal',
      modelHealth: 'fatal',
      generationHealth: 'fatal',
      failure: { kind: 'process-exit' },
    })
  })

  it('runs periodic health polling, aborts timed-out probes, and becomes inert after disposal', async () => {
    const periodicFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', periodicFetch)
    const periodic = await harness('unknown', 'https://127.0.0.1:8080/health', 5, 1_000)
    await vi.waitFor(() => { expect(periodicFetch.mock.calls.length).toBeGreaterThan(1) })
    const observer = periodic.ctx.mlxBackendObserver
    await periodic.ctx.fiber.dispose()
    const callsAfterDispose = periodicFetch.mock.calls.length
    await observer.pollHealth()
    expect(periodicFetch).toHaveBeenCalledTimes(callsAfterDispose)

    const aborts: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      aborts.push(signal)
      signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })))
    const timed = await harness('unknown', 'http://127.0.0.1:8080/health', 10_000, 1)
    await vi.waitFor(() => { expect(aborts[0]?.aborted).toBe(true) })
    expect(timed.ctx.agentRunState.diagnostics(timed.session).unattributedBackendObservations[0]).toMatchObject({
      processHealth: 'degraded',
    })
  })

  it('aborts an in-flight health probe during provider teardown', async () => {
    let captured: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      captured = init.signal as AbortSignal
      captured.addEventListener('abort', () => { reject(new Error('disposed')) }, { once: true })
    })))
    const subject = await harness('unknown', 'http://127.0.0.1:8080/health')
    await vi.waitFor(() => { expect(captured).toBeDefined() })
    await subject.ctx.fiber.dispose()
    expect(captured?.aborted).toBe(true)
  })

  it('keeps non-success access probes degraded and never clears a fatal generation worker', async () => {
    const subject = await harness('unknown')
    const observer = subject.ctx.mlxBackendObserver
    observer.ingestLogLine('generation thread terminated: fatal worker exit', 1)
    observer.ingestLogLine('127.0.0.1 - - [13/Sep/2026 01:00:01] "GET /health HTTP/1.1" 503 -')
    observer.ingestLogLine('127.0.0.1 - - [13/Sep/2026 01:00:02] "GET /v1/models HTTP/1.1" 503 -')
    observer.ingestLogLine('2026-09-13 01:00:03,000 - INFO - Prompt processing progress: 1/10')
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]).toMatchObject({
      processHealth: 'degraded',
      modelHealth: 'healthy',
      generationHealth: 'fatal',
      prefill: { current: 1 },
    })
  })

  it('recognizes direct worker/model failures and only traceback-terminal generation evidence', async () => {
    const subject = await harness('unknown')
    const observer = subject.ctx.mlxBackendObserver
    observer.ingestLogLine('uncaught exception in worker: scheduler died', 1)
    observer.ingestLogLine('unable to load model: invalid weights', 2)
    observer.ingestLogLine('Exception occurred during processing of request from client', 3)
    observer.ingestLogLine('ValueError: ordinary request failure', 4)
    observer.ingestLogLine('Exception in thread Thread-2 (_generate):', 5)
    observer.ingestLogLine('RuntimeError: generation stopped', 6)
    observer.ingestLogLine('ValueError: unscoped noise', 7)
    const diagnostics = subject.ctx.agentRunState.diagnostics(subject.session)
    expect(diagnostics.unattributedBackendObservations[0]).toMatchObject({
      modelHealth: 'fatal',
      generationHealth: 'fatal',
      failure: { kind: 'generation-worker-terminated' },
    })
  })

  it('calculates speed only across increasing samples with a stable total and later time', async () => {
    const subject = await harness('unknown')
    const observer = subject.ctx.mlxBackendObserver
    observer.ingestLogLine('Prompt processing progress: 1/10', 1_000)
    observer.ingestLogLine('Prompt processing progress: 2/11', 2_000)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.prefill?.speed).toBeUndefined()
    observer.ingestLogLine('Prompt processing progress: 2/11', 3_000)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.prefill?.speed).toBeUndefined()
    observer.ingestLogLine('Prompt processing progress: 3/11', 3_000)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.prefill?.speed).toBeUndefined()
    observer.ingestLogLine('Prompt processing progress: 4/11', 4_000)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.prefill?.speed).toBe(1)
  })

  it('contains listener failures and removes subscriptions idempotently', async () => {
    const subject = await harness('unknown')
    const observer = subject.ctx.mlxBackendObserver
    const initial = observer.subscriberCount
    const dispose = observer.subscribe(() => { throw new Error('listener fault') })
    expect(observer.subscriberCount).toBe(initial + 1)
    expect(() => { observer.ingestLogLine('Prompt processing progress: 1/2', 1) }).not.toThrow()
    dispose()
    dispose()
    expect(observer.subscriberCount).toBe(initial)
  })

  it('parses server/model lifecycle and ignores malformed progress without inventing state', async () => {
    const subject = await harness('unknown')
    const observer = subject.ctx.mlxBackendObserver
    observer.ingestLogLine('2026-09-13 01:00:00,000 - INFO - Starting httpd at 127.0.0.1 on port 8080...')
    observer.ingestLogLine('127.0.0.1 - - [13/Sep/2026 01:00:01] "GET /v1/models HTTP/1.1" 200 -')
    observer.ingestLogLine('2026-09-13 01:00:02,000 - INFO - Prompt processing progress: 11/10')
    observer.ingestLogLine('2026-09-13 01:00:03,000 - INFO - Prompt processing progress: x/y')
    observer.ingestLogLine('127.0.0.1 - - [13/Foo/2026 01:00:04] "GET /health HTTP/1.1" 200 -', 99)
    observer.ingestLogLine('Prompt processing progress: 99999999999999999999/99999999999999999999', 100)
    observer.ingestLogLine('Prompt processing progress: 1/0', 101)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]).toMatchObject({
      processHealth: 'healthy', modelHealth: 'healthy', generationHealth: 'unknown',
    })
  })
})

describe('request correlation guardrails', () => {
  it('does not bind an exclusive endpoint without an eligible active attempt', async () => {
    const subject = await harness()
    subject.ctx.mlxBackendObserver.ingestLogLine(
      '127.0.0.1 - - [13/Sep/2026 02:00:00] "POST /v1/chat/completions HTTP/1.1" 200 -',
    )
    subject.ctx.mlxBackendObserver.ingestLogLine('Prompt processing progress: 1/2', 1)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.attribution)
      .toEqual({ kind: 'unknown' })
  })

  it('rejects purpose, absent session, wrong provider/model, disposed session, and runless session leases', async () => {
    const subject = await harness()
    const runless = subject.ctx.sessions.create(SessionId('runless'))
    runless.append('session/title', { title: 'Runless', messageSeqs: [], source: { kind: 'user' } })
    subject.ctx.llm.registerAdapter([PROVIDER, 'wrong'], new CallbackAdapter(() => {
      subject.ctx.mlxBackendObserver.ingestLogLine(
        '127.0.0.1 - - [13/Sep/2026 02:00:00] "POST /v1/chat/completions HTTP/1.1" 200 -',
      )
    }))
    const calls: GenerateOptions[] = [
      { provider: PROVIDER, model: MODEL, messages: [], purpose: 'compaction', sessionId: subject.session.id },
      { provider: PROVIDER, model: MODEL, messages: [] },
      { provider: 'wrong', model: MODEL, messages: [], sessionId: subject.session.id },
      { provider: PROVIDER, model: '/wrong-model', messages: [], sessionId: subject.session.id },
      { provider: PROVIDER, model: MODEL, messages: [], sessionId: SessionId('absent') },
      { provider: PROVIDER, model: MODEL, messages: [], sessionId: runless.id },
    ]
    for (const options of calls) {
      for await (const _chunk of subject.ctx.llm.stream(options)) { /* exhaust */ }
    }
    subject.ctx.emit('session/disposed', subject.session)
    for await (const _chunk of subject.ctx.llm.stream({
      provider: PROVIDER, model: MODEL, messages: [], sessionId: subject.session.id,
    })) { /* exhaust */ }
    subject.ctx.mlxBackendObserver.ingestLogLine('Prompt processing progress: 1/2', 1)
    expect(subject.ctx.agentRunState.diagnostics(subject.session).unattributedBackendObservations[0]?.attribution)
      .toEqual({ kind: 'unknown' })
  })
})

describe('configuration validation', () => {
  async function expectInvalid(overrides: Partial<Config>, message: RegExp) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mlx-invalid-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRunStateService, { slowAfterMs: 1_000, stalledAfterMs: 5_000 })
    const base: Config = {
      observerId: 'valid',
      logPath: join(root, 'mlx.log'),
      logPollIntervalMs: 10,
      healthPollIntervalMs: 10_000,
      healthTimeoutMs: 1_000,
      requestAttribution: 'unknown',
      provider: PROVIDER,
      models: [MODEL],
    }
    expect(() => new MLXBackendObserver(ctx, { ...base, ...overrides })).toThrow(message)
  }

  it('fails loud for invalid deployment-owned values', async () => {
    await expectInvalid({ observerId: ' ' }, /observerId/u)
    await expectInvalid({ logPath: 'relative.log' }, /absolute/u)
    await expectInvalid({ logPollIntervalMs: 0 }, /positive safe integer/u)
    await expectInvalid({ healthPollIntervalMs: 1.5 }, /positive safe integer/u)
    await expectInvalid({ healthTimeoutMs: 0 }, /positive safe integer/u)
    await expectInvalid({ healthUrl: 'ftp://127.0.0.1/health' }, /http or https/u)
    await expectInvalid({ provider: ' ' }, /provider/u)
    await expectInvalid({ models: [' '] }, /non-blank/u)
    await expectInvalid({ requestAttribution: 'exclusive-single-flight', models: [] }, /at least one model/u)
  })
})

describe('log follower edge behavior', () => {
  it('starts missing, reads later CRLF records, reacts to the watcher, and stops idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mlx-follower-'))
    roots.push(root)
    const path = join(root, 'later.log')
    const lines: string[] = []
    const warnings: unknown[] = []
    const follower = new MlxLogFileFollower(path, 10, (line) => { lines.push(line) }, (error) => { warnings.push(error) })
    await follower.start()
    await expect(follower.start()).rejects.toThrow(/already started/u)
    await follower.poll()
    await writeFile(path, 'one\r\ntwo\r\n')
    await follower.poll()
    await appendFile(path, 'three\n')
    await vi.waitFor(() => { expect(lines).toEqual(['one', 'two', 'three']) })
    expect(warnings).toEqual([])
    await follower.stop()
    await follower.stop()
    await appendFile(path, 'ignored\n')
    await follower.poll()
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('reports non-missing stat/read failures and reads records larger than one buffer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mlx-follower-error-'))
    roots.push(root)
    const invalid = new MlxLogFileFollower(`${root}\0bad`, 10, () => {}, () => {})
    await expect(invalid.start()).rejects.toThrow()

    const path = join(root, 'source')
    const warnings: unknown[] = []
    const follower = new MlxLogFileFollower(path, 10, () => {}, (error) => { warnings.push(error) })
    await follower.start()
    await mkdir(path)
    await follower.poll()
    expect(warnings.length).toBeGreaterThan(0)
    await follower.stop()

    const largePath = join(root, 'large.log')
    await writeFile(largePath, '')
    const records: string[] = []
    const large = new MlxLogFileFollower(largePath, 10, (line) => { records.push(line) }, () => {})
    await large.start()
    await large.poll()
    await appendFile(largePath, `${'x'.repeat(70_000)}\n`)
    await large.poll()
    expect(records[0]).toHaveLength(70_000)
    await large.stop()
  })
})
