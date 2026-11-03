/** Small schema fixtures isolate protocol admission from official binaries and credentials. */
import type { CodexCompatibilityReport, verifyCodexSchema } from '../src/compatibility.ts'
import type { CodexRuntimeDescriptor } from '../src/app-server.ts'
type Schema = Parameters<typeof verifyCodexSchema>[0][string]

export function schemaFixture(): Record<string, Schema> {
  const methods = (names: string[]): Schema => ({ oneOf: names.map(method => ({ properties: {
    method: { enum: [method] }, params: { type: 'object', properties: Object.fromEntries([
      'clientInfo', 'capabilities', 'refreshToken', 'cursor', 'limit', 'cwd', 'approvalPolicy', 'sandbox', 'model', 'developerInstructions',
      'threadId', 'includeTurns', 'items', 'itemsView', 'sortDirection', 'turnId', 'input', 'effort', 'clientUserMessageId',
      'success', 'loginId', 'error', 'authMode', 'planType', 'turn', 'item', 'startedAtMs', 'completedAtMs', 'itemId', 'delta', 'permissions',
    ].map(k => [k, {}])) },
  } })) })
  const docs: Record<string, Schema> = {
    ClientRequest: methods(['initialize', 'account/read', 'model/list', 'thread/start', 'thread/resume', 'thread/read',
      'thread/inject_items', 'thread/turns/list', 'turn/start', 'turn/interrupt']),
    ClientNotification: methods(['initialized']),
    ServerNotification: methods(['account/login/completed', 'account/updated', 'turn/started', 'turn/completed',
      'item/started', 'item/completed', 'item/agentMessage/delta']),
    ServerRequest: methods(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']),
  }
  const objects: Record<string, string[]> = {
    InitializeResponse: ['codexHome', 'userAgent', 'platformFamily', 'platformOs'], GetAccountResponse: ['account'],
    ModelListResponse: ['data', 'nextCursor'], Model: ['id', 'model', 'displayName', 'hidden', 'supportedReasoningEfforts', 'defaultReasoningEffort'],
    ReasoningEffortOption: ['reasoningEffort', 'description'], Thread: ['id', 'cwd', 'turns'], Turn: ['id', 'items', 'status'],
    ThreadReadResponse: ['thread'], ThreadStartResponse: ['thread'], ThreadResumeResponse: ['thread'],
    ThreadTurnsListResponse: ['data', 'nextCursor'], CommandExecutionRequestApprovalResponse: ['decision'],
    FileChangeRequestApprovalResponse: ['decision'], PermissionsRequestApprovalResponse: ['permissions', 'scope'],
  }
  for (const [name, fields] of Object.entries(objects)) docs[name] = { type: 'object', properties: Object.fromEntries(fields.map(k => [k, {}])) }
  docs.Turn!.properties!.status = { enum: ['inProgress', 'completed', 'failed', 'interrupted'] }
  docs.ThreadItem = { oneOf: Object.entries({ userMessage: ['id', 'clientId', 'content'],
    commandExecution: ['id', 'command', 'status'], fileChange: ['id', 'changes', 'status'] }).map(([kind, fields]) => ({
    properties: { type: { enum: [kind] }, ...Object.fromEntries(fields.map(k => [k, {}])) },
  })) }
  return docs
}

export function reportFixture(runtime: CodexRuntimeDescriptor): CodexCompatibilityReport {
  return { schemaVersion: 1, adapterContractRevision: 'codex-maint-2', runtimeSource: runtime.source, runtimeVersion: runtime.version,
    trustedLocationId: runtime.source, signer: 'fixture', architecture: 'darwin-arm64', binaryFingerprint: 'a'.repeat(64),
    fingerprint: (runtime.source === 'system' ? 'b' : 'c').repeat(64), requiredSchemaFingerprint: 'd'.repeat(64),
    lightStatus: 'PASS', fullStatus: 'UNKNOWN', capabilities: {}, classification: 'LEVEL_1_RUNTIME_COMPATIBLE',
    verifiedAt: '2026-09-30T00:00:00.000Z', modelCatalogDigest: '', models: [], cacheState: 'MISS',
    failureClassification: 'NONE', temporaryThreadCleanup: 'NOT_CREATED' }
}
