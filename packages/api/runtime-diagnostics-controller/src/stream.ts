/**
 * One open follow generation and the JSON detach step every frame passes.
 *
 * The generation exists to close one specific race. A reader that opens a
 * stream, subscribes, and *then* reads has to be sure no change lands between
 * the two, or the opening snapshot would be older than a change it never sent.
 * Registration here is silent and the read is synchronous, so the gap is
 * structurally empty rather than narrowed: no code runs between them.
 *
 * The buffer this holds is transport ordering, not authority. It carries
 * observations the owner has already committed, in the order it committed them,
 * and discards them as they are read. Nothing here interprets a value, and
 * nothing here outlives the stream that owns it.
 *
 * @module @deepseek-ai/dsh-api-runtime-diagnostics-controller/stream
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  RuntimeDiagnosticsFrame,
  RuntimeDiagnosticsObservation,
  RuntimeDiagnosticsProviderObservation,
  RuntimeDiagnosticsTopicDeclaration,
  RuntimeDiagnosticsValue,
} from './types.ts'

/**
 * Walk one untrusted value into detached plain JSON, or refuse it.
 *
 * A provider is a domain owner, not a serializer, so the transport does the
 * checking rather than trusting the shape: a function, a symbol, a bigint, a
 * non-finite number, a class instance, a cycle, or an `undefined` array entry
 * has no JSON representation, and silently dropping one would send a client a
 * value the owner never published. Refusing fails the stream closed instead.
 * @param value - the untrusted field value.
 * @param path - the field path, used to name the offending field in the error.
 * @param seen - the objects on the current walk path, for cycle detection.
 * @param topic - the topic being serialized, for the error's detail.
 * @returns the detached JSON value.
 * @throws RemoteError when the value has no JSON representation.
 */
function detachJson(value: unknown, path: string, seen: WeakSet<object>, topic: string): RuntimeDiagnosticsValue {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      if (!Number.isFinite(value)) refuse(topic, `field ${path} is not a finite number`)
      return value
    case 'object':
      break
    default:
      refuse(topic, `field ${path} is a ${typeof value}`)
  }
  const object = value
  if (seen.has(object)) refuse(topic, `field ${path} is cyclic`)
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      return object.map((entry, index) => {
        if (entry === undefined) refuse(topic, `field ${path}[${index}] is undefined`)
        return detachJson(entry, `${path}[${index}]`, seen, topic)
      })
    }
    const prototype = Object.getPrototypeOf(object) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      refuse(topic, `field ${path} is not a plain object`)
    }
    const detached: Record<string, RuntimeDiagnosticsValue> = {}
    for (const [key, entry] of Object.entries(object)) {
      if (entry === undefined) refuse(topic, `field ${path}.${key} is undefined`)
      detached[key] = detachJson(entry, `${path}.${key}`, seen, topic)
    }
    return detached
  } finally {
    // Removed on the way out so a value shared by two siblings stays legal
    // while a value that contains itself does not.
    seen.delete(object)
  }
}

/** Raise the transport's fail-closed error for an unserializable observation. */
function refuse(topic: string, detail: string): never {
  throw new RemoteError('runtime-diagnostics/invalid-observation', `observation for "${topic}" is not detached JSON: ${detail}`, { topic })
}

/**
 * Detach one observation into plain JSON, or refuse it.
 *
 * Absence is normalized here as well as in the frame: a provider that reports
 * `undefined` and one that reports `present: false` describe the same thing, and
 * a client should see one representation of it.
 * @param observation - the owner's observation, or `undefined` for none.
 * @param topic - the topic being serialized, for the error's detail.
 * @returns the detached observation.
 * @throws RemoteError when the present value is not detached JSON.
 */
