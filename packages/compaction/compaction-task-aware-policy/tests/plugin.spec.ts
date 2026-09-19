/**
 * The real policy service over the real projection registry and the real durable
 * Task authority.
 *
 * The point of these tests is the *fail-open* half: a Session that tracks no
 * Task must behave exactly as it would with no policy installed, because that is
 * what keeps the official profile — which mounts no policy at all — unchanged.
 * Nothing here mounts a second executor: the policy is a service the existing
 * compaction backend resolves.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { CompactionCandidateView } from '@deepseek-ai/dsh-compaction'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TaskCheckpoint from '@deepseek-ai/dsh-task-checkpoint'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TaskAwareCompactionPolicy from '../src/index.ts'
import { TASK_AWARE_POLICY_ID, TASK_AWARE_POLICY_VERSION } from '../src/types.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Mount the real policy over its real dependencies. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(TaskCheckpoint)
  await ctx.plugin(TaskAwareCompactionPolicy)
  return ctx
}

/** The mounted policy, resolved exactly the way the executor resolves it. */
function requirePolicy(ctx: Context): TaskAwareCompactionPolicy {
  const policy = ctx.get('compactionCandidatePolicy')
  if (!(policy instanceof TaskAwareCompactionPolicy)) {
    throw new Error('the task-aware compaction policy is not mounted')
  }
  return policy
}

/** A session that has committed no task event at all. */
function bareSession(ctx: Context): Session {
  return ctx.sessions.create(SessionId('session-plugin-1'))
}

/** One candidate the executor might offer. */
const CANDIDATE: CompactionCandidateView = {
  summary: [{ type: 'text', text: 'condensed' }],
  rawOutput: [{ type: 'text', text: 'condensed' }],
  truncated: false,
  checkpointContent: [{ type: 'text', text: 'condensed' }],
  framedTokenCount: 10,
  shadowedRouteTokenCount: 1_000,
  candidateAttempt: 0,
}

describe('the policy service', () => {
  it('registers the optional service the executor resolves', async () => {
    const ctx = await mount()
    const policy = requirePolicy(ctx)
    expect(policy).toBeInstanceOf(TaskAwareCompactionPolicy)
    expect(policy.id).toBe(TASK_AWARE_POLICY_ID)
    expect(policy.version).toBe(TASK_AWARE_POLICY_VERSION)
  })

  it('resolves as absent when no deployment mounted it', async () => {
    const ctx = new Context()
    context = ctx
    expect(ctx.get('compactionCandidatePolicy')).toBeUndefined()
  })
})

describe('a Session that tracks no Task', () => {
  it('admits every entry without asking for anything', async () => {
    const ctx = await mount()
    const policy = requirePolicy(ctx)
    const session = bareSession(ctx)
    for (const trigger of ['pressure', 'context-overflow', 'manual'] as const) {
      expect(await policy.assess({
        session,
        trigger,
        beforeTokens: 100_000,
        contextWindow: 131_072,
        maxTokens: 8_192,
      })).toEqual({ admitted: true })
    }
  })

  it('opens an inert transaction that changes nothing the executor sends or publishes', async () => {
    const ctx = await mount()
    const policy = requirePolicy(ctx)
    const session = bareSession(ctx)
    const transaction = await policy.begin({
      session,
      trigger: 'pressure',
      beforeTokens: 100_000,
      contextWindow: 131_072,
      maxTokens: 8_192,
      compactionId: CompactionId('compaction-1'),
      start: SessionSeq(0),
      end: SessionSeq(0),
      shadowedSeqs: [],
      shadowedTokenCount: 60_000,
      summarizationTarget: { provider: 'mock', model: 'mock' },
    })
    // No auxiliary reasoning, no supplement, and no replacement content: the
    // published replacement is exactly what the executor produced.
    expect(transaction.decorateRequest({
      provider: 'mock',
      model: 'mock',
      messages: [],
      maxTokens: 8_192,
      sessionId: String(session.id),
      candidateAttempt: 0,
    })).toEqual({})
    expect(transaction.validateCandidate(CANDIDATE)).toEqual({ kind: 'accept' })
    expect(() => { transaction.assertPublishable() }).not.toThrow()
    expect(() => { transaction.rebaseAfterOwnedRecovery('summary-error-recovery') }).not.toThrow()
    expect(transaction.audit()).toEqual({
      policyId: TASK_AWARE_POLICY_ID,
      policyVersion: TASK_AWARE_POLICY_VERSION,
      trigger: 'pressure',
      candidateAttempts: 1,
    })
  })

  it('reports the unprotected lifecycle as idle, which is a fact worth recording', async () => {
    const ctx = await mount()
    const policy = requirePolicy(ctx)
    const session = bareSession(ctx)
    expect(policy.diagnostics(String(session.id))).toBeUndefined()
    await policy.assess({ session, trigger: 'manual', beforeTokens: 10, maxTokens: 1 })
    expect(policy.diagnostics(String(session.id))).toMatchObject({
      status: 'idle',
      trigger: 'manual',
      protectedEvidenceCount: 0,
      mainRunReasoningUnchanged: true,
    })
  })
})

describe('authority that cannot be read', () => {
  it('refuses rather than guessing when the task projections are absent', async () => {
    // A context with the policy but no projection registry and no checkpoint
    // service cannot exist (the policy injects them), so the honest failure is
    // the missing registration, not a permissive fallback.
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(TaskAwareCompactionPolicy)
    expect(ctx.get('compactionCandidatePolicy')).toBeUndefined()
  })
})
