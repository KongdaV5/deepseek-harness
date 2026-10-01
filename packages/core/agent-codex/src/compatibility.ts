/** Shared, non-secret compatibility evidence for CLI maintenance and connection admission. */
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { inspectCodexRuntime, jsonObject, requiredString } from './app-server.ts'
import type { CodexAppServerConnection, CodexRuntimeDescriptor } from './app-server.ts'

/** Changing the DSH-consumed protocol requirements invalidates old evidence. */
export const ADAPTER_CONTRACT_REVISION = 'codex-maint-2'
type ObjectValue = Record<string, unknown>
type Schema = {
  [key: string]: unknown
  definitions?: Record<string, Schema>
  properties?: Record<string, Schema>
  required?: string[]
  type?: string | string[]
  enum?: unknown[]
  $ref?: string
  oneOf?: Schema[]
  anyOf?: Schema[]
  allOf?: Schema[]
  items?: Schema | boolean
}
type Status = 'PASS' | 'FAIL' | 'UNKNOWN'

/** A failure eligible for Automatic fallback; temporary RPC/transport errors are not this type. */
export class CodexIncompatibleError extends Error {
  constructor(readonly capability: string) { super(`Codex runtime incompatible: ${capability}`); this.name = 'CodexIncompatibleError' }
}

const id = 'compat-id'
const requestFixtures: Record<string, ObjectValue> = {
  initialize: { clientInfo: { name: 'deepseek-harness', version: '0.1.6-alpha.2' }, capabilities: { experimentalApi: false } },
  'account/read': { refreshToken: false },
  'model/list': { cursor: null, limit: 200 },
  'thread/start': { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write', model: id, developerInstructions: 'No tools.' },
  'thread/resume': { threadId: id }, 'thread/read': { threadId: id, includeTurns: true },
  'thread/inject_items': { threadId: id, items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'compat' }] }] },
  'thread/turns/list': { threadId: id, cursor: null, limit: 100, itemsView: 'full', sortDirection: 'desc' },
  'turn/start': { threadId: id, input: [{ type: 'text', text: 'compat' }], model: id, effort: 'low', clientUserMessageId: id },
  'turn/interrupt': { threadId: id, turnId: id },
}

