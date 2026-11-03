/** V5 codec reuses V4 physical framing with an explicit V5 header discriminator. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

function physicalV4(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 5) {
    throw new SessionFormatError('expected format v5 physical header')
  }
  return { ...value, version: 4 } as SessionFormatHeader
}

/** V5 physical encoder and decoder retain the released V4 row framing. */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value) {
    const header = releasedV4SessionFormatCodec.decodeHeader(physicalV4(value))
    return { ...header, version: 5 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalV4(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 5 },
      decodeRow(row, context) {
        decoder.decodeRow(row, context)
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV5Header(header)
    const encoded = releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, inheritedEventCount)
    return { ...encoded, version: 5 }
  },
  encodeEvent(event) {
    return releasedV4SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)
