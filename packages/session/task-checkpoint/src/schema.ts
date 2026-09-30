/** Strict runtime schemas for durable task checkpoint and result manifest values. */

import { z } from 'zod'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm/brand'
import type { ZodType } from 'zod'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { brandLegacyAttemptId, brandLegacyRunId } from './legacy-identity.ts'
import { taskIdFromString, taskOutputIdFromString, taskStepIdFromString } from './identity.ts'
import type {
  ResultManifest,
  ResultManifestProjectionState,
  TaskCheckpoint,
  TaskCheckpointProjection,
  TaskCheckpointProjectionState,
} from './types.ts'
import type { ResultManifestEventData, TaskCheckpointEventData } from './domain.ts'

const normalized = (field: string) => z.string().min(1).refine(value => value === value.trim(), `${field} must be normalized`)
const timestamp = z.number().int().nonnegative()
const positiveInteger = z.number().int().positive()
const taskIdSchema = normalized('taskId').transform(taskIdFromString)
const stepIdSchema = normalized('step id').transform(taskStepIdFromString)
const outputIdSchema = normalized('output id').transform(taskOutputIdFromString)
const runIdSchema = normalized('run id').transform(brandLegacyRunId)

const executionSchema = z.object({
  provider: normalized('provider'),
  model: normalized('model'),
  backend: normalized('backend').optional(),
  requestedReasoning: normalized('requestedReasoning').optional(),
  resolvedReasoning: normalized('resolvedReasoning').optional(),
}).strict()

const taskStepSchema = z.object({
  id: stepIdSchema,
  title: normalized('step title'),
}).strict()

const stepEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool-result'),
    eventSeq: z.number().int().nonnegative().transform(SessionSeq),
    callId: normalized('callId'),
  }).strict(),
  z.object({
    kind: z.literal('result-validation'),
    outputId: outputIdSchema,
    manifestRevision: positiveInteger,
  }).strict(),
  z.object({
    kind: z.literal('runtime-validation'),
    validator: normalized('validator'),
    reference: normalized('reference'),
  }).strict(),
])

const completedStepSchema = taskStepSchema.extend({
  completedAt: timestamp,
  evidence: stepEvidenceSchema,
}).strict()

const classifiedErrorSchema = z.object({
  code: z.enum([
    'RESOURCE_LIMIT', 'WORKER_CRASH', 'MODEL_LOAD_FAILED', 'INVALID_REASONING_PARAMETER',
    'INVALID_MODEL_CONFIG', 'CONTEXT_OVERFLOW', 'GENERATION_STALLED', 'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE', 'TRANSPORT', 'TOOL_FAILED', 'STREAM_DISCONNECTED',
    'CLIENT_CANCELLED', 'BACKEND_RESTARTED', 'BLOCKED', 'MAX_TOKENS',
    'SESSION_INTERRUPTED', 'RETRY_FAILED', 'UNKNOWN',
  ]),
  message: normalized('error message'),
  severity: z.enum(['degraded', 'fatal']),
  origin: z.enum(['backend', 'provider', 'transport', 'client', 'tool', 'session']),
  time: timestamp,
  providerRequestId: normalized('providerRequestId').transform(ProviderRequestId).optional(),
}).strict()

const failureContextSchema = z.object({
  primaryError: classifiedErrorSchema,
  failedAt: timestamp,
  failedAttemptId: normalized('attempt id').transform(brandLegacyAttemptId).optional(),
  currentStepId: stepIdSchema.optional(),
}).strict()

const resumeContextSchema = z.object({
  objective: normalized('objective'),
  constraints: z.array(normalized('constraint')),
  decisions: z.array(normalized('decision')),
  criticalContext: z.array(normalized('critical context')),
}).strict()

const resumeRecordSchema = z.object({
  requestedAt: timestamp,
  runId: runIdSchema,
  executionPlan: z.array(stepIdSchema),
  context: z.object({
    estimatedTokens: z.number().int().nonnegative(),
    maxTokens: positiveInteger,
    includedSections: z.array(normalized('included section')),
    omittedSections: z.array(normalized('omitted section')),
  }).strict(),
}).strict()

