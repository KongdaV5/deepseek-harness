/** Real adapter serialization against an isolated deterministic llama.cpp protocol fixture. */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import { memoryAuth } from './auth-double.ts'
import { textEvents } from './mock-server.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })))
})

async function fixture(contextWindow = 2000, serverWindow = contextWindow, minimumOutputTokens = 50) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = createServer((request, response) => {
    let bytes = ''
    request.on('data', (chunk: Buffer) => { bytes += chunk.toString('utf8') })
    request.on('end', () => {
      const body = (bytes.length === 0 ? {} : JSON.parse(bytes)) as Record<string, unknown>
      const path = request.url ?? ''
      requests.push({ path, body })
      response.setHeader('Content-Type', 'application/json')
      if (path === '/props') response.end(JSON.stringify({ default_generation_settings: { n_ctx: serverWindow } }))
      else if (path === '/apply-template') {
        // The fixture tokenizer counts one token per rendered character, including tools and framing.
        response.end(JSON.stringify({ prompt: JSON.stringify({ messages: body['messages'], tools: body['tools'] }) }))
      } else if (path === '/tokenize') response.end(JSON.stringify({ tokens: Array(String(body['content']).length).fill(1) }))
      else if (path === '/v1/chat/completions') {
        response.setHeader('Content-Type', 'text/event-stream')
        response.end(textEvents.map(event => `data: ${event}\n\n`).join(''))
      } else { response.statusCode = 404; response.end('{}') }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture requires a TCP address')
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ local: {
      api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: 'model', contextWindow, maxTokens: 1000 }],
      llamaCppContextAdmission: { safetyMarginTokens: 100, minimumOutputTokens },
    } }), resolveApiKey: () => Promise.resolve('local'), auth: memoryAuth(),
  })
  const run = async (overrides: Partial<GenerateOptions> = {}) => {
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of adapter.stream({ provider: 'local', model: 'model',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
        maxTokens: 500, ...overrides })) assembler.push(chunk)
    } catch (error) { return { error, assembler } }
    return { error: undefined, assembler }
  }
  return { requests, run }
}

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const tool = (name: string, description: string) => ({ name, description, parameters: { type: 'object', properties: {} } })

describe('Local pre-dispatch context admission', () => {
  it('rejects an input exceeding the declared window without inference dispatch', async () => {
    const f = await fixture(1000, 2000)
    const result = await f.run({ messages: [message('x'.repeat(1100))] })
    expect(result.error).toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
    expect(f.requests.map(r => r.path)).toEqual(['/props', '/apply-template', '/tokenize'])
  })

  it('clamps configured output to exact remaining total context before inference', async () => {
    const f = await fixture(2000, 1000)
    const result = await f.run({ messages: [message('x'.repeat(500))] })
    expect(result.error).toBeUndefined()
    const prompt = String(f.requests.find(r => r.path === '/tokenize')?.body['content'])
    expect(f.requests.at(-1)?.body['max_completion_tokens']).toBe(1000 - prompt.length - 100)
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
  })

  it('refuses insufficient answer room instead of dispatching with a one-token floor', async () => {
    const f = await fixture(1000, 1000, 200)
    const result = await f.run({ messages: [message('x'.repeat(730))] })
    expect(result.error).toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
    expect(f.requests.some(r => r.path === '/v1/chat/completions')).toBe(false)
  })

  it('counts CU OFF and ON schemas in the complete serialized prompt without removing other tools', async () => {
    const f = await fixture(2000)
    const other = tool('read', 'Read a workspace file')
    const cu = tool('mcp__cua-driver-mcp__list_windows', 'Observe window identities. '.repeat(100))
    expect((await f.run({ tools: [other] })).error).toBeUndefined()
    const off = f.requests.find(r => r.path === '/tokenize')?.body['content']
    const firstLength = f.requests.length
    expect((await f.run({ tools: [other, cu] })).error).toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
    const on = f.requests.slice(firstLength).find(r => r.path === '/tokenize')?.body['content']
    expect(String(on)).toContain(cu.name)
    expect(String(on)).toContain(other.name)
    expect(String(on).length - String(off).length).toBeGreaterThan(2000)
    expect(f.requests.slice(firstLength).some(r => r.path === '/v1/chat/completions')).toBe(false)
  })

  it('uses the rendered prompt once even when assistant usage includes cached input', async () => {
    const f = await fixture(2000)
    const usage: TokenUsage = { inputTokens: 10, cacheReadTokens: 1500, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 1520 }
    const assistant = createAssistantMessage({ content: [{ type: 'text', text: 'previous answer' }],
      source: { provider: 'local', model: 'model', replayState: { format: 'pi-ai', version: 1, response: { api: 'openai-completions', provider: 'local', model: 'model', stopReason: 'stop', timestamp: 1, usage: { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: 0, totalTokens: usage.totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, blocks: [{}] } } })
    const result = await f.run({ messages: [message('before'), assistant, message('after')] })
    expect(result.error).toBeUndefined()
    expect(f.requests.filter(r => r.path === '/tokenize')).toHaveLength(1)
    expect(f.requests.at(-1)?.body['max_completion_tokens']).toBe(500)
  })

  it('preserves a deliberately short caller cap when context has enough room', async () => {
    const f = await fixture(2000, 2000, 200)
    const result = await f.run({ maxTokens: 32 })
    expect(result.error).toBeUndefined()
    expect(f.requests.at(-1)?.body['max_completion_tokens']).toBe(32)
  })

  it('leaves a normal small prompt and its configured output unchanged', async () => {
    const f = await fixture()
    const result = await f.run()
    expect(result.error).toBeUndefined()
    expect(f.requests.at(-1)?.body['max_completion_tokens']).toBe(500)
    expect(result.assembler.message({ provider: 'local', model: 'model' }).content).toEqual([{ type: 'text', text: 'hello' }])
  })
})
