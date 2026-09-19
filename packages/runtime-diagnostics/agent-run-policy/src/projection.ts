/**
 * The durable retry-budget projection.
 *
 * Stage 9 needs one number before it can decide anything: how many automatic
 * attempts this failed step has already consumed. That number is neither a
 * guess nor a process-local counter — it is folded from the durable
 * `llm/retry` events the existing executor already writes, which is exactly the
 * state-after-resume seam the Session design requires. Retry history is
 * therefore readable without a historical event scan and without adding a
 * second durable vocabulary for facts upstream already records.
 *
 * The fold is deliberately per step. `step/start` opens a fresh budget, because
 * a new step's first request is an initial attempt and not a continuation of
 * the step before it, and a retry re-runs the *same* step, so nothing in the
 * loop appends a second `step/start` for it.
 *
 * @module @deepseek-ai/dsh-agent-run-policy/projection
 */

import { z as zod } from 'zod'
import type { SessionLogOffset, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** The projection key this package owns. */
export const AGENT_RUN_RETRY_BUDGET_KEY = 'agentRunRetryBudget'

/**
 * One Session's automatic in-run retry budget for its current step.
 *
 * `turnOpen` is the durable answer to "is there a Run to retry inside"; `turn`
 * and `step` name which one, so a decision made for a stale step cannot retry
 * inside a step that has already closed.
 */
export interface BoundedRetryProjectionState {
  /** The turn the budget currently belongs to; `0` before any turn started. */
  readonly turn: number
  /** The step the budget currently belongs to; `0` before any step started. */
  readonly step: number
  /** Automatic retries already recorded for that turn and step. */
  readonly retries: number
  /** Whether that turn has no durable closer yet. */
  readonly turnOpen: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Automatic in-run retries already recorded for one Session's current step. */
    agentRunRetryBudget: BoundedRetryProjectionState
  }
}

const boundedRetryProjectionStateSchema: zod.ZodType<BoundedRetryProjectionState> = zod.object({
  turn: zod.number().int().nonnegative(),
  step: zod.number().int().nonnegative(),
  retries: zod.number().int().nonnegative(),
  turnOpen: zod.boolean(),
})

/** The empty budget: no turn, no step, no retry, nothing open. */
const EMPTY_BUDGET: BoundedRetryProjectionState = Object.freeze({
  turn: 0,
  step: 0,
  retries: 0,
  turnOpen: false,
})

/**
 * The `agentRunRetryBudget` unit.
 *
 * A unit uninterested in an event returns the same state reference, so the
 * registry does no downstream work for events this budget does not track.
 */
export const boundedRetryProjectionDefinition: ProjectionDefinition<
  typeof AGENT_RUN_RETRY_BUDGET_KEY,
  BoundedRetryProjectionState
> = {
  key: AGENT_RUN_RETRY_BUDGET_KEY,
  stateVersion: 1,
  stateSchema: boundedRetryProjectionStateSchema,
  init: (_header: SessionHeader, _inheritedEventCount: SessionLogOffset) => EMPTY_BUDGET,
  apply: (state: BoundedRetryProjectionState, event: SessionEvent): BoundedRetryProjectionState => {
    switch (event.type) {
      case 'turn/start':
        return { turn: event.data.turn, step: 0, retries: 0, turnOpen: true }
      case 'turn/end':
        // A closed turn is history. The budget keeps its counts so a late
        // reader can still explain them, but `turnOpen` is now false, which is
        // what stops a retry from being permitted inside it.
        return state.turnOpen ? { ...state, turnOpen: false } : state
      case 'step/start':
        return { turn: event.data.turn, step: event.data.step, retries: 0, turnOpen: true }
      case 'llm/retry': {
        const { turn, step } = event.data
        if (state.turn === turn && state.step === step) return { ...state, retries: state.retries + 1 }
        // A retry event for another step establishes that step's budget; the
        // executor only ever writes one for the step it is recovering.
        return { turn, step, retries: 1, turnOpen: state.turnOpen }
      }
      default:
        return state
    }
  },
}
