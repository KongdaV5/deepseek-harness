/** Custom conversion and immutable generation publication over isolated JSONL fixtures. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '../src/format.ts'
import { prepareJsonlMigration, verifyJsonlCurrentGeneration } from '../src/generation.ts'
import { SessionFormatEventCollector, type SessionFormatEvent, type SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { codexSubscriptionProjection, codexMappingRecovery, EMPTY_CODEX_MAPPING } from '@deepseek-ai/dsh-agent-codex'
import { applyTaskCheckpointProjection, emptyTaskCheckpointProjection, decideGuardedResume, taskCheckpointSchema } from '@deepseek-ai/dsh-task-checkpoint'
import { runIdFor } from '@deepseek-ai/dsh-agent-run-state'
import { convertCustomV3Event } from '@deepseek-ai/dsh-session-format-catalog'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

const id = SessionId('custom-fixture')
const header = { version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
const native: SessionHeader = { ...header, version: 4 }
const row = (type: string, data: SessionFormatJsonValue, seq: number, ignorable?: true): SessionFormatEvent => ({
  type, data, seq, time: seq + 10, ...ignorable === undefined ? {} : { ignorable },
})
const hash = 'a'.repeat(64)
function mapping(status: 'intent' | 'accepted' | 'uncertain' | 'pending-sync' | 'completed-not-delivered' | 'reconciliation-required') {
  const dispatch = { status: status === 'intent' || status === 'accepted' ? status : 'uncertain', threadId: 'external-thread', turnId: 'external-turn', dshTurn: 1, dshStep: 1, model: 'gpt-fixture', effort: 'high', inputHash: hash, workspaceIdentity: 'workspace', cwd: '/fixture', clientUserMessageId: 'client-stable', messageId: 'user-stable' }
  return { ...EMPTY_CODEX_MAPPING, generation: 7, authGeneration: 'auth-epoch-stable', activeThreadId: 'external-thread', retiredThreadIds: ['old-thread'], runtimeFingerprint: hash, committedMessageId: status === 'completed-not-delivered' ? 'user-stable' : null, dispatch: status === 'pending-sync' || status === 'completed-not-delivered' || status === 'reconciliation-required' ? null : dispatch,
    pendingSync: status === 'pending-sync' ? { hash, fromMessageId: null, toMessageId: 'user-stable' } : null,
    lastReconciliation: status === 'completed-not-delivered' || status === 'reconciliation-required' ? { ...dispatch, status: status === 'reconciliation-required' ? 'unknown' : 'completed', turnId: 'external-turn', sideEffectCount: 1, sideEffectKinds: ['commandExecution'] } : null }
}
function checkpoint(evidenceSeq?: number) {
  return { version: 1, taskId: 'task', revision: 1, taskType: 'fixture', sessionId: id, originRunId: runIdFor(id, 1), latestRunId: runIdFor(id, 1), status: 'paused', originalExecution: { provider: 'local', model: 'huihui' }, latestExecution: { provider: 'local', model: 'huihui' }, modelRelation: 'same-model', completedSteps: evidenceSeq === undefined ? [] : [{ id: 'done', title: 'Done', completedAt: 2, evidence: { kind: 'tool-result', eventSeq: evidenceSeq, callId: 'tool-call' } }], pendingSteps: [{ id: 'pending', title: 'Pending' }], createdAt: 1, lastActivityAt: 2, resumeContext: { objective: 'Continue safely', constraints: [], decisions: [], criticalContext: [] }, outputs: [] }
}
function restore(rows: readonly SessionFormatEvent[]) {
  const reader = createSessionFormatCatalogWithChildren([]).createRestore({ type: 'session', ...header }, { recovery: 'strict', validation: 'current' })
  for (const event of rows) reader.decodeRow(event)
  return reader.finish()
}

it.each(['intent', 'accepted', 'uncertain', 'pending-sync', 'completed-not-delivered', 'reconciliation-required'] as const)('preserves %s and auth binding through physical V4 publication and restart', async (status) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m1-persistence-')); onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = generationLogPath(root, undefined, id, 3, 'none')
  const target = generationLogPath(root, undefined, id, 4, 'none')
  await mkdir(dirname(source), { recursive: true })
  const state = mapping(status)
  const bytes = [JSON.stringify({ type: 'session', ...header }), JSON.stringify(row('codex/subscription-state', { state }, 0, true))].join('\n') + '\n'
  await writeFile(source, bytes)
  const open = async () => {
    const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Jsonl, { root, compression: 'none' })
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try { return (await handle.read()).events } finally { await handle.close() }
  }
  const read = await open()
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  const prepared = await prepareJsonlMigration({ sourcePath: source, sourceVersion: 3, currentPath: target, compression: 'none', format: { currentVersion: 4, createRestore: value => createSessionFormatCatalogWithChildren([]).createRestore(value, { recovery: 'strict', validation: 'current' }), encodeHeader: (header, cut) => sessionFormatCatalog.encodeCurrentHeader(header, cut), encodeEvent: event => sessionFormatCatalog.encodeCurrentEvent(event) }, verifyCurrentFile: verifyJsonlCurrentGeneration })
  await prepared.publish()
  const write = await open()
  await prepared.publish()
  const restarted = await open()
  expect(restarted).toEqual(write); expect(read).toEqual(write)
  expect(await readFile(source, 'utf8')).toBe(bytes)
  expect((await readdir(dirname(source))).filter(name => /^session\.v/.test(name)).sort()).toEqual(['session.v3.jsonl', 'session.v4.jsonl'])
  const fold = restarted.reduce((state, event) => codexSubscriptionProjection.apply(state, event), EMPTY_CODEX_MAPPING)
  expect(fold.authGeneration).toBe('auth-epoch-stable')
  expect(fold.generation).toBe(7)
  expect(fold.activeThreadId).toBe('external-thread')
  expect(fold.retiredThreadIds).toEqual(['old-thread'])
  expect(fold.dispatch).toEqual(state.dispatch)
  expect(fold.pendingSync).toEqual(state.pendingSync)
  expect(fold.lastReconciliation).toEqual(state.lastReconciliation)
  expect(codexMappingRecovery(fold)).toBe('reconciliation-required')
})

it('does not publish a successor when Custom payload validation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m1-failure-')); onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = generationLogPath(root, undefined, id, 3, 'none'); await mkdir(dirname(source), { recursive: true })
  const bytes = JSON.stringify({ type: 'session', ...header }) + '\n' + JSON.stringify(row('codex/subscription-state', { state: { dispatch: null } }, 0)) + '\n'
  await writeFile(source, bytes)
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose()); await ctx.plugin(Jsonl, { root, compression: 'none' })
  await expect(prepareJsonlMigration({ sourcePath: source, sourceVersion: 3, currentPath: generationLogPath(root, undefined, id, 4, 'none'), compression: 'none', format: { currentVersion: 4, createRestore: value => createSessionFormatCatalogWithChildren([]).createRestore(value, { recovery: 'strict', validation: 'current' }), encodeHeader: (header, cut) => sessionFormatCatalog.encodeCurrentHeader(header, cut), encodeEvent: event => sessionFormatCatalog.encodeCurrentEvent(event) }, verifyCurrentFile: verifyJsonlCurrentGeneration })).rejects.toThrow()
  expect(await readFile(source, 'utf8')).toBe(bytes)
  expect((await readdir(dirname(source))).filter(name => name.includes('.v4.'))).toEqual([])
})

it.each([undefined, true] as const)('converts required and optional legacy task events to one canonical identity (%s)', (marker) => {
  const events = [row('turn/start', { turn: 1 }, 0), row('task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint: checkpoint() }, 1, marker), row('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2)]
  const artifact = restore(events)
  expect(artifact.events[1]?.type).toBe('plugin:task/checkpoint')
  const session = Session.fromRestore(id, artifact.events as SessionEvent[], native, SessionLogOffset(0), 'detached')
  const projected = session.snapshotEvents().reduce(applyTaskCheckpointProjection, emptyTaskCheckpointProjection())
  expect(projected.failure).toBeNull(); expect(projected.tasks[0]?.originRunId).toBe(runIdFor(id, 1))
  expect(projected.tasks[0]?.pendingSteps[0]?.id).toBe('pending')
  const reopened = sessionFormatCatalog.createRestore({ type: 'session', ...native }, { recovery: 'strict', validation: 'current' })
  artifact.events.forEach((event) => { reopened.decodeRow(event) })
  expect(reopened.finish()).toEqual(artifact)
})

it('restores checkpoint evidence across interrupted-turn insertion and native tool-result lifting', () => {
  const initial = { ...checkpoint(), originRunId: runIdFor(id, 2), latestRunId: runIdFor(id, 2) }
  const complete = { ...initial, revision: 2, completedSteps: checkpoint(9).completedSteps }
  const call = { type: 'tool-call', id: 'tool-call', name: 'read', arguments: '{}' }
  const source = [
    row('turn/start', { turn: 1 }, 0), row('step/start', { turn: 1, step: 1 }, 1), row('step/end', { turn: 1, step: 1 }, 2),
    row('agent/inbox/spliced', { target: 'next-turn', inserted: [{ id: 'next', role: 'user', source: { kind: 'user' }, content: [] }] }, 3), row('turn/start', { turn: 2 }, 4),
    row('task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint: initial }, 5),
    row('step/start', { turn: 2, step: 1 }, 6),
    { ...row('assistant/message', { turn: 2, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'huihui' }, content: [call] } }, 7), surfaceOp: 'append' as const },
    row('tool/call', { turn: 2, step: 1, callId: 'tool-call', name: 'read', arguments: '{}' }, 8),
    { ...row('tool/result', { turn: 2, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'tool-call' }, content: [{ type: 'tool-result', toolCallId: 'tool-call', isError: false, content: [{ type: 'text', text: 'done' }] }] } }, 9), surfaceOp: 'append' as const },
    row('step/end', { turn: 2, step: 1 }, 10), row('task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint: complete }, 11), row('turn/end', { turn: 2, reason: { kind: 'completed' } }, 12),
  ]
  const artifact = restore(source)
  const session = Session.fromRestore(id, artifact.events as SessionEvent[], native, SessionLogOffset(0), 'detached')
  const projected = session.snapshotEvents().reduce(applyTaskCheckpointProjection, emptyTaskCheckpointProjection())
  expect(projected.failure).toBeNull()
  const restoredTask = projected.tasks[0]
  if (restoredTask === undefined) throw new Error('Fixture task did not restore')
  expect(restoredTask.completedSteps[0]?.evidence).toEqual({ kind: 'tool-result', eventSeq: 10, callId: 'tool-call' })
  expect(projected.successfulToolResults).toEqual([{ eventSeq: 10, callId: 'tool-call' }])
  expect(session.deriveMessages().find(message => message.role === 'tool')).toMatchObject({ id: 'result', toolCallId: 'tool-call', isError: false })
  const decision = decideGuardedResume({
    checkpoint: restoredTask, results: [], sessionId: id, hazards: [],
    successfulToolResults: projected.successfulToolResults, lastTurn: 2, openRun: false,
  })
  expect(decision.decision).toBe('allowed')
  expect(decision.plan).toEqual(['pending'])
  expect(source[11]?.data).toEqual({ kind: 'task/checkpoint', version: 1, checkpoint: complete })
})

it('keeps task compaction captures qualified to the unchanged V3 generation', () => {
  const audit = { authorityAsOfSeq: 5, checkpointSeq: 5, sha256: hash, supplementalMessages: [{ role: 'user', content: [{ type: 'text', text: 'authority at V3 seq 5' }] }] }
  const source = [row('turn/start', { turn: 1 }, 0), row('step/start', { turn: 1, step: 1 }, 1), row('step/end', { turn: 1, step: 1 }, 2), row('agent/inbox/spliced', { target: 'next-turn', inserted: [{ id: 'next', role: 'user', source: { kind: 'user' }, content: [] }] }, 3), row('turn/start', { turn: 2 }, 4), row('feedback/record', {}, 5), row('compaction/summary', { summary: [], shadowedRange: { start: 5, end: 5 }, shadowedSeqs: [5], policyAudit: audit }, 6)]
  const stage = createSessionFormatV3ToV4([], convertCustomV3Event).createStage({ sourceHeader: header, targetHeader: { ...header, version: 4 }, sourceKind: 'decoded', sourceInheritedEventCount: 0 })
  const output = new SessionFormatEventCollector(); source.forEach((event) => { stage.transformEvent(event, output) }); stage.finish(output)
  const converted = output.values.find(event => event.type === 'compaction/summary')!
  expect(converted.data).toEqual({ summary: [], shadowedRange: { start: 6, end: 6 }, shadowedSeqs: [6], 'plugin:task-compaction-audit': { sessionFormatVersion: 3, audit } })
  expect(converted.data).not.toHaveProperty('policyAudit')
  expect(source[6]?.data).toHaveProperty('policyAudit', audit)
})

it.each([{ surfaceOp: 'append' as const }, { sourceEventSeqs: [0] }])('refuses surface authority on Custom metadata (%j)', (extra) => {
  expect(() => convertCustomV3Event({ ...row('task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint: checkpoint() }, 1), ...extra }, 1, [0])).toThrow('metadata events')
})

it('refuses forward, missing and non-integral Custom event references', () => {
  for (const ref of [2, 99, 0.5]) expect(() => convertCustomV3Event(row('task/checkpoint', { kind: 'task/checkpoint', version: 1, checkpoint: checkpoint(ref) }, 2), 3, [0, 1])).toThrow()
})

it('retains completed task authority without manufacturing a continuation', () => {
  const task = taskCheckpointSchema.parse({ ...checkpoint(), status: 'completed', pendingSteps: [] })
  const decision = decideGuardedResume({
    checkpoint: task, results: [], sessionId: id, hazards: [], successfulToolResults: [], lastTurn: 1, openRun: false,
  })
  expect(decision.decision).toBe('not_applicable')
})

it('preserves result manifest revision, output, task and run identity', () => {
  const value = { version: 1, outputId: 'output', revision: 1, taskId: 'task', runId: runIdFor(id, 1), path: '/fixture/result', status: 'partial', createdAt: 1, updatedAt: 2, execution: { provider: 'local', model: 'huihui' }, validation: { status: 'pending', checks: [] } }
  const artifact = restore([row('task/result-manifest', { kind: 'task/result-manifest', version: 1, manifest: value }, 0)])
  expect(artifact.events[0]).toEqual(row('plugin:task/result-manifest', { kind: 'task/result-manifest', version: 1, manifest: value }, 0))
})


it('rejects unqualified required Custom identities in native V4 rather than using a second projection vocabulary', () => {
  const reader = sessionFormatCatalog.createRestore({ type: 'session', ...native }, { recovery: 'strict', validation: 'current' })
  expect(() => {
    reader.decodeRow(row('codex/subscription-state', { state: mapping('uncertain') }, 0))
    reader.finish()
  }).toThrow()
})


it.each([null, { turn: 1, step: 2 }, { turn: 2, step: 1 }])('requires matching assistant settlement despite a committed user cursor: %j', (settlement) => {
  const state = { ...mapping('completed-not-delivered'), lastAssistantSettlement: settlement }
  const artifact = restore([row('codex/subscription-state', { state }, 0, true)])
  const projected = (artifact.events as SessionEvent[]).reduce(
    (state, event) => codexSubscriptionProjection.apply(state, event), EMPTY_CODEX_MAPPING,
  )
  expect(projected.committedMessageId).toBe('user-stable')
  expect(codexMappingRecovery(projected)).toBe('reconciliation-required')
})

it('recognizes only a committed matching assistant event as delivery settlement', () => {
  const artifact = restore([
    row('turn/start', { turn: 1 }, 0), row('step/start', { turn: 1, step: 1 }, 1),
    row('codex/subscription-state', { state: mapping('completed-not-delivered') }, 2, true),
    { ...row('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'settled-answer', role: 'assistant', source: { kind: 'model', provider: 'codex-subscription', model: 'gpt-fixture' }, content: [{ type: 'text', text: 'Completed answer' }] } }, 3), surfaceOp: 'append' as const },
    row('step/end', { turn: 1, step: 1 }, 4), row('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  ])
  const projected = (artifact.events as SessionEvent[]).reduce(
    (state, event) => codexSubscriptionProjection.apply(state, event), EMPTY_CODEX_MAPPING,
  )
  expect(projected.lastAssistantSettlement).toEqual({ turn: 1, step: 1 })
  expect(codexMappingRecovery(projected)).toBe('settled')
})
