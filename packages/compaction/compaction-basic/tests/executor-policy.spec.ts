/**
 * Executor-level proof that `BasicCompactionEngine` consults the optional
 * candidate policy *before* it does anything destructive, and that a refusal
 * leaves the surface exactly as it was found.
 *
 * The engine is the only compaction executor. This suite proves the two
 * admission call sites — pressure and context overflow — and that the audit a
 * policy reports reaches the durable `compaction/summary` record.
 *
 * @module @deepseek-ai/dsh-compaction-basic/tests/executor-policy
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { CompactionPolicyRejectionError } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAssessInput,
  CompactionBeginInput,
  CompactionCandidatePolicy,
  CompactionCandidateView,
  CompactionPolicyAdmission,
  CompactionPolicyAudit,
  CompactionPolicyBlock,
  CompactionPolicyTransaction,
  CompactionPolicyVerdict,
  CompactionRequestDecoration,
} from '@deepseek-ai/dsh-compaction'
import {
  createMessage,
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'
const SUMMARY_BLOCKS: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]

class ContextAdapter extends LlmAdapter {
  /**
   * @param contextWindow - capacity this route advertises.
   */
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(contextWindow = 1_000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new ContextAdapter(contextWindow))
  return ctx
}

/** Closed two-message turns followed by one open turn for durable brackets. */
function conversation(turns = 4, text = 'fixture '.repeat(120).trim()): Session {
  const session = Session.create(SessionId(`executor-policy-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

function agent(session: Session, model: string = MODEL): Agent {
  return { session, options: { provider: model, model } } as Agent
}

/** Every event of one type, in log order. */
function eventsOf<K extends SessionEvent['type']>(
  session: Session,
  type: K,
): Array<Extract<SessionEvent, { type: K }>> {
  const found: Array<Extract<SessionEvent, { type: K }>> = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))!
    if (event.type === type) found.push(event as Extract<SessionEvent, { type: K }>)
  }
  return found
}

/** The policy this suite scripts: one fixed admission, one inert transaction. */
class ScriptedPolicy implements CompactionCandidatePolicy {
  readonly id = 'scripted-policy'
  readonly version = '1.2.3'
  readonly assessments: CompactionAssessInput[] = []
  readonly begins: CompactionBeginInput[] = []

  /**
   * @param admission - the fixed admission decision.
   * @param beginFailure - when set, `begin` throws it.
   */
  constructor(
    private readonly admission: CompactionPolicyAdmission = { admitted: true },
    private readonly beginFailure?: Error,
  ) {}

  assess(input: CompactionAssessInput): CompactionPolicyAdmission {
    this.assessments.push(input)
    return this.admission
  }

  begin(input: CompactionBeginInput): CompactionPolicyTransaction {
    this.begins.push(input)
    if (this.beginFailure !== undefined) throw this.beginFailure
    return {
      decorateRequest: (): CompactionRequestDecoration => ({}),
      validateCandidate: (): CompactionPolicyVerdict => ({ kind: 'accept' }),
      rebaseAfterOwnedRecovery: (): void => {},
      assertPublishable: (): void => {},
      audit: (): CompactionPolicyAudit => ({
        policyId: 'scripted-policy',
        policyVersion: '1.2.3',
        trigger: input.trigger,
        candidateAttempts: 1,
        authorityAsOfSeq: 3,
        protectionHash: 'deadbeef',
      }),
    }
  }
}

/** The engine with a deterministic summarizer and no model-free pruner mounted. */
class ScriptedEngine extends BasicCompactionEngine {
  readonly calls: SummarizationInput[] = []
  readonly decorations: Array<CompactionRequestDecoration | undefined> = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
    decoration?: CompactionRequestDecoration,
  ): Promise<SummaryResult> {
    this.calls.push(input)
    this.decorations.push(decoration)
    return { summary: SUMMARY_BLOCKS, provider: 'summary-provider', model: 'summary-model', maxTokens: 123 }
  }
}

function engine(
  config: BasicCompactionConfig = { auto: false },
  ctx: Context = createContext(),
): ScriptedEngine {
  return new ScriptedEngine(ctx, config)
}

describe('BasicCompactionEngine and the optional candidate policy', () => {
  it('never consults a policy that is not mounted', async () => {
    const ctx = createContext()
    const compact = engine({ auto: false }, ctx)
    const session = conversation(4)

    const result = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)

    expect(result).not.toBeNull()
    expect(compact.calls).toHaveLength(1)
    const summary = eventsOf(session, 'compaction/summary')
    expect(summary).toHaveLength(1)
    expect(Object.hasOwn(summary[0]!.data, 'policyAudit')).toBe(false)
  })

  it('admits through the policy on pressure and records the audit it reported', async () => {
    const ctx = createContext()
    const policy = new ScriptedPolicy()
    ctx.provide('compactionCandidatePolicy', policy)
    const compact = engine({ auto: false }, ctx)
    const session = conversation(4)

    const result = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)

    expect(result).not.toBeNull()
    // The admission ran before the bracket opened, with the priced surface and
    // the capacity the routed model actually advertised.
    expect(policy.assessments).toHaveLength(1)
    const assessment = policy.assessments[0]!
    expect(assessment.session).toBe(session)
    expect(assessment.trigger).toBe('pressure')
    expect(assessment.beforeTokens).toBeGreaterThan(0)
    expect(assessment.contextWindow).toBe(1_000)
    expect(assessment.maxTokens).toBeGreaterThan(0)
    expect(policy.begins).toHaveLength(1)
    expect(policy.begins[0]!.trigger).toBe('pressure')
    expect(policy.begins[0]!.compactionId).toBe(result?.compactionId)

    expect(eventsOf(session, 'compaction/summary')[0]!.data.policyAudit).toMatchObject({
      policyId: 'scripted-policy',
      policyVersion: '1.2.3',
      trigger: 'pressure',
      candidateAttempts: 1,
      protectionHash: 'deadbeef',
    })
  })

  it('admits through the policy on context overflow before anything destructive', async () => {
    const ctx = createContext()
    const policy = new ScriptedPolicy()
    ctx.provide('compactionCandidatePolicy', policy)
    const compact = engine({ auto: false }, ctx)
    const session = conversation(4)

    const result = await compact.compactIfNeeded(agent(session), 'context-overflow', SIGNAL)

    expect(result).not.toBeNull()
    expect(policy.assessments.map(assessment => assessment.trigger)).toEqual(['context-overflow'])
    // Overflow prices no capacity up front, so the policy makes no capacity claim.
    expect(policy.assessments[0]!.contextWindow).toBeUndefined()
    expect(eventsOf(session, 'compaction/summary')[0]!.data.policyAudit).toMatchObject({
      trigger: 'context-overflow',
    })
  })

  it('refuses the operation before opening a bracket, leaving the surface untouched', async () => {
    const block: CompactionPolicyBlock = {
      code: 'TASK_AUTHORITY_UNAVAILABLE',
      reason: 'unknown-outcome-hazard',
      detail: 'a destructive execution has an unknown outcome',
    }
    const ctx = createContext()
    const policy = new ScriptedPolicy({ admitted: false, block })
    ctx.provide('compactionCandidatePolicy', policy)
    const compact = engine({ auto: false }, ctx)
    const session = conversation(4)
    const surfaceBefore = [...session.surface.nodes]
    const seqBefore = session.seq

    const failure = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CompactionPolicyRejectionError)
    expect((failure as CompactionPolicyRejectionError).policyId).toBe('scripted-policy')
    expect((failure as CompactionPolicyRejectionError).block).toEqual(block)
    // Nothing destructive happened: no bracket, no summary, no model call.
    expect(eventsOf(session, 'compaction/start')).toHaveLength(0)
    expect(eventsOf(session, 'compaction/summary')).toHaveLength(0)
    expect(compact.calls).toHaveLength(0)
    expect(session.seq).toBe(seqBefore)
    expect([...session.surface.nodes]).toEqual(surfaceBefore)
  })

  it('fails closed when the mounted policy cannot open the transaction', async () => {
    const beginFailure = new Error('TASK_AUTHORITY_UNAVAILABLE: the session tracks no Task to protect')
    const ctx = createContext()
    ctx.provide('compactionCandidatePolicy', new ScriptedPolicy({ admitted: true }, beginFailure))
    const compact = engine({ auto: false }, ctx)
    const session = conversation(4)

    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).rejects.toBe(beginFailure)

    // The bracket opened before `begin`, and the failure closed it.
    expect(eventsOf(session, 'compaction/start')).toHaveLength(1)
    expect(eventsOf(session, 'compaction/summary')).toHaveLength(0)
    expect(compact.calls).toHaveLength(0)
  })

  it('carries the policy decoration into the auxiliary request the engine sends', async () => {
    const ctx = createContext()
    const transaction: CompactionPolicyTransaction = {
      decorateRequest: () => ({ supplementalMessages: [createUserMessage({
        content: [{ type: 'text', text: 'policy background' }],
        source: { kind: 'plugin', plugin: 'executor-policy-test' },
      })] }),
      validateCandidate: (_candidate: CompactionCandidateView): CompactionPolicyVerdict => ({ kind: 'accept' }),
      rebaseAfterOwnedRecovery: (): void => {},
      assertPublishable: (): void => {},
      audit: (): CompactionPolicyAudit => ({
        policyId: 'decorating-policy',
        policyVersion: '1.0.0',
        trigger: 'pressure',
        candidateAttempts: 1,
      }),
    }
    const policy: CompactionCandidatePolicy = {
      id: 'decorating-policy',
      version: '1.0.0',
      assess: () => ({ admitted: true }),
      begin: () => transaction,
    }
    ctx.provide('compactionCandidatePolicy', policy)
    const compact = engine({ auto: false }, ctx)
    const session = conversation(4)

    await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)

    expect(compact.decorations).toHaveLength(1)
    expect(compact.decorations[0]?.supplementalMessages).toHaveLength(1)
    expect(eventsOf(session, 'compaction/summary')[0]!.data.policyAudit).toMatchObject({
      policyId: 'decorating-policy',
    })
  })

  it('passes a configured further-candidate budget through to the transaction', async () => {
    const ctx = createContext()
    const seen: number[] = []
    let attempts = 0
    const policy: CompactionCandidatePolicy = {
      id: 'retrying-policy',
      version: '1.0.0',
      assess: () => ({ admitted: true }),
      begin: () => ({
        decorateRequest: () => ({}),
        validateCandidate: (candidate: CompactionCandidateView): CompactionPolicyVerdict => {
          seen.push(candidate.candidateAttempt)
          attempts += 1
          return attempts === 1 ? { kind: 'retry', reason: 'TASK_CANDIDATE_INVALID' } : { kind: 'accept' }
        },
        rebaseAfterOwnedRecovery: (): void => {},
        assertPublishable: (): void => {},
        audit: (): CompactionPolicyAudit => ({
          policyId: 'retrying-policy',
          policyVersion: '1.0.0',
          trigger: 'pressure',
          candidateAttempts: attempts,
        }),
      }),
    }
    ctx.provide('compactionCandidatePolicy', policy)
    const compact = engine({ auto: false, maxSummaryValidationRetries: 1 }, ctx)
    const session = conversation(4)

    const result = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)

    expect(result).not.toBeNull()
    // Default is zero retries; the DS deployment sets one, and that is what the
    // executor honors.
    expect(seen).toEqual([0, 1])
    expect(compact.calls).toHaveLength(2)
  })

  it('stops at one candidate when the configured budget is the upstream default', async () => {
    const ctx = createContext()
    const policy: CompactionCandidatePolicy = {
      id: 'retrying-policy',
      version: '1.0.0',
      assess: () => ({ admitted: true }),
      begin: () => ({
        decorateRequest: () => ({}),
        validateCandidate: (): CompactionPolicyVerdict => ({ kind: 'retry', reason: 'TASK_CANDIDATE_INVALID' }),
        rebaseAfterOwnedRecovery: (): void => {},
        assertPublishable: (): void => {},
        audit: (): CompactionPolicyAudit => ({
          policyId: 'retrying-policy',
          policyVersion: '1.0.0',
          trigger: 'pressure',
          candidateAttempts: 1,
        }),
      }),
    }
    ctx.provide('compactionCandidatePolicy', policy)
    const compact = engine({ auto: false }, ctx)
    const session = conversation(4)

    const failure = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CompactionPolicyRejectionError)
    expect((failure as CompactionPolicyRejectionError).block).toMatchObject({
      code: 'COMPACTION_POLICY_RETRY_EXHAUSTED',
    })
    expect(compact.calls).toHaveLength(1)
    expect(eventsOf(session, 'compaction/summary')).toHaveLength(0)
  })

  it('leaves a non-compacting operation alone when no policy is mounted', async () => {
    const compact = engine()
    const session = conversation(1)

    // Below threshold, so the engine never asks anyone anything.
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.toBeNull()
    expect(compact.calls).toHaveLength(0)
  })
})
