/**
 * Agent run-state Service: durable event projection plus transient stream and
 * replaceable backend-observer overlays. It observes only; it never retries,
 * restarts, cancels, resumes, or changes model policy.
 *
 * @module @deepseek-ai/dsh-agent-run-state
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { attemptIdFor, runIdFor } from './brand.ts'
import { classifyRunError } from './errors.ts'
import { classifyRunHealth } from './health.ts'
import { agentRunStateProjectionDefinition } from './projection.ts'
import type {
  AgentRunDiagnostics,
  AgentRunState,
  AttemptId,
  BackendObservation,
  ClassifiedRunError,
  LocalBackendObserver,
  LocalRunDiagnosticsObserver,
  LocalRunControlObserver,
  RunDiagnosticsObservation,
  RunControlObservation,
  RunId,
  RunPhase,
} from './types.ts'

export * from './brand.ts'
export * from './errors.ts'
export * from './health.ts'
export * from './view.ts'
export { agentRunStateProjectionDefinition, agentRunStateSchema, applyAgentRunEvent } from './projection.ts'
export type * from './types.ts'

/** Deployment-owned elapsed-time thresholds. */
export interface Config {
  /** Run age after which continuing activity is classified as slow. */
  readonly slowAfterMs: number
  /** Inactivity duration after which an active run is classified as stalled. */
  readonly stalledAfterMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRunState: AgentRunStateService
  }
}

interface StreamOverlay {
  readonly phase: RunPhase
  readonly lastActivityAt: number
}

interface BackendRegistration {
  readonly observer: LocalBackendObserver
  readonly dispose: () => void
}

interface ControlOverlay {
  readonly owner: string
  readonly observation: RunControlObservation
}

interface DiagnosticsOverlay {
  readonly owner: string
  readonly observation: RunDiagnosticsObservation
}

/** Listener for one Session's activity-driven diagnostic changes. */
export type DiagnosticsListener = (diagnostics: AgentRunDiagnostics) => void

function isTerminal(phase: RunPhase): boolean {
  return phase === 'completed' || phase === 'cancelled' || phase === 'failed'
}

function maxActivity(baseline: number, ...values: readonly (number | undefined)[]): number {
  return Math.max(baseline, ...values.filter((value): value is number => value !== undefined))
}

function streamPhase(frame: Extract<AssistantStreamFrame, { type: 'chunk' }>): RunPhase | undefined {
  switch (frame.chunk.type) {
    case 'reasoning-delta': return frame.chunk.text.length > 0 ? 'reasoning' : undefined
    case 'text-delta': return frame.chunk.text.length > 0 ? 'generating' : undefined
    case 'tool-call-delta':
      return (frame.chunk.name?.length ?? 0) > 0 || frame.chunk.argumentsDelta.length > 0 ? 'generating' : undefined
    default: return undefined
  }
}

function backendPhase(observation: BackendObservation): RunPhase | undefined {
  if (observation.activity === 'generation') return 'generating'
  if (observation.prefill !== undefined || observation.activity === 'prefill') return 'prefill'
  if (observation.activity === 'model-loading') return 'starting'
  return undefined
}

function orderedErrors(
  state: AgentRunState,
  transient: readonly ClassifiedRunError[],
): Pick<AgentRunState, 'primaryError' | 'secondaryErrors'> {
  const all = [
    ...state.primaryError === undefined ? [] : [state.primaryError],
    ...state.secondaryErrors,
    ...transient,
  ].sort((a, b) => a.time - b.time)
  const [primaryError, ...secondaryErrors] = all
  if (primaryError === undefined) return { secondaryErrors: [] }
  return { primaryError, secondaryErrors }
}

/** Read-only projection and observer registry for run diagnostics. */
export class AgentRunStateService extends Service {
  static inject = ['sessionProjections']
  static Config: Schema<Config> = z.object({
    slowAfterMs: z.number().step(1).min(1).required(),
    stalledAfterMs: z.number().step(1).min(1).required(),
  })

