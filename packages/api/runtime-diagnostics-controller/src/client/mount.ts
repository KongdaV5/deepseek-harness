/**
 * Browser half: mount the generated Remote contribution and serve the
 * `runtime-diagnostics` resource protocol.
 *
 * The mount takes its contribution as a parameter rather than importing the
 * generated artifact, so this module — the topic registry, the provider wiring,
 * and the lifecycle — is compiled and covered by the source lane, while the
 * package's `./client` entry stays the only place that binds the artifact
 * (which exists only after a build).
 *
 * The plugin does three things and nothing else: it mounts the contribution
 * that makes `ctx.remote.runtimeDiagnostics` exist, it holds the Client's
 * declared observation schemas, and it registers the resource provider that
 * turns an address into a validated stream. It adds no client state framework,
 * no polling, and no semantic interpretation of what an observation means.
 *
 * The schema declaration is deliberately separate from the transport. A topic
 * is a domain's business, so the generic package cannot know which schema a
 * topic carries; a domain package declares it for its own lifetime, and a topic
 * nobody declared fails closed rather than being rendered unvalidated.
 *
 * @module @deepseek-ai/dsh-api-runtime-diagnostics-controller/client/mount
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createRuntimeDiagnosticsProvider } from './provider.ts'
import type { RuntimeDiagnosticsSchema } from './provider.ts'

export type { RuntimeDiagnosticsSchema } from './provider.ts'
export { parseRuntimeDiagnosticsAddress, runtimeDiagnosticsAddress, RUNTIME_DIAGNOSTICS_PROTOCOL } from './address.ts'
export { createRuntimeDiagnosticsProvider } from './provider.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Client's declared transient diagnostics topics. */
    runtimeDiagnosticsTopics: RuntimeDiagnosticsTopics
  }
}

/**
 * The Client-side topic registry.
 *
 * A topic's schema belongs to the domain that owns the topic, so this service
 * only records what that domain declares. It holds no observation, opens no
 * stream, and reads nothing.
 */
export class RuntimeDiagnosticsTopics extends Service {
  /** The service name the Client resolves. */
  static override readonly name = 'runtimeDiagnosticsTopics'

  private readonly declared = new Map<string, RuntimeDiagnosticsSchema>()

  /** @param ctx - the owning Client context. */
  constructor(ctx: ClientContext) {
    super(ctx, 'runtimeDiagnosticsTopics')
  }

  /**
   * Declare the schema one topic's frames must carry.
   * @param topic - the topic being declared.
   * @param schema - the exact schema identity its frames must repeat.
   * @returns an idempotent disposer that withdraws the declaration.
   * @throws Error when the topic already has a declaration.
   */
  declare(topic: string, schema: RuntimeDiagnosticsSchema): () => void {
    if (this.declared.has(topic)) {
      throw new Error(`runtime diagnostics topic "${topic}" is already declared`)
    }
    this.declared.set(topic, schema)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.declared.delete(topic)
    }
  }

  /**
   * Read the declared schema for one topic.
   * @param topic - the topic to resolve.
   * @returns the declared schema, or `undefined` when nothing declared it.
   */
  schemaFor(topic: string): RuntimeDiagnosticsSchema | undefined {
    return this.declared.get(topic)
  }
}

/** Required browser services: the Remote carrier and the resource model. */
export const inject = ['remote', 'resources']

/**
 * Mount the contribution, declare the registry, and register the provider.
 * @param ctx - client root context carrying `remote` and `resources`.
 * @param contribution - the generated contribution selected by the entry.
 * @returns the release of the contribution mount.
 */
export async function mountRuntimeDiagnostics(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  await ctx.plugin(RuntimeDiagnosticsTopics)
  const topics = ctx.runtimeDiagnosticsTopics
  ctx.effect(
    () => ctx.resources.register(createRuntimeDiagnosticsProvider(ctx.remote, topic => topics.schemaFor(topic))),
    'runtime-diagnostics-controller: resource provider',
  )
  return ctx.remote.$mount(contribution)
}
