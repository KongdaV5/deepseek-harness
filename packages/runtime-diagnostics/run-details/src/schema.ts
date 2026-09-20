/**
 * Strict runtime schemas for the Run Details fold state and wire cut.
 *
 * These schemas guard two different things and are strict by default:
 *
 * - {@link runDetailsViewSchema} validates the payload before it leaves the
 *   host, so a malformed value can never reach a renderer.
 * - {@link runDetailsStateSchema} validates persisted fold state before it
 *   seeds a fold. It is a shortcut guard, not authority: a rejection makes the
 *   registry discard the row and replay the log, so a stricter rule can only
 *   cost a re-fold, never produce a wrong answer.
 *
 * The one deliberately open shape is the durable `turn/end` reason. It is a
 * merge-extensible union that plugins extend, so validating it as a closed set
 * of variants would reject a future variant the log legitimately carries; the
 * schema proves the discriminant and preserves the payload verbatim instead.
 *
 * @module @deepseek-ai/dsh-run-details/schema
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { LifecycleFacts } from '@deepseek-ai/dsh-agent-lifecycle-facts/types'
import { backendObserverId } from '@deepseek-ai/dsh-agent-run-state'
import type {
  BackendObservation,
  ClassifiedRunError,
  RunErrorCode,
  RunHealth,
  RunId,
  RunPhase,
} from '@deepseek-ai/dsh-agent-run-state/types'
import type {
  RunCompactionFacts,
  RunDetailsState,
  RunDetailsView,
  RunReasoningFacts,
} from './types.ts'

/** Prefix Stage 7 stamps on every derived Run identity (`run:v1:...`). */
const RUN_ID_PREFIX = 'run:v1:'

const sessionIdSchema = z.string().min(1).transform(SessionId)
const sessionSeqSchema = z.number().int().nonnegative().transform(SessionSeq)
const timestamp = z.number().int().nonnegative()
const normalized = (field: string) => z.string().min(1).refine(value => value === value.trim(), `${field} must be normalized`)

/**
 * The durable `turn/end` reason is a merge-extensible union: a plugin may add a
 * variant upstream knows nothing about, and the log then carries it. The schema
 * proves only what every variant has — a string discriminant — and keeps the
 * payload intact, so a replayed fold cannot lose or rewrite a reason it does not
 * model.
 */
const turnEndReasonSchema: ZodType<TurnEndReason> = z.custom<TurnEndReason>(
  value => typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string',
  'turn end reason must be an object carrying a string kind',
)

const runIdSchema: ZodType<RunId> = z.string().startsWith(RUN_ID_PREFIX)
  .refine(value => value.length > RUN_ID_PREFIX.length, 'run id must carry an encoded session and turn')
  .transform(value => brandString<RunId>(value))

const runPhaseSchema: ZodType<RunPhase> = z.enum([
  'unknown', 'starting', 'executing', 'waiting_retry', 'completed', 'cancelled', 'failed',
])

const runHealthSchema: ZodType<RunHealth> = z.enum([
  'unknown', 'healthy', 'slow', 'stalled', 'degraded', 'fatal',
])

const runErrorCodeSchema: ZodType<RunErrorCode> = z.enum([
  'RESOURCE_LIMIT',
  'WORKER_CRASH',
  'MODEL_LOAD_FAILED',
  'INVALID_REASONING_PARAMETER',
  'INVALID_MODEL_CONFIG',
  'CONTEXT_OVERFLOW',
  'GENERATION_STALLED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'TRANSPORT',
  'TOOL_FAILED',
  'STREAM_DISCONNECTED',
  'CLIENT_CANCELLED',
  'BACKEND_RESTARTED',
  'BLOCKED',
  'MAX_TOKENS',
  'SESSION_INTERRUPTED',
  'RETRY_FAILED',
  'UNKNOWN',
])

const classifiedRunErrorObjectSchema = z.object({
  code: runErrorCodeSchema,
  message: z.string(),
  severity: z.enum(['degraded', 'fatal']),
  origin: z.enum(['backend', 'provider', 'transport', 'client', 'tool', 'session']),
  time: timestamp,
  providerRequestId: normalized('providerRequestId').optional(),
}).strict()

const classifiedRunErrorSchema = classifiedRunErrorObjectSchema as unknown as ZodType<ClassifiedRunError>

/**
 * Backend evidence, validated as the separate dimension it is: every field keeps
 * its own `unknown` member, so an unobserved backend can never be forced into
 * `reachable`, `idle`, or `active` by a schema default.
 */
const backendObservationObjectSchema = z.object({
  observerId: normalized('observerId').transform(backendObserverId),
  observedAt: timestamp,
  source: z.enum(['endpoint', 'process', 'metrics', 'none']),
  directness: z.enum(['direct', 'unavailable']),
  reachability: z.enum(['unknown', 'reachable', 'unreachable']),
  activity: z.enum(['unknown', 'idle', 'active']),
}).strict()

const backendObservationSchema = backendObservationObjectSchema as unknown as ZodType<BackendObservation>

