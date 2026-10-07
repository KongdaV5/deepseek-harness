import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { LocalProfile } from '../src/index.ts'
import {
  LOCAL_IMAGE_PROVIDER, LocalImageGenerationAdapter,
} from '../src/local-image-generation.ts'
import LocalImageGenerationPlugin from '../src/local-image-generation.ts'

const profile: LocalProfile = {
  id: 'img21', name: 'Qwen Image 2.1', modality: 'image', modelId: '/models/Qwen-Image-2.1',
}
const image: ImageAttachmentRef = {
  attachmentId: AttachmentId('0123456789abcdef'), mediaType: 'image/png', bytes: 8, width: 1, height: 1,
}

function options(content: Parameters<typeof createUserMessage>[0]['content']): GenerateOptions {
  return {
    provider: LOCAL_IMAGE_PROVIDER,
    model: profile.id,
    messages: [createUserMessage({ content, source: { kind: 'user' } })],
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function dependencies(overrides: Partial<ConstructorParameters<typeof LocalImageGenerationAdapter>[0]> = {}) {
  return {
    endpoint: 'http://127.0.0.1:8080/v1',
    timeoutMs: 3_600_000,
    profiles: () => [profile],
    status: async () => ({ state: 'running', profile: profile.id }),
    saveImage: async () => image,
    readImage: async () => ({ data: new Uint8Array([0, 1]) }),
    sendRequest: vi.fn(async (_url: string, _body: string, _signal: AbortSignal) =>
      ({ status: 200, text: JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }) })),
    ...overrides,
  }
}

