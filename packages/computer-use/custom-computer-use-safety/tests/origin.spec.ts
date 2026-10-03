/**
 * Admission refuses the desktop to a scheduled or externally-routed turn, so the
 * origin must come from the canonical vocabulary rather than a guess. These
 * tests drive the tracker through exactly the inputs the agent loop supplies:
 * admitted messages carrying a `source`, an external-route announcement, and the
 * session header of a delegated child.
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-schedule/src/runtime.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { TurnOrigin } from '../src/origin.ts'

/** A plain agent stand-in: the tracker reads only the session header origin. */
function agent(id: string, origin?: 'subagent'): Parameters<TurnOrigin['note']>[0] {
  return { id: SessionId(id), session: { header: origin === undefined ? {} : { origin } } }
}

/** One admitted message with the given durable source kind. */
function message(kind: string): UserMessage {
  return createUserMessage({ source: kind === 'schedule' ? { kind: 'schedule' } : { kind: 'user' }, content: [] })
}

describe('TurnOrigin defaults', () => {
  it('reports a foreground turn zero for a session it has never seen', () => {
    const origin = new TurnOrigin()
    expect(origin.kindOf('unknown')).toBe('external')
    expect(origin.turnOf('unknown')).toBe(0)
  })

  it('treats every non-schedule source as a foreground turn', () => {
    const origin = new TurnOrigin()
    for (const kind of ['user', 'tool', 'team-message', 'agent-instructions']) {
      const subject = agent(kind)
      origin.note(subject, [message(kind)], 1)
      expect(origin.kindOf(kind)).toBe('foreground')
    }
  })
})

describe('TurnOrigin classification', () => {
  it('classifies a scheduled delivery from the canonical message source', () => {
    const origin = new TurnOrigin()
    const subject = agent('scheduled')
    origin.note(subject, [message('schedule')], 1)

    expect(origin.kindOf('scheduled')).toBe('schedule')
    expect(origin.turnOf('scheduled')).toBe(1)
  })

  it('finds a scheduled message among unrelated admitted messages', () => {
    const origin = new TurnOrigin()
    origin.note(agent('mixed'), [message('user'), message('schedule'), message('tool')], 3)
    expect(origin.kindOf('mixed')).toBe('schedule')
  })

  it('classifies a delegated child from its own session header', () => {
    const origin = new TurnOrigin()
    origin.note(agent('child', 'subagent'), [message('user')], 1)
    expect(origin.kindOf('child')).toBe('subagent')
  })

  it('lets the subagent header outrank a scheduled payload and an external marker', () => {
    const origin = new TurnOrigin()
    const subject = agent('child', 'subagent')
    origin.markExternal(subject)

    origin.note(subject, [message('schedule')], 1)

    expect(origin.kindOf('child')).toBe('schedule')
  })

  it('classifies a turn that resolved an external executor', () => {
    const origin = new TurnOrigin()
    const subject = agent('codex')
    origin.markExternal(subject)
    origin.note(subject, [message('user')], 1)

    expect(origin.kindOf('codex')).toBe('external')
  })

  it('records the turn number alongside the kind', () => {
    const origin = new TurnOrigin()
    origin.note(agent('s'), [message('user')], 7)
    expect(origin.turnOf('s')).toBe(7)
  })
})

describe('TurnOrigin across turns and steps', () => {
  it('consumes a pending external marker exactly once', () => {
    const origin = new TurnOrigin()
    const subject = agent('codex')
    origin.markExternal(subject)

    origin.note(subject, [message('user')], 1)
    expect(origin.kindOf('codex')).toBe('external')

    // Restating the same turn cannot change it...
    origin.note(subject, [message('user')], 1)
    expect(origin.kindOf('codex')).toBe('external')

    // ...and the marker is gone, so the next turn is ordinary again.
    origin.note(subject, [message('user')], 2)
    expect(origin.kindOf('codex')).toBe('foreground')
    expect(origin.turnOf('codex')).toBe(2)
  })

  it('narrows a foreground turn to schedule when a scheduled message arrives later', () => {
    const origin = new TurnOrigin()
    const subject = agent('late')
    origin.note(subject, [message('user')], 1)
    expect(origin.kindOf('late')).toBe('foreground')

    origin.note(subject, [message('schedule')], 1)
    expect(origin.kindOf('late')).toBe('schedule')
  })

  it('never widens a restricted turn back to foreground', () => {
    const origin = new TurnOrigin()
    const subject = agent('scheduled')
    origin.note(subject, [message('schedule')], 1)
    origin.note(subject, [], 1)
    origin.note(subject, [message('user')], 1)

    expect(origin.kindOf('scheduled')).toBe('schedule')
  })

  it('does not carry a restriction into the next turn', () => {
    const origin = new TurnOrigin()
    const subject = agent('scheduled')
    origin.note(subject, [message('schedule')], 1)
    origin.note(subject, [message('user')], 2)

    expect(origin.kindOf('scheduled')).toBe('foreground')
    expect(origin.turnOf('scheduled')).toBe(2)
  })

  it('keeps sessions independent', () => {
    const origin = new TurnOrigin()
    origin.note(agent('a'), [message('schedule')], 1)
    origin.note(agent('b'), [message('user')], 1)

    expect(origin.kindOf('a')).toBe('schedule')
    expect(origin.kindOf('b')).toBe('foreground')
  })

  it('does not let one session consume another session external marker', () => {
    const origin = new TurnOrigin()
    origin.markExternal(agent('codex'))
    origin.note(agent('local'), [message('user')], 1)

    expect(origin.kindOf('local')).toBe('foreground')
    origin.note(agent('codex'), [message('user')], 1)
    expect(origin.kindOf('codex')).toBe('external')
  })
})

describe('TurnOrigin disposal', () => {
  it('drops the turn record and any pending external marker', () => {
    const origin = new TurnOrigin()
    const subject = agent('codex')
    origin.markExternal(subject)
    origin.note(subject, [message('user')], 1)

    origin.forget('codex')

    expect(origin.kindOf('codex')).toBe('external')
    expect(origin.turnOf('codex')).toBe(0)

    // A marker recorded before disposal must not leak into a later turn.
    origin.note(subject, [message('user')], 5)
    expect(origin.kindOf('codex')).toBe('foreground')
  })

  it('discards a marker recorded for a session that never opened a turn', () => {
    const origin = new TurnOrigin()
    const subject = agent('codex')
    origin.markExternal(subject)
    origin.forget('codex')

    origin.note(subject, [message('user')], 1)
    expect(origin.kindOf('codex')).toBe('foreground')
  })
})

it('revokes an existing Local turn immediately when an external executor resolves without a Local pre-step', () => {
  const origin = new TurnOrigin()
  const subject = agent('switch')
  origin.note(subject, [message('user')], 1)
  origin.markExternal(subject)
  expect(origin.kindOf('switch')).toBe('external')
})
