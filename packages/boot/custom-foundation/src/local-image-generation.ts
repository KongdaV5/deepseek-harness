/** OpenAI Images-compatible local image generation through the model router. */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { request } from 'node:http'
import { isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { LocalProfile } from './index.ts'
import type {} from './local-runtime.ts'
import { z as zod } from 'zod'

/** Route shown beside chat models in the shared model selector. */
export const LOCAL_IMAGE_PROVIDER = 'dsh-local-image'

const responseSchema = zod.object({
  data: zod.array(zod.object({ b64_json: zod.string().min(1) }).loose()).min(1),
}).loose()

/** Host dependencies the image route needs for one request. */
export interface LocalImageGenerationDependencies {
  readonly endpoint: string
  readonly timeoutMs: number
  readonly profiles: () => readonly LocalProfile[]
  readonly status: () => Promise<{
    readonly state: string
    readonly profile: string | null
  }>
  readonly saveImage: (data: Uint8Array) => Promise<ImageAttachmentRef>
  /** Write a generated image to the active session workspace and return its relative path. */
  readonly saveWorkspaceImage?: (data: Uint8Array, sessionId: GenerateOptions['sessionId'], filename: string) => Promise<string | undefined>
  readonly readImage: (attachment: ImageAttachmentRef) => Promise<{ readonly data: Uint8Array }>
  readonly sendRequest?: (url: string, body: string, signal: AbortSignal) => Promise<{ readonly status: number; readonly text: string }>
}

// Images arrive only after inference. Native HTTP avoids fetch's fixed five-minute
// header deadline; the operation signal bounds both inference and response reading.
async function sendImageRequest(url: string, body: string, signal: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', agent: false, signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      response.setEncoding('utf8')
      let text = ''
      response.on('data', (chunk: string) => { text += chunk })
      response.once('error', reject)
      response.once('end', () => { resolve({ status: response.statusCode ?? 500, text }) })
    })
    req.once('error', reject)
    req.end(body)
  })
}

/** Adapter that sends selected image-model requests to `/images/generations`. */
export class LocalImageGenerationAdapter extends LlmAdapter {
  private readonly sendRequest: NonNullable<LocalImageGenerationDependencies['sendRequest']>

