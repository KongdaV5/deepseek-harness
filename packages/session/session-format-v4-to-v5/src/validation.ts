/** Native V5 header and artifact admission built on the stable V4 semantics. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/** Validate the exact native V5 logical header. */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) {
    throw new SessionFormatError('expected format v5 header')
  }
  assertReleasedV4Header({ ...header, version: 4 })
}

/** Validate V5 envelope vocabulary and retain all established V4 relationships. */
export function restoreReleasedV5Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  const sourceView = {
    ...artifact,
    header: { ...artifact.header, version: 4 },
  }
  restoreReleasedV4Artifact(sourceView, knownEventTypes)
  const cut = sessionFormatCount(artifact.inheritedEventCount, 'format v5 inherited event count')
  for (const event of artifact.events) {
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    const data = event.data
    if (!isSessionFormatJsonObject(data)) throw new SessionFormatError('delivery-accepted data must be an object')
    const version = sessionFormatCount(data['sessionFormatVersion'] === undefined ? 0 : data['sessionFormatVersion'], 'delivery sessionFormatVersion')
    if (version !== 5) continue
    const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
    if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
    const sessionId = data['sessionId']
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new SessionFormatError('delivery requires a nonempty Session id')
    }
    const inheritedFromParent = artifact.header.parentSession !== undefined && event.seq < cut
    if (!inheritedFromParent && sessionId !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
  }
  return artifact
}
