/**
 * The task protection graph: the exact durable facts a compaction may not
 * silently change, their deterministic canonical serialization, and their
 * digest.
 *
 * Two properties matter more than anything else here.
 *
 * *Canonical means order-independent for objects and order-preserving for
 * arrays.* Object key insertion order is an accident of construction, so it
 * must not reach the hash; but a `constraints`, `decisions`, or
 * `criticalContext` list carries meaning in its order, so its order must reach
 * the hash. Serializing with a sorted key walk and untouched arrays is exactly
 * that distinction.
 *
 * *Evidence stays an identity, never prose.* A completed step is protected by
 * the exact `eventSeq`/`callId`, `outputId`/`manifestRevision`, or opaque
 * validator reference it cited. None of those can be regenerated from a
 * summary, which is why the protection is a reference and not a description.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/protection
 */

import { createHash } from 'node:crypto'
import type { TaskAuthoritySnapshot } from '@deepseek-ai/dsh-task-checkpoint'
import type {
  ResultManifest,
  TaskCheckpoint,
  TaskRepairHazard,
  SuccessfulTaskToolResult,
} from '@deepseek-ai/dsh-task-checkpoint'
import { TaskAwarePolicyError } from './errors.ts'
import type {
  ProtectedManifestReference,
  ProtectedReference,
  TaskProtection,
  TaskProtectionValue,
} from './types.ts'
import { TASK_AWARE_POLICY_VERSION } from './types.ts'

/**
 * Serialize a JSON-compatible value deterministically.
 *
 * Object keys are visited in sorted order and `undefined`-valued properties are
 * omitted, so two structurally equal values always produce the same string
 * regardless of how they were built. Arrays keep their order, because array
 * order is data. Non-finite numbers, functions, and symbols are rejected rather
 * than coerced: a protection digest computed over a coerced value would be a
 * digest of something no durable record says.
 * @param value - the value to serialize.
 * @returns the canonical one-line JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonical json: ${String(value)} is not a finite number`)
      }
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      break
    default:
      throw new Error(`canonical json: unsupported value of type ${typeof value}`)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/**
 * Digest one canonical serialization.
 * @param canonical - the canonical text.
 * @returns the lowercase hexadecimal SHA-256 digest.
 */
export function protectionDigest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Digest the exact referenced result revision set for comparison and reporting.
 * @param references - the exact referenced result revisions to digest.
 * @returns the lowercase hexadecimal SHA-256 digest of their canonical form.
 */
export function manifestReferenceDigest(
  references: readonly ProtectedManifestReference[],
): string {
  return protectionDigest(canonicalJson(references))
}

/**
 * The one exact result revision a checkpoint output is protected at.
 * @param manifests - every durable manifest revision in the cut.
 * @param outputId - the referenced output identity.
 * @returns the highest durable revision, or `undefined` when the output has none.
 */
function latestRevision(
  manifests: readonly ResultManifest[],
  outputId: string,
): ResultManifest | undefined {
  let latest: ResultManifest | undefined
  for (const manifest of manifests) {
    if (manifest.outputId !== outputId) continue
    if (latest === undefined || manifest.revision > latest.revision) latest = manifest
  }
  return latest
}

/** Project one durable manifest onto the exact facts a guard re-checks. */
function manifestReference(manifest: ResultManifest): ProtectedManifestReference {
  return {
    outputId: manifest.outputId,
    revision: manifest.revision,
    status: manifest.status,
    validation: manifest.validation.status,
    ...manifest.checksum === undefined ? {} : { checksum: manifest.checksum.value },
  }
}

/**
 * Turn one completed step's evidence into the exact identity it protects.
 *
 * Fails closed when the identity cannot be resolved in this cut: an unresolvable
 * citation is not a smaller problem than a missing one, because a summary that
 * silently replaced it would be indistinguishable from a correct one.
 * @param step - the completed step and its cited evidence.
 * @param snapshot - the authority cut the evidence must resolve in.
 * @returns the exact protected identity.
 * @throws TaskAwarePolicyError when the citation no longer resolves.
 */
