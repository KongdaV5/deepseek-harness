/**
 * The bounded in-run retry decision, over structured evidence only.
 *
 * The provider policy in every case is built by the current upstream
 * `resolveRetryPolicy`, so the retryability this policy composes over is the
 * contract the adapters actually publish rather than a restatement of it.
 */

import { describe, expect, it } from 'vitest'
import { resolveRetryPolicy, type LlmFailure, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ClassifiedRunError } from '@deepseek-ai/dsh-agent-run-state'
import {
  decideBoundedRetry,
  MAX_AUTOMATIC_ATTEMPTS,
  MAX_AUTOMATIC_RETRIES,
  type RetryDecision,
  type RetryDecisionInput,
} from '../src/index.ts'

const TIME = 1_726_600_000_000

/** The policy a provider route gets when it configures nothing. */
const DEFAULT_POLICY: ResolvedRetryPolicy = resolveRetryPolicy(undefined, 'test default')

/** The transient codes the current upstream contract names by default. */
const DEFAULT_TRANSIENT_CODES = DEFAULT_POLICY.mode === 'normal' ? DEFAULT_POLICY.retryableCodes : []

const ALWAYS_POLICY: ResolvedRetryPolicy = resolveRetryPolicy({ mode: 'always' }, 'test always')

function failure(code: string, extra: Partial<LlmFailure> = {}): LlmFailure {
  return { message: `provider reported ${code}`, code, ...extra }
}

function decide(overrides: Partial<RetryDecisionInput> = {}): RetryDecision {
  return decideBoundedRetry({
    failure: failure('TRANSPORT'),
    retryPolicy: DEFAULT_POLICY,
    retryCount: 0,
    maxRetryCount: MAX_AUTOMATIC_RETRIES,
    signalAborted: false,
    runOpen: true,
    time: TIME,
    ...overrides,
  })
}

describe('the ceiling is a product invariant', () => {
  it('caps automatic retries at two after the initial attempt', () => {
    expect(MAX_AUTOMATIC_RETRIES).toBe(2)
    expect(MAX_AUTOMATIC_ATTEMPTS).toBe(3)
  })
})

describe('A and B: a structured transient failure delegates, twice', () => {
  it('permits the first retry of a declared transient code', () => {
    expect(decide()).toEqual({
      kind: 'delegate',
      reason: 'UPSTREAM_RETRYABLE',
      category: 'TRANSPORT',
      severity: 'degraded',
      retryCount: 0,
      maxRetryCount: 2,
      nextAttempt: 1,
    })
  })

  it('permits the second retry of the same condition', () => {
    const decision = decide({ retryCount: 1 })
    expect(decision.kind).toBe('delegate')
    expect(decision.retryCount).toBe(1)
  })

  it('permits every code the current default contract names transient', () => {
    expect(DEFAULT_TRANSIENT_CODES.length).toBeGreaterThan(0)
    for (const code of DEFAULT_TRANSIENT_CODES) {
      expect(decide({ failure: failure(code) }), code).toMatchObject({ kind: 'delegate' })
    }
  })
})

describe('C: the budget is spent after retry two', () => {
  it('denies the third retry, so the chain stops at three attempts', () => {
    expect(decide({ retryCount: MAX_AUTOMATIC_RETRIES })).toEqual({
      kind: 'deny',
      reason: 'RETRY_BUDGET_EXHAUSTED',
      category: 'TRANSPORT',
      severity: 'degraded',
      retryCount: 2,
      maxRetryCount: 2,
    })
  })

  it('denies immediately when the cap is zero and stays denied past the cap', () => {
    expect(decide({ maxRetryCount: 0 })).toMatchObject({ kind: 'deny', reason: 'RETRY_BUDGET_EXHAUSTED' })
    expect(decide({ retryCount: 9 })).toMatchObject({ kind: 'deny', reason: 'RETRY_BUDGET_EXHAUSTED' })
  })

  it('keeps counting attempts rather than retries', () => {
    // initial attempt + retry 1 + retry 2 is the whole automatic chain.
    const permitted = [0, 1].map(retryCount => decide({ retryCount }).kind)
    expect(permitted).toEqual(['delegate', 'delegate'])
    expect(decide({ retryCount: MAX_AUTOMATIC_RETRIES }).kind).toBe('deny')
    expect(permitted.length + 1).toBe(MAX_AUTOMATIC_ATTEMPTS)
  })
})

