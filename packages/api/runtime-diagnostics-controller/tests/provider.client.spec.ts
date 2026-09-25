/**
 * The `runtime-diagnostics` resource provider.
 *
 * A Remote payload is untrusted input, so the suite is written the way an
 * attacker would read it: every frame field is varied independently, and each
 * variation must end as a typed failure rather than as a rendered value. The two
 * properties that matter most are asserted directly — a stream never yields a
 * change before its snapshot, and a stream that ends is never reported as a live
 * value.
 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { runtimeDiagnosticsAddress } from '../src/client/address.ts'
import { createRuntimeDiagnosticsProvider } from '../src/client/provider.ts'
import type { RuntimeDiagnosticsSchema } from '../src/client/provider.ts'
import type { RuntimeDiagnosticsFrame, RuntimeDiagnosticsObservation } from '../src/types.ts'
import { frame, Source, ScriptedRemote } from './harness.client.ts'

const SCHEMA: RuntimeDiagnosticsSchema = { schemaId: 'dsh.test-diagnostics', schemaVersion: 1 }
const ADDRESS = runtimeDiagnosticsAddress('test-topic', 'session-1')

/** A provider whose Client declares exactly the topic the fixtures use. */
function providerFor(remote: ScriptedRemote, declare = true) {
  return createRuntimeDiagnosticsProvider(remote, topic => (declare && topic === 'test-topic' ? SCHEMA : undefined))
}

/** One opened stream, its Host side, and the cancellation the model owns. */
interface OpenStream {
  readonly remote: ScriptedRemote
  readonly host: Source<RuntimeDiagnosticsFrame>
  readonly iterator: AsyncIterator<RemoteResult<RuntimeDiagnosticsObservation>>
  readonly controller: AbortController
}

/** Open one generation over a spec-planned Host stream. */
function open(address = ADDRESS): OpenStream {
  const remote = new ScriptedRemote()
  const controller = new AbortController()
  const host = remote.plan(new Source<RuntimeDiagnosticsFrame>())
  const iterator = providerFor(remote).open(address, { signal: controller.signal })[Symbol.asyncIterator]()
  return { remote, host, iterator, controller }
}

/**
 * Assert that a stream reports one failure and then ends.
 *
 * A failure frame that leaves the generation open would hold a resource that can
 * never be repaired, so every refusal is asserted to close its stream too.
 */
async function refused(
  iterator: AsyncIterator<RemoteResult<RuntimeDiagnosticsObservation>>,
  expected: object,
): Promise<void> {
  const first = await iterator.next()
  expect(first.value).toMatchObject(expected)
  expect((await iterator.next()).done).toBe(true)
}

