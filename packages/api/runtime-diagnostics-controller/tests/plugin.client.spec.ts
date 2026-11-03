/**
 * The browser mount: hold the Client's topic declarations, register the resource
 * provider, and release both with the fiber, so the plugin leaves nothing behind.
 *
 * The generated contribution is a fixture rather than an import: the artifact
 * exists only in `lib`, so the source lane binds the entry to a value it owns
 * and the mount lifecycle stays fully covered.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import {
  inject,
  mountRuntimeDiagnostics,
  RuntimeDiagnosticsTopics,
  runtimeDiagnosticsAddress,
} from '../src/client/mount.ts'
import type { RuntimeDiagnosticsFrame } from '../src/types.ts'
import { frame, Source, ScriptedRemote } from './harness.client.ts'

/** The generated contribution shape the entry supplies. */
const CONTRIBUTION: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-api-runtime-diagnostics-controller',
  descriptors: [],
}

/** One client fixture: a Context carrying the two services the mount needs. */
function client() {
  const ctx = new Context()
  const remote = new ScriptedRemote()
  const registered: Array<ResourceProvider<'runtime-diagnostics'>> = []
  const released: string[] = []
  ctx.provide('remote', remote as never)
  ctx.provide('resources', {
    register: (provider: ResourceProvider<'runtime-diagnostics'>) => {
      registered.push(provider)
      return () => { released.push(provider.protocol) }
    },
  } as never)
  return { ctx, remote, registered, released }
}

describe('mountRuntimeDiagnostics', () => {
  it('activates inside the real plugin context after providing its topic service', async () => {
    const { ctx, registered } = client()
    const fiber = ctx.plugin({
      inject,
      apply: async pluginCtx => mountRuntimeDiagnostics(pluginCtx, CONTRIBUTION),
    })
    await fiber.await()

    expect(ctx.get('runtimeDiagnosticsTopics')).toBeInstanceOf(RuntimeDiagnosticsTopics)
    expect(registered.map(provider => provider.protocol)).toEqual(['runtime-diagnostics'])
    await ctx.fiber.dispose()
  })

  it('mounts the contribution and registers the protocol provider', async () => {
    const { ctx, remote, registered, released } = client()
    const dispose = await mountRuntimeDiagnostics(ctx, CONTRIBUTION)

    expect(remote.mounts).toEqual([CONTRIBUTION])
    expect(registered.map(provider => provider.protocol)).toEqual(['runtime-diagnostics'])
    expect(inject).toEqual(['remote', 'resources'])

    // The mount and the provider have different owners: releasing the mount
    // withdraws the Remote namespace, while the provider belongs to the fiber
    // that registered it.
    await dispose()
    expect(remote.mountReleases).toBe(1)
    expect(released).toEqual([])

    await ctx.fiber.dispose()
    expect(released).toEqual(['runtime-diagnostics'])
  })

  it('serves a declared topic end to end, and unregisters the provider with the fiber', async () => {
    const { ctx, remote, registered, released } = client()
    await mountRuntimeDiagnostics(ctx, CONTRIBUTION)
    const topics = ctx.runtimeDiagnosticsTopics
    topics.declare('test-topic', { schemaId: 'dsh.test-diagnostics', schemaVersion: 1 })

    const controller = new AbortController()
    const host = remote.plan(new Source<RuntimeDiagnosticsFrame>())
    const iterator = registered[0]!
      .open(runtimeDiagnosticsAddress('test-topic', 'session-1'), { signal: controller.signal })
      [Symbol.asyncIterator]()
    host.push(frame())
    expect((await iterator.next()).value).toEqual({ ok: true, value: { present: true, value: { status: 'idle' } } })
    expect(remote.opened[0]?.request).toEqual({ topic: 'test-topic', sessionId: 'session-1' })

    await ctx.fiber.dispose()
    expect(released).toEqual(['runtime-diagnostics'])
  })

  it('fails a topic nobody declared closed rather than serving it unvalidated', async () => {
    const { ctx, registered } = client()
    await mountRuntimeDiagnostics(ctx, CONTRIBUTION)
    const iterator = registered[0]!
      .open(runtimeDiagnosticsAddress('undeclared', 'session-1'), { signal: new AbortController().signal })
      [Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({
      ok: false,
      error: { code: 'runtime-diagnostics/unknown-schema', details: { topic: 'undeclared' } },
    })
    await ctx.fiber.dispose()
  })
})

describe('RuntimeDiagnosticsTopics', () => {
  it('records one declaration per topic and withdraws it idempotently', () => {
    const ctx = new Context()
    const topics = new RuntimeDiagnosticsTopics(ctx)
    const schema = { schemaId: 'dsh.test-diagnostics', schemaVersion: 1 }

    expect(topics.schemaFor('test-topic')).toBeUndefined()
    const withdraw = topics.declare('test-topic', schema)
    expect(topics.schemaFor('test-topic')).toEqual(schema)
    withdraw()
    withdraw()
    expect(topics.schemaFor('test-topic')).toBeUndefined()
  })

  it('refuses a second declaration for one topic instead of redefining its schema', () => {
    const ctx = new Context()
    const topics = new RuntimeDiagnosticsTopics(ctx)
    topics.declare('test-topic', { schemaId: 'dsh.test-diagnostics', schemaVersion: 1 })
    expect(() => topics.declare('test-topic', { schemaId: 'dsh.test-diagnostics', schemaVersion: 2 }))
      .toThrow('runtime diagnostics topic "test-topic" is already declared')
  })

  it('holds no observation: reading a topic a domain declared yields its schema, nothing else', () => {
    const ctx = new Context()
    const topics = new RuntimeDiagnosticsTopics(ctx)
    topics.declare('test-topic', { schemaId: 'dsh.test-diagnostics', schemaVersion: 1 })
    // The registry's whole surface is naming schemas. There is no read, no
    // stream, and no writer to reach an observation through.
    expect(Object.getOwnPropertyNames(RuntimeDiagnosticsTopics.prototype).sort())
      .toEqual(['constructor', 'declare', 'schemaFor'])
  })
})