function protectEvidence(
  step: TaskCheckpoint['completedSteps'][number],
  snapshot: TaskAuthoritySnapshot,
): ProtectedReference {
  const evidence = step.evidence
  const stepId = String(step.id)
  switch (evidence.kind) {
    case 'tool-result': {
      const match: SuccessfulTaskToolResult | undefined = snapshot.successfulToolResults
        .find(candidate => candidate.eventSeq === evidence.eventSeq)
      if (match === undefined || match.callId !== evidence.callId) {
        throw new TaskAwarePolicyError(
          'TASK_CHECKPOINT_EVIDENCE_MISSING',
          `completed step ${stepId} cites tool result event ${String(evidence.eventSeq)} call "${evidence.callId}", which no projected successful tool result satisfies`,
        )
      }
      return {
        kind: 'tool-result',
        stepId,
        eventSeq: evidence.eventSeq,
        callId: evidence.callId,
      }
    }
    case 'result-validation': {
      const manifest = snapshot.results
        .find(candidate => candidate.outputId === evidence.outputId)
      if (manifest === undefined) {
        throw new TaskAwarePolicyError(
          'TASK_RESULT_MANIFEST_REVISION_MISSING',
          `completed step ${stepId} cites result "${String(evidence.outputId)}" revision ${String(evidence.manifestRevision)}, which no durable manifest revision satisfies`,
        )
      }
      if (manifest.revision !== evidence.manifestRevision) {
        throw new TaskAwarePolicyError(
          'TASK_RESULT_MANIFEST_REVISION_MISSING',
          `completed step ${stepId} cites result "${String(evidence.outputId)}" revision ${String(evidence.manifestRevision)}, but the durable revision is ${String(manifest.revision)}`,
        )
      }
      if (manifest.validation.status !== 'passed') {
        throw new TaskAwarePolicyError(
          'TASK_RESULT_MANIFEST_REVISION_MISSING',
          `completed step ${stepId} cites result "${String(evidence.outputId)}" revision ${String(evidence.manifestRevision)}, whose validation status is "${manifest.validation.status}"`,
        )
      }
      return {
        kind: 'result-validation',
        stepId,
        outputId: evidence.outputId,
        manifestRevision: evidence.manifestRevision,
      }
    }
    case 'runtime-validation': {
      // The runtime that ran the validator owns resolution, and no owner
      // resolver exists for it here. The reference is therefore preserved as an
      // exact opaque identity rather than re-verified — but a citation with no
      // reference at all protects nothing, so it fails closed.
      if (evidence.validator.length === 0 || evidence.reference.length === 0) {
        throw new TaskAwarePolicyError(
          'TASK_EXTERNAL_REFERENCE_UNRESOLVED',
          `completed step ${stepId} cites a runtime validation with no validator or no external reference, so its protected external reference cannot be resolved`,
        )
      }
      return {
        kind: 'runtime-validation',
        stepId,
        validator: evidence.validator,
        reference: evidence.reference,
      }
    }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      throw new TaskAwarePolicyError(
        'TASK_CHECKPOINT_EVIDENCE_MISSING',
        `completed step ${stepId} cites an evidence kind this build cannot protect`,
      )
  }
}

/**
 * The repair hazards that belong to one Task, in projection order.
 * @param snapshot - the authority cut.
 * @param taskId - the protected Task identity.
 * @returns that Task's hazards.
 */
export function taskRepairHazards(
  snapshot: TaskAuthoritySnapshot,
  taskId: string,
): readonly TaskRepairHazard[] {
  return snapshot.repairHazards.filter(hazard => hazard.taskId === taskId)
}

/**
 * Capture the protection root for the addressed Task.
 *
 * The output is a value, a deterministic serialization of it, and the digest of
 * that serialization. Nothing here writes, and nothing here replaces durable
 * authority: the protected view is derived from the append-only log and the
 * log keeps every original event.
 * @param snapshot - one consistent, detached authority cut.
 * @returns the protection root.
 * @throws TaskAwarePolicyError when no Task is addressed, or when a protected
 *   fact cannot be resolved in this cut.
 */
