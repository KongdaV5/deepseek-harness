/**
 * Shared fixtures for the transient diagnostics transport suites.
 *
 * The provider here is scripted rather than real: the transport's whole job is
 * to route, order, and detach what an owner publishes, so a spec has to control
 * exactly when an owner commits and exactly what it hands over. Everything a
 * spec asserts about ordering is therefore a fact about the transport, not about
 * a test double's timing.
 *
 * This file is the Host-face half. The Client-face fixtures live in
 * `harness.client.ts`, because the two lanes merge cordis `Context` under the
 * same keys and one program cannot see both.
 */
import type {
  RuntimeDiagnosticsFrame,
  RuntimeDiagnosticsProvider,
  RuntimeDiagnosticsProviderObservation,
} from '../src/types.ts'

/** One observation an owner commits. */
export interface Committed {
  /** The Session the observation is about. */
  readonly sessionId: string
  /** The committed value, or `undefined` for a removal. */
  readonly value: object | undefined
}

/** The observable call sequence one scripted provider recorded. */
export type ProviderOperation = `read:${string}` | `subscribe:${string}` | `dispose:${string}`

/**
 * A provider whose reads and replacements the spec drives.
 *
 * `onSubscribe` runs synchronously inside `subscribe`, which is what makes the
 * controller's subscribe-then-read ordering falsifiable: a commit injected there
 * must appear in the opening snapshot, and it only can if the read happens after
 * the subscription is in place.
 */
export class ScriptedProvider implements RuntimeDiagnosticsProvider {
  readonly schemaId = 'dsh.test-diagnostics'
  readonly schemaVersion = 1
  readonly operations: ProviderOperation[] = []
  /** Committed observations, in commit order. */
  readonly committed: Committed[] = []
  /** Runs synchronously inside `subscribe`, before it returns. */
  onSubscribe: ((sessionId: string) => void) | undefined

  private readonly current = new Map<string, object>()
  private readonly listeners = new Map<string, Set<(observation: RuntimeDiagnosticsProviderObservation | undefined) => void>>()

  /** @param topic - the topic this provider claims. */
  constructor(readonly topic = 'test-topic') {}

  read(sessionId: string): RuntimeDiagnosticsProviderObservation | undefined {
    this.operations.push(`read:${sessionId}`)
    const value = this.current.get(sessionId)
    return value === undefined ? undefined : { present: true, value }
  }

  subscribe(
    sessionId: string,
    listener: (observation: RuntimeDiagnosticsProviderObservation | undefined) => void,
  ): () => void {
    this.operations.push(`subscribe:${sessionId}`)
    let listeners = this.listeners.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    this.onSubscribe?.(sessionId)
    return () => {
      this.operations.push(`dispose:${sessionId}`)
      listeners.delete(listener)
    }
  }

  /** Commit one observation and notify, exactly as a real owner's write does. */
  commit(sessionId: string, value: object | undefined): void {
    this.committed.push({ sessionId, value })
    if (value === undefined) this.current.delete(sessionId)
    else this.current.set(sessionId, value)
    for (const listener of [...this.listeners.get(sessionId) ?? []]) {
      listener(value === undefined ? undefined : { present: true, value })
    }
  }
}

/**
 * A generation's iterator at a call site that expects frames.
 *
 * `IteratorResult<T>` defaults its return type to `any`, which would leave
 * `value` untyped at every assertion; narrowing the return type to `undefined`
 * stays assignable from that default while making `value` the frame the
 * generation yielded, or nothing once the generation has ended.
 */
export type FrameIterator = AsyncIterator<RuntimeDiagnosticsFrame, undefined>

/** Wait for one more frame, or report that the stream stayed silent for a tick. */
export async function nextFrame(
  iterator: AsyncIterator<RuntimeDiagnosticsFrame>,
): Promise<RuntimeDiagnosticsFrame | 'silent'> {
  return Promise.race([
    iterator.next().then(result => (result.done === true ? 'silent' as const : result.value)),
    new Promise<'silent'>((resolve) => { setTimeout(() => { resolve('silent') }, 0) }),
  ])
}

/** The frames a bounded pull delivers before the stream stops producing. */
export async function drainFrames(
  stream: AsyncIterable<RuntimeDiagnosticsFrame>,
  limit: number,
): Promise<RuntimeDiagnosticsFrame[]> {
  const frames: RuntimeDiagnosticsFrame[] = []
  const iterator = stream[Symbol.asyncIterator]()
  for (let index = 0; index < limit; index += 1) {
    const frame = await nextFrame(iterator)
    if (frame === 'silent') break
    frames.push(frame)
  }
  return frames
}

/** Let queued microtasks settle. */
export const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })
