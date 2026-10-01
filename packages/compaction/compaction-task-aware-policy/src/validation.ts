/**
 * Deterministic validation of one produced candidate.
 *
 * Every rule here is a comparison, not an opinion. The protection root was
 * serialized canonically at `begin`; validation re-parses what the replacement
 * actually carries and compares canonical forms. That ordering matters: an
 * ordered `criticalContext` list whose entries were reordered compares unequal,
 * and a duplicated string cannot pass by appearing twice.
 *
 * No rule consults a model. A second LLM would be a semantic judge with its own
 * failure modes, and a compaction that needs one cannot be proven to preserve
 * anything.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/validation
 */

import type { CompactionCandidateView, CompactionPolicyVerdict } from '@deepseek-ai/dsh-compaction'
import { canonicalJson } from './protection.ts'
import { parseTaskProtectionBlocks, textOfContent } from './context.ts'
import type { TaskCandidateRejectionCode, TaskProtection } from './types.ts'
import {
  TASK_AWARE_POLICY_VERSION,
  TASK_COMPACTION_BLOCK_TYPE,
  TASK_COMPACTION_BLOCK_VERSION,
} from './types.ts'

/**
 * Phrases in the narrative that claim the summary itself is task authority.
 *
 * A denylist, not a semantic judgment: each entry is a claim about authority
 * that is false by construction, because compaction never changes durable
 * authority. The list is deliberately narrow — a false rejection costs a
 * compaction, which is recoverable, while a missed claim would teach a later
 * model that prose outranks a checkpoint, which is not.
 */
const AUTHORITY_CLAIM_MARKERS: readonly string[] = [
  'replaces the task checkpoint',
  'supersedes the task checkpoint',
  'replaces the authoritative task',
  'the authoritative task state is',
  'is now the task authority',
  'this summary is the task authority',
]

/**
 * Markers of a leaked hidden reasoning transcript.
 *
 * The upstream vocabulary has a `reasoning` content block, so a genuine
 * transcript is normally already rejected as non-text; these catch the case
 * where a provider folds its scratchpad into ordinary text.
 */
const REASONING_TRANSCRIPT_MARKERS: readonly string[] = [
  '<reasoning>',
  '</reasoning>',
  '<thinking>',
  '</thinking>',
  '<scratchpad>',
  '</scratchpad>',
  '[reasoning]',
  'chain-of-thought:',
]

/** One protected fact group, compared as a unit so a mismatch names its group. */
interface ProtectionGroup {
  readonly name: string
  readonly project: (value: Record<string, unknown>) => unknown
}

/**
 * The fact groups validation compares independently.
 *
 * Splitting the protection value this way means a rejection tells a reader
 * which part of task authority moved, instead of only that something did.
 */
const PROTECTION_GROUPS: readonly ProtectionGroup[] = [
  {
    name: 'identity',
    project: value => pick(value, [
      'type', 'version', 'taskId', 'checkpointRevision', 'taskType', 'sessionId',
      'originRunId', 'latestRunId', 'status', 'modelRelation', 'authorityAsOfSeq',
    ]),
  },
  { name: 'execution', project: value => pick(value, ['originalExecution', 'latestExecution']) },
  { name: 'progress', project: value => pick(value, ['completedSteps', 'currentStep', 'pendingSteps']) },
  { name: 'resume', project: value => pick(value, ['objective', 'constraints', 'decisions', 'criticalContext']) },
  { name: 'recovery', project: value => pick(value, ['failureContext', 'resumeRecord', 'repairHazards']) },
  { name: 'evidence', project: value => pick(value, ['evidence', 'successfulToolResults']) },
  { name: 'results', project: value => pick(value, ['outputs', 'manifestReferences']) },
]

/** Project a fixed key set out of a record, preserving the requested order. */
function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const key of keys) projected[key] = value[key]
  return projected
}

/** A deterministic rejection with its precise rule. */
function reject(
  reason: TaskCandidateRejectionCode,
  message: string,
): TaskCandidateRejection {
  return { kind: 'reject', block: { code: 'TASK_CANDIDATE_INVALID', detail: `${reason}: ${message}` } }
}

/**
 * Everything validation needs beyond the candidate itself.
 *
 * `usableInputTokens` is `undefined` when the routed route's capacity could not
 * be resolved. Validation then proves the shrink and the protected facts but
 * makes no capacity claim, rather than asserting one it cannot support.
 */
export interface TaskCandidateValidationContext {
  /** The protection root captured at `begin`. */
  readonly protection: TaskProtection
  /** The exact block text the code rendered for this transaction. */
  readonly expectedBlockText: string
  /** Priced size of the surface the candidate was built from. */
  readonly beforeTokens: number
  /** The usable input budget of the next request, when capacity was resolved. */
  readonly usableInputTokens?: number
  /**
   * Whether one further candidate may be requested. The policy asks for at most
   * one, so the second failure of any rule is terminal.
   */
  readonly retryAvailable: boolean
}

/**
 * Validate one candidate against the captured protection root.
 * @param candidate - the candidate and its priced facts.
 * @param context - the captured protection and the resolved budget.
 * @returns accept, one permitted further candidate, or a deterministic rejection.
 */
export function validateTaskAwareCandidate(
  candidate: CompactionCandidateView,
  context: TaskCandidateValidationContext,
): CompactionPolicyVerdict {
  const failure = firstFailure(candidate, context)
  if (failure === undefined) return { kind: 'accept' }
  if (context.retryAvailable) {
    return { kind: 'retry', reason: failure.block.reason ?? failure.block.code }
  }
  return failure
}

/** A deterministic rejection of one candidate. */
export type TaskCandidateRejection = Extract<CompactionPolicyVerdict, { kind: 'reject' }>