export function protectTaskAuthority(snapshot: TaskAuthoritySnapshot): TaskProtection {
  const task = snapshot.task
  if (task === undefined) {
    throw new TaskAwarePolicyError(
      'TASK_AUTHORITY_UNAVAILABLE',
      'task-aware compaction was asked to protect authority for a Session that tracks no Task',
    )
  }

  const evidence = task.completedSteps.map(step => protectEvidence(step, snapshot))

  const references: ProtectedManifestReference[] = []
  const seen = new Set<string>()
  const record = (manifest: ResultManifest): void => {
    const key = `${manifest.outputId}#${String(manifest.revision)}`
    if (seen.has(key)) return
    seen.add(key)
    references.push(manifestReference(manifest))
  }
  for (const outputId of task.outputs) {
    const manifest = latestRevision(snapshot.results, outputId)
    if (manifest === undefined) {
      throw new TaskAwarePolicyError(
        'TASK_RESULT_MANIFEST_REVISION_MISSING',
        `the checkpoint names output "${String(outputId)}", which no durable result manifest revision satisfies`,
      )
    }
    record(manifest)
  }
  for (const step of task.completedSteps) {
    const citation = step.evidence
    if (citation.kind !== 'result-validation') continue
    const manifest = snapshot.results.find(candidate =>
      candidate.outputId === citation.outputId
      && candidate.revision === citation.manifestRevision)
    if (manifest === undefined) {
      throw new TaskAwarePolicyError(
        'TASK_RESULT_MANIFEST_REVISION_MISSING',
        `completed step ${String(step.id)} cites result "${String(citation.outputId)}" revision ${String(citation.manifestRevision)}, which no durable manifest satisfies`,
      )
    }
    record(manifest)
  }

  const value: TaskProtectionValue = {
    type: 'task_protection',
    version: Number(TASK_AWARE_POLICY_VERSION),
    taskId: task.taskId,
    checkpointRevision: task.revision,
    taskType: task.taskType,
    sessionId: task.sessionId,
    originRunId: task.originRunId,
    latestRunId: task.latestRunId,
    status: task.status,
    originalExecution: task.originalExecution,
    latestExecution: task.latestExecution,
    modelRelation: task.modelRelation,
    completedSteps: task.completedSteps,
    currentStep: task.currentStep ?? null,
    pendingSteps: task.pendingSteps,
    objective: task.resumeContext.objective,
    constraints: task.resumeContext.constraints,
    decisions: task.resumeContext.decisions,
    criticalContext: task.resumeContext.criticalContext,
    failureContext: task.failureContext ?? null,
    resumeRecord: task.latestResume ?? null,
    outputs: task.outputs,
    evidence,
    manifestReferences: references,
    repairHazards: taskRepairHazards(snapshot, task.taskId),
    successfulToolResults: snapshot.successfulToolResults,
    authorityAsOfSeq: snapshot.asOfSeq,
  }
  const canonical = canonicalJson(value)
  return {
    value,
    canonical,
    payload: canonical,
    digest: protectionDigest(canonical),
  }
}

/**
 * Whether the protected Task already carries an unknown external side effect.
 *
 * `TOOL_OUTCOME_UNKNOWN` means a tool may have acted outside the process and
 * nobody can say whether it did. No model summary can normalize that: a
 * compacted narrative would read exactly as calmly whether the effect happened
 * or not. `TOOL_NOT_STARTED` is the opposite fact — nothing ran — so it does not
 * by itself block anything, and it stays visible in the protected context either
 * way.
 * @param hazards - the Task's own repair hazards.
 * @returns the first unknown-outcome hazard, or `undefined`.
 */
export function unknownOutcomeHazard(
  hazards: readonly TaskRepairHazard[],
): TaskRepairHazard | undefined {
  return hazards.find(hazard => hazard.code === 'TOOL_OUTCOME_UNKNOWN')
}