const stepLifecycleFactObjectSchema = z.object({
  step: z.number().int().nonnegative(),
  startSeq: sessionSeqSchema,
  endSeq: sessionSeqSchema.optional(),
  startTime: timestamp,
  endTime: timestamp.optional(),
  open: z.boolean(),
}).strict()

const turnLifecycleFactObjectSchema = z.object({
  turn: z.number().int().positive(),
  startSeq: sessionSeqSchema,
  endSeq: sessionSeqSchema.optional(),
  startTime: timestamp,
  endTime: timestamp.optional(),
  terminal: z.string().min(1).optional(),
  terminalReason: turnEndReasonSchema.optional(),
  repairClosure: z.boolean(),
  steps: z.array(stepLifecycleFactObjectSchema),
}).strict()

const retryAttemptFactObjectSchema = z.object({
  retry: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative().optional(),
  delayMs: z.number().int().nonnegative(),
  failureCode: normalized('failureCode'),
  scheduledSeq: sessionSeqSchema,
  scheduledTime: timestamp,
  startedSeq: sessionSeqSchema.optional(),
  startedTime: timestamp.optional(),
}).strict()

const retryChainFactObjectSchema = z.object({
  retryId: normalized('retryId').transform(RetryId),
  turn: z.number().int().positive(),
  step: z.number().int().nonnegative(),
  provider: normalized('provider'),
  mode: z.enum(['normal', 'always']),
  policyKey: normalized('policyKey'),
  attempts: z.array(retryAttemptFactObjectSchema),
}).strict()

const seedBoundaryFactSchema = z.object({
  seq: sessionSeqSchema,
  time: timestamp,
  inherited: z.boolean(),
}).strict()

/** Stage 6's fold output, validated so a persisted row can seed the next fold. */
export const lifecycleFactsSchema = z.object({
  seedBoundary: seedBoundaryFactSchema.nullable(),
  turns: z.array(turnLifecycleFactObjectSchema),
  retryChains: z.array(retryChainFactObjectSchema),
  durableAttemptIdentity: z.null(),
}).strict() as unknown as ZodType<LifecycleFacts>

const runReasoningFactsObjectSchema = z.object({
  requested: z.string().min(1).optional(),
  resolved: z.string().min(1).optional(),
  adapterMaterialized: z.boolean(),
  atSeq: sessionSeqSchema,
  at: timestamp,
}).strict()

const runReasoningFactsSchema = runReasoningFactsObjectSchema as unknown as ZodType<RunReasoningFacts>

const runCompactionFactsObjectSchema = z.object({
  policyId: normalized('policyId'),
  policyVersion: normalized('policyVersion'),
  trigger: normalized('trigger'),
  candidateAttempts: z.number().int().nonnegative(),
  authorityAsOfSeq: z.number().int().nonnegative().optional(),
  protectionHash: normalized('protectionHash').optional(),
  requestedReasoning: z.string().min(1).optional(),
  resolvedReasoning: z.string().min(1).optional(),
  reasoningSource: z.string().min(1).optional(),
  atSeq: sessionSeqSchema,
  at: timestamp,
}).strict()

const runCompactionFactsSchema = runCompactionFactsObjectSchema as unknown as ZodType<RunCompactionFacts>

/** The idle cut: no Run, so no run fields exist to render. */
const runDetailsIdleViewObjectSchema = z.object({
  sessionId: sessionIdSchema,
  hasRun: z.literal(false),
}).strict()

/** The run cut: every field proven by the durable turn it describes. */
const runDetailsRunViewObjectSchema = z.object({
  sessionId: sessionIdSchema,
  hasRun: z.literal(true),
  runId: runIdSchema,
  turn: z.number().int().positive(),
  active: z.boolean(),
  phase: runPhaseSchema,
  health: runHealthSchema,
  startedAt: timestamp,
  updatedAt: timestamp,
  lastActivityAt: timestamp,
  completedAt: timestamp.optional(),
  terminalReason: z.string().min(1).optional(),
  repairClosure: z.boolean(),
  stepCount: z.number().int().nonnegative(),
  openStep: z.number().int().nonnegative().nullable(),
  retryCount: z.number().int().nonnegative(),
  maxRetryCount: z.number().int().nonnegative().optional(),
  retryReason: runErrorCodeSchema.optional(),
  primaryError: classifiedRunErrorSchema.optional(),
  secondaryErrors: z.array(classifiedRunErrorSchema),
  backend: backendObservationSchema,
  reasoning: runReasoningFactsSchema.nullable(),
  compaction: runCompactionFactsSchema.nullable(),
}).strict()

/** Validates the whole client-visible cut before it leaves the host. */
export const runDetailsViewSchema = z.discriminatedUnion('hasRun', [
  runDetailsIdleViewObjectSchema,
  runDetailsRunViewObjectSchema,
]) as unknown as ZodType<RunDetailsView>

/** Validates persisted fold state before it seeds a fold. */
export const runDetailsStateSchema = z.object({
  sessionId: sessionIdSchema,
  lifecycle: lifecycleFactsSchema,
  reasoning: runReasoningFactsSchema.nullable(),
  compaction: runCompactionFactsSchema.nullable(),
  cut: runDetailsViewSchema,
}).strict() as unknown as ZodType<RunDetailsState>
