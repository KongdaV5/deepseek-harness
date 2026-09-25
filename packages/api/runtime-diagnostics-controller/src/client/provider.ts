/**
 * The `runtime-diagnostics` protocol's provider.
 *
 * One address names one `topic + SessionId`, and the provider turns that into
 * the Host's typed stream, validated frame by frame. Validation is the point:
 * a Remote payload is untrusted input, so nothing is cast and rendered. A frame
 * must be a plain object whose `topic` and `sessionId` repeat the address it was
 * asked for, whose schema matches the Client's declaration for that topic, and
 * whose observation is a plain object carrying a boolean `present`. A stream must
 * open with exactly one `snapshot` and then deliver `change` frames.
 *
 * Every violation ends the logical resource with a failure frame rather than
 * being tolerated. Physical Remote generations are supervised by Gateway and
 * reopened with a new validated snapshot; terminal transport or protocol
 * failures never masquerade as the last phase a Host published before it went
 * away.
 *
 * @module @deepseek-ai/dsh-api-runtime-diagnostics-controller/client/provider
 */

import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseRuntimeDiagnosticsAddress, RUNTIME_DIAGNOSTICS_PROTOCOL } from './address.ts'
import type { RuntimeDiagnosticsRemote } from './remote.ts'
import type {
  RuntimeDiagnosticsFrame,
  RuntimeDiagnosticsObservation,
  RuntimeDiagnosticsValue,
} from '../types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** One topic's current transient observation for one Session. */
    'runtime-diagnostics': RuntimeDiagnosticsObservation
  }
}

/** The observation schema a Client declares for one topic. */
export interface RuntimeDiagnosticsSchema {
  /** The schema identity the frames must carry. */
  readonly schemaId: string
  /** The schema version the frames must carry. */
  readonly schemaVersion: number
}

/**
 * Resolve the schema a topic's frames must declare.
 * @param topic - the topic to resolve.
 * @returns the declared schema, or `undefined` when this Client knows no such topic.
 */
export type RuntimeDiagnosticsSchemaLookup = (topic: string) => RuntimeDiagnosticsSchema | undefined

/** One frame that passed validation. */
interface AcceptedFrame {
  readonly type: 'snapshot' | 'change'
  readonly observation: RuntimeDiagnosticsObservation
}

/** The outcome of validating one untrusted frame. */
type FrameVerdict =
  | { readonly ok: true; readonly frame: AcceptedFrame }
  | { readonly ok: false; readonly detail: string }

/** Whether one untrusted value is a plain record. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one untrusted value is a detached JSON tree.
 *
 * The generated codec has already validated the tree's *shape* at the Remote
 * boundary, but this provider is also driven by scripted faces in tests and by
 * whatever a foreign implementation returns, so it re-checks rather than casts:
 * a value that reaches the UI is a value this module proved JSON. The rules are
 * the Host's own: a class instance, a non-finite number, and an `undefined`
 * member are all values with no JSON representation, and all are refused.
 * @param value - the untrusted value.
 * @returns `true` when the value is JSON.
 */
