import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent, SessionFormatHeader, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { sessionFormatV4ToV5 } from '../src/migration.ts'
import { releasedV5SessionFormatCodec } from '../src/codec.ts'
import { restoreReleasedV5Artifact } from '../src/validation.ts'

const header = {
  version: 4,
  id: 'v4-session',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
} as const

function stageFor(sourceHeader: SessionFormatHeader = header, sourceInheritedEventCount?: number) {
  const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
  const stage = sessionFormatV4ToV5.createStage({
    sourceHeader,
    targetHeader,
    sourceInheritedEventCount,
    sourceKind: 'decoded',
  })
  const output: SessionFormatEvent[] = []
  const context: SessionFormatMigrationContext = {
    emitEvent: (event) => { output.push(event) },
    emitRun: (run) => { for (const event of run.expand()) output.push(event) },
  }
  return { stage, output, context }
}

describe('V4-to-V5 migration', () => {
  it('renames the known DSH-local legacy records without changing payloads or sequence positions', () => {
    const { stage, output, context } = stageFor()
    const events: SessionFormatEvent[] = [
      { type: 'plugin:task/checkpoint', seq: 0, time: 2, ignorable: true,
        data: { kind: 'task/checkpoint', version: 1, checkpoint: { revision: 1 } } },
      { type: 'plugin:task/result-manifest', seq: 1, time: 3, ignorable: true,
        data: { kind: 'task/result-manifest', version: 1, manifest: { revision: 1 } } },
      { type: 'plugin:codex/subscription-state', seq: 2, time: 4, ignorable: true,
        data: { state: { generation: 1 } } },
      { type: 'plugin:translator/result', seq: 3, time: 5, ignorable: true,
        data: { text: 'retained' } },
    ]
    for (const event of events) stage.transformEvent(event, context)

    expect(stage.finish(context)).toBe(0)
    expect(output).toEqual([
      { ...events[0]!, type: 'task/checkpoint' },
      { ...events[1]!, type: 'task/result-manifest' },
      { ...events[2]!, type: 'codex/subscription-state' },
      events[3],
    ])
  })

  it('preserves a seeded inherited cut and refuses a mismatched marker', () => {
    const seededHeader = { ...header, isSeeded: true, parentSession: 'parent' }
    const { stage, output, context } = stageFor(seededHeader, undefined)
    stage.transformEvent({ type: 'session/end-seed', seq: 0, time: 2, data: { inherited: true } }, context)
    expect(output).toHaveLength(1)
    expect(stage.finish(context)).toBe(0)

    const mismatch = stageFor(seededHeader, 1)
    mismatch.stage.transformEvent({ type: 'session/end-seed', seq: 0, time: 2, data: { inherited: true } }, mismatch.context)
    expect(() => mismatch.stage.finish(mismatch.context)).toThrow('inherited cut disagrees')
  })

  it('round-trips V5 headers through the V4 physical framing', () => {
    const target = sessionFormatV4ToV5.migrateHeader(header)
    const physical = releasedV5SessionFormatCodec.encodeHeader(target, 0)
    expect(physical).toMatchObject({ type: 'session', version: 5 })
    expect(releasedV5SessionFormatCodec.decodeHeader(physical)).toEqual(target)
  })

  it('admits the new native event identities and refuses unknown required records', () => {
    const artifact = {
      header: { ...header, version: 5 },
      inheritedEventCount: 0,
      events: [{ type: 'task/checkpoint', seq: 0, time: 2, ignorable: true,
        data: { kind: 'task/checkpoint', version: 1, checkpoint: {} } }],
    }
    expect(restoreReleasedV5Artifact(artifact, new Set(['task/checkpoint']))).toBe(artifact)
    expect(() => restoreReleasedV5Artifact({
      ...artifact,
      events: [{ type: 'external/required', seq: 0, time: 2, data: {} }],
    }, new Set())).toThrow('unknown event type')
  })
})
