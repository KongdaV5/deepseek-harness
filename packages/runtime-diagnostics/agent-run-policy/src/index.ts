/**
 * Bounded in-run retry policy for the current upstream.
 *
 * The current source already owns model-request retry: `dsh-llm-retry` recovers
 * failures on the agent loop's `agent/request-error` waterfall, the provider
 * adapter owns the `retryPolicy`, and each scheduled retry is durable before
 * its wait. Stage 9 does not replace one line of that. It installs one
 * outermost waterfall listener that decides *whether the executor may proceed*
 * — nothing else. When it delegates, the executor still applies its own code
 * eligibility, its own budget, its own backoff, its own retry identity, and its
 * own durable events.
 *
 * Three constraints compose over the executor:
 *
 * - **A hard ceiling.** This policy permits at most
 *   {@link MAX_AUTOMATIC_RETRIES} retries after the initial attempt, so no
 *   provider configuration — including an `always` policy that declares no
 *   limit of its own — can produce a longer automatic chain.
 * - **A no-retry category set.** Cancellation, a fatal category, a blocked run,
 *   a context overflow Stage 10 owns, a reached max-token limit, an invalid
 *   reasoning or model configuration, a tool-semantics failure, a stalled
 *   generation, a Session interruption that needs guarded resume, and a failed
 *   retry chain are denied even when the provider's own policy would retry
 *   them.
 * - **Fail-closed classification.** Retryability comes from the captured
 *   provider policy and the Stage 7 category, never from message text, and a
 *   failure no current contract names is denied rather than assumed transient.
 *
 * A retry stays inside the same Session, turn, `RunId`, and step. This plugin
 * advances no checkpoint, opens no Run, records no resume, and adds no Session
 * event type: the retry facts it reads are the ones upstream already writes.
 *
 * @module @deepseek-ai/dsh-agent-run-policy
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { decideBoundedRetry } from './policy.ts'
import {
  AGENT_RUN_RETRY_BUDGET_KEY,
  boundedRetryProjectionDefinition,
  type BoundedRetryProjectionState,
} from './projection.ts'
import { MAX_AUTOMATIC_RETRIES } from './types.ts'
import type { RetryDecision } from './types.ts'

export { MAX_AUTOMATIC_ATTEMPTS, MAX_AUTOMATIC_RETRIES } from './types.ts'
export type * from './types.ts'
export { decideBoundedRetry } from './policy.ts'
export {
  AGENT_RUN_RETRY_BUDGET_KEY,
  boundedRetryProjectionDefinition,
} from './projection.ts'
export type { BoundedRetryProjectionState } from './projection.ts'

export const name = 'agentRunPolicy'
/** The durable retry budget is folded through the projection registry. */
export const inject = ['sessionProjections']

/** Deployment-owned ceiling on automatic in-run retries. */
export interface Config {
  /**
   * Maximum automatic retries after the initial attempt. `0` disables automatic
   * in-run retry entirely. Never above {@link MAX_AUTOMATIC_RETRIES}: the
   * ceiling is a product invariant, not a tunable.
   */
  readonly maxRetryCount?: number
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  maxRetryCount: z.number().step(1).min(0).max(MAX_AUTOMATIC_RETRIES).default(MAX_AUTOMATIC_RETRIES),
}) as unknown as z<Config>

/**
 * Read the automatic retries already recorded for one exact turn and step.
 *
 * @param state - the projected budget, or `undefined` when the unit is absent.
 * @param turn - the turn the failed step belongs to.
 * @param step - the step the failed step is.
 * @returns the recorded retry count, or `0` when the budget names another step.
 */
export function retryCountFor(
  state: BoundedRetryProjectionState | undefined,
  turn: number,
  step: number,
): number {
  if (state === undefined || state.turn !== turn || state.step !== step) return 0
  return state.retries
}

/** Validate one deployment configuration before any listener is installed. */
function validateConfig(config: Config): number {
  const maxRetryCount = config.maxRetryCount ?? MAX_AUTOMATIC_RETRIES
  if (!Number.isSafeInteger(maxRetryCount) || maxRetryCount < 0 || maxRetryCount > MAX_AUTOMATIC_RETRIES) {
    throw new Error(
      `agent-run-policy: maxRetryCount must be a safe integer from 0 through ${MAX_AUTOMATIC_RETRIES}`,
    )
  }
  return maxRetryCount
}

/**
 * Install bounded in-run retry governance over the existing retry executor.
 *
 * @param ctx - plugin context that owns the listener and the projection unit.
 * @param config - deployment-owned ceiling; omission allows the product maximum.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxRetryCount = validateConfig(config)
  const lifetime = new AbortController()
  // The registration is an effect on this fiber: unloading the plugin removes
  // the unit, and a caller that then reads the key sees capability absence
  // rather than a stale budget.
  ctx.effect(() => ctx.sessionProjections.register(boundedRetryProjectionDefinition), 'agent-run-policy: register retry budget')

  /**
   * Decide one failed attempt. Everything here is synchronous policy: the
   * budget is already folded, the failure already carries its structured code,
   * and the run's openness is already a durable fact. Only the delegated
   * decision is asynchronous, and it is the executor's.
   */
  function decide(
    payload: Parameters<Events['agent/request-error']>[0],
    session: Session,
  ): RetryDecision {
    const state = ctx.sessionProjections.stateOf(session, AGENT_RUN_RETRY_BUDGET_KEY)
    return decideBoundedRetry({
      failure: payload.failure,
      retryPolicy: payload.retryPolicy,
      retryCount: retryCountFor(state, payload.turn, payload.step),
      maxRetryCount,
      signalAborted: payload.signal.aborted,
      runOpen: (state?.turnOpen ?? false)
        && state?.turn === payload.turn
        && state.step === payload.step,
      time: Date.now(),
    })
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    // A waterfall may hold this callback after its registration was removed.
    // A disposed policy must not decide, and must not let a stale callback
    // reach the executor.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    const decision = decide(payload, payload.agent.session)
    if (decision.kind === 'delegate') return next()
    if (decision.reason !== 'NO_STRUCTURED_RETRYABILITY') {
      ctx.logger.debug(
        `agent-run-policy: denied automatic retry for turn ${payload.turn} step ${payload.step} `
        + `(${decision.category}, ${decision.reason}, ${decision.retryCount}/${decision.maxRetryCount})`,
      )
    }
    return Promise.resolve<RequestErrorAction>(undefined)
  }, { prepend: true })

  ctx.effect(() => () => {
    disposeListener()
    lifetime.abort(new Error('agent-run-policy plugin disposed'))
  }, 'agent-run-policy: abort and drain the retry decision listener')
}