function json(value: unknown): value is RuntimeDiagnosticsValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(json)
  if (!record(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(json)
}

/** Validate one untrusted frame against the address and the declared schema. */
function validateFrame(
  value: unknown,
  address: { readonly topic: string; readonly sessionId: string },
  schema: RuntimeDiagnosticsSchema,
): FrameVerdict {
  if (!record(value)) return { ok: false, detail: 'the frame is not an object' }
  if (value.type !== 'snapshot' && value.type !== 'change') {
    return { ok: false, detail: 'the frame type is neither snapshot nor change' }
  }
  if (value.topic !== address.topic) return { ok: false, detail: 'the frame topic is not the addressed topic' }
  if (value.sessionId !== address.sessionId) return { ok: false, detail: 'the frame Session is not the addressed Session' }
  if (value.schemaId !== schema.schemaId || value.schemaVersion !== schema.schemaVersion) {
    return { ok: false, detail: 'the frame schema is not the declared schema for this topic' }
  }
  const observation = value.observation
  if (!record(observation) || typeof observation.present !== 'boolean') {
    return { ok: false, detail: 'the frame observation is not a present/absent record' }
  }
  if (!observation.present) {
    return { ok: true, frame: { type: value.type, observation: { present: false } } }
  }
  const payload = observation.value
  if (!record(payload) || !json(payload)) {
    return { ok: false, detail: 'the present observation value is not a detached JSON record' }
  }
  return { ok: true, frame: { type: value.type, observation: { present: true, value: payload } } }
}

/**
 * The failure for an address that is not a runtime-diagnostics target.
 * One helper per code, so each returns a single-code `RemoteError` and the
 * failure branch of `RemoteResult` narrows without a cast.
 * @returns the typed error.
 */
function invalidAddress(): RemoteError<'runtime-diagnostics/invalid-address'> {
  return new RemoteError(
    'runtime-diagnostics/invalid-address',
    'Not a runtime-diagnostics resource address.',
    {},
  )
}

/**
 * The failure for a topic this Client cannot name a schema for.
 * @param topic - the undeclared topic.
 * @returns the typed error.
 */
function unknownSchema(topic: string): RemoteError<'runtime-diagnostics/unknown-schema'> {
  return new RemoteError(
    'runtime-diagnostics/unknown-schema',
    `This client declares no schema for runtime diagnostics topic "${topic}".`,
    { topic },
  )
}

/**
 * The failure for any violation of the stream contract.
 * @param detail - the stable machine-readable reason.
 * @param message - the human diagnostic.
 * @returns the typed error.
 */
function unexpectedFrame(detail: string, message: string): RemoteError<'runtime-diagnostics/unexpected-frame'> {
  return new RemoteError('runtime-diagnostics/unexpected-frame', message, { detail })
}

/** A carrier failed outside the diagnostics frame contract. */
function transportFailure(message: string): RemoteError<'runtime-diagnostics/transport-failure'> {
  return new RemoteError('runtime-diagnostics/transport-failure', message, { detail: 'carrier-failure' })
}

/**
 * Build the `runtime-diagnostics` provider over one Remote face.
 * @param remote - the Remote face carrying `runtimeDiagnostics.follow`.
 * @param schemas - the Client's declared schema per topic.
 * @returns the provider to register into `ctx.resources`.
 */
export function createRuntimeDiagnosticsProvider(
  remote: RuntimeDiagnosticsRemote,
  schemas: RuntimeDiagnosticsSchemaLookup,
): ResourceProvider<typeof RUNTIME_DIAGNOSTICS_PROTOCOL> {
  return {
    protocol: RUNTIME_DIAGNOSTICS_PROTOCOL,
    async *open(address, { signal }): AsyncIterable<RemoteResult<RuntimeDiagnosticsObservation>> {
      const target = parseRuntimeDiagnosticsAddress(address)
      if (target === undefined) {
        yield { ok: false, error: invalidAddress() }
        return
      }
      const schema = schemas(target.topic)
      if (schema === undefined) {
        // Reading a topic whose schema this Client cannot name would mean
        // rendering an observation nobody validated, so it fails closed.
        yield { ok: false, error: unknownSchema(target.topic) }
        return
      }
      const request = { topic: target.topic, sessionId: target.sessionId }
      const stream = remote.$stream<RuntimeDiagnosticsFrame>({
        name: `runtime diagnostics ${target.topic}/${target.sessionId}`,
        open: streamSignal => remote.runtimeDiagnostics.follow(request, streamSignal),
        // A diagnostics follow is a snapshot-and-change stream. A clean end is
        // therefore a completed physical generation, not a valid end of the
        // logical resource; let Gateway reopen it against the current Host.
        ended: accepted => new RemoteStreamCarrierError(
          accepted
            ? 'runtime diagnostics generation ended after its opening snapshot'
            : 'runtime diagnostics generation ended before its opening snapshot',
        ),
      })
      const disposeOnAbort = (): void => { void stream.dispose() }
      signal.addEventListener('abort', disposeOnAbort, { once: true })
      if (signal.aborted) disposeOnAbort()
      let generation: number | undefined
      let opened = false
      try {
        for await (const item of stream) {
          if (signal.aborted) return
          if (item.generation !== generation) {
            generation = item.generation
            opened = false
          }
          const verdict = validateFrame(item.value, target, schema)
          if (!verdict.ok) {
            yield { ok: false, error: unexpectedFrame(verdict.detail, verdict.detail) }
            return
          }
          if (!opened) {
            if (verdict.frame.type !== 'snapshot') {
              yield {
                ok: false,
                error: unexpectedFrame('change-before-snapshot', 'The stream changed before it opened a snapshot.'),
              }
              return
            }
            opened = true
            item.accept()
          } else if (verdict.frame.type === 'snapshot') {
            yield {
              ok: false,
              error: unexpectedFrame('duplicate-snapshot', 'The stream opened a second snapshot in one generation.'),
            }
            return
          }
          yield { ok: true, value: verdict.frame.observation }
        }
        if (signal.aborted) return
        yield {
          ok: false,
          error: unexpectedFrame(
            'unexpected-logical-end',
            'The runtime diagnostics stream supervisor ended without an abort.',
          ),
        }
      } catch (error) {
        if (signal.aborted) return
        const remoteError = remoteErrorOf(error)
        if (remoteError !== undefined) {
          yield { ok: false, error: remoteError }
          return
        }
        if (!(error instanceof RemoteStreamCarrierError)) throw error
        yield { ok: false, error: transportFailure(error.message) }
      } finally {
        signal.removeEventListener('abort', disposeOnAbort)
        await stream.dispose()
      }
    },
  }
}
