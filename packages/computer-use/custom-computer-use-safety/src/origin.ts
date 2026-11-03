/**
 * Turn-origin tracking: which kind of turn is currently running in each session.
 *
 * V1 admits Computer Use in a foreground Local turn only, so admission must know
 * how the open turn was started. The origin comes from the canonical vocabulary
 * rather than a guess: a scheduled occurrence arrives as a durable user message
 * whose `source.kind` is `schedule`, an external route announces itself through
 * the `agent/resolve-external-turn` waterfall, and a delegated child reports
 * itself in its own session header. Nothing here reads a task name, a UI state,
 * or a clock.
 *
 * @module @deepseek-ai/dsh-custom-computer-use-safety/origin
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { DesktopTurnKind } from './lease.ts'

/** One session's currently open turn. */
interface TurnRecord {
  /** The open turn number. */
  turn: number
  /** How that turn started. */
  kind: DesktopTurnKind
}

/** Per-session turn origin, rebuilt from live events and discarded with the Host. */
export class TurnOrigin {
  private readonly turns = new Map<string, TurnRecord>()
  private readonly pendingExternal = new Set<string>()

  /**
   * Record the messages admitted into a step, resetting on a new turn.
   *
   * The first step of a turn decides the origin; a later step may only narrow a
   * foreground turn to `schedule`, never widen a restricted turn back.
   * @param agent - the turn's agent.
   * @param messages - messages removed from the inbox for this step.
   * @param turn - the turn that owns the step.
   */
  note(agent: Pick<Agent, 'id'> & { session: { header: { origin?: 'subagent' } } }, messages: readonly UserMessage[], turn: number): void {
    const sessionId = String(agent.id)
    const scheduled = messages.some(message => isScheduled(message))
    const current = this.turns.get(sessionId)
    if (current === undefined || current.turn !== turn) {
      const external = this.pendingExternal.delete(sessionId)
      const subagent = agent.session.header.origin === 'subagent'
      this.turns.set(sessionId, {
        turn,
        kind: scheduled ? 'schedule' : external ? 'external' : subagent ? 'subagent' : 'foreground',
      })
      return
    }
    if (scheduled && current.kind === 'foreground') current.kind = 'schedule'
  }

  /**
   * Record that the next turn of this session resolved an external executor.
   * Foreign loops own their own tools, so such a turn may never hold the desktop.
   * @param agent - the agent whose turn is being resolved.
   */
  markExternal(agent: Pick<Agent, 'id'>): void {
    const id = String(agent.id)
    this.pendingExternal.add(id)
    const current = this.turns.get(id)
    if (current !== undefined) current.kind = 'external'
  }

  /**
   * How the session's current turn started.
   * @param sessionId - session identity.
   * @returns the recorded kind, or `external` (fail closed) for a session with no open turn.
   */
  kindOf(sessionId: string): DesktopTurnKind {
    return this.turns.get(sessionId)?.kind ?? 'external'
  }

  /**
   * The session's current turn number.
   * @param sessionId - session identity.
   * @returns the open turn number, or `0` for a session with no open turn.
   */
  turnOf(sessionId: string): number {
    return this.turns.get(sessionId)?.turn ?? 0
  }

  /**
   * Drop one session's records, so a closed session cannot leak a pending
   * external marker into a later turn.
   * @param sessionId - session identity.
   */
  forget(sessionId: string): void {
    this.turns.delete(sessionId)
    this.pendingExternal.delete(sessionId)
  }
}

/** Whether one admitted message was delivered by the Schedule service. */
function isScheduled(message: UserMessage): boolean {
  // The source union is merge-extensible, so the schedule variant only exists in
  // a compilation that also loads the Schedule service. Widening to `string`
  // keeps this comparison total without asserting a shape.
  const kind: string = message.source.kind
  return kind === 'schedule'
}
