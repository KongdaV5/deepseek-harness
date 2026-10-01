/**
 * Host half of the generic transient runtime-diagnostics transport.
 *
 * The controller owns routing and delivery, and nothing else. It knows which
 * provider serves a topic, it opens one stream per `topic + SessionId`, and it
 * delivers each frame the provider published — in the order the provider
 * committed it. It never reads a phase, never keeps a current-value map, never
 * caches what it delivered, and never writes to a provider. A reconnect
 * therefore re-reads the owner rather than replaying anything the controller
 * remembered, which is what keeps the transport from becoming a second
 * authority over state it does not own.
 *
 * @module @deepseek-ai/dsh-api-runtime-diagnostics-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { DiagnosticsGeneration } from './stream.ts'
import type {
  RuntimeDiagnosticsFollowRequest,
  RuntimeDiagnosticsFrame,
  RuntimeDiagnosticsProvider,
} from './types.ts'

export type * from './types.ts'

/** The typed terminal failure for a provider retired during an open generation. */
function providerUnavailable(topic: string): RemoteError<'runtime-diagnostics/provider-unavailable'> {
  return new RemoteError(
    'runtime-diagnostics/provider-unavailable',
    `The runtime diagnostics provider for "${topic}" is no longer available.`,
    { topic },
  )
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The topic-keyed transient diagnostics transport owner. */
    runtimeDiagnostics: RuntimeDiagnosticsController
  }
}

/**
 * Host service backing the generated `ctx.remote.runtimeDiagnostics` namespace.
 *
 * A deployment that mounts no provider registers the namespace but serves no
 * topic, so a follow for any topic fails as provider-unavailable rather than
 * opening a stream that can never carry anything.
 */
export class RuntimeDiagnosticsController extends TypertRemoteService {
  static inject = ['typert']

  private readonly providers = new Map<string, RuntimeDiagnosticsProvider>()
  private readonly generations = new Set<DiagnosticsGeneration>()

  /** @param ctx - Host context; this service is its own Remote namespace owner. */
  constructor(ctx: Context) {
    super(ctx, 'runtimeDiagnostics', { namespace: 'runtimeDiagnostics' })
    ctx.effect(() => () => {
      // Disposal retires every provider and ends every open generation, so no
      // owner listener outlives the plugin that registered it.
      this.providers.clear()
      for (const generation of [...this.generations]) generation.end(providerUnavailable(generation.topic))
      this.generations.clear()
    }, 'runtime-diagnostics-controller.lifecycle')
  }

  /**
   * Register the one provider that serves a topic.
   *
   * A second provider for the same topic is a wiring error rather than a
   * precedence question, so it fails fast instead of silently shadowing the
   * first.
   * @param provider - the topic's read-only observation face.
   * @returns an idempotent disposer that also ends the provider's live streams.
   * @throws Error when the topic already has a provider.
   */
  registerProvider(provider: RuntimeDiagnosticsProvider): () => void {
    if (this.providers.has(provider.topic)) {
      throw new Error(`runtime diagnostics topic "${provider.topic}" already has a provider`)
    }
    this.providers.set(provider.topic, provider)
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      this.providers.delete(provider.topic)
      // Streams already open on the removed provider terminate with the same
      // typed unavailable result as a new request would receive. A lifecycle
      // retirement is not a malformed frame, and a reader must not keep the
      // provider's last transient value looking current.
      for (const generation of [...this.generations]) {
        if (generation.topic !== provider.topic) continue
        this.generations.delete(generation)
        generation.end(providerUnavailable(provider.topic))
      }
    }
  }

  /**
   * Open one generation of a topic's observations for one Session.
   * @param request - the topic and Session to follow.
   * @param signal - generation cancellation, supplied by the Remote carrier.
   * @returns the opening snapshot followed by ordered complete replacements.
   */
  @Remote({ mode: 'stream' })
  follow(
    request: RuntimeDiagnosticsFollowRequest,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeDiagnosticsFrame> {
    return this.openGeneration(request, signal)
  }

  private async *openGeneration(
    request: unknown,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeDiagnosticsFrame> {
    signal.throwIfAborted()
    // The wire is untrusted: a peer can send anything, so the request is read as
    // data and validated rather than trusted because the type says so.
    const { topic, sessionId } = (request ?? {}) as Partial<RuntimeDiagnosticsFollowRequest>
    if (typeof topic !== 'string' || topic === '' || typeof sessionId !== 'string' || sessionId === '') {
      throw new RemoteError(
        'runtime-diagnostics/invalid-request',
        'A runtime diagnostics request needs a non-empty topic and sessionId.',
        {},
      )
    }
    const provider = this.providers.get(topic)
    if (provider === undefined) {
      throw new RemoteError(
        'runtime-diagnostics/provider-unavailable',
        `No runtime diagnostics provider is registered for "${topic}".`,
        { topic },
      )
    }
    const generation = new DiagnosticsGeneration(provider, sessionId)
    this.generations.add(generation)
    // Subscribe first, then read, with nothing in between. Registration is
    // silent by contract, so the read that follows observes the very state the
    // subscription is attached to and no change can land in the gap.
    const unsubscribe = provider.subscribe(sessionId, (observation) => { generation.push(observation) })
    try {
      yield generation.frame('snapshot', provider.read(sessionId))
      yield* generation.drain(signal)
    } finally {
      unsubscribe()
      this.generations.delete(generation)
    }
  }
}

export default RuntimeDiagnosticsController