/** Only consumed request, notification, response and approval fields are required. */
export const REQUIRED_CAPABILITY_CONTRACT = {
  requests: requestFixtures,
  notifications: {
    initialized: null,
    'account/login/completed': { success: true, loginId: id, error: null },
    'account/updated': { authMode: 'chatgpt', planType: 'plus' },
    'turn/started': { threadId: id, turn: { id, items: [], status: 'inProgress', error: null } },
    'turn/completed': { threadId: id, turn: { id, items: [], status: 'interrupted', error: null } },
    'item/started': { threadId: id, turnId: id, startedAtMs: 0, item: { type: 'agentMessage', id, text: 'compat' } },
    'item/completed': { threadId: id, turnId: id, completedAtMs: 1, item: { type: 'agentMessage', id, text: 'compat' } },
    'item/agentMessage/delta': { threadId: id, turnId: id, itemId: id, delta: 'compat' },
  },
  approvals: {
    'item/commandExecution/requestApproval': { threadId: id, turnId: id, itemId: id, startedAtMs: 0 },
    'item/fileChange/requestApproval': { threadId: id, turnId: id, itemId: id, startedAtMs: 0 },
    'item/permissions/requestApproval': { threadId: id, turnId: id, itemId: id, startedAtMs: 0, cwd: '/tmp', permissions: {} },
  },
  fields: {
    InitializeResponse: { codexHome: '/tmp', userAgent: 'codex', platformFamily: 'unix', platformOs: 'macos' },
    GetAccountResponse: { account: null },
    ModelListResponse: { data: [], nextCursor: null },
    Model: { id, model: id, displayName: 'Model', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' },
    ReasoningEffortOption: { reasoningEffort: 'low', description: 'Low' },
    Thread: { id, cwd: '/tmp', turns: [] }, Turn: { id, items: [], status: 'completed' },
    ThreadReadResponse: { thread: null }, ThreadStartResponse: { thread: null }, ThreadResumeResponse: { thread: null },
    ThreadTurnsListResponse: { data: [], nextCursor: null },
    CommandExecutionRequestApprovalResponse: { decision: 'decline' },
    FileChangeRequestApprovalResponse: { decision: 'decline' },
    PermissionsRequestApprovalResponse: { permissions: {}, scope: 'turn' },
  },
} as const

const evidenceSchema = z.object({ schema: z.enum(['PASS', 'FAIL', 'UNKNOWN']), rpc: z.enum(['PASS', 'FAIL', 'UNKNOWN']),
  behavior: z.enum(['PASS', 'FAIL', 'UNKNOWN']) }).strict()
const modelSchema = z.object({ id: z.string(), model: z.string(), displayName: z.string(), hidden: z.boolean(),
  efforts: z.array(z.string()), defaultEffort: z.string() }).strict()
const reportSchema = z.object({
  schemaVersion: z.literal(1), adapterContractRevision: z.literal(ADAPTER_CONTRACT_REVISION),
  runtimeSource: z.enum(['system', 'bundled']), runtimeVersion: z.string(), trustedLocationId: z.string(), signer: z.string(),
  architecture: z.string(), binaryFingerprint: z.string().length(64), fingerprint: z.string().length(64),
  requiredSchemaFingerprint: z.string().length(64), lightStatus: z.enum(['PASS', 'FAIL', 'UNKNOWN']),
  fullStatus: z.enum(['PASS', 'FAIL', 'UNKNOWN']), capabilities: z.record(z.string(), evidenceSchema),
  classification: z.enum(['LEVEL_0_CATALOG_ONLY', 'LEVEL_1_RUNTIME_COMPATIBLE', 'LEVEL_2_ADDITIVE_ADAPTER_CHANGE', 'LEVEL_3_BREAKING']),
  verifiedAt: z.string(), modelCatalogDigest: z.string(), models: z.array(modelSchema),
  cacheState: z.enum(['HIT', 'MISS', 'WRITTEN', 'WRITE_FAILED']),
  failureClassification: z.enum(['NONE', 'INCOMPATIBLE', 'TEMPORARY_RPC', 'IDENTITY_CHANGED', 'FULL_BEHAVIOR']),
  temporaryThreadCleanup: z.enum(['NOT_CREATED', 'DELETED', 'RETAINED_PROTOCOL', 'FAILED']).default('NOT_CREATED'),
}).strict()
/** Versioned Light/Full evidence for one verified executable identity. */
export type CodexCompatibilityReport = z.infer<typeof reportSchema>
/** Model metadata discovered from the active official App Server. */
export type CodexCatalogModel = z.infer<typeof modelSchema>

function capability(evidence: CodexCompatibilityReport['capabilities'], method: string): z.infer<typeof evidenceSchema> {
  const value = evidence[method]
  if (value === undefined) throw new CodexIncompatibleError(`missing capability evidence ${method}`)
  return value
}

/** Stable JSON digests ignore insertion order without dropping meaningful fields.
 * @param value - non-secret compatibility metadata.
 * @returns SHA-256 of canonical JSON.
 */
export function compatibilityDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function dereference(schema: Schema, root: Schema): Schema {
  if (schema.$ref === undefined) return schema
  const name = schema.$ref.replace('#/definitions/', '')
  const resolved = root.definitions?.[name]
  if (resolved === undefined) throw new CodexIncompatibleError('unresolved required schema reference')
  return dereference(resolved, root)
}

// Validate the draft-07 forms emitted for the DSH-consumed messages. Conditional contracts fail closed.
function accepts(raw: Schema | boolean, value: unknown, root: Schema, depth = 0): boolean {
  if (typeof raw === 'boolean') return raw
  if (depth > 40) return false
  const s = dereference(raw, root)
  if (['not', 'if', 'then', 'else'].some(k => k in s)) return false
  if (s.allOf !== undefined && !s.allOf.every(branch => accepts(branch, value, root, depth + 1))) return false
  if (s.anyOf !== undefined && !s.anyOf.some(branch => accepts(branch, value, root, depth + 1))) return false
  if (s.oneOf !== undefined && s.oneOf.filter(branch => accepts(branch, value, root, depth + 1)).length !== 1) return false
  if (s.enum !== undefined && !s.enum.includes(value)) return false
  if ('const' in s && s.const !== value) return false
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    if (!types.includes(kind) && !(kind === 'number' && types.includes('integer') && Number.isInteger(value))) return false
  }
  if (typeof value === 'number' && (typeof s.minimum === 'number' && value < s.minimum
    || typeof s.maximum === 'number' && value > s.maximum)) return false
  if (Array.isArray(value)) {
    const items = s.items
    return items === undefined || value.every(v => accepts(items, v, root, depth + 1))
  }
  if (value !== null && typeof value === 'object') {
    const object = value as ObjectValue
    if (s.required?.some(k => !(k in object))) return false
    return Object.entries(object).every(([k, v]) => s.properties?.[k] === undefined
      ? s.additionalProperties !== false : accepts(s.properties[k], v, root, depth + 1))
  }
  return true
}

