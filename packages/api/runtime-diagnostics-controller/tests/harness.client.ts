/**
 * Shared fixtures for the transient diagnostics suites that live on the browser
 * side of the seam: the `runtime-diagnostics` resource provider and the
 * generated-contribution mount.
 *
 * The Remote here is scripted rather than real, because the properties under
 * test are about how a consumer treats an untrusted payload — a spec has to
 * decide exactly which frames a generation delivers, including a frame the Host
 * would only send while the carrier was already being torn down.
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { RuntimeDiagnosticsRemote } from '../src/client/remote.ts'
import type {
  RuntimeDiagnosticsFollowRequest,
  RuntimeDiagnosticsFrame,
} from '../src/types.ts'

/**
 * One scripted Remote stream generation.
 *
 * The queue is deliberately unaware of the abort signal: a spec decides exactly
 * which frames a consumer receives, so the consumer's own cancellation handling
 * is what is under test rather than the fake's.
 */
export class Source<T> implements AsyncIterable<T> {
  private readonly queue: Array<{ kind: 'value'; value: T } | { kind: 'end' } | { kind: 'fail'; error: unknown }> = []
  private wake: (() => void) | undefined

  /** Deliver one frame to whoever is reading. */
  push(value: T): void {
    this.queue.push({ kind: 'value', value })
    this.wake?.()
  }

  /** End the generation the way a Host stream ends. */
  end(): void {
    this.queue.push({ kind: 'end' })
    this.wake?.()
  }

  /** End the generation with a carrier failure. */
  fail(error: unknown): void {
    this.queue.push({ kind: 'fail', error })
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.queue.shift()
      if (next === undefined) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
        continue
      }
      if (next.kind === 'value') {
        yield next.value
        continue
      }
      if (next.kind === 'end') return
      throw next.error
    }
  }
}

/** One follow generation a scripted Remote opened. */
export interface OpenedGeneration {
  /** The request the Client submitted. */
  readonly request: RuntimeDiagnosticsFollowRequest
  /** The cancellation the Client handed over, when it handed one over. */
  readonly signal: AbortSignal | undefined
  /** The frames the spec decides to deliver. */
  readonly source: Source<RuntimeDiagnosticsFrame>
}

/** The Client Remote, scripted: `follow` opens a spec-controlled generation. */
export class ScriptedRemote implements RuntimeDiagnosticsRemote {
  /** Every generation opened, in order. */
  readonly opened: OpenedGeneration[] = []
  /** Every contribution this face was asked to mount, in order. */
  readonly mounts: TypertRemoteContribution[] = []
  /** How many times a mount release has run. */
  mountReleases = 0

  private readonly planned: Source<RuntimeDiagnosticsFrame>[] = []

  private readonly connection = {
    generation: {
      getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }),
      subscribe: () => () => {},
    },
  }

  /**
   * Hand the generation the next `follow` call returns.
   * Planning the stream before it is opened is what lets a spec push a frame
   * before the provider's generator has started.
   * @param source - the generation to serve.
   * @returns the same source, for convenience.
   */
  plan(source: Source<RuntimeDiagnosticsFrame>): Source<RuntimeDiagnosticsFrame> {
    this.planned.push(source)
    return source
  }

  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    return new RemoteStream(this.connection, options)
  }

  readonly runtimeDiagnostics = {
    follow: (request: RuntimeDiagnosticsFollowRequest, signal?: AbortSignal): AsyncIterable<RuntimeDiagnosticsFrame> => {
      const source = this.planned.shift() ?? new Source<RuntimeDiagnosticsFrame>()
      this.opened.push({ request, signal, source })
      const aborted = (): void => { source.end() }
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
      return {
        async * [Symbol.asyncIterator](): AsyncIterator<RuntimeDiagnosticsFrame> {
          try {
            yield* source
          } finally {
            signal?.removeEventListener('abort', aborted)
          }
        },
      }
    },
  }

  async $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
    this.mounts.push(contribution)
    return async () => { this.mountReleases += 1 }
  }
}

/** One frame a spec can hand a provider, complete and valid unless overridden. */
export function frame(overrides: Partial<RuntimeDiagnosticsFrame> = {}): RuntimeDiagnosticsFrame {
  return {
    type: 'snapshot',
    topic: 'test-topic',
    sessionId: 'session-1',
    schemaId: 'dsh.test-diagnostics',
    schemaVersion: 1,
    observation: { present: true, value: { status: 'idle' } },
    ...overrides,
  }
}