/** Strict schema for one whole durable task checkpoint. */
const taskCheckpointObjectSchema = z.object({
  version: z.literal(1),
  taskId: taskIdSchema,
  revision: positiveInteger,
  taskType: normalized('taskType'),
  sessionId: normalized('sessionId').transform(SessionId),
  originRunId: runIdSchema,
  latestRunId: runIdSchema,
  status: z.enum(['running', 'paused', 'blocked', 'completed', 'partial', 'failed', 'cancelled']),
  originalExecution: executionSchema,
  latestExecution: executionSchema,
  modelRelation: z.enum(['same-model', 'model-changed']),
  completedSteps: z.array(completedStepSchema),
  currentStep: taskStepSchema.optional(),
  pendingSteps: z.array(taskStepSchema),
  createdAt: timestamp,
  lastSuccessAt: timestamp.optional(),
  lastActivityAt: timestamp,
  resumeContext: resumeContextSchema,
  outputs: z.array(outputIdSchema),
  failureContext: failureContextSchema.optional(),
  latestResume: resumeRecordSchema.optional(),
}).strict().superRefine((checkpoint, context) => {
  const completed = new Set<string>()
  for (const step of checkpoint.completedSteps) {
    if (completed.has(step.id)) context.addIssue({ code: 'custom', message: `duplicate completed step ${step.id}` })
    completed.add(step.id)
  }
  const pending = new Set<string>()
  for (const step of checkpoint.pendingSteps) {
    if (pending.has(step.id)) context.addIssue({ code: 'custom', message: `duplicate pending step ${step.id}` })
    if (completed.has(step.id)) context.addIssue({ code: 'custom', message: `step ${step.id} cannot be completed and pending` })
    pending.add(step.id)
  }
  if (checkpoint.currentStep !== undefined && !pending.has(checkpoint.currentStep.id)) {
    context.addIssue({ code: 'custom', message: 'currentStep must remain in pendingSteps until completion' })
  }
  if (checkpoint.status === 'completed' && (checkpoint.currentStep !== undefined || checkpoint.pendingSteps.length > 0)) {
    context.addIssue({ code: 'custom', message: 'completed task cannot retain current or pending steps' })
  }
  if (checkpoint.failureContext?.currentStepId !== undefined && checkpoint.currentStep?.id !== checkpoint.failureContext.currentStepId) {
    context.addIssue({ code: 'custom', message: 'failureContext.currentStepId must identify currentStep' })
  }
  if (checkpoint.lastSuccessAt !== undefined && checkpoint.lastSuccessAt > checkpoint.lastActivityAt) {
    context.addIssue({ code: 'custom', message: 'lastSuccessAt cannot follow lastActivityAt' })
  }
  if (checkpoint.createdAt > checkpoint.lastActivityAt) {
    context.addIssue({ code: 'custom', message: 'createdAt cannot follow lastActivityAt' })
  }
  const relation = checkpoint.originalExecution.model === checkpoint.latestExecution.model
    ? 'same-model'
    : 'model-changed'
  if (checkpoint.modelRelation !== relation) {
    context.addIssue({ code: 'custom', message: `modelRelation must be ${relation}` })
  }
  if (new Set(checkpoint.outputs).size !== checkpoint.outputs.length) {
    context.addIssue({ code: 'custom', message: 'outputs must be unique' })
  }
  if (checkpoint.latestResume !== undefined) {
    if (checkpoint.latestResume.runId !== checkpoint.latestRunId) {
      context.addIssue({ code: 'custom', message: 'latestResume.runId must equal latestRunId' })
    }
    if (new Set(checkpoint.latestResume.executionPlan).size !== checkpoint.latestResume.executionPlan.length) {
      context.addIssue({ code: 'custom', message: 'latestResume.executionPlan must be unique' })
    }
    if (checkpoint.latestResume.context.estimatedTokens > checkpoint.latestResume.context.maxTokens) {
      context.addIssue({ code: 'custom', message: 'latestResume context cannot exceed its admitted budget' })
    }
  }
})

/** Strict public runtime schema for one whole durable Task Checkpoint. */
export const taskCheckpointSchema = taskCheckpointObjectSchema as ZodType<TaskCheckpoint>

