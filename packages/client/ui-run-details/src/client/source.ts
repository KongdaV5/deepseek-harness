/** Registrant-private observable over one versioned Desktop diagnostics stream. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopRunDiagnosticsSnapshot } from '@deepseek-ai/dsh-desktop-run-diagnostics/client'

/** Remote stream and connection-reset inputs for one Session diagnostics source. */
export interface RunDetailsSourceDependencies {
  readonly watch: (signal: AbortSignal) => AsyncIterable<DesktopRunDiagnosticsSnapshot>
  readonly subscribeReset: (listener: () => void) => () => void
}

/**
 * Start Remote consumption only while a renderer observes the session. Stream
 * revisions are Host-owned; this source retains only the latest whole cut and
 * never infers a health, phase, or backend fact after stream loss.
 * @param dependencies - stream opener and connection-generation notifier.
 * @returns stable framework observable for the injected hook compartment.
 */
export function createRunDetailsSource(
  dependencies: RunDetailsSourceDependencies,
): HostObservable<DesktopRunDiagnosticsSnapshot | undefined> {
  let snapshot: DesktopRunDiagnosticsSnapshot | undefined
  let subscriptions = 0
  let controller: AbortController | undefined
  let disposeReset: (() => void) | undefined
  let generation = 0
  let streamGeneration = 0
  let acceptedStreamGeneration = 0
  const listeners = new Set<() => void>()

  const publish = (next: DesktopRunDiagnosticsSnapshot, stream: number): void => {
    // A Host reconnection begins a fresh, Host-owned revision sequence. Keep
    // the last confirmed frame until a new one arrives, then accept the new
    // stream even when its revision restarts at one. Frames from an older
    // stream never replace a newer frame.
    if (stream < acceptedStreamGeneration) return
    if (stream === acceptedStreamGeneration
      && snapshot !== undefined
      && next.version === snapshot.version
      && next.revision <= snapshot.revision) return
    acceptedStreamGeneration = stream
    snapshot = next
    for (const listener of listeners) listener()
  }

  const start = (): void => {
    const current = ++generation
    const open = (): void => {
      controller?.abort()
      const stream = ++streamGeneration
      const next = new AbortController()
      controller = next
      void (async () => {
        try {
          for await (const value of dependencies.watch(next.signal)) {
            if (next.signal.aborted || current !== generation) return
            publish(value, stream)
          }
        } catch {
          // The Connection owns Remote stream recovery. Retain the last
          // confirmed snapshot rather than inventing a disconnected run state.
        }
      })()
    }
    disposeReset = dependencies.subscribeReset(() => {
      if (current !== generation) return
      open()
    })
    open()
  }

  const stop = (): void => {
    generation++
    disposeReset?.()
    disposeReset = undefined
    controller?.abort()
    controller = undefined
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (subscriptions === 0) start()
      subscriptions++
      return () => {
        listeners.delete(listener)
        subscriptions--
        if (subscriptions === 0) stop()
      }
    },
  }
}
