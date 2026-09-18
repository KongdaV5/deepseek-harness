/**
 * Durable run projection over normalized Stage 6 lifecycle facts.
 *
 * One logical Run is one durable upstream turn, so this fold needs no identity
 * heuristic: `turn/start` opens the only possible run for that turn, and
 * `turn/end` closes it forever. The projection is therefore a *pure function of
 * the fact set*, recomputed per call rather than carried forward, which is what
 * makes terminal monotonicity structural instead of defensive — a closed turn
 * simply has no representation as an active run.
 *
 * Two consequences are deliberate. A run that upstream closed by crash repair is
 * terminal, not running, because the durable log says so. And a pending retry
 * keeps the run active under the same identity, because a retry continues the
 * turn it belongs to rather than opening a new one.
 *
 * @module @deepseek-ai/dsh-agent-run-state/projection
 */

import type { LifecycleFacts, RetryChainFact, TurnLifecycleFact } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { runIdFor } from './brand.ts'
import { classifyRunError, clientCancelledError, providerErrorCode, selectPrimaryError } from './errors.ts'
import type { RankedRunError, RunErrorSelection } from './errors.ts'
import type { ClassifiedRunError, RunErrorCode, RunPhase, RunProjectionState, RunState, RunStepFact } from './types.ts'

/**
 * Largest value in a list, ignoring absent entries.
 * @param values - candidate timestamps, some possibly absent.
 * @param fallback - the result when no timestamp is present.
 * @returns the largest present value, or the fallback.
 */
function latest(values: readonly (number | undefined)[], fallback: number): number {
  let best = fallback
  for (const value of values) {
    if (value !== undefined && value > best) best = value
  }
  return best
}

/** The normalized phase one terminal reason produces. */
function terminalPhase(reason: TurnEndReason): RunPhase {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'cancelled'
    default:
      // `blocked`, `error`, `max-tokens`, `interrupted`, and any kind a plugin
      // merges in later all mean the turn did not complete normally.
      return 'failed'
  }
}

/** Categories a closed turn can prove without carrying a structured payload. */
const CLOSED_TURN_CODES: Readonly<Record<string, RunErrorCode>> = {
  blocked: 'BLOCKED',
  'max-tokens': 'MAX_TOKENS',
  interrupted: 'SESSION_INTERRUPTED',
}

/** Human-readable text for each of those categories. */
const CLOSED_TURN_MESSAGES: Readonly<Record<string, string>> = {
  blocked: 'The run was blocked before completing.',
  'max-tokens': 'The run reached its output token limit.',
  interrupted: 'The run was closed by after-the-fact crash repair.',
}

/** The classified error a terminal reason implies, if any. */
function terminalError(reason: TurnEndReason, time: number): RankedRunError | null {
  if (reason.kind === 'completed') return null
  // A recorded cancellation is a durable terminal fact, so it ranks with the
  // other turn/end facts. It cannot be fatal either way: the error is degraded.
  if (reason.kind === 'aborted') return { error: clientCancelledError(time), authority: 'terminal' }
  if (reason.kind === 'error') {
    return {
      error: classifyRunError({ origin: 'provider', error: reason.error, time, authority: 'terminal' }),
      authority: 'terminal',
    }
  }
  // The remaining kinds carry no structured payload, and a kind a later plugin
  // merges in reaches neither record: that is reported as `UNKNOWN` rather than
  // rounded to the nearest plausible category.
  return {
    error: {
      code: CLOSED_TURN_CODES[reason.kind] ?? 'UNKNOWN',
      message: CLOSED_TURN_MESSAGES[reason.kind] ?? 'The run ended for a reason this build does not classify.',
      severity: 'degraded',
      origin: 'session',
      time,
    },
    authority: 'terminal',
  }
}

/**
 * The retry evidence one turn accumulated.
 *
 * Every attempt is attached as execution-strength evidence, so a retry failure
 * competes on strength rather than on arrival order and can never displace a
 * durable terminal fact.
 * @param chains - the retry chains folded for this turn.
 * @param turn - the run's own turn number.
 * @returns the retry summary and the classified attempt evidence.
 */
function retryFacts(
  chains: readonly RetryChainFact[],
  turn: number,
): { retryCount: number; maxRetryCount?: number; retryReason?: RunErrorCode; errors: RankedRunError[]; times: number[] } {
  const errors: RankedRunError[] = []
  const times: number[] = []
  let retryCount = 0
  let maxRetryCount: number | undefined
  let retryReason: RunErrorCode | undefined
  for (const chain of chains) {
    if (chain.turn !== turn) continue
    for (const attempt of chain.attempts) {
      if (attempt.retry > retryCount) retryCount = attempt.retry
      if (attempt.maxRetries !== undefined) maxRetryCount = attempt.maxRetries
      retryReason = providerErrorCode(attempt.failureCode)
      times.push(attempt.scheduledTime)
      // The start transition is absent while a retry is still waiting.
      if (attempt.startedTime !== undefined) times.push(attempt.startedTime)
      // The durable fact keeps the provider-neutral code but not the surrounding
      // payload, so the code is also the only durable text the message can carry.
      errors.push({
        error: classifyRunError({
          origin: 'provider',
          error: { message: attempt.failureCode, code: attempt.failureCode },
          time: attempt.scheduledTime,
          authority: 'execution',
        }),
        authority: 'execution',
      })
    }
  }
  return {
    retryCount,
    ...maxRetryCount === undefined ? {} : { maxRetryCount },
    ...retryReason === undefined ? {} : { retryReason },
    errors,
    times,
  }
}

/** Whether the fold should report a pending retry wait for this turn. */
function awaitingRetry(chains: readonly RetryChainFact[], turn: number): boolean {
  for (const chain of chains) {
    if (chain.turn !== turn) continue
    const last = chain.attempts.at(-1)
    if (last !== undefined && last.startedSeq === undefined) return true
  }
  return false
}

/** Project one turn fact into its durable run state. */
function projectTurn(
  sessionId: SessionId,
  turn: TurnLifecycleFact,
  chains: readonly RetryChainFact[],
): RunState {
  const steps: RunStepFact[] = turn.steps.map(step => ({
    step: step.step,
    startSeq: step.startSeq,
    ...step.endSeq === undefined ? {} : { endSeq: step.endSeq },
    open: step.open,
  }))
  const retries = retryFacts(chains, turn.turn)
  const openStep = steps.findLast(step => step.open)?.step ?? null
  const lastStep = steps.at(-1)?.step ?? null
  const stepTimes = turn.steps.flatMap(step => [step.startTime, step.endTime])

  // A turn with no durable closer is live; the honest phase then depends only
  // on how far its durable boundaries got.
  const phase: RunPhase = turn.endSeq === undefined
    ? awaitingRetry(chains, turn.turn)
      ? 'waiting_retry'
      : steps.length > 0 ? 'executing' : 'starting'
    : turn.terminalReason === undefined ? 'failed' : terminalPhase(turn.terminalReason)

  // The durable close is the terminal fact's own time. A closed turn always
  // carries an `endTime`, so the turn start is only the honest fallback for a
  // fact set whose range supplied no close timestamp.
  const closedAt = latest([turn.endTime], turn.startTime)
  const terminal = turn.terminalReason === undefined ? null : terminalError(turn.terminalReason, closedAt)
  const selection: RunErrorSelection = selectPrimaryError([
    ...retries.errors,
    ...terminal === null ? [] : [terminal],
  ])
  const primaryError: ClassifiedRunError | undefined = selection.primaryError

  // Meaningful activity is progress inside the turn; the close itself is
  // activity but not progress, so a terminal run's `lastActivityAt` can exceed
  // its `lastMeaningfulActivityAt`.
  const lastMeaningfulActivityAt = latest([...stepTimes, ...retries.times], turn.startTime)

  return {
    sessionId,
    runId: runIdFor(sessionId, turn.turn),
    turn: turn.turn,
    phase,
    startedAt: turn.startTime,
    updatedAt: turn.endTime ?? lastMeaningfulActivityAt,
    ...turn.endTime === undefined ? {} : { completedAt: turn.endTime },
    lastActivityAt: latest([lastMeaningfulActivityAt, turn.endTime], lastMeaningfulActivityAt),
    lastMeaningfulActivityAt,
    ...turn.terminalReason === undefined ? {} : { terminalReason: turn.terminalReason },
    repairClosure: turn.repairClosure,
    steps,
    stepCount: steps.length,
    lastStep,
    openStep,
    retryCount: retries.retryCount,
    ...retries.maxRetryCount === undefined ? {} : { maxRetryCount: retries.maxRetryCount },
    ...retries.retryReason === undefined ? {} : { retryReason: retries.retryReason },
    ...primaryError === undefined ? {} : { primaryError },
    secondaryErrors: selection.secondaryErrors,
  }
}

/**
 * Derive the durable run projection from normalized lifecycle facts.
 *
 * `active` is the last turn only while that turn has no durable closer; every
 * closed turn contributes to `terminal` instead. A turn left open before a later
 * turn — which upstream cannot produce, because it appends `turn/end` before the
 * next `turn/start` — is reported as neither, rather than being invented as a
 * live run.
 * @param sessionId - the durable conversation identity that owns these facts.
 * @param facts - normalized lifecycle facts, folded from one event range in log order.
 * @returns the active run, if the log leaves a turn open, plus the last terminal run.
 */
export function projectRuns(sessionId: SessionId, facts: LifecycleFacts): RunProjectionState {
  let active: RunState | null = null
  let terminal: RunState | null = null
  const last = facts.turns.at(-1)
  for (const turn of facts.turns) {
    if (turn.endSeq === undefined) {
      if (turn === last) active = projectTurn(sessionId, turn, facts.retryChains)
      continue
    }
    terminal = projectTurn(sessionId, turn, facts.retryChains)
  }
  return { sessionId, active, terminal }
}

/**
 * Read the active run, if any.
 *
 * This is the selector Stage 11 depends on: it returns `null` whenever no
 * durable turn is open, so a consumer never renders a synthesized idle Run.
 * @param state - the durable run projection.
 * @returns the active run, or `null`.
 */
export function activeRun(state: RunProjectionState): RunState | null {
  return state.active
}

/**
 * Read the most recent terminal run, if any.
 *
 * A terminal run is history: reading it never implies current work.
 * @param state - the durable run projection.
 * @returns the last terminal run, or `null`.
 */
export function terminalRun(state: RunProjectionState): RunState | null {
  return state.terminal
}
