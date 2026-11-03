/** V4-to-V5 identity migration with stable Session coordinates. */

import { defineSessionFormatMigration, SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

const LEGACY_EVENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'plugin:codex/subscription-state': 'codex/subscription-state',
  'plugin:task/checkpoint': 'task/checkpoint',
  'plugin:task/result-manifest': 'task/result-manifest',
})

/** The adjacent V4-to-V5 Session format edge. */
export const sessionFormatV4ToV5: SessionFormatMigration = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    const target = { ...header, version: 5 }
    assertReleasedV5Header(target)
    return target
  },
  createStage: input => new V4ToV5Stage(input),
  validateTargetHeader: assertReleasedV5Header,
})

class V4ToV5Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private sourceSeq = 0
  private inheritedMarkerSeq: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    const knownCut = input.sourceInheritedEventCount ?? (input.sourceHeader.isSeeded ? undefined : 0)
    if (knownCut !== undefined) this.headerInheritedEventCount = knownCut
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.sourceSeq) throw new SessionFormatError('format v4 source events must be dense')
    this.sourceSeq += 1
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) {
        throw new SessionFormatError('unseeded format v4 Session contains an inherited end-seed marker')
      }
      this.inheritedMarkerSeq = event.seq
    }
    const type = LEGACY_EVENT_TYPES[event.type]
    context.emitEvent(type === undefined ? event : { ...event, type })
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(_context: SessionFormatMigrationContext): number {
    if (!this.input.sourceHeader.isSeeded) {
      if (this.inheritedMarkerSeq !== undefined) {
        throw new SessionFormatError('unseeded format v4 Session contains an inherited end-seed marker')
      }
      if (this.input.sourceInheritedEventCount !== undefined && this.input.sourceInheritedEventCount !== 0) {
        throw new SessionFormatError('unseeded format v4 Session has an inherited event count')
      }
      return 0
    }
    if (this.inheritedMarkerSeq === undefined) {
      throw new SessionFormatError('seeded format v4 Session lacks an inherited end-seed marker')
    }
    if (this.input.sourceInheritedEventCount !== undefined
      && this.input.sourceInheritedEventCount !== this.inheritedMarkerSeq) {
      throw new SessionFormatError('format v4 inherited cut disagrees with its end-seed marker')
    }
    return this.inheritedMarkerSeq
  }
}

/** Validate a complete source artifact with this edge's source and target contracts. */
export function migrateReleasedV4Artifact(artifact: SessionFormatArtifact): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  const targetHeader = sessionFormatV4ToV5.migrateHeader(artifact.header)
  const stage = sessionFormatV4ToV5.createStage({
    sourceHeader: artifact.header,
    targetHeader,
    sourceInheritedEventCount: artifact.inheritedEventCount,
    sourceKind: 'decoded',
  })
  const events: SessionFormatEvent[] = []
  const context: SessionFormatMigrationContext = {
    emitEvent: (event) => { events.push(event) },
    emitRun: (run) => { for (const event of run.expand()) events.push(event) },
  }
  for (const event of artifact.events) stage.transformEvent(event, context)
  const inheritedEventCount = stage.finish(context)
  return { header: targetHeader, inheritedEventCount, events }
}
