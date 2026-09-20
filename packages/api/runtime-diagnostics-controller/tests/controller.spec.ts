/**
 * The generic controller: routing, opening, ordering, and lifecycle.
 *
 * Every test here drives a real Controller on a real Context over a scripted
 * provider, because the properties under test are about what the transport does
 * with what an owner publishes — never about what it decides the value means.
 */
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import RuntimeDiagnosticsController from '../src/index.ts'
import { drainFrames, type FrameIterator, nextFrame, ScriptedProvider, settle } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

/** One controller on a fresh Context, disposed by the suite's teardown. */
function fixture(): { ctx: Context; controller: RuntimeDiagnosticsController } {
  const ctx = new Context()
  contexts.push(ctx)
  return { ctx, controller: new RuntimeDiagnosticsController(ctx) }
}

/** The signal one follow generation is opened with. */
const signal = (): AbortSignal => new AbortController().signal

/** The typed failure one stream raised on its first pull. */
async function failureOfStream(stream: AsyncIterable<unknown>): Promise<{ code: string; details: unknown }> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    await iterator.next()
  } catch (error) {
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return { code: failure.code, details: failure.details }
  }
  throw new Error('expected the stream to fail')
}

describe('RuntimeDiagnosticsController', () => {
  it('opens with a snapshot read after the subscription is registered', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    provider.commit('session-1', { status: 'idle' })
    // A commit landing during registration is published to the listener the
    // registration just installed, so the opening snapshot must already show it.
    // Reading before subscribing would publish `idle` and lose the change.
    provider.onSubscribe = (sessionId) => {
      provider.onSubscribe = undefined
      provider.commit(sessionId, { status: 'assessing' })
    }
    controller.registerProvider(provider)

    const frames = await drainFrames(controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal()), 2)
    expect(frames).toEqual([
      {
        type: 'snapshot',
        topic: 'test-topic',
        sessionId: 'session-1',
        schemaId: 'dsh.test-diagnostics',
        schemaVersion: 1,
        observation: { present: true, value: { status: 'assessing' } },
      },
      {
        type: 'change',
        topic: 'test-topic',
        sessionId: 'session-1',
        schemaId: 'dsh.test-diagnostics',
        schemaVersion: 1,
        observation: { present: true, value: { status: 'assessing' } },
      },
    ])
    expect(provider.operations).toEqual(['subscribe:session-1', 'read:session-1'])
  })

  it('delivers committed replacements in order, after the snapshot', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    controller.registerProvider(provider)
    const iterator: FrameIterator = controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal())[Symbol.asyncIterator]()

    expect((await iterator.next()).value?.type).toBe('snapshot')
    provider.commit('session-1', { step: 1 })
    expect((await iterator.next()).value?.observation).toEqual({ present: true, value: { step: 1 } })
    provider.commit('session-1', { step: 2 })
    provider.commit('session-1', { step: 3 })
    expect((await iterator.next()).value?.observation).toEqual({ present: true, value: { step: 2 } })
    expect((await iterator.next()).value?.observation).toEqual({ present: true, value: { step: 3 } })
  })

  it('reports an owner holding nothing as an absent snapshot, not as a failure', async () => {
    const { controller } = fixture()
    controller.registerProvider(new ScriptedProvider())
    const frames = await drainFrames(controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal()), 1)
    expect(frames).toEqual([{
      type: 'snapshot',
      topic: 'test-topic',
      sessionId: 'session-1',
      schemaId: 'dsh.test-diagnostics',
      schemaVersion: 1,
      observation: { present: false },
    }])
  })

  it('reports a removal as an absent replacement rather than as an end', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    provider.commit('session-1', { step: 1 })
    controller.registerProvider(provider)
    const iterator: FrameIterator = controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal())[Symbol.asyncIterator]()

    expect((await iterator.next()).value?.observation).toEqual({ present: true, value: { step: 1 } })
    provider.commit('session-1', undefined)
    expect((await iterator.next()).value?.observation).toEqual({ present: false })
    expect(await nextFrame(iterator)).toBe('silent')
  })

  it('keeps one Session stream out of another Session', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    controller.registerProvider(provider)
    const iterator: FrameIterator = controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal())[Symbol.asyncIterator]()
    await iterator.next()

    // One pending pull, reused: a frame from another Session must not satisfy it.
    const pending = iterator.next()
    provider.commit('session-2', { other: true })
    expect(await Promise.race([pending, settle().then(() => 'silent' as const)])).toBe('silent')
    provider.commit('session-1', { mine: true })
    expect((await pending).value?.observation).toEqual({ present: true, value: { mine: true } })
  })

  it('refuses a second provider for one topic instead of silently shadowing the first', () => {
    const { controller } = fixture()
    controller.registerProvider(new ScriptedProvider('test-topic'))
    expect(() => controller.registerProvider(new ScriptedProvider('test-topic')))
      .toThrow('runtime diagnostics topic "test-topic" already has a provider')
  })

  it('serves a topic with no provider as unavailable rather than as an empty stream', async () => {
    const { controller } = fixture()
    expect(await failureOfStream(controller.follow({ topic: 'absent-topic', sessionId: 'session-1' }, signal())))
      .toEqual({
        code: 'runtime-diagnostics/provider-unavailable',
        details: { topic: 'absent-topic' },
      })
  })

  it('refuses a request that names no topic or no Session', async () => {
    const { controller } = fixture()
    controller.registerProvider(new ScriptedProvider())
    const invalid: unknown[] = [
      { topic: '', sessionId: 'session-1' },
      { topic: 'test-topic', sessionId: '' },
      { sessionId: 'session-1' },
      { topic: 'test-topic' },
      undefined,
    ]
    for (const request of invalid) {
      expect(await failureOfStream(controller.follow(request as never, signal())), JSON.stringify(request))
        .toEqual({ code: 'runtime-diagnostics/invalid-request', details: {} })
    }
  })

  it('refuses to open a generation for a signal that is already aborted', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    controller.registerProvider(provider)
    const aborted = new AbortController()
    aborted.abort()
    const iterator: FrameIterator = controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, aborted.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow()
    // An abort is not a transport failure: the owner was never subscribed and
    // nothing was reported to a reader.
    expect(provider.operations).toEqual([])
  })

  it('fails the stream closed when an owner publishes a value that is not detached JSON', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    provider.commit('session-1', { handler: (): void => {}, at: new Date() })
    controller.registerProvider(provider)
    expect(await failureOfStream(controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal())))
      .toEqual({ code: 'runtime-diagnostics/invalid-observation', details: { topic: 'test-topic' } })
  })

  it('releases the owner subscription and its generation when the reader aborts', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    controller.registerProvider(provider)
    const aborted = new AbortController()
    const iterator: FrameIterator = controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, aborted.signal)[Symbol.asyncIterator]()
    await iterator.next()

    aborted.abort()
    expect((await iterator.next()).done).toBe(true)
    expect(provider.operations).toEqual(['subscribe:session-1', 'read:session-1', 'dispose:session-1'])
  })

  it('ends a withdrawn provider\'s open generations and frees its topic, idempotently', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    const release = controller.registerProvider(provider)
    const iterator: FrameIterator = controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal())[Symbol.asyncIterator]()
    await iterator.next()

    release()
    release()
    expect((await iterator.next()).done).toBe(true)
    expect(provider.operations).toEqual(['subscribe:session-1', 'read:session-1', 'dispose:session-1'])
    // The topic is free again, so a replacement provider can claim it.
    controller.registerProvider(new ScriptedProvider('test-topic'))
  })

  it('leaves another topic\'s generation open when one provider is withdrawn', async () => {
    const { controller } = fixture()
    const first = new ScriptedProvider('first-topic')
    const second = new ScriptedProvider('second-topic')
    const releaseFirst = controller.registerProvider(first)
    controller.registerProvider(second)
    const iterator: FrameIterator = controller.follow({ topic: 'second-topic', sessionId: 'session-1' }, signal())[Symbol.asyncIterator]()
    await iterator.next()

    releaseFirst()
    second.commit('session-1', { alive: true })
    expect((await iterator.next()).value?.observation).toEqual({ present: true, value: { alive: true } })
  })

  it('retires every provider and ends every generation when the controller is disposed', async () => {
    const { ctx, controller } = fixture()
    const provider = new ScriptedProvider()
    controller.registerProvider(provider)
    const iterator: FrameIterator = controller.follow({ topic: 'test-topic', sessionId: 'session-1' }, signal())[Symbol.asyncIterator]()
    await iterator.next()

    await ctx.fiber.dispose()
    expect((await iterator.next()).done).toBe(true)
    expect(provider.operations).toEqual(['subscribe:session-1', 'read:session-1', 'dispose:session-1'])
  })

  it('opens one independent generation per reader of the same topic and Session', async () => {
    const { controller } = fixture()
    const provider = new ScriptedProvider()
    provider.commit('session-1', { step: 0 })
    controller.registerProvider(provider)
    const request = { topic: 'test-topic', sessionId: 'session-1' }
    const first: FrameIterator = controller.follow(request, signal())[Symbol.asyncIterator]()
    const second: FrameIterator = controller.follow(request, signal())[Symbol.asyncIterator]()

    expect((await first.next()).value?.observation).toEqual({ present: true, value: { step: 0 } })
    expect((await second.next()).value?.observation).toEqual({ present: true, value: { step: 0 } })

    provider.commit('session-1', { step: 1 })
    expect((await first.next()).value?.observation).toEqual({ present: true, value: { step: 1 } })
    expect((await second.next()).value?.observation).toEqual({ present: true, value: { step: 1 } })
  })
})
