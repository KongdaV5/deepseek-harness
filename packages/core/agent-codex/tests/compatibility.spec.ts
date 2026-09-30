import { mkdtemp, realpath, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CodexCompatibilityMaintenance, CodexIncompatibleError, compatibilityDigest, codexThreadInterop,
  verifyCodexSchema, fullCodexCompatibility } from '../src/compatibility.ts'
import type { CodexAppServerConnection, CodexRuntimeDescriptor } from '../src/app-server.ts'
import { schemaFixture, reportFixture } from './compatibility-fixtures.ts'

const runtime: CodexRuntimeDescriptor = { source: 'system', version: '0.159.0', executablePath: '/fixture/codex', identity: 'official-fixture' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-compat-test-'))); roots.push(root)
  const inspect = vi.fn(async () => ({ trustedLocationId: 'official-fixture', signer: 'verified-team', architecture: 'darwin-arm64', binaryFingerprint: 'a'.repeat(64) }))
  const schemas = vi.fn(async () => schemaFixture())
  const maintenance = new CodexCompatibilityMaintenance(root, inspect, schemas)
  let name = 'model-a'
  const request = vi.fn(async (method: string) => method === 'account/read' ? { account: { type: 'chatgpt', email: 'MUST-NOT-CACHE' } }
    : method === 'model/list' ? { data: [{ id: name, model: name, displayName: 'Model A', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }], defaultReasoningEffort: 'low' }], nextCursor: null } : {})
  const client: CodexAppServerConnection = { request, initialize: async () => ({}), dispose: async () => {} }
  const initialized = { codexHome: join(root, 'codex-subscription', 'codex-home'), userAgent: 'fixture', platformFamily: 'unix', platformOs: 'darwin' }
  return { root, inspect, schemas, maintenance, client, initialized, request, rename: (n: string) => { name = n } }
}

describe('required schema, not invalid-RPC error-code guessing', () => {
  it('handles the official allOf path wrapper and boolean array-item schemas', () => {
    const docs = schemaFixture()
    docs.InitializeResponse!.definitions = { AbsolutePath: { type: 'string' } }
    docs.InitializeResponse!.properties!.codexHome = { allOf: [{ $ref: '#/definitions/AbsolutePath' }] }
    docs.Model!.properties!.supportedReasoningEfforts = { type: 'array', items: true }
    expect(verifyCodexSchema(docs).initializeSchema).toBe('PASS')
    docs.InitializeResponse!.definitions.AbsolutePath = { type: 'number' }
    expect(() => verifyCodexSchema(docs)).toThrow('InitializeResponse.codexHome')
  })
  it('admits optional additions but rejects missing methods even when an unknown RPC might return -32600', () => {
    const docs = schemaFixture()
    expect(verifyCodexSchema(docs).fingerprint).toHaveLength(64)
    docs.ClientRequest!.oneOf!.push({ properties: { method: { enum: ['optional/new'] } } })
    expect(verifyCodexSchema(docs).fingerprint).toHaveLength(64)
    docs.ClientRequest!.oneOf = docs.ClientRequest!.oneOf!.filter(b => !b.properties!.method!.enum!.includes('thread/resume'))
    expect(() => verifyCodexSchema(docs)).toThrow('missing required method thread/resume')
  })
  it('rejects removed input fields, new required parameters and changed terminal/approval fields', () => {
    for (const mutate of [
      (s: ReturnType<typeof schemaFixture>) => { delete s.ClientRequest!.oneOf![1]!.properties!.params!.properties!.refreshToken },
      (s: ReturnType<typeof schemaFixture>) => { s.ClientRequest!.oneOf![3]!.properties!.params!.required = ['unsupportedNewField'] },
      (s: ReturnType<typeof schemaFixture>) => { s.Turn!.properties!.status = { enum: ['done'] } },
      (s: ReturnType<typeof schemaFixture>) => { s.CommandExecutionRequestApprovalResponse!.properties!.decision = { enum: ['accept'] } },
    ]) { const docs = schemaFixture(); mutate(docs); expect(() => verifyCodexSchema(docs)).toThrow(CodexIncompatibleError) }
  })
})

