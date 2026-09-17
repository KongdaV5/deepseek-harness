/** Durable AgentRunState projection over existing low-frequency Session events. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { ProviderRequestId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { attemptIdFor, runIdFor } from './brand.ts'
import type { AttemptId, RunId } from './brand.ts'
import { appendRunError, classifyRunError, clientCancelledError } from './errors.ts'
import type { AgentRunProjectionState, AgentRunState, ClassifiedRunError, RunPhase } from './types.ts'

const sessionIdSchema = z.string() as unknown as z.ZodType<SessionId>
const runIdSchema = z.string() as unknown as z.ZodType<RunId>
const attemptIdSchema = z.string() as unknown as z.ZodType<AttemptId>
const providerRequestIdSchema = z.string() as unknown as z.ZodType<ProviderRequestId>

const errorSchema = z.object({
  code: z.enum([
    'RESOURCE_LIMIT', 'WORKER_CRASH', 'MODEL_LOAD_FAILED', 'INVALID_REASONING_PARAMETER',
    'INVALID_MODEL_CONFIG', 'CONTEXT_OVERFLOW', 'GENERATION_STALLED', 'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE', 'TRANSPORT', 'TOOL_FAILED', 'STREAM_DISCONNECTED',
    'CLIENT_CANCELLED', 'BACKEND_RESTARTED', 'BLOCKED', 'MAX_TOKENS',
    'SESSION_INTERRUPTED', 'RETRY_FAILED', 'UNKNOWN',
  ]),
  message: z.string(),
  severity: z.enum(['degraded', 'fatal']),
  origin: z.enum(['backend', 'provider', 'transport', 'client', 'tool', 'session']),
  time: z.number().nonnegative(),
  providerRequestId: providerRequestIdSchema.optional(),
}).strict()

const attributionSchema = z.union([
  z.object({
    kind: z.literal('attempt'),
    attemptId: attemptIdSchema,
    source: z.enum(['explicit', 'request-and-backend-lifecycle']).optional(),
    confidence: z.enum(['confirmed', 'provisional']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('run'),
    runId: runIdSchema,
    source: z.enum(['explicit', 'request-and-backend-lifecycle']).optional(),
    confidence: z.enum(['confirmed', 'provisional']).optional(),
  }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
])

const prefillSchema = z.object({
  current: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  speed: z.number().nonnegative().optional(),
  source: z.enum(['backend-log', 'callback', 'metrics', 'unknown']),
  confidence: z.enum(['provisional', 'confirmed', 'unknown']),
}).strict()

const generationActivitySchema = z.object({
  state: z.enum(['active', 'inactive']),
  source: z.enum(['backend-log', 'callback', 'metrics', 'unknown']),
  confidence: z.enum(['provisional', 'confirmed', 'unknown']),
}).strict()

const cancellationSchema = z.union([
  z.object({ status: z.literal('requested'), requestedAt: z.number().nonnegative() }).strict(),
  z.object({
    status: z.literal('confirmed'),
    requestedAt: z.number().nonnegative(),
    resolvedAt: z.number().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal('unconfirmed'),
    requestedAt: z.number().nonnegative(),
    resolvedAt: z.number().nonnegative(),
  }).strict(),
])

/** Persisted-cache and wire validation for the full durable run snapshot. */
export const agentRunStateSchema = z.object({
  sessionId: sessionIdSchema,
  runId: runIdSchema,
  turn: z.number().int().positive(),
  phase: z.enum([
    'unknown', 'starting', 'preparing_context', 'prefill', 'reasoning', 'generating', 'tool_wait',
    'waiting_retry', 'compacting', 'completed', 'cancelled', 'failed',
  ]),
  health: z.enum(['unknown', 'healthy', 'slow', 'stalled', 'degraded', 'fatal']),
  startedAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  completedAt: z.number().nonnegative().optional(),
  lastActivityAt: z.number().nonnegative(),
  lastMeaningfulActivityAt: z.number().nonnegative(),
  lastBackendActivityAt: z.number().nonnegative().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  attempt: z.object({
    attemptId: attemptIdSchema,
    step: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    startedAt: z.number().nonnegative(),
    settledAt: z.number().nonnegative().optional(),
    providerRequestId: providerRequestIdSchema.optional(),
  }).strict().optional(),
  retryCount: z.number().int().nonnegative(),
  maxRetryCount: z.number().int().nonnegative().optional(),
  retryReason: errorSchema.shape.code.optional(),
  cancellation: cancellationSchema.optional(),
  currentTool: z.object({ callId: z.string(), name: z.string() }).strict().optional(),
  reasoning: z.object({
    requestedReasoning: z.string().optional(),
    resolvedReasoning: z.string().optional(),
    backendDefaultReasoning: z.string().optional(),
  }).strict(),
  context: z.object({
    contextWindow: z.number().nonnegative().optional(),
    surfaceTokens: z.number().nonnegative().optional(),
    projectedTokens: z.number().nonnegative().optional(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
  }).strict(),
  backend: z.object({
    attribution: attributionSchema,
    processHealth: z.enum(['unknown', 'healthy', 'degraded', 'fatal']),
    modelHealth: z.enum(['unknown', 'healthy', 'degraded', 'fatal']),
    generationHealth: z.enum(['unknown', 'active', 'stalled', 'degraded', 'fatal']),
    generationActivity: generationActivitySchema.optional(),
    prefill: prefillSchema.optional(),
  }).strict(),
  primaryError: errorSchema.optional(),
  secondaryErrors: z.array(errorSchema),
}).strict() as unknown as z.ZodType<AgentRunState>

const nullableAgentRunStateSchema = agentRunStateSchema.nullable() as z.ZodType<AgentRunState | null>
const projectionStateSchema = z.object({
  sessionId: sessionIdSchema,
  run: nullableAgentRunStateSchema,
}).strict() as unknown as z.ZodType<AgentRunProjectionState>

type RunPatch = { [K in keyof AgentRunState]?: AgentRunState[K] | undefined }

function update(state: AgentRunState, event: SessionEvent, values: RunPatch): AgentRunState {
  const next = {
    ...state,
    ...values,
    updatedAt: event.time,
    lastActivityAt: event.time,
    lastMeaningfulActivityAt: event.time,
  } as Record<string, unknown>
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(next, key)
  }
  return next as unknown as AgentRunState
}

