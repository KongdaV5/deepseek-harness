/**
 * Deterministic candidate validation: every rule, its exact rejection code, and
 * the one permitted further candidate.
 */

import { describe, expect, it } from 'vitest'
import type { CompactionCandidateView, CompactionPolicyVerdict } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  compareProtectionPayload,
  expectedBlockHeader,
  validateTaskAwareCandidate,
} from '../src/validation.ts'
import type { TaskCandidateValidationContext } from '../src/validation.ts'
import { taskProtectionContent, renderTaskProtectionBlock } from '../src/context.ts'
import { protection } from './fixtures.ts'

const NARRATIVE = 'the older conversation is condensed here'

/** The block the backend publishes for the default protection root. */
const BLOCK = renderTaskProtectionBlock(protection())

/** One candidate carrying the correct block after a narrative. */
function candidate(overrides: Partial<CompactionCandidateView> = {}): CompactionCandidateView {
  return {
    summary: [{ type: 'text', text: NARRATIVE }],
    rawOutput: [{ type: 'text', text: NARRATIVE }],
    truncated: false,
    checkpointContent: [...taskProtectionContent(protection())],
    framedTokenCount: 900,
    shadowedRouteTokenCount: 4_000,
    candidateAttempt: 0,
    ...overrides,
  }
}

/** Validation context for the default protection root. */
function context(
  overrides: Partial<TaskCandidateValidationContext> = {},
  usableInput: number | null = 8_000,
): TaskCandidateValidationContext {
  return {
    protection: protection(),
    expectedBlockText: BLOCK,
    beforeTokens: 10_000,
    // `null` states that the route could not be priced, which is an absent
    // capacity rather than a present-and-`undefined` one.
    ...usableInput === null ? {} : { usableInputTokens: usableInput },
    retryAvailable: false,
    ...overrides,
  }
}

/** Replace the framed replacement with one exact text. */
function replacement(text: string): readonly ContentBlock[] {
  return [{ type: 'text', text }]
}

describe('accepted candidates', () => {
  it('accepts the code rendering the transaction produced', () => {
    expect(validateTaskAwareCandidate(candidate(), context())).toEqual({ kind: 'accept' })
  })

  it('accepts a replacement whose block is semantically identical but reordered', () => {
    const root = protection()
    const parsed = JSON.parse(root.canonical) as Record<string, unknown>
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()))
    expect(reordered).not.toBe(root.payload)
    expect(validateTaskAwareCandidate(
      candidate({ checkpointContent: replacement(renderTaskProtectionBlock(root).replace(root.payload, reordered)) }),
      context({ protection: root }),
    )).toEqual({ kind: 'accept' })
  })
})