const checksumSchema = z.object({
  algorithm: z.literal('sha256'),
  value: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

const validationSchema = z.object({
  status: z.enum(['pending', 'passed', 'failed']),
  checks: z.array(z.object({
    id: normalized('validation check id'),
    status: z.enum(['passed', 'failed']),
    message: normalized('validation message').optional(),
  }).strict()),
}).strict().superRefine((validation, context) => {
  const hasFailed = validation.checks.some(check => check.status === 'failed')
  if (validation.status === 'passed' && hasFailed) {
    context.addIssue({ code: 'custom', message: 'passed validation cannot contain failed checks' })
  }
  if (validation.status === 'failed' && !hasFailed) {
    context.addIssue({ code: 'custom', message: 'failed validation requires a failed check' })
  }
})

/** Strict schema for one whole durable result manifest. */
const resultManifestObjectSchema = z.object({
  version: z.literal(1),
  outputId: outputIdSchema,
  revision: positiveInteger,
  taskId: taskIdSchema,
  runId: runIdSchema,
  path: normalized('result path'),
  status: z.enum(['running', 'partial', 'completed', 'failed', 'cancelled']),
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.optional(),
  size: z.number().int().nonnegative().optional(),
  checksum: checksumSchema.optional(),
  execution: executionSchema,
  validation: validationSchema,
}).strict().superRefine((manifest, context) => {
  if (manifest.updatedAt < manifest.createdAt) {
    context.addIssue({ code: 'custom', message: 'result updatedAt cannot precede createdAt' })
  }
  if (manifest.completedAt !== undefined && manifest.completedAt < manifest.createdAt) {
    context.addIssue({ code: 'custom', message: 'result completedAt cannot precede createdAt' })
  }
  if (manifest.status === 'completed') {
    if (manifest.size === undefined || manifest.size === 0) {
      context.addIssue({ code: 'custom', message: 'completed result must have size > 0' })
    }
    if (manifest.checksum === undefined) {
      context.addIssue({ code: 'custom', message: 'completed result requires a checksum' })
    }
    if (manifest.completedAt === undefined) {
      context.addIssue({ code: 'custom', message: 'completed result requires completedAt' })
    }
    if (manifest.validation.status !== 'passed') {
      context.addIssue({ code: 'custom', message: 'completed result requires passed validation' })
    }
  }
})

/** Strict public runtime schema for one whole durable Result Manifest. */
export const resultManifestSchema = resultManifestObjectSchema as ZodType<ResultManifest>

/** Strict durable Session-event payload schema for a Task Checkpoint revision. */
export const taskCheckpointEventDataSchema: ZodType<TaskCheckpointEventData> = z.object({
  kind: z.literal('task/checkpoint'),
  version: z.literal(1),
  checkpoint: taskCheckpointSchema,
}).strict()

/** Strict durable Session-event payload schema for a Result Manifest revision. */
export const resultManifestEventDataSchema: ZodType<ResultManifestEventData> = z.object({
  kind: z.literal('task/result-manifest'),
  version: z.literal(1),
  manifest: resultManifestSchema,
}).strict()

const hazardSchema = z.object({
  taskId: taskIdSchema,
  callId: normalized('callId'),
  code: z.enum(['TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN']),
  eventSeq: z.number().int().nonnegative().transform(SessionSeq),
}).strict()

const successfulToolResultSchema = z.object({
  eventSeq: z.number().int().nonnegative().transform(SessionSeq),
  callId: normalized('callId'),
}).strict()

/** Projection-cache schema for task checkpoints and repair hazards. */
const taskCheckpointProjectionStateObjectSchema = z.object({
  tasks: z.array(taskCheckpointSchema),
  latestTaskId: taskIdSchema.optional(),
  repairHazards: z.array(hazardSchema),
  successfulToolResults: z.array(successfulToolResultSchema),
  failure: z.string().nullable(),
}).strict()

/** Strict public schema for cached Task projection state. */
export const taskCheckpointProjectionStateSchema
  = taskCheckpointProjectionStateObjectSchema as ZodType<TaskCheckpointProjectionState>

/** Projection-cache schema for result manifests. */
export const resultManifestProjectionStateSchema: ZodType<ResultManifestProjectionState> = z.object({
  manifests: z.array(resultManifestSchema),
  failure: z.string().nullable(),
}).strict()

/** Client wire schema for task checkpoints and hazards. */
export const taskCheckpointProjectionSchema = taskCheckpointProjectionStateObjectSchema
  .omit({ failure: true, successfulToolResults: true }) as ZodType<TaskCheckpointProjection>

/** Client wire schema for the result-manifest collection. */
export const resultManifestCollectionSchema = z.array(resultManifestSchema)
