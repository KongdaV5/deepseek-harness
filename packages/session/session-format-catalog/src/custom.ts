/** Custom V3 payload conversion; native V4 readers recognize only plugin-qualified identities. */
import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { mappingSchema } from '@deepseek-ai/dsh-agent-codex'
import { taskCheckpointEventDataSchema, resultManifestEventDataSchema } from '@deepseek-ai/dsh-task-checkpoint'

/** Required historical Custom events admitted only by the incoming V3 conversion. */
export const CUSTOM_V3_EVENT_TYPES = ['codex/subscription-state', 'task/checkpoint', 'task/result-manifest'] as const

/** Convert domain references with the official stage's insertion map.
 * @param event Source Custom event or first-party event carrying Custom compaction metadata.
 * @param seq Target event position assigned by the official migration.
 * @param mapping Earlier source positions mapped to target positions.
 * @returns Converted Custom event, or undefined to delegate ordinary conversion.
 */
export function convertCustomV3Event(event: SessionFormatEvent, seq: number, mapping: readonly number[]): SessionFormatEvent | undefined {
  if (CUSTOM_V3_EVENT_TYPES.some(type => type === event.type) && (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined)) {
    throw new SessionFormatError('Custom metadata events cannot carry surface operations or message references')
  }
  const reference = (value: SessionFormatJsonValue | undefined): number => {
    const source = sessionFormatCount(value, 'Custom source event reference')
    const target = mapping[source]
    if (source >= event.seq || target === undefined) throw new SessionFormatError('Custom reference must name an earlier source event')
    return target
  }
  const object = (value: SessionFormatJsonValue | undefined): SessionFormatJsonObject => {
    if (!isSessionFormatJsonObject(value)) throw new SessionFormatError('Custom event data must be an object')
    return value
  }
  if (event.type === 'codex/subscription-state') {
    const data = object(event.data)
    mappingSchema.parse(data['state'])
    // Message IDs, turn/step ordinals, external thread IDs, hashes and auth epochs are stable identities.
    return { ...event, seq, type: 'plugin:codex/subscription-state' }
  }
  if (event.type === 'task/checkpoint') {
    taskCheckpointEventDataSchema.parse(event.data)
    const data = object(event.data)
    const checkpoint = object(data['checkpoint'])
    const completed = checkpoint['completedSteps']
    if (!Array.isArray(completed)) throw new SessionFormatError('Custom completed steps must be an array')
    return { ...event, seq, type: 'plugin:task/checkpoint', data: { ...data, checkpoint: {
      ...checkpoint, completedSteps: completed.map((value: SessionFormatJsonValue) => {
        const step = object(value)
        const evidence = object(step['evidence'])
        return evidence['kind'] === 'tool-result' ? { ...step, evidence: { ...evidence, eventSeq: reference(evidence['eventSeq']) } } : step
      }),
    } } }
  }
  if (event.type === 'task/result-manifest') {
    resultManifestEventDataSchema.parse(event.data)
    return { ...event, seq, type: 'plugin:task/result-manifest' }
  }
  return undefined
}