  constructor(private readonly dependencies: LocalImageGenerationDependencies) {
    super()
    const endpoint = new URL(dependencies.endpoint)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
      || endpoint.pathname !== '/v1' || endpoint.search !== '' || endpoint.hash !== '') {
      throw new Error('Local image generation requires an explicit loopback /v1 endpoint')
    }
    this.sendRequest = dependencies.sendRequest ?? sendImageRequest
  }

  override providerInfo(provider: string) {
    return { id: provider, name: '本地图像' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.imageProfiles().map(profile => ({
      provider,
      id: profile.id,
      name: profile.name,
      description: 'Image generation',
      inputModalities: ['text', 'image'],
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const profile = this.imageProfiles().find(candidate => candidate.id === model)
    if (profile === undefined) return Promise.reject(new Error(`Unknown local image model: ${model}`))
    return Promise.resolve({
      provider,
      id: model,
      name: profile.name,
      inputModalities: ['text', 'image'],
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const profile = this.imageProfiles().find(candidate => candidate.id === options.model)
    if (profile === undefined) throw new Error(`Unknown local image model: ${options.model}`)

    const runtime = await this.dependencies.status()
    if (runtime.state !== 'running' || runtime.profile !== profile.id) {
      throw new Error(`Start ${profile.name} in Settings → Models before generating an image.`)
    }

    const userMessage = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user')
    if (userMessage === undefined) throw new Error('Image generation needs a user prompt.')
    const prompt = userMessage.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
      .trim()
    if (prompt.length === 0) throw new Error('Enter a text prompt for image generation.')

    const imageBlocks = userMessage.content.filter(block => block.type === 'image')
    if (imageBlocks.length > 1) throw new Error('Image editing accepts one reference image at a time.')
    const reference = imageBlocks[0]
    const referenceData = reference === undefined ? undefined : await this.dependencies.readImage(reference.attachment)
    const requestBody = {
      model: profile.modelId,
      prompt,
      ...(referenceData === undefined ? {} : { image: Buffer.from(referenceData.data).toString('base64') }),
    }
    const deadline = AbortSignal.timeout(this.dependencies.timeoutMs)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    let response: { readonly status: number; readonly text: string }
    try {
      response = await this.sendRequest(`${this.dependencies.endpoint}/images/generations`, JSON.stringify(requestBody), signal)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw error
    }
    const responseText = response.text
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Local image generation failed (${response.status}): ${responseText.slice(0, 1000)}`)
    }
    let payload: unknown
    try { payload = JSON.parse(responseText) }
    catch (error) { throw new Error(`Local image server returned invalid JSON: ${String(error)}`) }
    const generated = responseSchema.parse(payload).data[0]
    if (generated === undefined) throw new Error('Local image server returned no image.')
    const data = new Uint8Array(Buffer.from(generated.b64_json, 'base64'))
    const filename = `dsh-image-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`
    const attachment = await this.dependencies.saveImage(data)
    let workspacePath: string | undefined
    try {
      workspacePath = await this.dependencies.saveWorkspaceImage?.(data, options.sessionId, filename)
    } catch {
      // Keep the durable attachment available in chat even when the workspace is read-only.
    }
    yield { type: 'block-start', index: 0, blockType: 'image' }
    yield { type: 'block-end', index: 0, block: { type: 'image', attachment } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'text',
        text: workspacePath === undefined
          ? '图片已生成，但未能自动保存到工作区。点击图片打开原图预览，再点右上角“下载图片”手动保存。'
          : `图片已自动保存到工作区：${workspacePath}`,
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private imageProfiles(): readonly LocalProfile[] {
    return this.dependencies.profiles().filter(profile => profile.modality === 'image')
  }
}

/** Register the image route alongside the ordinary LLM routes. */
export default class LocalImageGenerationPlugin {
  static inject = ['agents', 'attachments', 'customFoundation', 'llm', 'localModelRuntimeController']
  static Config = z.object({
    endpoint: z.string().default('http://127.0.0.1:8080/v1'),
    timeoutMs: z.number().min(1).step(1).default(3_600_000),
  })

  constructor(ctx: Context, config: { endpoint: string; timeoutMs: number }) {
    const adapter = new LocalImageGenerationAdapter({
      endpoint: config.endpoint,
      timeoutMs: config.timeoutMs,
      profiles: () => ctx.customFoundation.snapshot().profiles,
      status: () => ctx.localModelRuntimeController.status(),
      saveImage: data => ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'generated-image.png' }),
      saveWorkspaceImage: async (data, sessionId, filename) => {
        if (sessionId === undefined) return undefined
        const cwd = ctx.agents.get(sessionId)?.session.header.cwd
        if (cwd === undefined || !isAbsolute(cwd)) return undefined

        // Resolve the session root, then create only a real child directory. Refuse
        // an existing symlink so automatic output cannot escape the workspace.
        const workspace = await realpath(cwd)
        const outputDirectory = join(workspace, 'generated')
        try { await mkdir(outputDirectory) }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
        }
        const directoryInfo = await lstat(outputDirectory)
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
          throw new Error('The generated output path must be a real directory.')
        }

        const outputPath = join(outputDirectory, filename)
        const handle = await open(outputPath, 'wx', 0o600)
        try {
          await handle.writeFile(data)
          await handle.sync()
        } catch (error) {
          await handle.close().catch(() => undefined)
          await unlink(outputPath).catch(() => undefined)
          throw error
        }
        await handle.close()
        return relative(workspace, outputPath)
      },
      readImage: attachment => ctx.attachments.readImage(attachment),
    })
    ctx.llm.registerAdapter([LOCAL_IMAGE_PROVIDER], adapter)
  }
}
