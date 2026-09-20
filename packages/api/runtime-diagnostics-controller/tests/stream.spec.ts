/**
 * The transport's two mechanisms, in isolation: detaching an owner's value into
 * plain JSON, and one generation's ordering.
 *
 * These are the only places the transport can lose or corrupt an observation, so
 * each refusal is asserted by its typed code rather than by "it threw", and each
 * ordering property is asserted against a reader that is deliberately slow.
 */
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { DiagnosticsGeneration, detachObservation } from '../src/stream.ts'
import type { RuntimeDiagnosticsProviderObservation } from '../src/types.ts'
import type { FrameIterator } from './harness.ts'

/** The typed failure one call raised, or a defect when it did not raise one. */
function failureOf(run: () => unknown): { code: string; details: unknown } {
  try {
    run()
  } catch (error) {
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return { code: failure.code, details: failure.details }
  }
  throw new Error('expected the call to refuse the observation')
}

const present = (value: object): RuntimeDiagnosticsProviderObservation => ({ present: true, value })

describe('detachObservation', () => {
  it('normalizes absence, and an owner holding nothing, to one representation', () => {
    expect(detachObservation(undefined, 'topic')).toEqual({ present: false })
    expect(detachObservation({ present: false }, 'topic')).toEqual({ present: false })
  })

  it('detaches a nested observation into plain JSON, preserving null and ordering', () => {
    const detached = detachObservation(present({
      status: 'applied',
      count: 3,
      ok: true,
      nested: { null: null, list: [1, 'two', null, { deep: [] }] },
    }), 'topic')
    expect(detached).toEqual({
      present: true,
      value: {
        status: 'applied',
        count: 3,
        ok: true,
        nested: { null: null, list: [1, 'two', null, { deep: [] }] },
      },
    })
  })

  it('keeps a value shared by two siblings legal', () => {
    const shared = { id: 'shared' }
    expect(detachObservation(present({ left: shared, right: shared }), 'topic')).toEqual({
      present: true,
      value: { left: { id: 'shared' }, right: { id: 'shared' } },
    })
  })

  it('refuses a non-object observation rather than handing a client a bare array', () => {
    expect(failureOf(() => detachObservation(present([1, 2]), 'topic'))).toEqual({
      code: 'runtime-diagnostics/invalid-observation',
      details: { topic: 'topic' },
    })
  })

  it('refuses every value that has no JSON representation, naming the field', () => {
    const cases: Array<[string, () => object]> = [
      ['a function field', () => ({ f: (): void => {} })],
      ['a symbol field', () => ({ s: Symbol('s') })],
      ['a bigint field', () => ({ b: 1n })],
      ['a non-finite number', () => ({ n: Number.POSITIVE_INFINITY })],
      ['a class instance field', () => ({ instance: new (class Box { readonly v = 1 })() })],
      ['an undefined field', () => ({ u: undefined })],
      ['an undefined array entry', () => ({ list: [1, undefined] })],
      ['a cyclic field', () => {
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        return cyclic
      }],
    ]
    for (const [label, build] of cases) {
      const outcome = failureOf(() => detachObservation(present(build()), 'topic'))
      expect(outcome.code, label).toBe('runtime-diagnostics/invalid-observation')
    }
  })

  it('refuses a non-object present value at the top level', () => {
    expect(failureOf(() => detachObservation(present('a string' as unknown as object), 'topic')).code)
      .toBe('runtime-diagnostics/invalid-observation')
  })
})

describe('DiagnosticsGeneration', () => {
  const declaration = { topic: 'test-topic', schemaId: 'dsh.test-diagnostics', schemaVersion: 1 }

  it('stamps every frame with the topic identity and the addressed Session', () => {
    const generation = new DiagnosticsGeneration(declaration, 'session-1')
    expect(generation.topic).toBe('test-topic')
    expect(generation.frame('snapshot', present({ status: 'idle' }))).toEqual({
      type: 'snapshot',
      topic: 'test-topic',
      sessionId: 'session-1',
      schemaId: 'dsh.test-diagnostics',
      schemaVersion: 1,
      observation: { present: true, value: { status: 'idle' } },
    })
  })

  it('reads buffered replacements in commit order before it waits', async () => {
    const generation = new DiagnosticsGeneration(declaration, 'session-1')
    generation.push(present({ step: 1 }))
    generation.push(present({ step: 2 }))
    generation.end()
    const frames = []
    for await (const frame of generation.drain(new AbortController().signal)) frames.push(frame)
    expect(frames.map(frame => [frame.type, frame.observation])).toEqual([
      ['change', { present: true, value: { step: 1 } }],
      ['change', { present: true, value: { step: 2 } }],
    ])
  })

  it('reports a removal as an absent replacement rather than dropping the frame', async () => {
    const generation = new DiagnosticsGeneration(declaration, 'session-1')
    generation.push(undefined)
    generation.end()
    const frames = []
    for await (const frame of generation.drain(new AbortController().signal)) frames.push(frame)
    expect(frames.map(frame => frame.observation)).toEqual([{ present: false }])
  })

  it('delivers a replacement committed while a reader is already waiting', async () => {
    const generation = new DiagnosticsGeneration(declaration, 'session-1')
    const iterator: FrameIterator = generation.drain(new AbortController().signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    generation.push(present({ step: 1 }))
    expect((await pending).value?.observation).toEqual({ present: true, value: { step: 1 } })
    generation.end()
    expect((await iterator.next()).done).toBe(true)
  })

  it('stops a waiting reader on end and on abort alike', async () => {
    const ended = new DiagnosticsGeneration(declaration, 'session-1')
    const endedIterator = ended.drain(new AbortController().signal)[Symbol.asyncIterator]()
    const waitingOnEnd = endedIterator.next()
    ended.end()
    expect((await waitingOnEnd).done).toBe(true)

    const controller = new AbortController()
    const aborted = new DiagnosticsGeneration(declaration, 'session-2')
    const abortedIterator = aborted.drain(controller.signal)[Symbol.asyncIterator]()
    const waitingOnAbort = abortedIterator.next()
    controller.abort()
    expect((await waitingOnAbort).done).toBe(true)
  })

  it('never opens a generation for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const generation = new DiagnosticsGeneration(declaration, 'session-1')
    const frames = []
    for await (const frame of generation.drain(controller.signal)) frames.push(frame)
    expect(frames).toEqual([])
  })

  it('ignores a replacement committed after the generation ended', async () => {
    const generation = new DiagnosticsGeneration(declaration, 'session-1')
    generation.end()
    generation.end()
    generation.push(present({ late: true }))
    const frames = []
    for await (const frame of generation.drain(new AbortController().signal)) frames.push(frame)
    expect(frames).toEqual([])
  })
})
