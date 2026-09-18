import { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, expectTypeOf, it } from 'vitest'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { IgnorableSessionEventType, SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Stands in for a plugin's optional-subsystem record (`task/checkpoint`). */
    'test/optional-fact': { value: string; revision: number }
  }
  /**
   * A registered opt-in stands in for the first-party consumer of the seam.
   * Every other known event type stays out, which is what keeps ordinary
   * first-party events required-by-default.
   */
  interface IgnorableSessionEventMap {
    'test/optional-fact': { value: string; revision: number }
  }
}

const id = SessionId('ignorable-append')

/**
 * Compile-time contract of the seam. Never executed: the negative arms must fail
 * to type-check, and running them would append ordinary events instead.
 */
function typedSeamContracts(session: Session): void {
  // Registration alone admits the type, and the return type stays the narrow event.
  expectTypeOf(session.appendIgnorable('test/optional-fact', { value: 'v', revision: 1 }))
    .toEqualTypeOf<SessionEvent<'test/optional-fact'>>()
  // The payload stays the declared SessionEventMap shape.
  // @ts-expect-error -- a missing required payload member is still rejected.
  session.appendIgnorable('test/optional-fact', { value: 'v' })
  // @ts-expect-error -- an unexpected payload member is still rejected.
  session.appendIgnorable('test/optional-fact', { value: 'v', revision: 1, extra: true })

  // Core events are known vocabulary but never registered reader-optional.
  // @ts-expect-error -- turn/start is required history, not optional metadata.
  session.appendIgnorable('turn/start', { turn: 1 })
  // @ts-expect-error -- turn/end is required history, not optional metadata.
  session.appendIgnorable('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // @ts-expect-error -- assistant/message is surface history, never ignorable.
  session.appendIgnorable('assistant/message', {})
  // @ts-expect-error -- tool/call is required history, not optional metadata.
  session.appendIgnorable('tool/call', {})
  // @ts-expect-error -- an unregistered name is not a Session event at all.
  session.appendIgnorable('random/unknown', {})

  // Registration narrows appendIgnorable only; normal append is unchanged.
  expectTypeOf(session.append('test/optional-fact', { value: 'v', revision: 1 }))
    .toEqualTypeOf<SessionEvent<'test/optional-fact'>>()
  // A known but unregistered event type is not part of the opt-in set at all.
  expectTypeOf<Extract<'turn/start', IgnorableSessionEventType>>().toEqualTypeOf<never>()
}
void typedSeamContracts

describe('typed ignorable append seam', () => {
  it('emits the ignorable marker and keeps the ordinary envelope fields', () => {
    const session = Session.create(id)

    const event = session.appendIgnorable('test/optional-fact', { value: 'first', revision: 1 })

    expect(event.type).toBe('test/optional-fact')
    expect(event.seq).toBe(SessionSeq(0))
    expect(typeof event.time).toBe('number')
    expect(event.data).toEqual({ value: 'first', revision: 1 })
    expect(event.ignorable).toBe(true)
    expect(Object.hasOwn(event, 'ignorable')).toBe(true)
    expect(Object.keys(event).sort()).toEqual(['data', 'ignorable', 'seq', 'time', 'type'])
  })

  it('freezes the logged payload and never keeps the caller input by reference', () => {
    const session = Session.create(id)
    const input = { value: 'mutable', revision: 1 }

    const event = session.appendIgnorable('test/optional-fact', input)
    input.value = 'mutated-after-append'

    expect(event.data).toEqual({ value: 'mutable', revision: 1 })
    expect(event.data).not.toBe(input)
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
  })

  it('rejects non-JSON payloads through the same validation as append, without growing the log', () => {
    const session = Session.create(id)

    expect(() => session.appendIgnorable('test/optional-fact', { value: 1n as unknown as string, revision: 1 }))
      .toThrow('carries non-JSON-serializable data')
    expect(session.snapshotEvents()).toEqual([])
    expect(session.seq).toBe(SessionSeq(0))
  })
  it('shares the single Session sequence authority with append and keeps log order', () => {
    const session = Session.create(id)

    const first = session.append('turn/start', { turn: 1 })
    const optional = session.appendIgnorable('test/optional-fact', { value: 'mid', revision: 2 })
    const last = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect([first.seq, optional.seq, last.seq]).toEqual([SessionSeq(0), SessionSeq(1), SessionSeq(2)])
    expect(session.seq).toBe(SessionSeq(3))
    expect(session.snapshotEvents()).toEqual([first, optional, last])
    expect(session.eventAt(SessionSeq(1))).toBe(optional)
    expect(session.eventAt(SessionSeq(1))?.ignorable).toBe(true)
    expect(session.isOwnSeq(SessionSeq(1))).toBe(true)
  })

  it('leaves normal append envelopes without an ignorable property', () => {
    const session = Session.create(id)

    const logOnly = session.append('turn/start', { turn: 1 })
    const surface = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    for (const event of [logOnly, surface]) expect(Object.hasOwn(event, 'ignorable')).toBe(false)
    expect(surface.surfaceOp).toBe('append')
    expect(session.surface.nodes).toEqual([surface.seq])
  })

  it('keeps surface intent behavior unchanged for source-citing events', () => {
    const session = Session.create(id)
    const head = session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('head', 'fixture'),
    }, { surfaceOp: 'append' })
    const next = session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('next', 'fixture'),
    }, { surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] })

    expect(next.surfaceOp).toEqual({ op: 'replace', startSeq: head.seq, endSeq: head.seq })
    expect(next.sourceEventSeqs).toEqual([head.seq])
    expect(Object.hasOwn(next, 'ignorable')).toBe(false)
    expect(session.surface.nodes).toEqual([next.seq])
  })

  it('publishes ignorable events to the same observers as append', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('ignorable-observer'))
    const heard: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { heard.push(event) })

    const appended = session.append('turn/start', { turn: 1 })
    const optional = session.appendIgnorable('test/optional-fact', { value: 'observed', revision: 3 })

    expect(heard).toEqual([appended, optional])
    expect(heard[1]?.ignorable).toBe(true)
  })

  it('contains a reentrant observer append identically for the ignorable path', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const session = ctx.sessions.create(SessionId('ignorable-reentrant'))
    const heard: SessionEvent[] = []
    ctx.on('session/event', (observedSession) => {
      observedSession.appendIgnorable('test/optional-fact', { value: 'reentrant', revision: 4 })
    })
    ctx.on('session/event', (_observedSession, event) => { heard.push(event) })

    const appended = session.appendIgnorable('test/optional-fact', { value: 'outer', revision: 5 })

    expect(session.snapshotEvents()).toEqual([appended])
    expect(heard).toEqual([appended])
    expect(warnings).toEqual([
      'session "ignorable-reentrant": session/event listener threw: Error: session append cannot reenter while another append is being published',
    ])
  })

  it('keeps the Session format version at 3', () => {
    expect(SESSION_FORMAT_VERSION).toBe(3)
    expect(Session.create(id).header.version).toBe(3)
  })
})