function messageParams(root: Schema, method: string): Schema {
  const branch = root.oneOf?.find(b => b.properties?.method?.enum?.includes(method))
  if (branch === undefined) throw new CodexIncompatibleError(`missing required method ${method}`)
  return dereference(branch.properties?.params ?? {}, root)
}

/** Check generated schemas, not error codes from deliberately invalid RPC requests.
 * @param documents - official generated schema files indexed by basename.
 * @returns fingerprint of the required schema projection and optional cleanup support.
 */
export function verifyCodexSchema(documents: Record<string, Schema>): {
  fingerprint: string
  canDeleteThread: boolean
  initializeSchema: Status
} {
  const projection: ObjectValue = {}
  const initializeSchema: Status = 'PASS'
  for (const [file, fixtures] of [
    ['ClientRequest', REQUIRED_CAPABILITY_CONTRACT.requests],
    ['ServerNotification', REQUIRED_CAPABILITY_CONTRACT.notifications],
    ['ServerRequest', REQUIRED_CAPABILITY_CONTRACT.approvals],
  ] as const) {
    const root = documents[file]
    if (root === undefined) throw new CodexIncompatibleError(`missing ${file} schema`)
    for (const [method, fixture] of Object.entries(fixtures)) {
      if (method === 'initialized') continue // initialized is a client notification, checked below
      const params = messageParams(root, method)
      if (fixture === null || Object.keys(fixture).some(k => params.properties?.[k] === undefined)
        || !accepts(params, fixture, root)) throw new CodexIncompatibleError(`changed ${method} parameters`)
      projection[method] = projectSchema(params, root)
    }
  }
  const initialized = documents.ClientNotification
  if (initialized === undefined || !initialized.oneOf?.some(b => b.properties?.method?.enum?.includes('initialized'))) {
    throw new CodexIncompatibleError('initialized lifecycle')
  }
  for (const [name, fields] of Object.entries(REQUIRED_CAPABILITY_CONTRACT.fields)) {
    const root = documents[name]
    if (root === undefined) throw new CodexIncompatibleError(`missing ${name}`)
    const s = dereference(root, root)
    for (const [field, sample] of Object.entries(fields)) {
      const raw = s.properties?.[field]
      if (raw === undefined || sample !== null && !accepts(raw, sample, root)) throw new CodexIncompatibleError(`${name}.${field}`)
      projection[`${name}.${field}`] = projectSchema(raw, root)
    }
  }
  const turn = documents.Turn
  const terminalStatus = turn?.properties?.status
  if (turn === undefined || terminalStatus === undefined) throw new CodexIncompatibleError('terminal status schema')
  for (const status of ['completed', 'failed', 'interrupted']) {
    if (!accepts(terminalStatus, status, turn)) throw new CodexIncompatibleError(`terminal ${status}`)
  }
  const item = documents.ThreadItem
  if (item === undefined) throw new CodexIncompatibleError('history items')
  const variants = item.oneOf ?? []
  for (const [kind, fields] of Object.entries({ userMessage: ['id', 'clientId', 'content'], commandExecution: ['id', 'command', 'status'], fileChange: ['id', 'changes', 'status'] })) {
    const variant = variants.find(b => b.properties?.type?.enum?.includes(kind))
    if (variant === undefined || fields.some(f => variant.properties?.[f] === undefined)) throw new CodexIncompatibleError(`history/activity ${kind}`)
    projection[kind] = Object.fromEntries(fields.map((f) => {
      const field = variant.properties?.[f]
      if (field === undefined) throw new CodexIncompatibleError(`history/activity ${kind}.${f}`)
      return [f, projectSchema(field, item)]
    }))
  }
  return { fingerprint: compatibilityDigest(projection), initializeSchema,
    canDeleteThread: documents.ClientRequest?.oneOf?.some(b => b.properties?.method?.enum?.includes('thread/delete')) ?? false }
}

