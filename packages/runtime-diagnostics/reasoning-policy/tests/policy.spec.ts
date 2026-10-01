/**
 * Reasoning policy over the current upstream capability seam.
 *
 * Every case here drives the real `dsh-llm` service with a scripted adapter:
 * the capability comes from `LlmRuntime.resolveModelInfo`, the resolution is
 * applied to a real call configuration, and the current upstream
 * `prepareCall` — the transport-side authority — is the thing that accepts or
 * rejects the result. Nothing is asserted against a restated capability table.
 */

import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmModelReasoningInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session/types'
import {
  advertisedReasoningEfforts,
  advertisesReasoningEffort,
  applyReasoningResolution,
  reasoningCapabilityOf,
  reasoningMetadataFromHeader,
  ReasoningPolicyError,
  requireResolvedReasoning,
  resolveReasoning,
  taskReasoningMetadata,
  UNSUPPORTED_REASONING_EFFORT_CODE,
} from '../src/index.ts'

const PROVIDER = 'local-qwen'
const MODEL = 'local-gguf-model'

const NONE = ReasoningEffortId('none')
const LOW = ReasoningEffortId('low')
const MEDIUM = ReasoningEffortId('medium')
const HIGH = ReasoningEffortId('high')
const XHIGH = ReasoningEffortId('xhigh')

/**
 * One scripted route. `reasoning` is the adapter-owned capability the policy
 * reads; `requests` records what actually reached the adapter boundary.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly reasoning: LlmResolvedModelInfo['reasoning']) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The audited shape of the target local route: four levels, one default, `high` absent. */
function localRouteCapability(): LlmModelReasoningInfo {
  return {
    efforts: [
      { id: NONE, name: 'None' },
      { id: LOW, name: 'Low' },
      { id: MEDIUM, name: 'Medium' },
      { id: XHIGH, name: 'Extra high' },
    ],
    defaultEffort: XHIGH,
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

interface RoutingHarness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly capability: LlmModelReasoningInfo | undefined
}

/**
 * The audited target route. Its capability is advertised, so the harness
 * reports it as present rather than as `T | undefined`.
 */
interface ReasoningRoutingHarness extends RoutingHarness {
  readonly capability: LlmModelReasoningInfo
}

/** Build one real `dsh-llm` route whose adapter publishes the supplied capability, if any. */
async function buildRoute(options: { readonly reasoning?: LlmModelReasoningInfo }): Promise<RoutingHarness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedAdapter(options.reasoning)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const info = await ctx.llm.resolveModelInfo(PROVIDER, MODEL)
  context = ctx
  return { ctx, adapter, capability: reasoningCapabilityOf(info) }
}

/**
 * The audited target route: four selectable levels and one adapter default.
 *
 * The capability returned is the very object the adapter published, so a case
 * that needs a present capability reads one instead of re-deriving it.
 */
async function routeHarness(): Promise<ReasoningRoutingHarness> {
  const reasoning = localRouteCapability()
  const harness = await buildRoute({ reasoning })
  return { ...harness, capability: reasoning }
}

/**
 * One route that publishes no reasoning block at all. A separate entry point
 * because an explicit `undefined` argument takes the default parameter above,
 * and "no reasoning capability" must be reachable on purpose.
 */
function routeHarnessWithoutReasoning(): Promise<RoutingHarness> {
  return buildRoute({})
}

describe('reasoning capability extraction', () => {
  it('reads the exact route capability from the current upstream model resolution', async () => {
    const { capability } = await routeHarness()
    expect(capability).toBeDefined()
    expect(advertisedReasoningEfforts(capability)).toEqual([NONE, LOW, MEDIUM, XHIGH])
    expect(advertisesReasoningEffort(capability, HIGH)).toBe(false)
    expect(advertisesReasoningEffort(capability, XHIGH)).toBe(true)
  })

  it('reports an absent reasoning block as a negative capability rather than a gap', async () => {
    const { capability } = await routeHarnessWithoutReasoning()
    expect(capability).toBeUndefined()
    expect(advertisedReasoningEfforts(capability)).toEqual([])
    expect(advertisesReasoningEffort(capability, LOW)).toBe(false)
  })
})

describe('A: supported requested reasoning resolves truthfully', () => {
  it('uses the requested level unchanged and drives it to the adapter', async () => {
    const { ctx, adapter, capability } = await routeHarness()

    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: MEDIUM, capability })
    expect(resolution).toEqual({
      kind: 'resolved',
      requested: MEDIUM,
      resolved: MEDIUM,
      source: 'request',
      provider: PROVIDER,
      model: MODEL,
      capability,
    })

    const proposed: LlmCallConfig = { provider: PROVIDER, model: MODEL, reasoningEffort: MEDIUM }
    const applied = applyReasoningResolution(proposed, requireResolvedReasoning(resolution))
    expect(applied.reasoningEffort).toBe(MEDIUM)

    // The transport-side authority accepts the result and preserves the value,
    // and it does not record the effort as an adapter-materialized default.
    const prepared = await ctx.llm.prepareCall(applied)
    expect(prepared.config.reasoningEffort).toBe(MEDIUM)
    expect(prepared.adapterDefaults.reasoningEffort).toBeUndefined()

    const stream = prepared.stream({ provider: PROVIDER, model: MODEL, messages: [], reasoningEffort: MEDIUM })
    for await (const _chunk of stream) { /* drain */ }
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.reasoningEffort).toBe(MEDIUM)
  })
})