/** The first deterministic rule this candidate fails, or `undefined` when it passes. */
function firstFailure(
  candidate: CompactionCandidateView,
  context: TaskCandidateValidationContext,
): TaskCandidateRejection | undefined {
  if (candidate.truncated) {
    return reject(
      'summary-truncated',
      'the provider ended the candidate at its generation cap, so the narrative is incomplete',
    )
  }

  for (const block of candidate.rawOutput) {
    if (block.type === 'text') continue
    if (block.type === 'reasoning') {
      return reject(
        'reasoning-transcript-in-summary',
        'the candidate returned a reasoning block, which is a hidden transcript rather than a summary',
      )
    }
    return reject(
      'summary-non-text',
      `the candidate returned a "${block.type}" block, which the replacement content cannot carry`,
    )
  }

  const narrative = textOfContent(candidate.summary).toLowerCase()
  for (const marker of AUTHORITY_CLAIM_MARKERS) {
    if (narrative.includes(marker)) {
      return reject(
        'authority-claim-in-summary',
        `the narrative claims to replace durable task authority ("${marker}")`,
      )
    }
  }
  for (const marker of REASONING_TRANSCRIPT_MARKERS) {
    if (narrative.includes(marker)) {
      return reject(
        'reasoning-transcript-in-summary',
        `the narrative carries a hidden reasoning transcript marker ("${marker}")`,
      )
    }
  }

  const replacement = textOfContent(candidate.checkpointContent)
  const parsed = parseTaskProtectionBlocks(replacement)
  if (parsed.malformed) {
    return reject(
      'authoritative-block-missing',
      'the replacement carries an unterminated authoritative block',
    )
  }
  if (parsed.blocks.length === 0) {
    return reject(
      'authoritative-block-missing',
      'the replacement carries no authoritative task block',
    )
  }
  if (parsed.blocks.length > 1) {
    return reject(
      'authoritative-block-duplicated',
      `the replacement carries ${String(parsed.blocks.length)} authoritative task blocks; exactly one is allowed`,
    )
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- length 1 was just proven
  const block = parsed.blocks[0]!
  if (block.header !== expectedBlockHeader(context.protection)) {
    return reject(
      'artifact-identity-mismatch',
      `the block header is "${block.header}", not the rendering this transaction produced`,
    )
  }
  if (block.payload !== context.protection.payload) {
    const mismatch = compareProtectionPayload(block.payload, context.protection.canonical)
    if (mismatch !== undefined) return mismatch
  }
  if (candidate.framedTokenCount >= candidate.shadowedRouteTokenCount) {
    return reject(
      'not-smaller-than-shadowed',
      `the framed replacement (${String(candidate.framedTokenCount)} tokens) is not smaller than the span it shadows (${String(candidate.shadowedRouteTokenCount)})`,
    )
  }
  if (context.usableInputTokens !== undefined) {
    const after = context.beforeTokens - candidate.shadowedRouteTokenCount + candidate.framedTokenCount
    if (after > context.usableInputTokens) {
      return reject(
        'post-compaction-budget-exceeded',
        `the post-compaction request would price at ${String(after)} tokens against a usable budget of ${String(context.usableInputTokens)}`,
      )
    }
  }
  return undefined
}

/**
 * The exact block header this transaction's code rendering produces.
 *
 * Recomputed from the protection digest rather than reused from the rendered
 * text, so validation compares against an independent expression of the same
 * fact instead of against the string it is checking.
 * @param protection - the captured protection root.
 * @returns the header text the block must carry.
 */
export function expectedBlockHeader(protection: TaskProtection): string {
  return `type=${TASK_COMPACTION_BLOCK_TYPE}`
    + ` version=${String(TASK_COMPACTION_BLOCK_VERSION)}`
    + ` protectionHash=${protection.digest}`
}

/**
 * Compare a parsed payload against the captured canonical serialization.
 *
 * The payload is parsed and re-serialized canonically, so a reordered object, a
 * duplicated key, or a reordered protected list all compare unequal while a
 * semantically identical payload still passes. A payload that is not JSON at
 * all, or whose envelope is not this artifact, is reported before any fact is
 * compared.
 * @param payload - the exact payload text the replacement carried.
 * @param expectedCanonical - the captured canonical serialization.
 * @returns `undefined` when the payload is identical, otherwise the rejection.
 */
export function compareProtectionPayload(
  payload: string,
  expectedCanonical: string,
): TaskCandidateRejection | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error: unknown) {
    return reject(
      'artifact-identity-mismatch',
      `the authoritative block payload is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reject('artifact-identity-mismatch', 'the authoritative block payload is not an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.type !== 'task_protection' || record.version !== Number(TASK_AWARE_POLICY_VERSION)) {
    return reject(
      'artifact-identity-mismatch',
      `the authoritative block payload declares type "${String(record.type)}" version "${String(record.version)}"`,
    )
  }
  if (canonicalJson(record) === expectedCanonical) return undefined
  let expected: Record<string, unknown>
  try {
    expected = JSON.parse(expectedCanonical) as Record<string, unknown>
  } catch {
    /* v8 ignore next -- the captured canonical form is produced by canonicalJson itself */
    return reject('protected-facts-mismatch', 'the captured protection canonical form is unreadable')
  }
  for (const group of PROTECTION_GROUPS) {
    if (canonicalJson(group.project(record)) !== canonicalJson(group.project(expected))) {
      return reject(
        'protected-facts-mismatch',
        `the replacement changed protected ${group.name} facts`,
      )
    }
  }
  return reject(
    'protected-facts-mismatch',
    'the replacement restated protected facts in a different canonical form',
  )
}
