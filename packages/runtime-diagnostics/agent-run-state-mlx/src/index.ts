/**
 * MLX backend observer: external log and HTTP health facts normalized into
 * backend-neutral Agent Run State observations. It never owns Run State,
 * health classification, retry, recovery, or presentation.
 *
 * @module @deepseek-ai/dsh-agent-run-state-mlx
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  BackendObserverId,
  type AttemptId,
  type BackendAttribution,
  type BackendComponentHealth,
  type BackendObservation,
  type GenerationHealth,
  type GenerationActivityObservation,
  type LocalBackendObserver,
  type PrefillObservation,
  type StrongBackendFailureKind,
} from '@deepseek-ai/dsh-agent-run-state'
import { MlxLogFileFollower } from './log-file.ts'
import type { Config, MlxAttemptLease, MlxProcessExit } from './types.ts'

export type * from './types.ts'
export { MlxLogFileFollower } from './log-file.ts'

const PROGRESS = /Prompt processing progress:\s*(\d+)\s*\/\s*(\d+)/u
const REQUEST = /"POST\s+\/v1\/(?:chat\/completions|completions)\s+HTTP\/\d(?:\.\d)?"\s+\d{3}\b/u
const HEALTH = /"GET\s+\/health\s+HTTP\/\d(?:\.\d)?"\s+(\d{3})\b/u
const MODELS = /"GET\s+\/v1\/models(?:\s+|\/[^\s]*\s+)HTTP\/\d(?:\.\d)?"\s+(\d{3})\b/u
const LOG_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3})\b/u
const ACCESS_TIME = /\[(\d{2})\/([A-Z][a-z]{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\]/u
const TERMINAL_EXCEPTION = /^[A-Za-z_][\w.]*(?:Error|Exception):\s*(.+)$/u
const MONTHS = new Map([
  ['Jan', 0], ['Feb', 1], ['Mar', 2], ['Apr', 3], ['May', 4], ['Jun', 5],
  ['Jul', 6], ['Aug', 7], ['Sep', 8], ['Oct', 9], ['Nov', 10], ['Dec', 11],
])

type TraceTarget = 'generation' | 'request'

interface PrefillSample {
  readonly current: number
  readonly total: number
  readonly time: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mlxBackendObserver: MLXBackendObserver
  }
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`agent-run-state-mlx: ${name} must be a positive safe integer`)
  }
}

function httpUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('agent-run-state-mlx: healthUrl must use http or https')
  }
  return url
}

function timestamp(line: string, fallback: number): number {
  const direct = LOG_TIME.exec(line)
  if (direct !== null) {
    return new Date(
      Number(direct[1]), Number(direct[2]) - 1, Number(direct[3]),
      Number(direct[4]), Number(direct[5]), Number(direct[6]), Number(direct[7]),
    ).getTime()
  }
  const access = ACCESS_TIME.exec(line)
  if (access === null) return fallback
  const month = MONTHS.get(access[2] as string)
  if (month === undefined) return fallback
  return new Date(
    Number(access[3]), month, Number(access[1]),
    Number(access[4]), Number(access[5]), Number(access[6]),
  ).getTime()
}

function terminalMessage(line: string): string | undefined {
  const match = TERMINAL_EXCEPTION.exec(line.trim())
  return match?.[1] === undefined ? undefined : `${line.trim().split(':', 1)[0]}: ${match[1]}`
}

/** Real MLX observation provider over a followed log and optional HTTP health endpoint. */
export class MLXBackendObserver extends Service implements LocalBackendObserver {
  static inject = ['agentRunState']
  static Config: Schema<Config> = z.object({
    observerId: z.string().required(),
    logPath: z.string().required(),
    logPollIntervalMs: z.number().step(1).min(1).required(),
    healthUrl: z.string(),
    healthPollIntervalMs: z.number().step(1).min(1).required(),
    healthTimeoutMs: z.number().step(1).min(1).required(),
    requestAttribution: z.union(['unknown', 'exclusive-single-flight'] as const).required(),
    provider: z.string().required(),
    models: z.array(z.string()).required(),
  })