export function detachObservation(
  observation: RuntimeDiagnosticsProviderObservation | undefined,
  topic: string,
): RuntimeDiagnosticsObservation {
  if (observation === undefined || !observation.present) return { present: false }
  const value = detachJson(observation.value, 'value', new WeakSet(), topic)
  // An observation is a record of a topic's fields. A bare array is detached
  // JSON but not an observation, so it is refused rather than handed to a client
  // that would have to guess how to read it.
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return refuse(topic, 'the present value is not an object')
  }
  return { present: true, value }
}

/** One queued replacement, boxed so a legitimate removal is not an empty queue. */
interface Queued {
  readonly observation: RuntimeDiagnosticsProviderObservation
}

/**
 * One Session's open generation: identity, buffered replacements, and the
 * single reader draining them.
 */
export class DiagnosticsGeneration {
  private readonly buffered: Queued[] = []
  private waiter: (() => void) | undefined
  private ended = false
  private terminalError: Error | undefined

  /**
   * @param declaration - the topic and schema the generation carries on every frame.
   * @param sessionId - the Session the generation observes.
   */
  constructor(
    private readonly declaration: RuntimeDiagnosticsTopicDeclaration,
    readonly sessionId: string,
  ) {}

  /** The topic this generation follows. */
  get topic(): string {
    return this.declaration.topic
  }

  /**
   * Buffer one committed replacement.
   *
   * The value is not serialized here: this runs inside the owner's notification,
   * and an unserializable observation must fail the stream rather than be thrown
   * back into the owner, which would report it as nothing more than a broken
   * listener and drop the frame.
   * @param observation - the committed observation, or `undefined` on removal.
   */
  push(observation: RuntimeDiagnosticsProviderObservation | undefined): void {
    if (this.ended) return
    this.buffered.push({ observation: observation ?? { present: false } })
    this.waiter?.()
  }

  /**
   * End the generation, optionally reporting why its owner was retired.
   * @param error - the terminal failure, or `undefined` for normal completion.
   */
  end(error?: Error): void {
    if (this.ended) return
    this.ended = true
    this.terminalError = error
    this.waiter?.()
  }

  /**
   * Build one wire frame for an observation.
   * @param type - whether this frame opens a generation or replaces within one.
   * @param observation - the observation to serialize.
   * @returns the complete replacement frame.
   */
  frame(type: 'snapshot' | 'change', observation: RuntimeDiagnosticsProviderObservation | undefined): RuntimeDiagnosticsFrame {
    return {
      type,
      topic: this.declaration.topic,
      sessionId: this.sessionId,
      schemaId: this.declaration.schemaId,
      schemaVersion: this.declaration.schemaVersion,
      observation: detachObservation(observation, this.declaration.topic),
    }
  }

  /**
   * Read buffered replacements in order until the generation ends or the signal aborts.
   *
   * Everything the owner committed before the generation ended is still
   * delivered: ending a generation stops future commits and releases the reader
   * once the buffer is empty, it does not discard observations the owner already
   * published. A retired owner then terminates with its typed lifecycle failure;
   * an unexpected natural end remains distinguishable at the Client. An abort
   * is different — it means stop now — so a frame buffered but not yet read is
   * dropped rather than delivered after cancellation.
   * @param signal - generation cancellation, torn down by the Remote carrier.
   * @returns every buffered replacement, in the order it was committed.
   */
  async *drain(signal: AbortSignal): AsyncIterable<RuntimeDiagnosticsFrame> {
    while (!signal.aborted) {
      const next = this.buffered.shift()
      if (next !== undefined) {
        yield this.frame('change', next.observation)
        continue
      }
      if (this.ended) {
        if (this.terminalError !== undefined) throw this.terminalError
        return
      }
      await this.wait(signal)
    }
  }

  /**
   * Wait for the next replacement, the end, or an abort.
   *
   * The caller has already proven the buffer empty and the generation live, and
   * nothing can run between that proof and this subscription, so the wait relies
   * on the notification it installs rather than re-testing what it was told.
   */
  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one reader owns the sole installed waiter. */
        if (this.waiter === finish) this.waiter = undefined
        resolve()
      }
      this.waiter = finish
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}