describe('F: a fatal structured failure gets zero retries', () => {
  it('denies a fatal failure even when its code is otherwise retryable', () => {
    const decision = decide({ failure: failure('WORKER_CRASH', { status: 500 }) })
    expect(decision).toMatchObject({ kind: 'deny', reason: 'FATAL_FAILURE', category: 'WORKER_CRASH', severity: 'fatal' })
  })

  it('denies when the run already recorded a fatal primary error', () => {
    const primary: ClassifiedRunError = {
      code: 'RESOURCE_LIMIT',
      message: 'metal resource limit',
      severity: 'fatal',
      origin: 'backend',
      time: TIME,
    }
    expect(decide({ runPrimaryError: primary }))
      .toMatchObject({ kind: 'deny', reason: 'FATAL_FAILURE', category: 'TRANSPORT' })
  })

  it('does not treat a degraded recorded error as fatal', () => {
    const primary: ClassifiedRunError = {
      code: 'PROVIDER_TIMEOUT',
      message: 'slow',
      severity: 'degraded',
      origin: 'provider',
      time: TIME,
    }
    expect(decide({ runPrimaryError: primary })).toMatchObject({ kind: 'delegate' })
  })
})

describe('G: cancellation gets zero retries', () => {
  it('denies on an aborted signal even for a declared transient code', () => {
    expect(decide({ signalAborted: true }))
      .toMatchObject({ kind: 'deny', reason: 'CANCELLED', category: 'TRANSPORT' })
  })

  it('reports cancellation ahead of a fatal category', () => {
    expect(decide({ signalAborted: true, failure: failure('WORKER_CRASH') }))
      .toMatchObject({ kind: 'deny', reason: 'CANCELLED' })
  })
})

describe('H, I, J, K, L: the no-retry categories', () => {
  const cases: readonly [string, string, string][] = [
    ['H', 'CONTEXT_WINDOW_EXCEEDED', 'CONTEXT_OVERFLOW'],
    ['I', 'INVALID_REASONING_PARAMETER', 'INVALID_REASONING_PARAMETER'],
    ['I', 'INVALID_MODEL_CONFIG', 'INVALID_MODEL_CONFIG'],
    ['K', 'MAX_TOKENS', 'MAX_TOKENS'],
    ['L', 'TOOL_FAILED', 'TOOL_FAILED'],
  ]

  it.each(cases)('%s: %s gets zero automatic retries', (_group, code, category) => {
    const decision = decide({ failure: failure(code) })
    expect(decision).toMatchObject({ kind: 'deny', reason: 'NO_RETRY_CATEGORY', category })
  })

  it('denies the context overflow that Stage 10 owns rather than repeating it', () => {
    // The same failure under an always policy, which would otherwise retry it.
    expect(decide({ failure: failure('CONTEXT_LENGTH_EXCEEDED'), retryPolicy: ALWAYS_POLICY }))
      .toMatchObject({ kind: 'deny', reason: 'NO_RETRY_CATEGORY', category: 'CONTEXT_OVERFLOW' })
  })

  it('denies an interrupted Session that needs guarded resume rather than retry', () => {
    expect(decide({ failure: failure('SESSION_INTERRUPTED'), retryPolicy: ALWAYS_POLICY }))
      .toMatchObject({ kind: 'deny', reason: 'NO_RETRY_CATEGORY', category: 'SESSION_INTERRUPTED' })
  })

  it('denies a blocked run and a failed retry chain', () => {
    expect(decide({ failure: failure('BLOCKED'), retryPolicy: ALWAYS_POLICY }))
      .toMatchObject({ kind: 'deny', reason: 'NO_RETRY_CATEGORY', category: 'BLOCKED' })
    expect(decide({ failure: failure('RETRY_FAILED'), retryPolicy: ALWAYS_POLICY }))
      .toMatchObject({ kind: 'deny', reason: 'NO_RETRY_CATEGORY', category: 'RETRY_FAILED' })
  })

  it('J: denies a structurally unknown code under the default policy', () => {
    // A code the current contract names nowhere: it reaches neither a Stage 7
    // category nor the default retryable set, so it stays UNKNOWN and fails closed.
    const decision = decide({ failure: failure('SOMETHING_NEW') })
    expect(decision).toMatchObject({
      kind: 'deny',
      reason: 'NO_STRUCTURED_RETRYABILITY',
      category: 'UNKNOWN',
      severity: 'degraded',
    })
  })

  it('J: preserves UNKNOWN rather than promoting it to a transient category', () => {
    expect(decide({ failure: failure('UNKNOWN') })).toMatchObject({ kind: 'deny', category: 'UNKNOWN' })
    expect(decide({ failure: failure('EMAIL_NOT_VERIFIED', { status: 403 }) }))
      .toMatchObject({ kind: 'deny', category: 'UNKNOWN' })
  })
})