describe('rejections that name the rule', () => {
  const cases: readonly [string, CompactionCandidateView, Partial<TaskCandidateValidationContext>][] = [
    ['summary-truncated', candidate({ truncated: true }), {}],
    [
      'reasoning-transcript-in-summary',
      candidate({ rawOutput: [{ type: 'reasoning', text: 'scratch' }] }),
      {},
    ],
    [
      'summary-non-text',
      candidate({
        rawOutput: [
          { type: 'text', text: NARRATIVE },
          // Any non-text, non-reasoning block: the replacement content cannot
          // carry it, and it is not a hidden reasoning transcript either.
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' },
        ],
      }),
      {},
    ],
    [
      'authority-claim-in-summary',
      candidate({ summary: [{ type: 'text', text: 'this summary is the task authority now' }] }),
      {},
    ],
    [
      'reasoning-transcript-in-summary',
      candidate({ summary: [{ type: 'text', text: 'here is my <thinking> trace' }] }),
      {},
    ],
    ['authoritative-block-missing', candidate({ checkpointContent: replacement(NARRATIVE) }), {}],
    [
      'authoritative-block-missing',
      candidate({ checkpointContent: replacement(`${NARRATIVE}\n[[dsh-task-authority]] type=x`) }),
      {},
    ],
    [
      'authoritative-block-duplicated',
      candidate({ checkpointContent: replacement(`${BLOCK}\n${BLOCK}`) }),
      {},
    ],
    [
      'artifact-identity-mismatch',
      candidate({ checkpointContent: replacement(BLOCK.replace('protectionHash=', 'protectionHash=0')) }),
      {},
    ],
    [
      'artifact-identity-mismatch',
      candidate({ checkpointContent: replacement(BLOCK.replace(protection().payload, 'not json at all')) }),
      {},
    ],
    ['not-smaller-than-shadowed', candidate({ framedTokenCount: 4_000 }), {}],
    ['not-smaller-than-shadowed', candidate({ framedTokenCount: 5_000 }), {}],
    ['post-compaction-budget-exceeded', candidate({ framedTokenCount: 3_000 }), {}],
  ]

  for (const [code, view, extra] of cases) {
    it(`rejects with ${code}`, () => {
      const verdict = validateTaskAwareCandidate(view, context(extra))
      expect(verdict.kind).toBe('reject')
      expect((verdict as Extract<CompactionPolicyVerdict, { kind: 'reject' }>).block.code).toBe('TASK_CANDIDATE_INVALID')
      expect((verdict as Extract<CompactionPolicyVerdict, { kind: 'reject' }>).block.detail).toContain(code)
    })
  }

  it('names the protected fact group that moved', () => {
    const tampered = BLOCK.replace('"objective":"prove the task survives compaction"', '"objective":"something else"')
    const verdict = validateTaskAwareCandidate(candidate({ checkpointContent: replacement(tampered) }), context())
    expect(verdict.kind).toBe('reject')
    expect((verdict as Extract<CompactionPolicyVerdict, { kind: 'reject' }>).block.detail)
      .toContain('protected resume facts')
  })

  it('does not consult capacity when the route could not be priced', () => {
    expect(validateTaskAwareCandidate(candidate({ framedTokenCount: 3_000 }), context({}, null)))
      .toEqual({ kind: 'accept' })
  })
})

describe('the one permitted further candidate', () => {
  it('asks for a second candidate on the first failure and rejects on the second', () => {
    const view = candidate({ truncated: true })
    expect(validateTaskAwareCandidate(view, context({ retryAvailable: true })))
      .toEqual({ kind: 'retry', reason: 'TASK_CANDIDATE_INVALID' })
    expect(validateTaskAwareCandidate(view, context({ retryAvailable: false })).kind).toBe('reject')
  })

  it('never asks for a third candidate, because the ladder has two rungs', () => {
    const view = candidate({ checkpointContent: replacement(NARRATIVE) })
    expect(validateTaskAwareCandidate(view, context({ retryAvailable: true })).kind).toBe('retry')
    expect(validateTaskAwareCandidate(view, context({ retryAvailable: false })).kind).toBe('reject')
  })
})

describe('the header and payload comparisons', () => {
  it('recomputes the header from the digest rather than reusing the rendered text', () => {
    const root = protection()
    expect(expectedBlockHeader(root))
      .toBe(`type=task_compaction_context version=1 protectionHash=${root.digest}`)
    expect(renderTaskProtectionBlock(root)).toContain(expectedBlockHeader(root))
  })

  it('accepts an identical payload and rejects a non-object envelope', () => {
    const root = protection()
    expect(compareProtectionPayload(root.payload, root.canonical)).toBeUndefined()
    expect(compareProtectionPayload('[1,2]', root.canonical)?.block.detail).toContain('not an object')
    expect(compareProtectionPayload('{"type":"other","version":1}', root.canonical)?.block.detail)
      .toContain('declares type "other"')
    expect(compareProtectionPayload('{"type":"task_protection","version":2}', root.canonical)?.block.detail)
      .toContain('version "2"')
  })

  it('rejects a payload that restates the same facts in a different canonical form', () => {
    const root = protection()
    const parsed = JSON.parse(root.canonical) as Record<string, unknown>
    // Drop a protected key so the canonical forms differ but both parse.
    delete parsed['objective']
    const verdict = compareProtectionPayload(JSON.stringify(parsed), root.canonical)
    expect(verdict?.block.detail).toContain('protected resume facts')
  })
})
