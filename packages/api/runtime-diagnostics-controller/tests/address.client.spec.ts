/**
 * The resource address grammar.
 *
 * The parser is the only place a string becomes a `topic + SessionId` pair, so
 * the tests are written as an accept/reject table: an address that names two
 * things, or names one thing two ways, must name nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  parseRuntimeDiagnosticsAddress,
  RUNTIME_DIAGNOSTICS_PROTOCOL,
  runtimeDiagnosticsAddress,
} from '../src/client/address.ts'

describe('runtimeDiagnosticsAddress', () => {
  it('names the topic and Session under the package protocol', () => {
    expect(RUNTIME_DIAGNOSTICS_PROTOCOL).toBe('runtime-diagnostics')
    expect(runtimeDiagnosticsAddress('task-aware-compaction', 'session-1'))
      .toBe('dsh-resource://runtime-diagnostics/task-aware-compaction/session-1')
  })

  it('escapes a topic or Session that would otherwise change the grammar', () => {
    const address = runtimeDiagnosticsAddress('topic/with/separators', 'session with spaces')
    expect(address).toBe('dsh-resource://runtime-diagnostics/topic%2Fwith%2Fseparators/session%20with%20spaces')
    expect(parseRuntimeDiagnosticsAddress(address)).toEqual({
      topic: 'topic/with/separators',
      sessionId: 'session with spaces',
    })
  })
})

describe('parseRuntimeDiagnosticsAddress', () => {
  it('resolves the canonical address of a pair', () => {
    expect(parseRuntimeDiagnosticsAddress('dsh-resource://runtime-diagnostics/topic-1/session-1'))
      .toEqual({ topic: 'topic-1', sessionId: 'session-1' })
  })

  it('names nothing for an address outside this protocol', () => {
    const rejected = [
      'dsh-resource://runtime-diagnostics',
      'dsh-resource://runtime-diagnostics/',
      'dsh-resource://runtime-diagnostics/topic-1',
      'dsh-resource://runtime-diagnostics/topic-1/session-1/extra',
      'dsh-resource://runtime-diagnostics-other/topic-1/session-1',
      'dsh-resource://file/session/session-1/path',
      'sidebar://guide',
      'runtime-diagnostics/topic-1/session-1',
      'dsh-resource://runtime-diagnostics/topic-1/',
      'dsh-resource://runtime-diagnostics//session-1',
    ]
    for (const address of rejected) {
      expect(parseRuntimeDiagnosticsAddress(address), address).toBeUndefined()
    }
  })

  it('names nothing for a malformed percent-escape rather than passing it on', () => {
    expect(parseRuntimeDiagnosticsAddress('dsh-resource://runtime-diagnostics/%E0%A4%A/session-1')).toBeUndefined()
  })

  it('names nothing for a segment that is not its own canonical encoding', () => {
    // `%41` decodes to `A`, so the string names a pair whose canonical address
    // is a different string: accepting it would let two addresses alias one
    // resource.
    expect(parseRuntimeDiagnosticsAddress('dsh-resource://runtime-diagnostics/%41/session-1')).toBeUndefined()
    expect(parseRuntimeDiagnosticsAddress('dsh-resource://runtime-diagnostics/topic-1/%41')).toBeUndefined()
  })
})