describe('machine evidence and Light admission', () => {
  it('keeps account and model reads behind the pending-auth barrier and does not cache incomplete Light evidence', async () => {
    const h = await fixture()
    const report = await h.maintenance.light(runtime, h.client, h.initialized, true)
    expect(report.lightStatus).toBe('UNKNOWN')
    expect(h.request).not.toHaveBeenCalled()
    expect(await h.maintenance.status(runtime)).toBeUndefined()
    expect((await h.maintenance.light(runtime, h.client, h.initialized)).lightStatus).toBe('PASS')
  })
  it('serializes competing writers without losing the other runtime evidence', async () => {
    const h = await fixture()
    const system = await h.maintenance.light(runtime, h.client, h.initialized)
    const bundled = { ...system, runtimeSource: 'bundled' as const }
    await Promise.all([h.maintenance.persist(system), h.maintenance.persist(bundled)])
    const entries = z.array(z.object({ runtimeSource: z.enum(['system', 'bundled']) }))
      .parse(JSON.parse(await readFile(join(h.root, 'cache/codex-runtime-compat.json'), 'utf8')))
    expect(entries.map(entry => entry.runtimeSource).sort()).toEqual(['bundled', 'system'])
  })
  it('rechecks identity on cache reuse and preserves Light/Full distinctions with atomic private cache', async () => {
    const h = await fixture()
    const first = await h.maintenance.light(runtime, h.client, h.initialized)
    expect(first.lightStatus).toBe('PASS'); expect(first.fullStatus).toBe('UNKNOWN')
    expect(first.cacheState).toBe('WRITTEN')
    await h.maintenance.light(runtime, h.client, h.initialized)
    expect(h.schemas).toHaveBeenCalledOnce(); expect(h.inspect.mock.calls.length).toBeGreaterThan(2)
    expect(await readFile(join(h.root, 'cache/codex-runtime-compat.json'), 'utf8')).not.toContain('MUST-NOT-CACHE')
    expect(h.request.mock.calls.every(([m]) => !m.startsWith('thread/') && !m.startsWith('turn/'))).toBe(true)
  })
  it('treats corrupt/revision-mismatched cache as a miss', async () => {
    const h = await fixture(); await h.maintenance.light(runtime, h.client, h.initialized)
    const path = join(h.root, 'cache/codex-runtime-compat.json')
    await writeFile(path, '{bad'); expect(await h.maintenance.status(runtime)).toBeUndefined()
    await h.maintenance.light(runtime, h.client, h.initialized)
    const data = (await readFile(path, 'utf8')).replace('codex-maint-2', 'old')
    await writeFile(path, data); expect(await h.maintenance.status(runtime)).toBeUndefined()
  })
  it('revalidates same-version new binaries and rejects changes during verification', async () => {
    const h = await fixture(); await h.maintenance.light(runtime, h.client, h.initialized)
    h.inspect.mockImplementation(async () => ({ trustedLocationId: 'official-fixture', signer: 'verified-team', architecture: 'darwin-arm64', binaryFingerprint: 'b'.repeat(64) }))
    await h.maintenance.light(runtime, h.client, h.initialized); expect(h.schemas).toHaveBeenCalledTimes(2)
    h.inspect.mockResolvedValueOnce({ trustedLocationId: 'official-fixture', signer: 'verified-team', architecture: 'darwin-arm64', binaryFingerprint: 'c'.repeat(64) })
    await expect(h.maintenance.light(runtime, h.client, h.initialized)).rejects.toThrow('fingerprint changed')
  })
  it('classifies catalog-only changes without substituting disappeared model IDs', async () => {
    const h = await fixture(); const before = await h.maintenance.light(runtime, h.client, h.initialized)
    h.rename('gpt-6.2-fixture'); const after = await h.maintenance.light(runtime, h.client, h.initialized)
    expect(after.fingerprint).toBe(before.fingerprint); expect(after.modelCatalogDigest).not.toBe(before.modelCatalogDigest)
    expect(after.classification).toBe('LEVEL_0_CATALOG_ONLY'); expect(after.models.map(m => m.id)).toEqual(['gpt-6.2-fixture'])
  })
  it('does not convert temporary account/transport failure or unavailable usage into incompatibility', async () => {
    const h = await fixture()
    h.request.mockRejectedValueOnce(new Error('temporary transport'))
    await expect(h.maintenance.light(runtime, h.client, h.initialized)).rejects.toThrow('temporary transport')
    const original = h.client.request.bind(h.client)
    h.client.request = async (m, p) => { if (m === 'account/rateLimits/read') throw new Error('quota unavailable'); return original(m, p) }
    expect((await h.maintenance.light(runtime, h.client, h.initialized)).lightStatus).toBe('PASS')
  })
  it('separates direct verification from cache persistence failure and rejects unsafe cache directory links', async () => {
    const h = await fixture(); await mkdir(join(h.root, 'other'))
    await symlink(join(h.root, 'other'), join(h.root, 'cache'))
    expect((await h.maintenance.light(runtime, h.client, h.initialized)).cacheState).toBe('WRITE_FAILED')
  })
  it('does not accept stale Full pass after a failed Full run', async () => {
    const h = await fixture(); const report = await h.maintenance.light(runtime, h.client, h.initialized)
    report.fullStatus = 'PASS'; report.capabilities['turn/interrupt']!.behavior = 'PASS'
    h.client.request = async () => { throw new Error('full unavailable') }
    const result = await fullCodexCompatibility(report, h.client, async () => ({}))
    expect(result.fullStatus).toBe('FAIL'); expect(result.capabilities['turn/interrupt']!.behavior).toBe('UNKNOWN')
  })
})

describe('unknown runtime pairs and stable identities', () => {
  it('resumes the same fingerprint, retires settled unknown pairs, and blocks unresolved pairs', () => {
    expect(codexThreadInterop('a', 'a', true)).toBe('resume')
    expect(codexThreadInterop('a', 'b', false)).toBe('retire')
    expect(() => codexThreadInterop('a', 'b', true)).toThrow('no turn was replayed')
    expect(codexThreadInterop(null, 'a', false)).toBe('retire')
  })
  it('uses relevant ordered metadata, not version number comparisons', () => {
    expect(compatibilityDigest({ a: 1, b: 2 })).toBe(compatibilityDigest({ b: 2, a: 1 }))
    expect(reportFixture(runtime).runtimeVersion).toBe('0.159.0')
  })
})
