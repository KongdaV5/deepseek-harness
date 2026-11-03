/**
 * Deterministic run and observer identities owned by the run-state domain.
 *
 * The logical DS Harness Run is one durable upstream turn, so its identity is a
 * pure function of `(SessionId, turn)` and nothing else. There is deliberately
 * no `RunId(value)` constructor: minting a run identity from an arbitrary
 * string is exactly the process-local or random allocation this domain must not
 * permit. A caller that needs a `RunId` derives it from durable facts.
 *
 * @module @deepseek-ai/dsh-agent-run-state/brand
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One logical DS Harness Run: one durable upstream turn of one Session. */
export type RunId = Branded<'RunId'>

/** Stable identity of one replaceable backend observer registration. */
export type BackendObserverId = Branded<'BackendObserverId'>

/** Version tag of the deterministic run-id encoding. */
const RUN_ID_SCHEME = 'run:v1'

/**
 * Brand a validated backend-observer identity.
 *
 * The observer id is supplied by the deploying adapter, not derived from a run,
 * so an external brand is safe here: it names a registration, not a run.
 * @param value - non-empty normalized observer identity.
 * @returns the supplied value carrying the observer brand.
 */
export function backendObserverId(value: string): BackendObserverId {
  if (value.length === 0 || value !== value.trim()) {
    throw new TypeError('backend observer id must be a non-empty normalized string')
  }
  return brandString<BackendObserverId>(value)
}

/**
 * Deterministically derive the logical Run owning one durable Session turn.
 *
 * The encoding is length-prefixed — `run:v1:<sessionIdLength>:<sessionId>:<turn>`
 * — so it is injective even when a Session id itself contains a colon or a
 * digit run. The same Session and turn therefore always yield the same identity
 * in any process, while a different turn, or the same turn of a different
 * Session, always yields a different one.
 * @param sessionId - durable conversation identity.
 * @param turn - the turn number the durable `turn/start` event opened, at least 1.
 * @returns the stable run identity for that Session turn.
 */
export function runIdFor(sessionId: SessionId, turn: number): RunId {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new TypeError(`run turn must be a positive safe integer, got ${String(turn)}`)
  }
  const raw = String(sessionId)
  return brandString<RunId>(`${RUN_ID_SCHEME}:${String(raw.length)}:${raw}:${String(turn)}`)
}
