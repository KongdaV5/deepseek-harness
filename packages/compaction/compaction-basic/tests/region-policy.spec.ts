/**
 * Executor-level proof that `compactSurfaceRegion` consults the optional
 * candidate policy and gates publication on it.
 *
 * The policy package's own suites prove the decision matrices. This suite
 * proves the *executor* honors the seam: it opens the transaction against the
 * durable bracket, carries the decoration onto the real auxiliary request,
 * asks for the verdict on the candidate it actually produced, re-checks
 * publication synchronously, records the audit, and spends the configured
 * further-candidate budget before it refuses.
 *
 * @module @deepseek-ai/dsh-compaction-basic/tests/region-policy
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CompactionPolicyRejectionError } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAssessInput,
  CompactionBeginInput,
  CompactionCandidatePolicy,
  CompactionCandidateView,
  CompactionOwnedRecoveryCause,
  CompactionPolicyAdmission,
  CompactionPolicyAudit,
  CompactionPolicyTransaction,
  CompactionPolicyVerdict,
  CompactionRequestDecoration,
  CompactionRequestDraft,
} from '@deepseek-ai/dsh-compaction'
import { compactSurfaceRegion } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import type { CompactionPolicySeam } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'test-model'
const AUX_PROVIDER = 'aux-provider'
const AUX_MODEL = 'aux-model'
const AUX_MAX_TOKENS = 512

const SUMMARY_BLOCKS: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]
const POLICY_BLOCK: ContentBlock[] = [{ type: 'text', text: '<task_compaction_context> protected </task_compaction_context>' }]
const SUPPLEMENT: Message = createUserMessage({
  content: [{ type: 'text', text: 'policy background' }],
  source: { kind: 'plugin', plugin: 'region-policy-test' },
})

class StaticAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  // TokenMeter's constructor registers three projection units, so the registry
  // has to exist before it is mounted.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new StaticAdapter())
  return ctx
}

/** Three closed turns and one open turn, so a durable bracket can be opened. */
function policySession(turns = 3): Session {
  const session = Session.create(SessionId(`region-policy-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `fixture user ${turn} `.repeat(24) }],
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
        content: [{ type: 'text', text: `fixture assistant ${turn} `.repeat(24) }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Every event of one type, in log order. */
function eventsOf<K extends SessionEvent['type']>(
  session: Session,
  type: K,
): Array<Extract<SessionEvent, { type: K }>> {
  const found: Array<Extract<SessionEvent, { type: K }>> = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    // A monotonic log, so every seq below `session.seq` exists.
    const event = session.eventAt(SessionSeq(seq))!
    if (event.type === type) found.push(event as Extract<SessionEvent, { type: K }>)
  }
  return found
}

/** The policy a test scripts: admission is fixed, the transaction records everything. */
class RecordingPolicy implements CompactionCandidatePolicy {
  readonly id = 'recording-policy'
  readonly version = '9.9.9'
  readonly assessments: CompactionAssessInput[] = []
  readonly begins: CompactionBeginInput[] = []

  /**
   * @param transaction - the transaction `begin` hands back.
   * @param admission - the fixed admission decision.
   */
  constructor(
    private readonly transaction: CompactionPolicyTransaction | Error,
    private readonly admission: CompactionPolicyAdmission = { admitted: true },
  ) {}

  assess(input: CompactionAssessInput): CompactionPolicyAdmission {
    this.assessments.push(input)
    return this.admission
  }

  begin(input: CompactionBeginInput): CompactionPolicyTransaction {
    this.begins.push(input)
    if (this.transaction instanceof Error) throw this.transaction
    return this.transaction
  }
}

/** A transaction that records every executor interaction and answers on script. */
class RecordingTransaction implements CompactionPolicyTransaction {
  readonly drafts: CompactionRequestDraft[] = []
  readonly candidates: CompactionCandidateView[] = []
  readonly rebases: CompactionOwnedRecoveryCause[] = []
  publishChecks = 0
  auditCalls = 0

  /**
   * @param verdicts - the verdict for candidate N, defaulting to `accept`.
   * @param onPublish - runs inside the synchronous publication guard.
   */
  constructor(
    private readonly verdicts: readonly CompactionPolicyVerdict[] = [],
    private readonly onPublish?: () => void,
  ) {}

  decorateRequest(draft: CompactionRequestDraft): CompactionRequestDecoration {
    this.drafts.push(draft)
    return { supplementalMessages: [SUPPLEMENT], replacementContent: POLICY_BLOCK }
  }

  validateCandidate(candidate: CompactionCandidateView): CompactionPolicyVerdict {
    this.candidates.push(candidate)
    return this.verdicts[candidate.candidateAttempt] ?? { kind: 'accept' }
  }

  rebaseAfterOwnedRecovery(cause: CompactionOwnedRecoveryCause): void {
    this.rebases.push(cause)
  }

  assertPublishable(): void {
    this.publishChecks += 1
    this.onPublish?.()
  }

  audit(): CompactionPolicyAudit {
    this.auditCalls += 1
    return {
      policyId: 'recording-policy',
      policyVersion: '9.9.9',
      trigger: 'pressure',
      candidateAttempts: this.candidates.length,
      authorityAsOfSeq: 7,
      protectionHash: 'abc123',
    }
  }
}

interface HarnessOptions {
  /** The policy to install; omit for the policy-free upstream path. */
  readonly policy?: RecordingPolicy
  /** How many summary retries the executor is configured to permit. */
  readonly retries?: number
  /** Summarization calls that fail before the backend's own recovery applies. */
  readonly failures?: number
  /** Whether the backend's own recovery claim succeeds. */
  readonly recover?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const ctx = createContext()
  const session = policySession()
  // A detached copy: the surface shell rewrites its own node list when the
  // replacement lands, so the pre-compaction span has to be pinned here.
  const nodes = [...session.surface.nodes]
  const start = nodes[0] as SessionSeq
  // The fourth surface node closes turn 2's assistant message, so the span is a
  // balanced replacement target that leaves the newest turn visible.
  const end = nodes[3] as SessionSeq

  const summarizeCalls: SummarizationInput[] = []
  const decorationsSeen: Array<CompactionRequestDecoration | undefined> = []
  const recoveries: Array<readonly SessionSeq[]> = []
  let failures = options.failures ?? 0

  const seam: CompactionPolicySeam | undefined = options.policy === undefined
    ? undefined
    : {
      policy: options.policy,
      summarizationTarget: { provider: AUX_PROVIDER, model: AUX_MODEL },
      maxTokens: AUX_MAX_TOKENS,
      validationRetries: options.retries ?? 0,
    }

  const dependencies: Parameters<typeof compactSurfaceRegion>[0] = {
    meter: ctx.tokenMeter,
    summarize: async (input, _agent, _signal, decoration): Promise<SummaryResult> => {
      summarizeCalls.push(input)
      decorationsSeen.push(decoration)
      if (failures > 0) {
        failures -= 1
        throw new Error('auxiliary model failed')
      }
      return {
        summary: SUMMARY_BLOCKS,
        provider: AUX_PROVIDER,
        model: AUX_MODEL,
        maxTokens: AUX_MAX_TOKENS,
      }
    },
    recover: (_error, _agent, sourceEventSeqs) => {
      recoveries.push(sourceEventSeqs)
      return options.recover ?? false
    },
    ...seam === undefined ? {} : { policy: seam },
  }

  const agent = { session, options: {} } as Agent
  return { session, nodes, start, end, dependencies, agent, summarizeCalls, decorationsSeen, recoveries }
}

/** The replacement content the executor actually published, if any. */
function publishedContent(session: Session): readonly ContentBlock[] | undefined {
  return eventsOf(session, 'user/message').at(-1)?.data.content
}

describe('compactSurfaceRegion candidate-policy seam', () => {
  it('takes the upstream path and records no audit when no policy is mounted', async () => {
    const { session, dependencies, agent, start, end, summarizeCalls } = createHarness()

    const result = await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )

    expect(summarizeCalls).toHaveLength(1)
    expect(result.shadowedRange).toEqual({ start, end })
    const summary = eventsOf(session, 'compaction/summary')
    expect(summary).toHaveLength(1)
    // The optional audit field is absent, not present-and-undefined: an
    // unmodified deployment keeps a byte-identical `compaction/summary`.
    expect(Object.hasOwn(summary[0]!.data, 'policyAudit')).toBe(false)
    expect(eventsOf(session, 'compaction/end')).toHaveLength(1)
    expect(publishedContent(session)).toContainEqual({ type: 'text', text: 'small checkpoint' })
  })

  it('opens the transaction against the durable bracket with the priced span and resolved route', async () => {
    const transaction = new RecordingTransaction()
    const policy = new RecordingPolicy(transaction)
    const { session, nodes, dependencies, agent, start, end } = createHarness({ policy })

    const result = await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )

    // The bracket exists before the policy is told anything.
    expect(eventsOf(session, 'compaction/start')).toHaveLength(1)
    expect(policy.begins).toHaveLength(1)
    const begin = policy.begins[0]!
    expect(begin.session).toBe(session)
    expect(begin.trigger).toBe('pressure')
    expect(begin.compactionId).toBe(result.compactionId)
    expect(begin.start).toBe(start)
    expect(begin.end).toBe(end)
    expect(begin.shadowedSeqs).toEqual(nodes.slice(0, 4))
    expect(begin.shadowedTokenCount).toBeGreaterThan(0)
    expect(begin.beforeTokens).toBeGreaterThan(begin.shadowedTokenCount)
    expect(begin.summarizationTarget).toEqual({ provider: AUX_PROVIDER, model: AUX_MODEL })
    expect(begin.maxTokens).toBe(AUX_MAX_TOKENS)
  })

  it('carries the decoration onto the real auxiliary request and the published replacement', async () => {
    const transaction = new RecordingTransaction()
    const { session, dependencies, agent, start, end, decorationsSeen } = createHarness({
      policy: new RecordingPolicy(transaction),
    })

    await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )

    expect(transaction.drafts).toHaveLength(1)
    const draft = transaction.drafts[0]!
    expect(draft.provider).toBe(AUX_PROVIDER)
    expect(draft.model).toBe(AUX_MODEL)
    expect(draft.maxTokens).toBe(AUX_MAX_TOKENS)
    expect(draft.sessionId).toBe(session.id)
    expect(draft.candidateAttempt).toBe(0)
    expect(draft.messages.length).toBeGreaterThan(0)

    // The decoration reached the request the executor actually sent.
    expect(decorationsSeen[0]?.supplementalMessages).toEqual([SUPPLEMENT])
    // And the code-rendered block is the tail of the published replacement,
    // after the model's own narrative.
    const content = publishedContent(session)
    expect(content).toContainEqual({ type: 'text', text: 'small checkpoint' })
    expect(content?.at(-1)).toEqual(POLICY_BLOCK[0])
  })

  it('asks for a verdict on the candidate it produced and records the audit it reports', async () => {
    const transaction = new RecordingTransaction()
    const { session, dependencies, agent, start, end } = createHarness({
      policy: new RecordingPolicy(transaction),
    })

    await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )

    expect(transaction.candidates).toHaveLength(1)
    const view = transaction.candidates[0]!
    expect(view.candidateAttempt).toBe(0)
    expect(view.truncated).toBe(false)
    expect(view.summary).toEqual(SUMMARY_BLOCKS)
    expect(view.checkpointContent).toEqual(publishedContent(session))
    expect(view.framedTokenCount).toBeGreaterThan(0)
    expect(view.framedTokenCount).toBeLessThan(view.shadowedRouteTokenCount)
    expect(transaction.auditCalls).toBe(1)
    expect(transaction.publishChecks).toBe(1)

    const summary = eventsOf(session, 'compaction/summary')[0]!
    expect(summary.data.policyAudit).toEqual({
      policyId: 'recording-policy',
      policyVersion: '9.9.9',
      trigger: 'pressure',
      candidateAttempts: 1,
      authorityAsOfSeq: 7,
      protectionHash: 'abc123',
    })
  })

  it('refuses to publish when the synchronous guard rejects, leaving the surface unmutated', async () => {
    const guard = new Error('protected task authority changed during summarization')
    const transaction = new RecordingTransaction([], () => { throw guard })
    const { session, dependencies, agent, start, end } = createHarness({
      policy: new RecordingPolicy(transaction),
    })

    await expect(compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )).rejects.toBe(guard)

    // The guard ran, the candidate was accepted, and yet nothing was published.
    expect(transaction.publishChecks).toBe(1)
    expect(transaction.candidates).toHaveLength(1)
    expect(eventsOf(session, 'compaction/summary')).toHaveLength(0)
    expect(publishedContent(session)).not.toContainEqual(POLICY_BLOCK[0])
    // The failed bracket closed with the error, so the unmatched start stays detectable.
    const closed = eventsOf(session, 'compaction/end')
    expect(closed).toHaveLength(1)
    expect(closed[0]!.data.error).toBeDefined()
  })

  it('refuses publication when the policy rejects the produced candidate', async () => {
    const block = { code: 'TASK_CANDIDATE_INVALID', reason: 'summary-truncated', detail: 'the narrative was cut off' }
    const transaction = new RecordingTransaction([{ kind: 'reject', block }])
    const { session, dependencies, agent, start, end } = createHarness({
      policy: new RecordingPolicy(transaction),
    })

    const failure = await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CompactionPolicyRejectionError)
    expect((failure as CompactionPolicyRejectionError).policyId).toBe('recording-policy')
    expect((failure as CompactionPolicyRejectionError).block).toEqual(block)
    expect(transaction.publishChecks).toBe(0)
    expect(transaction.auditCalls).toBe(0)
    expect(eventsOf(session, 'compaction/summary')).toHaveLength(0)
  })

  it('spends the configured further candidates and then reports the exhausted budget', async () => {
    const retry: CompactionPolicyVerdict = { kind: 'retry', reason: 'TASK_CANDIDATE_INVALID' }
    const transaction = new RecordingTransaction([retry, retry, { kind: 'accept' }])
    const { session, dependencies, agent, start, end, summarizeCalls } = createHarness({
      policy: new RecordingPolicy(transaction),
      retries: 1,
    })

    const failure = await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    ).catch((error: unknown) => error)

    // One further candidate was permitted, and it was also refused.
    expect(summarizeCalls).toHaveLength(2)
    expect(transaction.drafts.map(draft => draft.candidateAttempt)).toEqual([0, 1])
    expect(failure).toBeInstanceOf(CompactionPolicyRejectionError)
    expect((failure as CompactionPolicyRejectionError).block).toMatchObject({
      code: 'COMPACTION_POLICY_RETRY_EXHAUSTED',
      reason: 'retry-exhausted',
    })
  })

  it('accepts the second candidate when the first only asked for another', async () => {
    const transaction = new RecordingTransaction([
      { kind: 'retry', reason: 'TASK_CANDIDATE_INVALID' },
      { kind: 'accept' },
    ])
    const { session, dependencies, agent, start, end, summarizeCalls } = createHarness({
      policy: new RecordingPolicy(transaction),
      retries: 1,
    })

    const result = await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )

    expect(summarizeCalls).toHaveLength(2)
    expect(result.shadowedRange).toEqual({ start, end })
    expect(transaction.candidates.map(view => view.candidateAttempt)).toEqual([0, 1])
    expect(eventsOf(session, 'compaction/summary')[0]!.data.policyAudit).toMatchObject({
      candidateAttempts: 2,
    })
  })

  it('rejects after a single candidate when no further candidate is permitted', async () => {
    const transaction = new RecordingTransaction([{ kind: 'retry', reason: 'TASK_CANDIDATE_INVALID' }])
    const { session, dependencies, agent, start, end, summarizeCalls } = createHarness({
      policy: new RecordingPolicy(transaction),
      retries: 0,
    })

    await expect(compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )).rejects.toBeInstanceOf(CompactionPolicyRejectionError)

    expect(summarizeCalls).toHaveLength(1)
  })

  it('rebases the policy after the backend own summary-error recovery', async () => {
    const transaction = new RecordingTransaction()
    const { session, dependencies, agent, start, end, summarizeCalls, recoveries } = createHarness({
      policy: new RecordingPolicy(transaction),
      failures: 1,
      recover: true,
    })

    await compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )

    // The recovery ran with the shadowed seqs, and the policy followed it.
    expect(summarizeCalls).toHaveLength(2)
    expect(recoveries).toHaveLength(1)
    expect(transaction.rebases).toEqual(['summary-error-recovery'])
    expect(transaction.candidates[0]!.candidateAttempt).toBe(0)
  })

  it('fails closed when the policy cannot open the transaction', async () => {
    const beginFailure = new Error('TASK_AUTHORITY_UNAVAILABLE: the session tracks no Task to protect')
    const policy = new RecordingPolicy(beginFailure)
    const { session, dependencies, agent, start, end, summarizeCalls } = createHarness({ policy })

    await expect(compactSurfaceRegion(
      dependencies, session, start, end, agent,
      { owner: 'current-turn', stability: 'selected-span', trigger: 'pressure' },
    )).rejects.toBe(beginFailure)

    // No model call and no replacement: the refusal happened before either.
    expect(summarizeCalls).toHaveLength(0)
    expect(eventsOf(session, 'compaction/summary')).toHaveLength(0)
    expect(eventsOf(session, 'compaction/end')).toHaveLength(1)
  })
})