function streamPhase(event: Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>): RunPhase {
  let phase: RunPhase = 'preparing_context'
  for (const record of event.data.stream) {
    switch (record.type) {
      case 'reasoning-chunks':
        if (record.texts.some(text => text.length > 0)) phase = 'reasoning'
        break
      case 'text-chunks':
        if (record.texts.some(text => text.length > 0)) phase = 'generating'
        break
      case 'tool-call-chunks':
        if ((record.name?.length ?? 0) > 0 || record.args.some(text => text.length > 0)) phase = 'generating'
        break
      case 'chunk':
        if (record.chunk.type === 'reasoning-delta' && record.chunk.text.length > 0) phase = 'reasoning'
        if (record.chunk.type === 'text-delta' && record.chunk.text.length > 0) phase = 'generating'
        if (record.chunk.type === 'tool-call-delta'
          && ((record.chunk.name?.length ?? 0) > 0 || record.chunk.argumentsDelta.length > 0)) phase = 'generating'
        break
    }
  }
  return phase
}

function withError(state: AgentRunState, error: ClassifiedRunError): AgentRunState {
  const errors = appendRunError(state, error)
  return {
    ...state,
    ...errors,
    health: error.severity === 'fatal' ? 'fatal' : state.health === 'fatal' ? 'fatal' : 'degraded',
  }
}

function terminalError(code: 'BLOCKED' | 'MAX_TOKENS' | 'SESSION_INTERRUPTED', time: number): ClassifiedRunError {
  return {
    code,
    message: code === 'BLOCKED'
      ? 'The run was blocked before completion.'
      : code === 'MAX_TOKENS'
        ? 'The run reached its output token limit.'
        : 'The run was interrupted by process recovery.',
    severity: 'degraded',
    origin: 'session',
    time,
  }
}

/**
 * Pure durable fold; backend observations and live stream frames never enter this state.
 * @param header - immutable Session identity used to derive run correlation.
 * @param state - previous latest-run state, or null before a run starts.
 * @param event - next durable Session event in log order.
 * @returns the next immutable latest-run state.
 */