function projectSchema(raw: Schema | boolean, root: Schema, seen = new Set<Schema>()): unknown {
  if (typeof raw === 'boolean') return raw
  const s = dereference(raw, root)
  if (seen.has(s)) return 'recursive'
  const next = new Set(seen).add(s)
  return Object.fromEntries(Object.entries(s).filter(([key]) => !['description', 'title', 'default', '$schema', 'definitions'].includes(key))
    .map(([key, value]) => [key, key === 'properties'
      ? Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, projectSchema(v, root, next)]))
      : key === 'oneOf' || key === 'anyOf' || key === 'allOf' ? (value as Schema[]).map(v => projectSchema(v, root, next))
        : key === 'items' ? projectSchema(value as Schema, root, next) : value]))
}

async function generatedSchemas(runtime: CodexRuntimeDescriptor): Promise<Record<string, Schema>> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-schema-'))
  try {
    const generated = spawnSync(runtime.executablePath, ['app-server', 'generate-json-schema', '--out', root], {
      timeout: 30_000, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: root },
    })
    if (generated.error !== undefined) throw new Error('Official schema generation failed or timed out.')
    if (generated.status !== 0) throw new CodexIncompatibleError('official schema generation unavailable')
    const names = new Set(['ClientRequest', 'ClientNotification', 'ServerNotification', 'ServerRequest', 'ThreadItem', 'Turn',
      ...Object.keys(REQUIRED_CAPABILITY_CONTRACT.fields)])
    const docs: Record<string, Schema> = {}
    for (const name of names) {
      for (const prefix of ['', 'v2', 'v1']) {
        try { docs[name] = JSON.parse(await readFile(join(root, prefix, `${name}.json`), 'utf8')) as Schema; break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
    for (const root of Object.values(docs)) {
      for (const [name, definition] of Object.entries(root.definitions ?? {})) {
        if (docs[name] === undefined) {
          docs[name] = { ...definition, ...(root.definitions === undefined ? {} : { definitions: root.definitions }) }
        }
      }
    }
    return docs
  } finally { await rm(root, { recursive: true, force: true }) }
}

/** Validate the current App Server catalog with bounded pagination and no model substitution.
 * @param client - initialized current runtime connection.
 * @returns current model IDs, routing names and supported effort metadata, including hidden entries.
 */
export async function readCodexCatalog(client: Pick<CodexAppServerConnection, 'request'>): Promise<CodexCatalogModel[]> {
  const models: CodexCatalogModel[] = []
  const cursors = new Set<string>(), ids = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const response = jsonObject(await client.request('model/list', { limit: 200, ...(cursor === undefined ? {} : { cursor }) }, 15_000), 'model catalog')
    if (!Array.isArray(response.data)) throw new CodexIncompatibleError('model/list.data')
    for (const value of response.data) {
      const m = jsonObject(value, 'model entry')
      if (!Array.isArray(m.supportedReasoningEfforts) || typeof m.hidden !== 'boolean') throw new CodexIncompatibleError('model effort/visibility metadata')
      const efforts = m.supportedReasoningEfforts.map(e => requiredString(jsonObject(e, 'effort').reasoningEffort, 'effort'))
      for (const effort of m.supportedReasoningEfforts) requiredString(jsonObject(effort, 'effort').description, 'effort description')
      const model = { id: requiredString(m.id, 'model id'), model: requiredString(m.model, 'model name'),
        displayName: requiredString(m.displayName, 'display name'), hidden: m.hidden, efforts,
        defaultEffort: requiredString(m.defaultReasoningEffort, 'default effort') }
      if (ids.has(model.id) || !efforts.includes(model.defaultEffort) || new Set(efforts).size !== efforts.length) throw new CodexIncompatibleError('duplicate model or invalid default effort')
      ids.add(model.id); models.push(model)
    }
    if (response.nextCursor === null) return models.sort((a, b) => a.id.localeCompare(b.id))
    cursor = requiredString(response.nextCursor, 'catalog cursor')
    if (cursors.has(cursor)) throw new CodexIncompatibleError('repeated catalog cursor')
    cursors.add(cursor)
  }
  throw new CodexIncompatibleError('unbounded catalog pagination')
}

