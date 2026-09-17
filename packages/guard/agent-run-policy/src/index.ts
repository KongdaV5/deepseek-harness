/**
 * Agent Run policy: progress-informed bounded retry and transient cancellation
 * acknowledgement over the Agent Run State observation service.
 *
 * @module @deepseek-ai/dsh-agent-run-policy
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import {
  RunControlObserverId,
  classifyRunError,
  type AgentRunDiagnostics,
  type CancellationObservation,
  type LocalRunControlObserver,
  type RunControlObservation,
  type RunErrorCode,
  type RunId,
} from '@deepseek-ai/dsh-agent-run-state'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  RetryDecision,
  RetryDecisionInput,
  RunPolicyClock,
  RunPolicyInternals,
} from './types.ts'

export type * from './types.ts'

export const name = 'agentRunPolicy'
export const inject = ['agentRunState']

/** Deployment-owned bounded retry and cancellation acknowledgement settings. */
export interface Config {
  /** Unique transient control-observer identity. */
  readonly observerId: string
  /** Exact provider routes governed by this policy. */
  readonly providers: string[]
  /** Maximum same-Run retries for eligible transient failures. */
  readonly maxRetryCount: number
  /** Time allowed for confirmed backend generation disappearance after cancellation. */
  readonly cancellationConfirmationMs: number
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  observerId: z.string().required(),
  providers: z.array(z.string()).required(),
  maxRetryCount: z.number().step(1).min(0).max(2).required(),
  cancellationConfirmationMs: z.number().step(1).min(1).required(),
}) as unknown as z<Config>

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'PROVIDER_UNAVAILABLE',
])

const NEVER_RETRY_CODES: ReadonlySet<RunErrorCode> = new Set([
  'RESOURCE_LIMIT',
  'WORKER_CRASH',
  'MODEL_LOAD_FAILED',
  'INVALID_MODEL_CONFIG',
  'INVALID_REASONING_PARAMETER',
  'CLIENT_CANCELLED',
  'CONTEXT_OVERFLOW',
  'GENERATION_STALLED',
])

const systemClock: RunPolicyClock = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return timer
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

function validateConfig(config: Config): void {
  if (config.observerId.trim().length === 0) throw new Error('agent-run-policy: observerId must not be blank')
  if (config.providers.length === 0 || config.providers.some(provider => provider.trim().length === 0)) {
    throw new Error('agent-run-policy: providers must contain at least one non-blank route')
  }
  if (new Set(config.providers).size !== config.providers.length) {
    throw new Error('agent-run-policy: providers must not contain duplicates')
  }
  if (!Number.isSafeInteger(config.maxRetryCount) || config.maxRetryCount < 0 || config.maxRetryCount > 2) {
    throw new Error('agent-run-policy: maxRetryCount must be a safe integer from 0 through 2')
  }
  if (!Number.isSafeInteger(config.cancellationConfirmationMs) || config.cancellationConfirmationMs < 1) {
    throw new Error('agent-run-policy: cancellationConfirmationMs must be a positive safe integer')
  }
}

/**
 * Decide whether the existing retry executor may handle one failed attempt.
 * Fatal/component evidence, cancellation, permanent request errors, and an
 * exhausted local budget deny delegation before provider policy is consulted.
 * @param input - current failure, Run State diagnostics, signal, and local budget.
 * @returns a stable decision and diagnostic reason.
 */
export function decideRunRetry(input: RetryDecisionInput): RetryDecision {
  const classified = classifyRunError({ origin: 'provider', error: input.failure, time: input.run.updatedAt })
  if (input.signalAborted) return { kind: 'deny', reason: 'CLIENT_CANCELLED' }
  if (input.run.health === 'fatal'
    || input.run.backend.processHealth === 'fatal'
    || input.run.backend.modelHealth === 'fatal'
    || input.run.backend.generationHealth === 'fatal'
    || input.run.primaryError?.severity === 'fatal') {
    return { kind: 'deny', reason: input.run.primaryError?.code ?? classified.code }
  }
  if (NEVER_RETRY_CODES.has(classified.code)) return { kind: 'deny', reason: classified.code }
  if (input.retryCount >= input.maxRetryCount) return { kind: 'deny', reason: classified.code }
  if (TRANSIENT_CODES.has(input.failure.code.toUpperCase())) {
    return { kind: 'delegate', reason: classified.code }
  }
  return { kind: 'deny', reason: classified.code }
}

class ControlObserver implements LocalRunControlObserver {
  readonly id: RunControlObserverId
  private readonly listeners = new Set<(observation: RunControlObservation) => void>()
  private readonly state = new Map<RunId, Omit<RunControlObservation, 'observerId' | 'runId' | 'observedAt'>>()

  constructor(id: string) {
    this.id = RunControlObserverId(id)
  }

  subscribe(listener: (observation: RunControlObservation) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  update(
    runId: RunId,
    observedAt: number,
    patch: Omit<RunControlObservation, 'observerId' | 'runId' | 'observedAt'>,
  ): void {
    const complete = { ...this.state.get(runId), ...patch }
    this.state.set(runId, complete)
    const observation = { observerId: this.id, runId, observedAt, ...complete }
    for (const listener of this.listeners) listener(observation)
  }

  snapshot(runId: RunId): Omit<RunControlObservation, 'observerId' | 'runId' | 'observedAt'> | undefined {
    return this.state.get(runId)
  }

  clear(): void {
    this.listeners.clear()
    this.state.clear()
  }
}

interface CancellationMonitor {
  readonly runId: RunId
  readonly session: Session
  readonly disposeDiagnostics: () => void
  timer?: unknown
}

function confirmedStopped(diagnostics: AgentRunDiagnostics): boolean {
  return diagnostics.run?.backend.generationActivity?.state === 'inactive'
    && diagnostics.run.backend.generationActivity.confidence === 'confirmed'
}

/** Install progress-aware retry governance and cancellation acknowledgement. */
export function apply(
  ctx: Context,
  config: Config,
  internals: RunPolicyInternals = {},
): void {
  validateConfig(config)
  const clock = internals.clock ?? systemClock
  const governedProviders = new Set(config.providers)
  const observer = new ControlObserver(config.observerId)
  const monitors = new Map<Session, CancellationMonitor>()
  const watchedSignals = new WeakSet<AbortSignal>()
  // A request waterfall can retain this listener while Cordis unloads its
  // owner. Every asynchronous observation therefore shares one fiber-owned
  // cancellation boundary and is drained before `agentRunState` can unload.
  const lifetime = new AbortController()
  const active = new Set<Promise<void>>()
  ctx.agentRunState.registerControlObserver(observer)

  function track(operation: Promise<void>): void {
    const tracked = operation.finally(() => { active.delete(tracked) })
    active.add(tracked)
  }

  function clearMonitor(session: Session): void {
    const monitor = monitors.get(session)
    if (monitor === undefined) return
    if (monitor.timer !== undefined) clock.clearTimeout(monitor.timer)
    monitor.disposeDiagnostics()
    monitors.delete(session)
  }

  function publishCancellation(
    monitor: CancellationMonitor,
    cancellation: CancellationObservation,
  ): void {
    observer.update(monitor.runId, clock.now(), { cancellation })
  }

  function confirmIfStopped(monitor: CancellationMonitor, diagnostics: AgentRunDiagnostics): void {
    const cancellation = observer.snapshot(monitor.runId)?.cancellation
    if (cancellation === undefined || cancellation.status === 'confirmed' || !confirmedStopped(diagnostics)) return
    if (monitor.timer !== undefined) clock.clearTimeout(monitor.timer)
    monitor.timer = undefined
    publishCancellation(monitor, {
      status: 'confirmed',
      requestedAt: cancellation.requestedAt,
      resolvedAt: clock.now(),
    })
  }

  function monitorFor(agent: Agent, runId: RunId): CancellationMonitor {
    const existing = monitors.get(agent.session)
    if (existing?.runId === runId) return existing
    clearMonitor(agent.session)
    const monitor: CancellationMonitor = {
      runId,
      session: agent.session,
      disposeDiagnostics: () => { disposeDiagnostics() },
    }
    const disposeDiagnostics = ctx.agentRunState.subscribe(agent.session, (diagnostics) => {
      confirmIfStopped(monitor, diagnostics)
    })
    monitors.set(agent.session, monitor)
    return monitor
  }

  function cancellationRequested(agent: Agent): void {
    if (lifetime.signal.aborted) return
    const diagnostics = ctx.agentRunState.diagnostics(agent.session, clock.now())
    const run = diagnostics.run
    if (run === null) return
    const monitor = monitorFor(agent, run.runId)
    const requestedAt = clock.now()
    publishCancellation(monitor, { status: 'requested', requestedAt })
    confirmIfStopped(monitor, ctx.agentRunState.diagnostics(agent.session, requestedAt))
    if (observer.snapshot(run.runId)?.cancellation?.status === 'confirmed') return
    monitor.timer = clock.setTimeout(() => {
      publishCancellation(monitor, {
        status: 'unconfirmed',
        requestedAt,
        resolvedAt: clock.now(),
      })
    }, config.cancellationConfirmationMs)
    track(ctx.agentRunState.probe(agent.session).then(() => {
      if (lifetime.signal.aborted) return
      confirmIfStopped(monitor, ctx.agentRunState.diagnostics(agent.session, clock.now()))
    }))
  }

  const disposeRequest = ctx.on('agent/request', ({ agent, signal }, next) => {
    if (lifetime.signal.aborted) return next()
    const run = ctx.agentRunState.diagnostics(agent.session, clock.now()).run
    if (run !== null) monitorFor(agent, run.runId)
    if (!watchedSignals.has(signal)) {
      watchedSignals.add(signal)
      const onAbort = (): void => { cancellationRequested(agent) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return next()
  })

  const disposeRequestError = ctx.on('agent/request-error', async (
    payload: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ) => {
    if (lifetime.signal.aborted) return undefined
    if (!governedProviders.has(payload.provider)) return next()
    await ctx.agentRunState.probe(payload.agent.session)
    if (lifetime.signal.aborted) return undefined
    const diagnostics = ctx.agentRunState.diagnostics(payload.agent.session, clock.now())
    const run = diagnostics.run
    if (run === null || run.turn !== payload.turn) return undefined
    const decision = decideRunRetry({
      failure: payload.failure,
      retryCount: run.retryCount,
      maxRetryCount: config.maxRetryCount,
      signalAborted: payload.signal.aborted,
      run,
    })
    observer.update(run.runId, clock.now(), {
      retry: { maxRetryCount: config.maxRetryCount, reason: decision.reason },
    })
    return decision.kind === 'delegate' ? next() : undefined
  }, { prepend: true })

  const disposeSession = ctx.on('session/disposed', (session) => { clearMonitor(session) })
  ctx.effect(() => async () => {
    disposeRequest()
    disposeRequestError()
    disposeSession()
    lifetime.abort(new Error('agent-run-policy plugin disposed'))
    for (const session of [...monitors.keys()]) clearMonitor(session)
    observer.clear()
    await Promise.allSettled([...active])
  }, 'agent-run-policy: abort and drain transient observations')
}