export function applyAgentRunEvent(
  header: Pick<SessionHeader, 'id'>,
  state: AgentRunState | null,
  event: SessionEvent,
): AgentRunState | null {
  if (event.type === 'turn/start') {
    return {
      sessionId: header.id,
      runId: runIdFor(header.id, event.data.turn),
      turn: event.data.turn,
      phase: 'starting',
      health: 'unknown',
      startedAt: event.time,
      updatedAt: event.time,
      lastActivityAt: event.time,
      lastMeaningfulActivityAt: event.time,
      retryCount: 0,
      reasoning: {},
      context: {},
      backend: {
        attribution: { kind: 'unknown' },
        processHealth: 'unknown',
        modelHealth: 'unknown',
        generationHealth: 'unknown',
      },
      secondaryErrors: [],
    }
  }
  if (state === null) return state

  switch (event.type) {
    case 'step/start':
      if (event.data.turn !== state.turn) return state
      return update(state, event, {
        phase: 'preparing_context',
        attempt: {
          attemptId: attemptIdFor(state.runId, event.data.step, 1),
          step: event.data.step,
          ordinal: 1,
          startedAt: event.time,
        },
        currentTool: undefined,
      })
    case 'request/header': {
      const effort = event.data.header.config.reasoningEffort
      const adapterDefault = event.data.header.adapterDefaults?.reasoningEffort === true
      return update(state, event, {
        provider: event.data.header.config.provider,
        model: event.data.header.config.model,
        reasoning: {
          ...adapterDefault || effort === undefined ? {} : { requestedReasoning: String(effort) },
          ...effort === undefined ? {} : { resolvedReasoning: String(effort) },
        },
      })
    }
    case 'request/context':
      return update(state, event, {
        provider: event.data.provider,
        model: event.data.model,
        context: {
          ...state.context,
          ...event.data.contextWindow === undefined ? {} : { contextWindow: event.data.contextWindow },
        },
      })
    case 'assistant/attempt':
    case 'assistant/message':
      if (event.data.turn !== state.turn) return state
      return update(state, event, {
        phase: streamPhase(event),
        ...state.attempt === undefined ? {} : { attempt: { ...state.attempt, settledAt: event.time } },
        context: event.type === 'assistant/message' && event.data.usage !== undefined
          ? {
            ...state.context,
            inputTokens: event.data.usage.inputTokens,
            outputTokens: event.data.usage.outputTokens,
            ...event.data.usage.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: event.data.usage.cacheReadTokens },
          }
          : state.context,
      })
    case 'tool/call':
      if (event.data.turn !== state.turn) return state
      return update(state, event, {
        phase: 'tool_wait',
        currentTool: { callId: String(event.data.callId), name: event.data.name },
      })
    case 'tool/result':
      return event.data.turn === state.turn
        ? update(state, event, { phase: 'preparing_context', currentTool: undefined })
        : state
    case 'llm/retry': {
      if (event.data.turn !== state.turn) return state
      const classified = classifyRunError({ origin: 'provider', error: event.data.failure, time: event.time })
      return update(withError(state, classified), event, {
        phase: 'waiting_retry',
        retryCount: event.data.retry,
        retryReason: classified.code,
        ...event.data.mode === 'normal' ? { maxRetryCount: event.data.maxRetries } : {},
      })
    }
    case 'llm/retry-started':
      if (event.data.turn !== state.turn) return state
      return update(state, event, {
        phase: 'preparing_context',
        attempt: {
          attemptId: attemptIdFor(state.runId, event.data.step, event.data.retry + 1),
          step: event.data.step,
          ordinal: event.data.retry + 1,
          startedAt: event.time,
        },
      })
    case 'compaction/start':
      return event.data.turn === state.turn ? update(state, event, { phase: 'compacting' }) : state
    case 'compaction/end':
      return event.data.turn === state.turn ? update(state, event, { phase: 'preparing_context' }) : state
    case 'turn/end': {
      if (event.data.turn !== state.turn) return state
      const completed = { completedAt: event.time, currentTool: undefined } as const
      switch (event.data.reason.kind) {
        case 'completed': return update(state, event, { ...completed, phase: 'completed', health: 'healthy' })
        case 'aborted': {
          const cancelled = withError(state, clientCancelledError(event.time))
          return update(cancelled, event, { ...completed, phase: 'cancelled', health: 'degraded' })
        }
        case 'error': {
          const failed = withError(state, classifyRunError({
            origin: 'provider', error: event.data.reason.error, time: event.time,
          }))
          return update(failed, event, { ...completed, phase: 'failed' })
        }
        case 'blocked': {
          const failed = withError(state, terminalError('BLOCKED', event.time))
          return update(failed, event, { ...completed, phase: 'failed' })
        }
        case 'max-tokens': {
          const failed = withError(state, terminalError('MAX_TOKENS', event.time))
          return update(failed, event, { ...completed, phase: 'failed' })
        }
        case 'interrupted': {
          const failed = withError(state, terminalError('SESSION_INTERRUPTED', event.time))
          return update(failed, event, { ...completed, phase: 'failed' })
        }
        default:
          return update(state, event, { ...completed, phase: 'failed', health: 'degraded' })
      }
    }
    default:
      return state
  }
}

/** Registered client-visible projection of the latest run's durable facts. */
export const agentRunStateProjectionDefinition = {
  key: 'agentRunState',
  stateVersion: 1,
  stateSchema: projectionStateSchema,
  init: header => ({ sessionId: header.id, run: null }),
  apply: (state, event) => {
    const run = applyAgentRunEvent({ id: state.sessionId }, state.run, event)
    return run === state.run ? state : { ...state, run }
  },
  wire: {
    viewSchema: nullableAgentRunStateSchema,
    view: state => state.run,
  },
} satisfies ProjectionDefinition<'agentRunState', AgentRunProjectionState>