  private readonly slowAfterMs: number
  private readonly stalledAfterMs: number
  private readonly runSessions = new Map<RunId, Session>()
  private readonly attemptRuns = new Map<AttemptId, RunId>()
  private readonly llmAttempts = new Map<LlmAttemptId, { attemptId: AttemptId; runId: RunId }>()
  private readonly stream = new Map<RunId, StreamOverlay>()
  private readonly backend = new Map<RunId, BackendObservation>()
  private readonly transientErrors = new Map<RunId, ClassifiedRunError[]>()
  private readonly unattributed = new Map<string, BackendObservation>()
  private readonly observers = new Map<string, BackendRegistration>()
  private readonly controlObservers = new Map<string, () => void>()
  private readonly control = new Map<RunId, ControlOverlay>()
  private readonly diagnosticsObservers = new Map<string, () => void>()
  private readonly diagnosticsOverlays = new Map<RunId, DiagnosticsOverlay[]>()
  private readonly listeners = new Map<Session, Set<DiagnosticsListener>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentRunState')
    const rawConfig: unknown = config
    if (rawConfig === null || typeof rawConfig !== 'object') {
      throw new Error('agent-run-state: configuration is required')
    }
    if (!Number.isSafeInteger(config.slowAfterMs) || config.slowAfterMs < 1) {
      throw new Error('agent-run-state: slowAfterMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(config.stalledAfterMs) || config.stalledAfterMs <= config.slowAfterMs) {
      throw new Error('agent-run-state: stalledAfterMs must be a safe integer greater than slowAfterMs')
    }
    this.slowAfterMs = config.slowAfterMs
    this.stalledAfterMs = config.stalledAfterMs

    ctx.sessionProjections.register(agentRunStateProjectionDefinition)
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        this.forgetSession(session)
        const runId = runIdFor(session.header.id, event.data.turn)
        this.runSessions.set(runId, session)
      }
      this.notify(session, event.time)
    })
    ctx.on('session/disposed', (session) => { this.forgetSession(session) })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => { this.onAssistantStream(agent, frame) })
    ctx.on('agent/error', ({ agent, error }) => {
      const state = this.projected(agent.session)
      if (state === null) return
      const classified = classifyRunError({ origin: 'transport', error, time: Date.now() })
      const errors = this.transientErrors.get(state.runId) ?? []
      this.transientErrors.set(state.runId, [...errors, classified])
      this.notify(agent.session)
    })
    ctx.effect(() => () => {
      for (const registration of this.observers.values()) registration.dispose()
      for (const dispose of this.controlObservers.values()) dispose()
      for (const dispose of this.diagnosticsObservers.values()) dispose()
      this.observers.clear()
      this.controlObservers.clear()
      this.diagnosticsObservers.clear()
      this.runSessions.clear()
      this.attemptRuns.clear()
      this.llmAttempts.clear()
      this.stream.clear()
      this.backend.clear()
      this.transientErrors.clear()
      this.unattributed.clear()
      this.control.clear()
      this.diagnosticsOverlays.clear()
      this.listeners.clear()
    }, 'agentRunState lifecycle')
  }

  /**
   * Register one replaceable backend observer. Duplicate ids fail loud.
   * @param observer - backend-neutral observation provider.
   * @returns idempotent disposer that unsubscribes and releases its identity.
   */
  registerObserver(observer: LocalBackendObserver): () => void {
    const key = String(observer.id)
    if (this.observers.has(key)) throw new Error(`agent-run-state: observer ${JSON.stringify(key)} is already registered`)
    const unsubscribe = observer.subscribe((observation) => { this.onBackendObservation(observer, observation) })
    let active = true
    const dispose = () => {
      if (!active) return
      active = false
      unsubscribe()
      this.observers.delete(key)
      this.unattributed.delete(key)
    }
    this.observers.set(key, { observer, dispose })
    this.ctx.effect(() => { return dispose }, `agentRunState observer ${key}`)
    return dispose
  }

  /**
   * Register one policy-fact observer. Duplicate ids fail loud.
   * @param observer - run-control observation provider.
   * @returns idempotent disposer that removes its transient overlays.
   */
  registerControlObserver(observer: LocalRunControlObserver): () => void {
    const key = String(observer.id)
    if (this.controlObservers.has(key)) {
      throw new Error(`agent-run-state: control observer ${JSON.stringify(key)} is already registered`)
    }
    const unsubscribe = observer.subscribe((observation) => { this.onControlObservation(observer, observation) })
    let active = true
    const dispose = () => {
      if (!active) return
      active = false
      unsubscribe()
      this.controlObservers.delete(key)
      for (const [runId, overlay] of this.control) {
        if (overlay.owner === key) this.control.delete(runId)
      }
    }
    this.controlObservers.set(key, dispose)
    this.ctx.effect(() => dispose, `agentRunState control observer ${key}`)
    return dispose
  }

  /**
   * Register an external read-only diagnostics overlay. The overlay is merged
   * only into current diagnostics; it is never durable Run State and cannot
   * alter terminal lifecycle, health, retry, or cancellation facts.
   * @param observer - provider of one Run-correlated diagnostic fact stream.
   * @returns idempotent disposer that removes this observer's transient facts.
   */
  registerDiagnosticsObserver(observer: LocalRunDiagnosticsObserver): () => void {
    const key = String(observer.id)
    if (this.diagnosticsObservers.has(key)) {
      throw new Error(`agent-run-state: diagnostics observer ${JSON.stringify(key)} is already registered`)
    }
    const unsubscribe = observer.subscribe((observation) => { this.onDiagnosticsObservation(observer, observation) })
    let active = true
    const dispose = () => {
      if (!active) return
      active = false
      unsubscribe()
      this.diagnosticsObservers.delete(key)
      for (const [runId, overlays] of this.diagnosticsOverlays) {
        const remaining = overlays.filter(overlay => overlay.owner !== key)
        if (remaining.length === 0) this.diagnosticsOverlays.delete(runId)
        else this.diagnosticsOverlays.set(runId, remaining)
      }
    }
    this.diagnosticsObservers.set(key, dispose)
    this.ctx.effect(() => dispose, `agentRunState diagnostics observer ${key}`)
    return dispose
  }

  /**
   * Ask every registered backend observer to refresh immediately available evidence.
   * Observer failures are logged and do not fabricate health or activity.
   * @param session - Session whose policy decision is waiting for current evidence.
   */
  async probe(session: Session): Promise<void> {
    const results = await Promise.allSettled(
      [...this.observers.values()].map(registration => Promise.resolve(registration.observer.probe?.())),
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        this.ctx.logger.warn('agent-run-state: backend observer probe failed: %o', result.reason)
      }
    }
    this.notify(session)
  }

  /**
   * Read a detached current diagnostic snapshot without mutating run state.
   * @param session - Session whose latest run is read.
   * @param now - timestamp used only for elapsed health classification.
   * @returns durable Run State merged with attributed transient observations.
   */
  diagnostics(session: Session, now: number = Date.now()): AgentRunDiagnostics {
    const projected = this.projected(session)
    if (projected === null) {
      return structuredClone({
        run: null,
        staleThresholdMs: this.stalledAfterMs,
        unattributedBackendObservations: [...this.unattributed.values()],
      })
    }
    this.runSessions.set(projected.runId, session)
    const stream = this.stream.get(projected.runId)
    const backend = this.backend.get(projected.runId)
    const transientErrors = this.transientErrors.get(projected.runId) ?? []
    const control = this.control.get(projected.runId)?.observation
    const overlays = this.diagnosticsOverlays.get(projected.runId) ?? []
    const diagnosticOverlay = overlays
      .slice()
      .sort((left, right) => left.observation.observedAt - right.observation.observedAt)
      .reduce<Pick<RunDiagnosticsObservation, 'reasoning' | 'context'>>((merged, overlay) => ({
        ...merged,
        ...overlay.observation.reasoning === undefined
          ? {}
          : { reasoning: { ...merged.reasoning, ...overlay.observation.reasoning } },
        ...overlay.observation.context === undefined
          ? {}
          : { context: { ...merged.context, ...overlay.observation.context } },
      }), {})
    const errors = orderedErrors(projected, transientErrors)
    const phase = isTerminal(projected.phase)
      ? projected.phase
      : stream?.phase ?? (backend === undefined ? projected.phase : backendPhase(backend) ?? projected.phase)
    const lastBackendActivityAt = backend?.lastActivityAt
    const lastActivityAt = maxActivity(projected.lastActivityAt, stream?.lastActivityAt, lastBackendActivityAt)
    const lastMeaningfulActivityAt = maxActivity(
      projected.lastMeaningfulActivityAt,
      stream?.lastActivityAt,
      lastBackendActivityAt,
    )
    const candidate: AgentRunState = {
      ...projected,
      ...errors,
      phase,
      lastActivityAt,
      lastMeaningfulActivityAt,
      ...control?.retry === undefined
        ? {}
        : { maxRetryCount: control.retry.maxRetryCount, retryReason: control.retry.reason },
      ...control?.cancellation === undefined ? {} : { cancellation: control.cancellation },
      ...lastBackendActivityAt === undefined ? {} : { lastBackendActivityAt },
      reasoning: { ...projected.reasoning, ...diagnosticOverlay.reasoning },
      context: { ...projected.context, ...diagnosticOverlay.context },
      backend: backend === undefined
        ? projected.backend
        : {
          attribution: backend.attribution,
          processHealth: backend.processHealth,
          modelHealth: backend.modelHealth,
          generationHealth: backend.generationHealth,
          ...backend.generationActivity === undefined ? {} : { generationActivity: backend.generationActivity },
          ...backend.prefill === undefined ? {} : { prefill: backend.prefill },
        },
      health: 'unknown',
    }
    const health = classifyRunHealth({
      now,
      phase: candidate.phase,
      startedAt: candidate.startedAt,
      lastMeaningfulActivityAt: candidate.lastMeaningfulActivityAt,
      processHealth: candidate.backend.processHealth,
      modelHealth: candidate.backend.modelHealth,
      generationHealth: candidate.backend.generationHealth,
      ...candidate.primaryError === undefined ? {} : { primaryError: candidate.primaryError },
      slowAfterMs: this.slowAfterMs,
      stalledAfterMs: this.stalledAfterMs,
    })
    const cancellationDegraded = candidate.cancellation?.status === 'unconfirmed' && health !== 'fatal'
    const merged: AgentRunState = { ...candidate, health: cancellationDegraded ? 'degraded' : health }
    return structuredClone({
      run: merged,
      staleThresholdMs: this.stalledAfterMs,
      unattributedBackendObservations: [...this.unattributed.values()],
    })
  }

  /**
   * Subscribe to activity-driven changes. Elapsed-only health changes are visible when diagnostics is polled.
   * @param session - Session whose latest diagnostics are observed.
   * @param listener - receiver of detached merged diagnostic cuts.
   * @returns idempotent listener disposer.
   */
  subscribe(session: Session, listener: DiagnosticsListener): () => void {
    const listeners = this.listeners.get(session) ?? new Set<DiagnosticsListener>()
    listeners.add(listener)
    this.listeners.set(session, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(session)
    }
  }

  private projected(session: Session): AgentRunState | null {
    return this.ctx.sessionProjections.snapshot(session, ['agentRunState']).values.agentRunState ?? null
  }

  private onAssistantStream(agent: Agent, frame: AssistantStreamFrame): void {
    const projected = this.projected(agent.session)
    if (projected === null) return
    this.runSessions.set(projected.runId, agent.session)
    if (frame.type === 'start') {
      const ordinal = projected.attempt?.step === frame.step ? projected.attempt.ordinal : 1
      const attemptId = attemptIdFor(projected.runId, frame.step, ordinal)
      this.llmAttempts.set(frame.attemptId, { attemptId, runId: projected.runId })
      this.attemptRuns.set(attemptId, projected.runId)
      this.notify(agent.session)
      return
    }
    const identity = this.llmAttempts.get(frame.attemptId)
    if (identity === undefined) return
    if (frame.type === 'end') {
      this.llmAttempts.delete(frame.attemptId)
      this.notify(agent.session)
      return
    }
    const phase = streamPhase(frame)
    if (phase === undefined) return
    this.stream.set(identity.runId, { phase, lastActivityAt: frame.time })
    this.notify(agent.session, frame.time)
  }

  private onBackendObservation(observer: LocalBackendObserver, observation: BackendObservation): void {
    if (observation.observerId !== observer.id) {
      throw new Error('agent-run-state: backend observation identity does not match its registered observer')
    }
    let runId: RunId | undefined
    if (observation.attribution.kind === 'run') runId = observation.attribution.runId
    if (observation.attribution.kind === 'attempt') runId = this.attemptRuns.get(observation.attribution.attemptId)
    if (runId === undefined) {
      this.unattributed.set(String(observer.id), { ...observation, attribution: { kind: 'unknown' } })
      return
    }
    const session = this.runSessions.get(runId)
    if (session === undefined) {
      this.unattributed.set(String(observer.id), { ...observation, attribution: { kind: 'unknown' } })
      return
    }
    const previousActivityAt = this.backend.get(runId)?.lastActivityAt
    this.backend.set(runId, observation)
    if (observation.failure !== undefined) {
      const classified = classifyRunError({
        origin: 'backend',
        error: observation.failure.error,
        time: observation.observedAt,
        ...observation.failure.kind === undefined ? {} : { kind: observation.failure.kind },
      })
      const errors = this.transientErrors.get(runId) ?? []
      this.transientErrors.set(runId, [...errors, classified])
    }
    if (observation.attribution.kind !== 'unknown'
      && observation.lastActivityAt !== undefined
      && observation.observedAt === observation.lastActivityAt
      && (previousActivityAt === undefined || observation.lastActivityAt > previousActivityAt)) {
      this.ctx.emit('llm/request-activity', {
        sessionId: session.header.id,
        observedAt: observation.lastActivityAt,
        source: 'backend-observer',
        confidence: observation.attribution.confidence ?? 'confirmed',
      })
    }
    this.notify(session, observation.observedAt)
  }

  private onControlObservation(observer: LocalRunControlObserver, observation: RunControlObservation): void {
    if (observation.observerId !== observer.id) {
      throw new Error('agent-run-state: control observation identity does not match its registered observer')
    }
    const session = this.runSessions.get(observation.runId)
    if (session === undefined) return
    const current = this.control.get(observation.runId)
    if (current !== undefined && observation.observedAt < current.observation.observedAt) return
    this.control.set(observation.runId, { owner: String(observer.id), observation })
    this.notify(session, observation.observedAt)
  }

  private onDiagnosticsObservation(
    observer: LocalRunDiagnosticsObserver,
    observation: RunDiagnosticsObservation,
  ): void {
    if (observation.observerId !== observer.id) {
      throw new Error('agent-run-state: diagnostics observation identity does not match its registered observer')
    }
    const session = this.runSessions.get(observation.runId)
    if (session === undefined) return
    const owner = String(observer.id)
    const previous = this.diagnosticsOverlays.get(observation.runId) ?? []
    const current = previous.find(overlay => overlay.owner === owner)
    if (current !== undefined && observation.observedAt < current.observation.observedAt) return
    const next = current === undefined
      ? [...previous, { owner, observation }]
      : previous.map(overlay => overlay.owner === owner ? { owner, observation } : overlay)
    this.diagnosticsOverlays.set(observation.runId, next)
    this.notify(session, observation.observedAt)
  }

  private notify(session: Session, now = Date.now()): void {
    const listeners = this.listeners.get(session)
    if (listeners === undefined) return
    const snapshot = this.diagnostics(session, now)
    for (const listener of listeners) listener(snapshot)
  }

  private forgetSession(session: Session): void {
    this.listeners.delete(session)
    for (const [runId, owner] of this.runSessions) {
      if (owner !== session) continue
      this.runSessions.delete(runId)
      this.stream.delete(runId)
      this.backend.delete(runId)
      this.control.delete(runId)
      this.diagnosticsOverlays.delete(runId)
      this.transientErrors.delete(runId)
      for (const [attemptId, attemptRun] of this.attemptRuns) {
        if (attemptRun === runId) this.attemptRuns.delete(attemptId)
      }
      for (const [llmAttemptId, identity] of this.llmAttempts) {
        if (identity.runId === runId) this.llmAttempts.delete(llmAttemptId)
      }
    }
  }
}

export default AgentRunStateService