describe('the policy never loosens upstream retryability', () => {
  it('denies a code the captured normal policy does not name', () => {
    const narrow: ResolvedRetryPolicy = resolveRetryPolicy(
      { mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'] },
      'test narrow',
    )
    expect(decide({ failure: failure('TRANSPORT'), retryPolicy: narrow }))
      .toMatchObject({ kind: 'deny', reason: 'NO_STRUCTURED_RETRYABILITY', category: 'TRANSPORT' })
    expect(decide({ failure: failure('SERVER'), retryPolicy: narrow })).toMatchObject({ kind: 'delegate' })
  })

  it('denies when no provider policy was captured at all', () => {
    expect(decide({ retryPolicy: undefined }))
      .toMatchObject({ kind: 'deny', reason: 'NO_STRUCTURED_RETRYABILITY' })
  })

  it('lets an always policy carry its documented transient set, still capped', () => {
    for (const code of DEFAULT_TRANSIENT_CODES) {
      expect(decide({ failure: failure(code), retryPolicy: ALWAYS_POLICY }), code)
        .toMatchObject({ kind: 'delegate' })
    }
    expect(decide({ failure: failure('TRANSPORT'), retryPolicy: ALWAYS_POLICY, retryCount: 2 }))
      .toMatchObject({ kind: 'deny', reason: 'RETRY_BUDGET_EXHAUSTED' })
  })

  it('refuses to extend always mode to a failure no current contract can name', () => {
    expect(decide({ failure: failure('SOMETHING_NEW'), retryPolicy: ALWAYS_POLICY }))
      .toMatchObject({ kind: 'deny', reason: 'NO_STRUCTURED_RETRYABILITY', category: 'UNKNOWN' })
  })
})

describe('retry is in-run only', () => {
  it('denies when no durable turn is open for the failed step', () => {
    expect(decide({ runOpen: false }))
      .toMatchObject({ kind: 'deny', reason: 'RUN_NOT_RETRYABLE' })
  })

  it('denies a context overflow before it denies a closed run, keeping the category readable', () => {
    // Ordering is observable: the more specific structured reason wins.
    expect(decide({ runOpen: false, failure: failure('CONTEXT_WINDOW_EXCEEDED') }))
      .toMatchObject({ kind: 'deny', reason: 'RUN_NOT_RETRYABLE' })
  })

  it('carries the configured cap through every decision so an exhausted budget is explainable', () => {
    const denied = decide({ maxRetryCount: 1, retryCount: 1 })
    expect(denied).toMatchObject({ kind: 'deny', reason: 'RETRY_BUDGET_EXHAUSTED', retryCount: 1, maxRetryCount: 1 })
  })
})

describe('classification reads structure, never prose', () => {
  it('ignores message text entirely', () => {
    const talkative = failure('TRANSPORT', { message: 'CONTEXT LENGTH EXCEEDED — do not retry, fatal' })
    expect(decide({ failure: talkative })).toMatchObject({ kind: 'delegate', category: 'TRANSPORT' })
  })

  it('ignores an unavailable-code message on an otherwise eligible code', () => {
    const misleading = failure('TIMEOUT', { message: 'provider unavailable, backend unhealthy' })
    expect(decide({ failure: misleading })).toMatchObject({ kind: 'delegate', category: 'PROVIDER_TIMEOUT' })
  })
})