describe('B: unsupported requested reasoning never becomes a wire parameter', () => {
  it('records the unsupported outcome with the advertised set and no resolved value', async () => {
    const { ctx, capability } = await routeHarness()

    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: HIGH, capability })
    expect(resolution).toMatchObject({
      kind: 'unsupported',
      requested: HIGH,
      reason: 'effort-not-offered',
      provider: PROVIDER,
      model: MODEL,
    })
    expect(advertisedReasoningEfforts(resolution.capability)).toEqual([NONE, LOW, MEDIUM, XHIGH])
    expect(taskReasoningMetadata(resolution)).toEqual({ requestedReasoning: HIGH })

    // Nothing is applied, and the current upstream authority rejects the same
    // value at the transport boundary, which is what the policy exists to
    // prevent the request from ever reaching.
    await expect(ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, reasoningEffort: HIGH }))
      .rejects.toMatchObject({ code: UNSUPPORTED_REASONING_EFFORT_CODE })
  })

  it('records a route with no reasoning capability as the reason the request is unsupported', async () => {
    const { capability } = await routeHarnessWithoutReasoning()
    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: LOW, capability })
    expect(resolution).toMatchObject({ kind: 'unsupported', requested: LOW, reason: 'route-declares-no-reasoning' })
    expect(resolution.capability).toBeUndefined()
  })

  it('resolves an empty request on a route with no reasoning capability to omission', async () => {
    const { capability } = await routeHarnessWithoutReasoning()
    expect(resolveReasoning({ provider: PROVIDER, model: MODEL, capability })).toEqual({
      kind: 'resolved',
      source: 'omitted',
      provider: PROVIDER,
      model: MODEL,
    })
  })
})

describe('C: requested and resolved stay distinct', () => {
  it('reports a provider default separately from an absent request, preserving both facts', async () => {
    const { capability } = await routeHarness()

    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, capability })
    expect(resolution).toEqual({
      kind: 'resolved',
      resolved: XHIGH,
      source: 'provider-default',
      provider: PROVIDER,
      model: MODEL,
      capability,
    })
    expect('requested' in resolution).toBe(false)
    expect(taskReasoningMetadata(resolution)).toEqual({ resolvedReasoning: XHIGH })
  })

  it('keeps a requested value that equals the route default attributed to the request', async () => {
    const { capability } = await routeHarness()
    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: XHIGH, capability })
    expect(resolution).toMatchObject({ requested: XHIGH, resolved: XHIGH, source: 'request' })
    expect(taskReasoningMetadata(resolution)).toEqual({
      requestedReasoning: XHIGH,
      resolvedReasoning: XHIGH,
    })
  })

  it('never escalates a requested level, even to the route default above it', async () => {
    const { capability } = await routeHarness()
    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: LOW, capability })
    expect(resolution).toMatchObject({ requested: LOW, resolved: LOW })
    expect(resolution.kind === 'resolved' && resolution.resolved).not.toBe(XHIGH)
  })
})

describe('D: an omitted reasoning value is never reported as an explicit level', () => {
  it('omits rather than inventing a level when the route declares no default', async () => {
    const { ctx, capability } = await buildRoute({ reasoning: { efforts: [{ id: LOW, name: 'Low' }] } })
    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, capability })
    expect(resolution).toMatchObject({ kind: 'resolved', source: 'omitted' })
    expect(resolution.kind === 'resolved' ? resolution.resolved : 'set').toBeUndefined()
    expect(taskReasoningMetadata(resolution)).toEqual({})

    const base: LlmCallConfig = { provider: PROVIDER, model: MODEL }
    const prepared = await ctx.llm.prepareCall(
      applyReasoningResolution(base, requireResolvedReasoning(resolution)),
    )
    expect(prepared.config.reasoningEffort).toBeUndefined()
  })

  it('clears any inherited effort rather than leaving the proposal behind', async () => {
    const { capability } = await buildRoute({ reasoning: { efforts: [{ id: LOW, name: 'Low' }] } })
    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, capability })
    const proposed: LlmCallConfig = { provider: PROVIDER, model: MODEL, temperature: 0.2, reasoningEffort: XHIGH }
    const applied = applyReasoningResolution(proposed, requireResolvedReasoning(resolution))
    expect('reasoningEffort' in applied).toBe(false)
    expect(applied.temperature).toBe(0.2)
    expect(applied.provider).toBe(PROVIDER)
  })

  it('reports the adapter-materialized effort as resolved-only when the header is read back', async () => {
    const { ctx } = await routeHarness()
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL })
    expect(prepared.config.reasoningEffort).toBe(XHIGH)
    expect(prepared.adapterDefaults.reasoningEffort).toBe(true)
    expect(reasoningMetadataFromHeader(headerFor(prepared.config, true)))
      .toEqual({ resolvedReasoning: XHIGH })
  })

  it('reports a caller-proposed effort as both requested and resolved', async () => {
    const { ctx } = await routeHarness()
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, reasoningEffort: LOW })
    expect(prepared.adapterDefaults.reasoningEffort).toBeUndefined()
    expect(reasoningMetadataFromHeader(headerFor(prepared.config, false)))
      .toEqual({ requestedReasoning: LOW, resolvedReasoning: LOW })
  })

  it('reports nothing when the committed header carries no reasoning effort at all', () => {
    expect(reasoningMetadataFromHeader(headerFor({ provider: PROVIDER, model: MODEL }, false))).toEqual({})
    expect(reasoningMetadataFromHeader(undefined)).toEqual({})
  })
})