describe('LocalImageGenerationAdapter', () => {
  it('advertises configured image profiles but omits text profiles', async () => {
    const adapter = new LocalImageGenerationAdapter(dependencies({
      profiles: () => [profile, { ...profile, id: 'huihui', name: 'Huihui', modality: 'text' }],
    }))

    await expect(adapter.listModels(LOCAL_IMAGE_PROVIDER)).resolves.toEqual([{
      provider: LOCAL_IMAGE_PROVIDER,
      id: profile.id,
      name: profile.name,
      description: 'Image generation',
      inputModalities: ['text', 'image'],
    }])
  })

  it('uses the Images API and emits a durable assistant image block', async () => {
    const saveImage = vi.fn(async () => image)
    const sendRequest = vi.fn(async (_url: string, _body: string, _signal: AbortSignal) =>
      ({ status: 200, text: JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }) }))
    const adapter = new LocalImageGenerationAdapter(dependencies({ saveImage, sendRequest }))

    const chunks = await collect(adapter.stream(options([{ type: 'text', text: 'A red fox in snow' }])))

    expect(sendRequest).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/images/generations',
      JSON.stringify({ model: profile.modelId, prompt: 'A red fox in snow' }), expect.any(AbortSignal))
    expect(saveImage).toHaveBeenCalledWith(new Uint8Array(Buffer.from('aGVsbG8=', 'base64')))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: image } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('sends an optional reference image to the image editing path', async () => {
    const sendRequest = vi.fn(async (_url: string, _body: string, _signal: AbortSignal) =>
      ({ status: 200, text: JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }) }))
    const adapter = new LocalImageGenerationAdapter(dependencies({ sendRequest }))

    await collect(adapter.stream(options([
      { type: 'text', text: 'Make this a watercolor' },
      { type: 'image', attachment: image },
    ])))

    const body = sendRequest.mock.calls[0]?.[1]
    expect(body).toBe(JSON.stringify({
      model: profile.modelId,
      prompt: 'Make this a watercolor',
      image: 'AAE=',
    }))
  })

  it('uses the latest human prompt and reference instead of appended user-role context', async () => {
    const deps = dependencies()
    const adapter = new LocalImageGenerationAdapter(deps)
    const request = options([{ type: 'text', text: 'Make this a watercolor' }, { type: 'image', attachment: image }])
    const context = createUserMessage({
      content: [{ type: 'text', text: 'Time sampled while preparing this turn' }],
      source: { kind: 'system-prompt' },
    })
    await collect(adapter.stream({
      ...request,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Earlier prompt' }], source: { kind: 'user' } }),
        ...request.messages, context],
    }))
    expect(deps.sendRequest).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/images/generations',
      JSON.stringify({ model: profile.modelId, prompt: 'Make this a watercolor', image: 'AAE=' }), expect.any(AbortSignal))
  })

  it('does not turn context-only messages into image prompts', async () => {
    const deps = dependencies()
    const adapter = new LocalImageGenerationAdapter(deps)
    const request = options([])
    await expect(collect(adapter.stream({
      ...request,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Injected context' }], source: { kind: 'system-prompt' } })],
    }))).rejects.toThrow('Image generation needs a user prompt.')
    expect(deps.sendRequest).not.toHaveBeenCalled()
  })

  async function serverDependencies(handler: RequestListener) {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a loopback TCP port')
    const deps = dependencies()
    return {
      endpoint: `http://127.0.0.1:${address.port}/v1`, timeoutMs: deps.timeoutMs,
      profiles: deps.profiles, status: deps.status, saveImage: deps.saveImage, readImage: deps.readImage,
    }
  }

  it('waits for delayed headers and persists the full response over real HTTP', async () => {
    const deps = await serverDependencies((_request, response) => {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }))
      }, 100)
      response.once('close', () => { clearTimeout(timer) })
    })
    const saveImage = vi.fn(deps.saveImage)
    const adapter = new LocalImageGenerationAdapter({ ...deps, saveImage })
    await expect(collect(adapter.stream(options([{ type: 'text', text: 'A care cup' }]))))
      .resolves.toContainEqual({ type: 'block-end', index: 0, block: { type: 'image', attachment: image } })
    expect(saveImage).toHaveBeenCalledOnce()
  })

  it('closes a waiting HTTP request when the user cancels, without saving an image', async () => {
    let arrived!: () => void
    let closed!: () => void
    const requestArrived = new Promise<void>((resolve) => { arrived = resolve })
    const responseClosed = new Promise<void>((resolve) => { closed = resolve })
    const deps = await serverDependencies((_request, response) => {
      response.once('close', closed)
      arrived()
    })
    const saveImage = vi.fn(deps.saveImage)
    const controller = new AbortController()
    const reason = new Error('User cancelled')
    const adapter = new LocalImageGenerationAdapter({ ...deps, saveImage })
    const pending = collect(adapter.stream({ ...options([{ type: 'text', text: 'A care cup' }]), signal: controller.signal }))
    const rejected = expect(pending).rejects.toBe(reason)
    await requestArrived
    controller.abort(reason)
    await rejected
    await responseClosed
    expect(saveImage).not.toHaveBeenCalled()
  })

  it.each([false, true])('bounds the whole HTTP operation, including partial response bodies (%s)', async (headersSent) => {
    const deps = await serverDependencies((_request, response) => {
      if (headersSent) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.write('{"data":[')
      }
    })
    const saveImage = vi.fn(deps.saveImage)
    const adapter = new LocalImageGenerationAdapter({ ...deps, timeoutMs: 100, saveImage })
    await expect(collect(adapter.stream(options([{ type: 'text', text: 'A care cup' }]))))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('refuses requests unless the exact image profile is running', async () => {
    const sendRequest = vi.fn(async () => ({ status: 200, text: '{}' }))
    const adapter = new LocalImageGenerationAdapter(dependencies({
      status: async () => ({ state: 'running', profile: 'huihui' }), sendRequest,
    }))

    await expect(collect(adapter.stream(options([{ type: 'text', text: 'Generate an image' }]))))
      .rejects.toThrow('Start Qwen Image 2.1')
    expect(sendRequest).not.toHaveBeenCalled()
  })
})

it('activates through Cordis and registers the configured image provider', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let registered: { providers: string[]; adapter: LocalImageGenerationAdapter } | undefined
  ctx.provide('attachments', {
    saveImage: async () => image,
    readImage: async () => ({ data: new Uint8Array([0, 1]) }),
  } as never)
  ctx.provide('customFoundation', { snapshot: () => ({ profiles: [profile] }) } as never)
  ctx.provide('localModelRuntimeController', { status: async () => ({ state: 'stopped', profile: null }) } as never)
  ctx.provide('llm', {
    registerAdapter: (providers: string[], adapter: LocalImageGenerationAdapter) => { registered = { providers, adapter } },
  } as never)

  await ctx.plugin(LocalImageGenerationPlugin)

  expect(registered?.providers).toEqual([LOCAL_IMAGE_PROVIDER])
  await expect(registered?.adapter.listModels(LOCAL_IMAGE_PROVIDER)).resolves.toEqual([{
    provider: LOCAL_IMAGE_PROVIDER,
    id: profile.id,
    name: profile.name,
    description: 'Image generation',
    inputModalities: ['text', 'image'],
  }])
})