describe('createRuntimeDiagnosticsProvider', () => {
  it('serves the package protocol', () => {
    expect(providerFor(new ScriptedRemote()).protocol).toBe('runtime-diagnostics')
  })

  it('opens exactly the topic and Session the address names', async () => {
    const stream = open(runtimeDiagnosticsAddress('test-topic', 'session-9'))
    stream.host.push(frame({ sessionId: 'session-9' }))
    await stream.iterator.next()
    expect(stream.remote.opened).toHaveLength(1)
    expect(stream.remote.opened[0]?.request).toEqual({ topic: 'test-topic', sessionId: 'session-9' })
    expect(stream.remote.opened[0]?.signal).toBe(stream.controller.signal)
  })

  it('yields the opening snapshot, then replaces the value on every change', async () => {
    const stream = open()
    stream.host.push(frame({ observation: { present: true, value: { status: 'idle' } } }))
    expect((await stream.iterator.next()).value).toEqual({ ok: true, value: { present: true, value: { status: 'idle' } } })

    stream.host.push(frame({ type: 'change', observation: { present: true, value: { status: 'applied' } } }))
    expect((await stream.iterator.next()).value).toEqual({ ok: true, value: { present: true, value: { status: 'applied' } } })
  })

  it('yields an explicit absence as a value rather than as a failure', async () => {
    const stream = open()
    stream.host.push(frame({ observation: { present: false } }))
    expect((await stream.iterator.next()).value).toEqual({ ok: true, value: { present: false } })
  })

  it('refuses an address it cannot parse without opening a Host stream', async () => {
    const remote = new ScriptedRemote()
    const iterator = providerFor(remote)
      .open('dsh-resource://runtime-diagnostics/only-one-segment', { signal: new AbortController().signal })
      [Symbol.asyncIterator]()
    await refused(iterator, { ok: false, error: { code: 'runtime-diagnostics/invalid-address' } })
    expect(remote.opened).toEqual([])
  })

  it('fails closed on a topic whose schema this Client cannot name', async () => {
    const remote = new ScriptedRemote()
    const iterator = providerFor(remote, false)
      .open(ADDRESS, { signal: new AbortController().signal })
      [Symbol.asyncIterator]()
    await refused(iterator, {
      ok: false,
      error: { code: 'runtime-diagnostics/unknown-schema', details: { topic: 'test-topic' } },
    })
    expect(remote.opened).toEqual([])
  })

  it('refuses a change that arrives before the opening snapshot', async () => {
    const stream = open()
    const pending = stream.iterator.next()
    stream.host.push(frame({ type: 'change' }))
    expect((await pending).value).toMatchObject({
      ok: false,
      error: { code: 'runtime-diagnostics/unexpected-frame', details: { detail: 'change-before-snapshot' } },
    })
    expect((await stream.iterator.next()).done).toBe(true)
  })

  it('refuses a second snapshot inside one generation', async () => {
    const stream = open()
    stream.host.push(frame())
    await stream.iterator.next()
    const pending = stream.iterator.next()
    stream.host.push(frame())
    expect((await pending).value).toMatchObject({
      ok: false,
      error: { code: 'runtime-diagnostics/unexpected-frame', details: { detail: 'duplicate-snapshot' } },
    })
    expect((await stream.iterator.next()).done).toBe(true)
  })

  it('refuses a frame that names another Session, another topic, or another schema', async () => {
    const mismatches = [
      frame({ sessionId: 'session-2' }),
      frame({ topic: 'other-topic' }),
      frame({ schemaId: 'dsh.other-diagnostics' }),
      frame({ schemaVersion: 2 }),
    ]
    for (const mismatched of mismatches) {
      const stream = open()
      const pending = stream.iterator.next()
      stream.host.push(mismatched)
      expect((await pending).value, JSON.stringify(mismatched)).toMatchObject({
        ok: false,
        error: { code: 'runtime-diagnostics/unexpected-frame' },
      })
      expect((await stream.iterator.next()).done).toBe(true)
    }
  })

  it('refuses every frame that is not a well-formed snapshot', async () => {
    const malformed: unknown[] = [
      'not an object',
      null,
      { ...frame(), type: 'patch' },
      { ...frame(), observation: undefined },
      { ...frame(), observation: { present: 'yes' } },
      { ...frame(), observation: { present: true, value: 'not a record' } },
      { ...frame(), observation: { present: true, value: [1, 2] } },
      { ...frame(), observation: { present: true, value: { nested: (): void => {} } } },
      { ...frame(), observation: { present: true, value: { nested: Number.NaN } } },
      { ...frame(), observation: { present: true, value: { nested: { deep: [new Date()] } } } },
    ]
    for (const candidate of malformed) {
      const stream = open()
      const pending = stream.iterator.next()
      // Deliberately not a frame: the consumer, not the type, is what refuses it.
      stream.host.push(candidate as RuntimeDiagnosticsFrame)
      expect((await pending).value, JSON.stringify(candidate)).toMatchObject({
        ok: false,
        error: { code: 'runtime-diagnostics/unexpected-frame' },
      })
      expect((await stream.iterator.next()).done).toBe(true)
    }
  })

  it('reports a carrier failure as unavailable, never as the last value', async () => {
    const stream = open()
    stream.host.push(frame())
    await stream.iterator.next()
    const pending = stream.iterator.next()
    stream.host.fail(new RemoteError('gateway/cancelled', 'the carrier went away', {}))
    expect((await pending).value).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
  })

  it('preserves a typed provider-retirement failure instead of calling it an unexpected frame', async () => {
    const stream = open()
    stream.host.push(frame())
    await stream.iterator.next()
    const pending = stream.iterator.next()
    stream.host.fail(new RemoteError(
      'runtime-diagnostics/provider-unavailable',
      'The runtime diagnostics provider was retired.',
      { topic: 'test-topic' },
    ))
    expect((await pending).value).toMatchObject({
      ok: false,
      error: { code: 'runtime-diagnostics/provider-unavailable', details: { topic: 'test-topic' } },
    })
  })

  it('reports a non-Remote carrier throw as an unexpected-frame transport failure', async () => {
    const stream = open()
    const pending = stream.iterator.next()
    stream.host.fail(new TypeError('socket closed'))
    const outcome = (await pending).value as RemoteResult<RuntimeDiagnosticsObservation>
    if (outcome.ok) throw new Error('expected a failure frame')
    expect(outcome.error.code).toBe('runtime-diagnostics/unexpected-frame')
    expect(outcome.error.details).toEqual({ detail: 'transport-failure' })
    expect(outcome.error.message).toBe('socket closed')
  })

  it('reports a carrier throw that is not an Error at all', async () => {
    const stream = open()
    const pending = stream.iterator.next()
    stream.host.fail('carrier exploded')
    const outcome = (await pending).value as RemoteResult<RuntimeDiagnosticsObservation>
    if (outcome.ok) throw new Error('expected a failure frame')
    expect(outcome.error.details).toEqual({ detail: 'transport-failure' })
    expect(outcome.error.message).toBe('carrier exploded')
  })

  it('treats a stream that ends after a snapshot as unavailable rather than as current', async () => {
    const stream = open()
    stream.host.push(frame({ observation: { present: true, value: { status: 'summarizing' } } }))
    await stream.iterator.next()
    const pending = stream.iterator.next()
    stream.host.end()
    const outcome = await pending
    expect(outcome.value).toMatchObject({
      ok: false,
      error: { code: 'runtime-diagnostics/unexpected-frame', details: { detail: 'unexpected-end' } },
    })
    // The generation is over: a reader must not be left believing the last frame
    // is still the current one.
    expect((await stream.iterator.next()).done).toBe(true)
  })

  it('treats a stream that ends before its snapshot as unavailable', async () => {
    const stream = open()
    const pending = stream.iterator.next()
    stream.host.end()
    expect((await pending).value).toMatchObject({
      ok: false,
      error: { code: 'runtime-diagnostics/unexpected-frame', details: { detail: 'end-before-snapshot' } },
    })
  })

  it('stops silently on an abort that lands between frames', async () => {
    const stream = open()
    stream.host.push(frame())
    await stream.iterator.next()
    const pending = stream.iterator.next()
    stream.controller.abort()
    // The Host stream is unblocked by a frame a real carrier would send before
    // it finished tearing down; the provider must still stop without reporting.
    stream.host.push(frame({ type: 'change' }))
    expect((await pending).done).toBe(true)
  })

  it('stops silently on an abort that races a carrier failure', async () => {
    const stream = open()
    const pending = stream.iterator.next()
    stream.controller.abort()
    stream.host.fail(new TypeError('torn down'))
    expect((await pending).done).toBe(true)
  })

  it('stops silently when the Host stream ends while the abort is already in flight', async () => {
    const stream = open()
    stream.host.push(frame())
    await stream.iterator.next()
    const pending = stream.iterator.next()
    stream.controller.abort()
    // A teardown that ends the generation cleanly is still a cancellation, so
    // it must not be reported as the Host having gone away.
    stream.host.end()
    expect((await pending).done).toBe(true)
  })

  it('stops silently on an abort that lands before the first frame is validated', async () => {
    const stream = open()
    const pending = stream.iterator.next()
    stream.controller.abort()
    stream.host.push(frame())
    expect((await pending).done).toBe(true)
  })
})
