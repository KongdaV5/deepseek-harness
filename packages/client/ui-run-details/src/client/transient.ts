/**
 * The transient compaction diagnostics this surface reads.
 *
 * The dock shows two different compaction facts and keeping them apart is the
 * whole point. The durable one — the `policyAudit` a committed
 * `compaction/summary` carries — travels the `runDetails` projection and the
 * panel renders it. The transient one is the policy's process-local view of what
 * it is doing *now*: it is published on the generic transient diagnostics
 * transport, read here by address, and never persisted.
 *
 * Because they are separate rows with separate sources, a reader cannot mistake
 * an in-flight compaction for a committed one. This module owns the second
 * row's identity and its decoding, and nothing else: it holds no state, opens no
 * stream of its own, and never writes.
 *
 * The topic and schema below mirror the domain's own declaration in
 * `@deepseek-ai/dsh-compaction-task-aware-policy/diagnostics-transport`. The
 * transport compares them on every frame, so drift between the two sides is a
 * refused observation rather than a misread value; the spec pins both.
 *
 * @module @deepseek-ai/dsh-client-ui-run-details/transient
 */

import type { RuntimeDiagnosticsObservation, RuntimeDiagnosticsValue } from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/types'

/** The topic the task-aware compaction policy publishes its transient view on. */
export const TRANSIENT_COMPACTION_TOPIC = 'task-aware-compaction'

/** The observation schema this surface is able to render. */
export const TRANSIENT_COMPACTION_SCHEMA = {
  schemaId: 'dsh.task-aware-compaction-diagnostics',
  schemaVersion: 1,
} as const

/**
 * The resource address of one Session's transient compaction observation.
 * @param sessionId - the Session to read the observation for.
 * @returns the canonical `dsh-resource://runtime-diagnostics/…` address.
 */
export function transientCompactionAddress(sessionId: string): string {
  // Mirrors the transport's own `runtimeDiagnosticsAddress`. The transport
  // parses this strictly, so drift shows up as a refused resource (a visible
  // failure) rather than as a value read out of the wrong place.
  return `dsh-resource://runtime-diagnostics/${encodeURIComponent(TRANSIENT_COMPACTION_TOPIC)}/${encodeURIComponent(sessionId)}`
}

/**
 * The slice of the resource model this row reads.
 *
 * Declared structurally so the module keeps its own shape: the transport
 * validates that a frame is detached JSON, never what its fields mean, so this
 * surface is the place that decides which fields it can render.
 */
export interface TransientResourceSnapshot {
  /** Where the resource stands: `none` means no provider is registered at all. */
  readonly status: 'none' | 'loading' | 'live' | 'failed'
  /** The latest served observation, absent before the first frame. */
  readonly value: RuntimeDiagnosticsObservation | undefined
  /** The latest frame's failure, present only while `status` is `failed`. */
  readonly failure: { readonly code: string } | undefined
}

/**
 * What the transient row renders.
 *
 * `hidden` is not the same as `none`: a hidden row means no transport is
 * mounted to ask, while `none` means the transport answered that the policy is
 * not compacting right now.
 */
export type TransientCompaction =
  | { readonly state: 'hidden' }
  | { readonly state: 'loading' }
  | { readonly state: 'none' }
  | { readonly state: 'failed'; readonly code: string }
  | { readonly state: 'live'; readonly status: string; readonly candidateAttempt?: number }

/** Read one field of an untrusted JSON observation, or nothing if it is not a record. */
function field(value: RuntimeDiagnosticsValue | undefined, key: string): RuntimeDiagnosticsValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  // `Array.isArray` cannot narrow `readonly T[]` out of the union, so the record
  // shape is asserted only after the array case has already been refused.
  const record = value as { readonly [key: string]: RuntimeDiagnosticsValue }
  return record[key]
}

/**
 * Map the resource model's snapshot onto the row's state.
 *
 * The row is only ever `live` for a status the policy actually reported; an
 * `idle` observation is rendered as `none`, so the strip never claims compaction
 * activity it cannot point at. A failed transport renders its classified code
 * rather than the last value it managed to deliver, which is what keeps a
 * disconnect from reading as a compaction that is still running.
 * @param snapshot - the resource model's current state for this address.
 * @returns the row's state.
 */
export function transientCompaction(snapshot: TransientResourceSnapshot): TransientCompaction {
  if (snapshot.status === 'none') return { state: 'hidden' }
  if (snapshot.status === 'loading') return { state: 'loading' }
  if (snapshot.status === 'failed') {
    return { state: 'failed', code: snapshot.failure?.code ?? 'runtime-diagnostics/transport-failure' }
  }
  const observation = snapshot.value
  if (observation === undefined || !observation.present) return { state: 'none' }
  const status = field(observation.value, 'status')
  if (typeof status !== 'string' || status === 'idle') return { state: 'none' }
  const attempt = field(observation.value, 'candidateAttempt')
  return typeof attempt === 'number'
    ? { state: 'live', status, candidateAttempt: attempt }
    : { state: 'live', status }
}