/** One safe-root cache and verification flow; evidence never contains account or thread content. */
export class CodexCompatibilityMaintenance {
  private readonly path: string
  constructor(private readonly root: string, private readonly inspect = inspectCodexRuntime,
    private readonly schemas = generatedSchemas) { this.path = join(root, 'cache', 'codex-runtime-compat.json') }

  private async cachePath(create: boolean): Promise<string> {
    const canonicalRoot = await realpath(this.root)
    if (canonicalRoot !== resolve(this.root)) throw new Error('Compatibility cache root is not canonical.')
    const dir = join(canonicalRoot, 'cache')
    if (create) await mkdir(dir, { mode: 0o700, recursive: true })
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(dir) !== dir) throw new Error('Compatibility cache directory is not trusted.')
    return this.path
  }

  private async entries(): Promise<CodexCompatibilityReport[]> {
    try {
      const path = await this.cachePath(false)
      if ((await lstat(path)).isSymbolicLink()) return []
      const data: unknown = JSON.parse(await readFile(path, 'utf8'))
      const parsed = z.array(reportSchema).max(8).safeParse(data)
      return parsed.success ? parsed.data : []
    } catch { return [] } // Corrupt/unavailable cache is a miss, never compatibility evidence.
  }

  /** Reverify distribution identity before consulting machine-local evidence.
   * @param runtime - current fixed runtime descriptor.
   * @returns valid evidence or a cache miss; no RPC or inference is performed.
   */
  async status(runtime: CodexRuntimeDescriptor): Promise<CodexCompatibilityReport | undefined> {
    const identity = await this.inspect(runtime)
    return (await this.entries()).find(e => e.runtimeSource === runtime.source && e.runtimeVersion === runtime.version
      && e.binaryFingerprint === identity.binaryFingerprint && e.signer === identity.signer
      && e.architecture === identity.architecture && e.trustedLocationId === identity.trustedLocationId)
  }

  /** Admit a connection with schema and read-only RPC evidence; never perform inference.
   * @param runtime - fixed binary for this connection.
   * @param client - initialized, owned connection.
   * @param initialized - previously validated initialization response for this child.
   * @param protocolOnly - omit account-specific capabilities when authentication is unavailable.
   * @returns current Light evidence, distinct from any prior Full evidence.
   */
  async light(runtime: CodexRuntimeDescriptor, client: CodexAppServerConnection, initialized: ObjectValue,
    protocolOnly = false): Promise<CodexCompatibilityReport> {
    let before: Awaited<ReturnType<typeof inspectCodexRuntime>>
    try { before = await this.inspect(runtime) } catch { throw new CodexIncompatibleError('executable identity') }
    const cached = (await this.entries()).find(e => e.runtimeSource === runtime.source && e.runtimeVersion === runtime.version
      && e.binaryFingerprint === before.binaryFingerprint && e.signer === before.signer
      && e.architecture === before.architecture && e.trustedLocationId === before.trustedLocationId)
    const schema = cached?.lightStatus === 'PASS' && cached.capabilities.initialize?.schema === 'PASS'
      ? { fingerprint: cached.requiredSchemaFingerprint, initializeSchema: cached.capabilities.initialize.schema }
      : verifyCodexSchema(await this.schemas(runtime))
    for (const field of ['codexHome', 'userAgent', 'platformFamily', 'platformOs']) requiredString(initialized[field], `initialize ${field}`)
    if (resolve(String(initialized.codexHome)) !== join(this.root, 'codex-subscription', 'codex-home')) {
      throw new CodexIncompatibleError('initialize CODEX_HOME containment')
    }
    const account = protocolOnly ? { account: null } : jsonObject(await client.request('account/read', { refreshToken: false }, 15_000), 'account/read')
    if (account.account !== null) {
      const a = jsonObject(account.account, 'account')
      if (a.type !== 'chatgpt' && a.type !== 'apiKey') throw new CodexIncompatibleError('account/read type')
    }
    // model/list remains read-only and available without creating or changing an account.
    const models = protocolOnly ? [] : await readCodexCatalog(client)
    const after = await this.inspect(runtime)
    if (compatibilityDigest(before) !== compatibilityDigest(after)) throw new CodexIncompatibleError('fingerprint changed during verification')
    const fingerprint = compatibilityDigest({ source: runtime.source, version: runtime.version, ...after,
      adapter: ADAPTER_CONTRACT_REVISION, schema: schema.fingerprint })
    let usage: Status = 'UNKNOWN'
    try { if (!protocolOnly) { jsonObject(await client.request('account/rateLimits/read', {}, 5_000), 'rate limits'); usage = 'PASS' } }
    catch { /* Optional quota visibility cannot trigger binary fallback. */ }
    const capabilities: CodexCompatibilityReport['capabilities'] = Object.fromEntries(
      Object.keys(requestFixtures).map(method => [method, { schema: 'PASS' as const, rpc: 'UNKNOWN' as const, behavior: 'UNKNOWN' as const }]),
    )
    for (const method of ['initialize', ...(protocolOnly ? [] : ['account/read', 'model/list'])]) capabilities[method] = { schema: 'PASS', rpc: 'PASS', behavior: 'UNKNOWN' }
    capability(capabilities, 'initialize').schema = schema.initializeSchema
    capabilities.notifications = { schema: 'PASS', rpc: 'UNKNOWN', behavior: 'UNKNOWN' }
    capabilities.approvals = { schema: 'PASS', rpc: 'UNKNOWN', behavior: 'UNKNOWN' }
    capabilities['thread/delete'] = { schema: 'canDeleteThread' in schema && schema.canDeleteThread
      || cached?.capabilities['thread/delete']?.schema === 'PASS' ? 'PASS' : 'UNKNOWN', rpc: 'UNKNOWN', behavior: 'UNKNOWN' }
    capabilities.usage = { schema: 'UNKNOWN', rpc: usage, behavior: 'UNKNOWN' }
    const report: CodexCompatibilityReport = {
      schemaVersion: 1, adapterContractRevision: ADAPTER_CONTRACT_REVISION,
      runtimeSource: runtime.source, runtimeVersion: runtime.version, ...after, fingerprint,
      requiredSchemaFingerprint: schema.fingerprint, lightStatus: protocolOnly ? 'UNKNOWN' : 'PASS', fullStatus: 'UNKNOWN', capabilities,
      classification: cached?.modelCatalogDigest !== undefined && cached.modelCatalogDigest !== compatibilityDigest(models)
        ? 'LEVEL_0_CATALOG_ONLY' : 'LEVEL_1_RUNTIME_COMPATIBLE', verifiedAt: new Date().toISOString(),
      models, modelCatalogDigest: compatibilityDigest(models), cacheState: cached === undefined ? 'MISS' : 'HIT',
      failureClassification: 'NONE', temporaryThreadCleanup: 'NOT_CREATED',
    }
    if (!protocolOnly && cached?.fingerprint === fingerprint && cached.fullStatus === 'PASS') {
      report.fullStatus = 'PASS'
      for (const [method, evidence] of Object.entries(cached.capabilities)) {
        const target = report.capabilities[method]
        if (evidence.behavior === 'PASS' && target !== undefined) target.behavior = 'PASS'
      }
    }
    if (!protocolOnly) await this.persist(report)
    return report
  }

  /** Atomically record verified evidence; persistence failure does not falsify the direct observation.
   * @param report - sanitized machine evidence.
   */
  async persist(report: CodexCompatibilityReport): Promise<void> {
    try {
      const path = await this.cachePath(true)
      await withFileLock(path, async () => {
        const entries = (await this.entries()).filter(e => e.runtimeSource !== report.runtimeSource)
        report.cacheState = 'WRITTEN'
        await writeFileAtomic(path, JSON.stringify([...entries, reportSchema.parse(report)], null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
      })
    } catch { report.cacheState = 'WRITE_FAILED' }
  }
}

/** Unknown runtime pairs retire settled mappings; unresolved dispatch must never be replayed.
 * @param mappingFingerprint - producer runtime fingerprint from the persistent mapping.
 * @param currentFingerprint - verified active runtime fingerprint.
 * @param unresolved - whether a remote dispatch still needs authoritative reconciliation.
 * @returns resume or retire; throws for an unresolved unknown pair.
 */
export function codexThreadInterop(mappingFingerprint: string | null | undefined, currentFingerprint: string, unresolved: boolean): 'resume' | 'retire' {
  if (mappingFingerprint === currentFingerprint) return 'resume'
  if (unresolved) throw new Error('Codex runtime pair is unverified for the unresolved dispatch; no turn was replayed.')
  return 'retire'
}

/** Explicit Full evidence from an owned synthetic thread; the caller owns connection shutdown.
 * @param report - directly verified Light evidence.
 * @param client - current initialized connection with Full notification routing.
 * @param events - bounded notification waiter, supplied by the connection owner.
 * @returns the same report with precise behavioral evidence and temporary-thread cleanup status.
 */
export async function fullCodexCompatibility(
  report: CodexCompatibilityReport, client: CodexAppServerConnection,
  events: (method: string, predicate: (params: ObjectValue) => boolean, action: () => Promise<unknown>) => Promise<ObjectValue>,
): Promise<CodexCompatibilityReport> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-codex-compat-')))
  let threadId: string | undefined
  report.fullStatus = 'UNKNOWN'
  for (const evidence of Object.values(report.capabilities)) evidence.behavior = 'UNKNOWN'
  try {
    const model = report.models.find(m => !m.hidden)
    if (model === undefined) throw new Error('No current model is available for Full compatibility.')
    const started = jsonObject(await client.request('thread/start', { cwd: workspace, model: model.model,
      approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Internal DSH compatibility check. Do not use tools, commands, agents or files. Only answer the user text.' }), 'thread/start')
    const thread = jsonObject(started.thread, 'thread')
    threadId = requiredString(thread.id, 'thread id')
    if (thread.cwd !== workspace) throw new Error('Compatibility thread cwd mismatch.')
    await client.request('thread/name/set', { threadId, name: 'DSH internal temporary compatibility check' })
    capability(report.capabilities, 'thread/start').behavior = 'PASS'
    await client.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Internal compatibility check only.' }] }] })
    capability(report.capabilities, 'thread/inject_items').behavior = 'PASS'
    const correlation = `dsh-compat-${randomUUID()}`
    let turnId: string | undefined
    const terminal = await events('turn/completed', p => p.threadId === threadId, async () => {
      const r = jsonObject(await client.request('turn/start', { threadId, model: model.model, effort: model.defaultEffort,
        clientUserMessageId: correlation, input: [{ type: 'text', text: 'Only reply CODEX-COMPAT-OK.' }] }), 'turn/start')
      turnId = requiredString(jsonObject(r.turn, 'turn').id, 'turn id')
    })
    const turn = jsonObject(terminal.turn, 'terminal')
    if (turn.id !== turnId || turn.status !== 'completed') throw new Error('Compatibility turn did not complete.')
    capability(report.capabilities, 'turn/start').behavior = 'PASS'
    const read = jsonObject(await client.request('thread/read', { threadId, includeTurns: true }), 'thread/read')
    const readThread = jsonObject(read.thread, 'thread')
    if (readThread.id !== threadId || readThread.cwd !== workspace) throw new Error('Read identity mismatch.')
    capability(report.capabilities, 'thread/read').behavior = 'PASS'
    const history = jsonObject(await client.request('thread/turns/list', { threadId, limit: 100, itemsView: 'full', sortDirection: 'desc' }), 'history')
    if (!Array.isArray(history.data) || !history.data.some((raw) => {
      const t = jsonObject(raw, 'turn')
      return t.id === turnId && Array.isArray(t.items) && t.items.some((rawItem) => {
        const item = jsonObject(rawItem, 'item'); return item.type === 'userMessage' && item.clientId === correlation
      })
    })) throw new Error('History correlation not preserved.')
    capability(report.capabilities, 'thread/turns/list').behavior = 'PASS'
    const resumed = jsonObject(await client.request('thread/resume', { threadId }), 'resume')
    const resumedThread = jsonObject(resumed.thread, 'thread')
    if (resumedThread.id !== threadId || resumedThread.cwd !== workspace) throw new Error('Resume identity mismatch.')
    capability(report.capabilities, 'thread/resume').behavior = 'PASS'
    try {
      const interruption: { turnId?: string; acknowledged: boolean } = { acknowledged: false }
      const interrupted = await events('turn/completed', p => p.threadId === threadId, async () => {
        const delta = await events('item/agentMessage/delta', p => p.threadId === threadId, async () => {
          await client.request('turn/start', { threadId, model: model.model, effort: model.defaultEffort,
            input: [{ type: 'text', text: 'Write a harmless 150-word description of a garden. Do not use tools.' }] })
        })
        interruption.turnId = requiredString(delta.turnId, 'active turn')
        await client.request('turn/interrupt', { threadId, turnId: interruption.turnId })
        interruption.acknowledged = true
      })
      const terminal = jsonObject(interrupted.turn, 'interrupted turn')
      if (interruption.acknowledged && terminal.id === interruption.turnId && terminal.status === 'interrupted') {
        capability(report.capabilities, 'turn/interrupt').behavior = 'PASS'
      }
    } catch { /* Inactive/too-fast turn is explicitly not interrupt proof. */ }
    report.fullStatus = capability(report.capabilities, 'turn/interrupt').behavior === 'PASS' ? 'PASS' : 'UNKNOWN'
  } catch {
    report.fullStatus = 'FAIL'; report.failureClassification = 'FULL_BEHAVIOR'
  } finally {
    if (threadId !== undefined) {
      try {
        if (report.capabilities['thread/delete']?.schema !== 'PASS') report.temporaryThreadCleanup = 'RETAINED_PROTOCOL'
        else { await client.request('thread/delete', { threadId }); report.temporaryThreadCleanup = 'DELETED' }
      }
      catch { report.temporaryThreadCleanup = 'FAILED' }
    }
    await rm(workspace, { recursive: true, force: true })
  }
  return report
}