  readonly id: BackendObserverId
  private readonly listeners = new Set<(observation: BackendObservation) => void>()
  private readonly activeAttempts = new Map<AttemptId, MlxAttemptLease>()
  private readonly sessions = new Map<string, Session>()
  private readonly acceptedModels: ReadonlySet<string>
  private readonly requestAttribution: Config['requestAttribution']
  private readonly provider: string
  private readonly follower: MlxLogFileFollower
  private readonly healthUrl: URL | undefined
  private readonly healthTimeoutMs: number
  private readonly healthControllers = new Set<AbortController>()
  private healthTail: Promise<void> = Promise.resolve()
  private closed = false
  private attribution: BackendAttribution = { kind: 'unknown' }
  private processHealth: BackendComponentHealth = 'unknown'
  private modelHealth: BackendComponentHealth = 'unknown'
  private generationHealth: GenerationHealth = 'unknown'
  private generationActivity: GenerationActivityObservation | undefined
  private lastActivityAt: number | undefined
  private prefill: PrefillObservation | undefined
  private prefillSample: PrefillSample | undefined
  private traceTarget: TraceTarget | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'mlxBackendObserver')
    if (config.observerId.trim().length === 0) throw new Error('agent-run-state-mlx: observerId must not be blank')
    if (!isAbsolute(config.logPath)) throw new Error('agent-run-state-mlx: logPath must be absolute')
    positiveInteger('logPollIntervalMs', config.logPollIntervalMs)
    positiveInteger('healthPollIntervalMs', config.healthPollIntervalMs)
    positiveInteger('healthTimeoutMs', config.healthTimeoutMs)
    if (config.provider.trim().length === 0) throw new Error('agent-run-state-mlx: provider must not be blank')
    if (config.models.some(model => model.trim().length === 0)) {
      throw new Error('agent-run-state-mlx: models must contain only non-blank ids')
    }
    if (config.requestAttribution === 'exclusive-single-flight' && config.models.length === 0) {
      throw new Error('agent-run-state-mlx: exclusive attribution requires at least one model id')
    }

    this.id = BackendObserverId(config.observerId)
    this.requestAttribution = config.requestAttribution
    this.provider = config.provider
    this.acceptedModels = new Set(config.models)
    this.healthUrl = config.healthUrl === undefined ? undefined : httpUrl(config.healthUrl)
    this.healthTimeoutMs = config.healthTimeoutMs
    this.follower = new MlxLogFileFollower(
      config.logPath,
      config.logPollIntervalMs,
      (line) => { this.ingestLogLine(line) },
      (error) => { ctx.logger.warn('agent-run-state-mlx: failed to follow MLX log: %o', error) },
    )

    ctx.effect(() => ctx.agentRunState.registerObserver(this), 'agent-run-state-mlx: observer registration')
    ctx.on('session/event', (session) => { this.sessions.set(String(session.header.id), session) })
    ctx.on('session/disposed', (session) => { this.sessions.delete(String(session.header.id)) })
    ctx.on('llm/stream', (options, next) => this.observeRequest(options, next))
    ctx.effect(async () => {
      await this.follower.start()
      const timer = this.healthUrl === undefined
        ? undefined
        : setInterval(() => { this.queueHealthPoll() }, config.healthPollIntervalMs)
      timer?.unref()
      if (this.healthUrl !== undefined) this.queueHealthPoll()
      return async () => {
        this.closed = true
        if (timer !== undefined) clearInterval(timer)
        for (const controller of this.healthControllers) controller.abort()
        await this.follower.stop()
        await this.healthTail
        this.listeners.clear()
        this.activeAttempts.clear()
        this.sessions.clear()
      }
    }, 'agent-run-state-mlx: external observation lifecycle')
  }

  /**
   * Subscribe to normalized MLX observations until the returned disposer is called.
   * @param listener - contained receiver for each backend-neutral observation.
   * @returns idempotent disposer that removes the listener.
   */
  subscribe(listener: (observation: BackendObservation) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Parse one complete MLX log line and publish only recognized backend facts.
   * @param line - one complete log record without its line terminator.
   * @param observedAt - fallback timestamp when the record contains no recognized time.
   */
  ingestLogLine(line: string, observedAt: number = Date.now()): void {
    const time = timestamp(line, observedAt)
    if (/Starting httpd at\b/u.test(line)) {
      this.attribution = { kind: 'unknown' }
      this.prefill = undefined
      this.prefillSample = undefined
      this.traceTarget = undefined
      this.processHealth = 'healthy'
      this.modelHealth = 'unknown'
      this.generationHealth = 'unknown'
      this.generationActivity = undefined
      this.activity(time, 'model-loading')
      return
    }

    if (/^Exception in thread .*\(_generate\):\s*$/u.test(line.trim())) {
      this.traceTarget = 'generation'
      return
    }
    if (/^Exception occurred during processing of request\b/u.test(line.trim())) {
      this.traceTarget = 'request'
      return
    }
    if (/\b(?:worker uncaught exception|uncaught exception in worker)\b/iu.test(line)) {
      this.traceTarget = undefined
      const message = line.trim()
      this.fail(time, message, 'worker-uncaught-exception')
      return
    }
    if (/\b(?:generation (?:thread|worker) terminated|generation thread termination)\b/iu.test(line)) {
      this.traceTarget = undefined
      this.fail(time, line.trim(), 'generation-worker-terminated')
      return
    }
    if (/\b(?:failed to load model|error loading model|model load failed|unable to load model)\b/iu.test(line)) {
      this.traceTarget = undefined
      this.fail(time, line.trim(), 'model-load-failure')
      return
    }

    const terminal = terminalMessage(line)
    if (terminal !== undefined) {
      if (/broken\s*pipe/iu.test(terminal)) {
        this.fail(time, terminal)
      } else if (this.traceTarget === 'generation') {
        this.fail(time, terminal, 'generation-worker-terminated')
      }
      this.traceTarget = undefined
      return
    }

    const progress = PROGRESS.exec(line)
    if (progress !== null) {
      const current = Number(progress[1])
      const total = Number(progress[2])
      if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 0 || total < 1 || current > total) return
      const previous = this.prefillSample
      const speed = previous !== undefined
        && previous.total === total
        && current > previous.current
        && time > previous.time
        ? (current - previous.current) * 1_000 / (time - previous.time)
        : undefined
      this.prefillSample = { current, total, time }
      this.prefill = {
        current,
        total,
        ...speed === undefined ? {} : { speed },
        source: 'backend-log',
        confidence: 'provisional',
      }
      this.modelHealth = 'healthy'
      if (this.generationHealth !== 'fatal') this.generationHealth = 'active'
      this.generationActivity = {
        state: 'active',
        source: 'backend-log',
        confidence: 'provisional',
      }
      this.activity(time, 'prefill')
      return
    }

    if (REQUEST.test(line)) {
      this.bindRequestAttribution()
      this.prefill = undefined
      this.prefillSample = undefined
      this.processHealth = 'healthy'
      this.activity(time, 'heartbeat')
      return
    }

    const health = HEALTH.exec(line)
    if (health !== null) {
      this.processHealth = Number(health[1]) >= 200 && Number(health[1]) < 300 ? 'healthy' : 'degraded'
      this.publish(time, 'heartbeat')
      return
    }

    const models = MODELS.exec(line)
    if (models !== null) {
      this.processHealth = Number(models[1]) >= 200 && Number(models[1]) < 300 ? 'healthy' : 'degraded'
      if (this.processHealth === 'healthy') this.modelHealth = 'healthy'
      this.publish(time, 'heartbeat')
    }
  }

  /**
   * Publish a process exit only when the process owner directly observed settlement.
   * @param exit - direct child-process settlement evidence and its observation time.
   */
  observeProcessExit(exit: MlxProcessExit): void {
    this.processHealth = 'fatal'
    this.fail(exit.time, exit.message, 'process-exit')
  }

  /** Probe the configured health endpoint once; failure degrades process health but is never fatal evidence. */
  async pollHealth(): Promise<void> {
    if (this.healthUrl === undefined || this.closed) return
    const controller = new AbortController()
    this.healthControllers.add(controller)
    const timer = setTimeout(() => { controller.abort() }, this.healthTimeoutMs)
    timer.unref()
    const time = Date.now()
    try {
      const response = await fetch(this.healthUrl, { method: 'GET', signal: controller.signal })
      this.processHealth = response.ok ? 'healthy' : 'degraded'
    } catch {
      this.processHealth = 'degraded'
    } finally {
      clearTimeout(timer)
      this.healthControllers.delete(controller)
    }
    this.publish(time, 'heartbeat')
  }

  /** Force one file poll for deterministic source tests and manual diagnostics. */
  async pollLog(): Promise<void> {
    await this.follower.poll()
  }

  /** Refresh appended MLX failure/progress evidence before a policy decision. */
  async probe(): Promise<void> {
    await this.pollLog()
  }

  /** Number of active subscribers, exposed for provider lifecycle diagnostics. */
  get subscriberCount(): number {
    return this.listeners.size
  }

  private async *observeRequest(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const lease = this.leaseFor(options)
    if (lease !== undefined) this.activeAttempts.set(lease.attemptId, lease)
    let completed = false
    try {
      yield* next()
      completed = true
    } finally {
      if (lease !== undefined) this.activeAttempts.delete(lease.attemptId)
      if (completed && this.attribution.kind === 'attempt'
        && this.attribution.attemptId === lease?.attemptId) {
        this.generationActivity = { state: 'inactive', source: 'callback', confidence: 'confirmed' }
        this.publish(Date.now(), 'heartbeat')
      }
    }
  }

  private leaseFor(options: GenerateOptions): MlxAttemptLease | undefined {
    if (options.purpose !== undefined
      || options.sessionId === undefined
      || options.provider !== this.provider
      || !this.acceptedModels.has(options.model)) return undefined
    const session = this.sessions.get(String(options.sessionId))
    if (session === undefined) return undefined
    const attempt = this.ctx.agentRunState.diagnostics(session).run?.attempt
    return attempt === undefined
      ? undefined
      : { attemptId: attempt.attemptId, provider: options.provider, model: options.model }
  }

  private bindRequestAttribution(): void {
    if (this.requestAttribution !== 'exclusive-single-flight' || this.activeAttempts.size !== 1) {
      this.attribution = { kind: 'unknown' }
      return
    }
    const lease = this.activeAttempts.values().next().value as MlxAttemptLease
    this.attribution = {
      kind: 'attempt',
      attemptId: lease.attemptId,
      source: 'request-and-backend-lifecycle',
      confidence: 'provisional',
    }
  }

  private activity(time: number, activity: NonNullable<BackendObservation['activity']>): void {
    this.lastActivityAt = time
    this.publish(time, activity)
  }

  private fail(time: number, message: string, kind?: StrongBackendFailureKind): void {
    this.lastActivityAt = time
    if (kind === 'model-load-failure') this.modelHealth = 'fatal'
    if (kind === 'process-exit') this.processHealth = 'fatal'
    if (kind === 'worker-uncaught-exception' || kind === 'generation-worker-terminated') {
      this.generationHealth = 'fatal'
    }
    if (kind !== undefined) {
      this.generationActivity = {
        state: 'inactive',
        source: kind === 'process-exit' ? 'callback' : 'backend-log',
        confidence: 'confirmed',
      }
    }
    this.publish(time, 'generation', {
      error: message,
      ...kind === undefined ? {} : { kind },
    })
  }

  private publish(
    observedAt: number,
    activity: NonNullable<BackendObservation['activity']>,
    failure?: BackendObservation['failure'],
  ): void {
    const observation: BackendObservation = {
      observerId: this.id,
      attribution: this.attribution,
      observedAt,
      ...this.lastActivityAt === undefined ? {} : { lastActivityAt: this.lastActivityAt },
      activity,
      processHealth: this.processHealth,
      modelHealth: this.modelHealth,
      generationHealth: this.generationHealth,
      ...this.generationActivity === undefined ? {} : { generationActivity: this.generationActivity },
      ...this.prefill === undefined ? {} : { prefill: this.prefill },
      ...failure === undefined ? {} : { failure },
    }
    for (const listener of this.listeners) {
      try {
        listener(observation)
      } catch (error) {
        this.ctx.logger.warn('agent-run-state-mlx: observation listener failed: %o', error)
      }
    }
  }

  private queueHealthPoll(): void {
    this.healthTail = this.healthTail.then(() => this.pollHealth())
  }
}

export default MLXBackendObserver
