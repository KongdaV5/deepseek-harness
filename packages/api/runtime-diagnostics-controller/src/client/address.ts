/**
 * The runtime-diagnostics resource address.
 *
 * One address names one `topic + SessionId` — the same pair one stream serves —
 * and nothing else. It is parsed strictly: the scheme and protocol segment must
 * match exactly, there must be exactly two path segments, and each segment must
 * be the canonical encoding of what it decodes to. A loose split would let two
 * different strings name one resource, or let a malformed address reach a Host
 * call, so anything that is not exactly this shape names no resource at all.
 *
 * @module @deepseek-ai/dsh-api-runtime-diagnostics-controller/client/address
 */

/** The resource protocol this package serves. */
export const RUNTIME_DIAGNOSTICS_PROTOCOL = 'runtime-diagnostics'

/** The exact address prefix, including the separator after the protocol. */
const ADDRESS_PREFIX = `dsh-resource://${RUNTIME_DIAGNOSTICS_PROTOCOL}/`

/** The topic and Session one address names. */
export interface RuntimeDiagnosticsAddress {
  /** The topic to follow. */
  readonly topic: string
  /** The Session to follow it for. */
  readonly sessionId: string
}

/**
 * Build the resource address for one topic and Session.
 * @param topic - the topic to observe.
 * @param sessionId - the Session to observe it for.
 * @returns the canonical resource address.
 */
export function runtimeDiagnosticsAddress(topic: string, sessionId: string): string {
  return `${ADDRESS_PREFIX}${encodeURIComponent(topic)}/${encodeURIComponent(sessionId)}`
}

/**
 * Parse one address back into its topic and Session.
 * @param address - the candidate address.
 * @returns the named pair, or `undefined` when the address is not exactly one.
 */
export function parseRuntimeDiagnosticsAddress(address: string): RuntimeDiagnosticsAddress | undefined {
  if (!address.startsWith(ADDRESS_PREFIX)) return undefined
  const segments = address.slice(ADDRESS_PREFIX.length).split('/')
  if (segments.length !== 2) return undefined
  const [topicSegment, sessionSegment] = segments
  /* v8 ignore next -- a two-element split always yields two defined entries. */
  if (topicSegment === undefined || sessionSegment === undefined) return undefined
  let topic: string
  let sessionId: string
  try {
    topic = decodeURIComponent(topicSegment)
    sessionId = decodeURIComponent(sessionSegment)
  } catch {
    // A malformed percent-escape names nothing rather than being passed on.
    return undefined
  }
  if (topic === '' || sessionId === '') return undefined
  // Re-encoding must reproduce the input, so an over- or under-escaped segment
  // cannot alias the canonical address of another pair.
  if (encodeURIComponent(topic) !== topicSegment) return undefined
  if (encodeURIComponent(sessionId) !== sessionSegment) return undefined
  return { topic, sessionId }
}