/** The committed request header one prepared configuration produces. */
function headerFor(config: LlmCallConfig, adapterDefaulted: boolean): EpochHeader {
  return {
    config,
    ...adapterDefaulted ? { adapterDefaults: { reasoningEffort: true as const } } : {},
  }
}

describe('E: backend observation is not an input to reasoning resolution', () => {
  it('resolves identically with no backend observation of any kind', async () => {
    const { capability } = await routeHarness()
    const first = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: LOW, capability })
    const second = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: LOW, capability })
    expect(second).toEqual(first)
    expect(first.kind).toBe('resolved')
  })

  it('resolves a route that no adapter, endpoint, or observation can reach', () => {
    const capability = localRouteCapability()
    const offline = resolveReasoning({ provider: 'unreachable-local-route', model: MODEL, requested: LOW, capability })
    expect(offline).toMatchObject({ kind: 'resolved', requested: LOW, resolved: LOW, source: 'request' })
  })

  it('exposes no reachability, activity, or health field on its input', () => {
    const input = { provider: PROVIDER, model: MODEL, requested: LOW, capability: localRouteCapability() }
    expect(Object.keys(input).sort()).toEqual(['capability', 'model', 'provider', 'requested'])
  })
})

describe('F: an invalid reasoning configuration fails closed', () => {
  it('fails before any provider request with the current upstream rejection code', async () => {
    const { ctx, adapter, capability } = await routeHarness()
    const resolution = resolveReasoning({ provider: PROVIDER, model: MODEL, requested: HIGH, capability })

    expect(() => requireResolvedReasoning(resolution)).toThrow(ReasoningPolicyError)
    try {
      requireResolvedReasoning(resolution)
      expect.unreachable('an unsupported resolution must not be demandable')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ReasoningPolicyError)
      expect((error as ReasoningPolicyError).code).toBe(UNSUPPORTED_REASONING_EFFORT_CODE)
      expect((error as Error).message).toContain(String(HIGH))
      expect((error as Error).message).toContain(String(XHIGH))
    }
    // Fail closed means nothing was attempted, so the adapter saw no request and
    // no retryable failure was ever produced.
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.llm.listProviders()).toHaveLength(1)
  })

  it('fails when a capability advertises a default it does not advertise as selectable', async () => {
    const { capability } = await routeHarness()
    const contradictory = { ...capability, defaultEffort: HIGH }
    expect(() => resolveReasoning({ provider: PROVIDER, model: MODEL, capability: contradictory }))
      .toThrow(ReasoningPolicyError)
    try {
      resolveReasoning({ provider: PROVIDER, model: MODEL, capability: contradictory })
      expect.unreachable('a self-contradicting capability must not resolve')
    } catch (error: unknown) {
      expect((error as ReasoningPolicyError).code).toBe('INVALID_CAPABILITY')
      expect((error as Error).message).toContain('does not also advertise as selectable')
    }
  })
})

describe('G: policy output projects onto the durable task execution fields', () => {
  it('carries only the two task execution reasoning keys', () => {
    const capability = localRouteCapability()
    const metadata = taskReasoningMetadata(
      resolveReasoning({ provider: PROVIDER, model: MODEL, requested: LOW, capability }),
    )
    expect(Object.keys(metadata).sort()).toEqual(['requestedReasoning', 'resolvedReasoning'])
  })

  it('carries no resolved value for a request the route cannot accept', () => {
    const capability = localRouteCapability()
    const metadata = taskReasoningMetadata(
      resolveReasoning({ provider: PROVIDER, model: MODEL, requested: HIGH, capability }),
    )
    expect(Object.keys(metadata)).toEqual(['requestedReasoning'])
  })
})

describe('policy source carries no deployment-specific reasoning facts', () => {
  const SOURCES = ['types.ts', 'errors.ts', 'capability.ts', 'resolve.ts', 'apply.ts', 'metadata.ts', 'index.ts']

  it('names no host, port, model string, vendor, or machine path', () => {
    const forbidden = [/127\.0\.0\.1/u, /:8080/u, /localhost/u, /Qwen/iu, /\.gguf/u, /\/Users\//u, /llama\.cpp/iu]
    for (const source of SOURCES) {
      const text = readFileSync(resolvePath(import.meta.dirname, '..', 'src', source), 'utf8')
      for (const pattern of forbidden) expect(text).not.toMatch(pattern)
    }
  })
})
