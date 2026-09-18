import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath, toHeaderLine } from '../packages/session/session-persistence-jsonl/src/format.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upstream-data-migration-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sessionContext(root: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  return ctx
}

async function writeV3Fixture(root: string, id: string, event?: object): Promise<string> {
  const sessionId = SessionId(id)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
  }
  const path = generationLogPath(root, undefined, sessionId, SESSION_FORMAT_VERSION, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, [toHeaderLine(header), event].filter(value => value !== undefined)
    .map(value => JSON.stringify(value)).join('\n') + '\n')
  return path
}

describe('Final Product settings compatibility', () => {
  it('reads without writeback and preserves unknown sections through a target update', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'settings.yaml')
    const source = [
      '# Final Product synthetic fixture',
      'sample:',
      '  value: 1',
      'future-plugin:',
      '  retained: true',
      '',
    ].join('\n')
    await writeFile(path, source)
    const before = digest(source)

    const first = new Context()
    const firstFiber = first.plugin(FileSettingsProvider, { path, watch: false })
    await firstFiber
    const schema = z.object({ value: z.number().default(0) })
    const sample = first.settings.register('sample', schema)
    expect(sample.get()).toEqual({ value: 1 })
    expect(digest(await readFile(path, 'utf8'))).toBe(before)
    await sample.update({ value: 2 })
    await firstFiber.dispose()

    const written = await readFile(path, 'utf8')
    expect(written).toContain('value: 2')
    expect(written).toContain('future-plugin:')
    expect(written).toContain('retained: true')

    const rollback = new Context()
    const rollbackFiber = rollback.plugin(FileSettingsProvider, { path, watch: false })
    await rollbackFiber
    expect(rollback.settings.register('sample', schema).get()).toEqual({ value: 2 })
    await rollbackFiber.dispose()
  })
})

describe('Final Product Session v3 compatibility', () => {
  it('round-trips a target-written current generation through the shared v3 provider', async () => {
    const root = await temporaryRoot()
    const ctx = await sessionContext(root)
    const id = SessionId('candidate-current-v3')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
    }
    const writer = await ctx.sessionPersistence.create(header)
    await writer.flush()
    await writer.close()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    expect(reader.header.version).toBe(3)
    expect((await reader.read()).events).toEqual([])
    await reader.close()
  })

  it('accepts a target-only required event in the target catalog', async () => {
    const root = await temporaryRoot()
    const id = 'target-workspace-event'
    await writeV3Fixture(root, id, {
      type: 'workspace/changes', seq: 0, time: 1, data: { turn: 1 },
    })
    const ctx = await sessionContext(root)
    const reader = await ctx.sessionPersistence.open(SessionId(id), 'read')
    expect((await reader.read()).events[0]?.type).toBe('workspace/changes')
    await reader.close()
  })

  // Restored first-party compatibility: `task/checkpoint` and
  // `task/result-manifest` were re-declared as known Session v3 vocabulary, so
  // the read path admits a legacy log carrying them with no conversion.
  it.each(['task/checkpoint', 'task/result-manifest'])('reads restored first-party required event %s without rewriting the log', async (type) => {
    const root = await temporaryRoot()
    const id = `restored-custom-${type.replace('/', '-')}`
    const path = await writeV3Fixture(root, id, {
      type,
      seq: 0,
      time: 1,
      data: { kind: type, version: 1 },
    })
    const before = await readFile(path)
    const ctx = await sessionContext(root)
    const reader = await ctx.sessionPersistence.open(SessionId(id), 'read')
    expect((await reader.read()).events[0]?.type).toBe(type)
    await reader.close()
    expect(await readFile(path)).toEqual(before)
  })

  // The generic refusal stays intact: only the two restored types became
  // known, so an event this build genuinely does not declare is still an
  // unreadable required event rather than a silently skipped one.
  it('still rejects a required event outside the target catalog', async () => {
    const root = await temporaryRoot()
    const id = 'unregistered-required-event'
    const path = await writeV3Fixture(root, id, {
      type: 'unregistered/required',
      seq: 0,
      time: 1,
      data: { kind: 'unregistered/required', version: 1 },
    })
    const before = await readFile(path)
    const ctx = await sessionContext(root)
    await expect(ctx.sessionPersistence.open(SessionId(id), 'read')).rejects.toThrow(
      /unknown to this harness and not marked ignorable/,
    )
    expect(await readFile(path)).toEqual(before)
  })
})
