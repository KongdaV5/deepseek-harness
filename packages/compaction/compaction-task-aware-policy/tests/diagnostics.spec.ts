/**
 * The transient diagnostics store's read-only observation seam.
 *
 * Stage 11 transports this seam to a client, so the properties that matter are
 * the ones that keep it an *observer* of Stage 10 rather than a second owner of
 * Stage 10's state: registration is silent, notification follows the commit,
 * removal is announced as `undefined` rather than left stale, and a listener
 * failure is reported without reaching the writer or a sibling listener.
 */

import { describe, expect, it, vi } from 'vitest'
import { TaskAwareDiagnosticsStore } from '../src/diagnostics.ts'
import type { TaskAwareCompactionDiagnostics } from '../src/types.ts'

/** One complete observation for a Session. */
function observation(status: TaskAwareCompactionDiagnostics['status']): TaskAwareCompactionDiagnostics {
  return { status, protectedEvidenceCount: 0, mainRunReasoningUnchanged: true }
}

describe('the diagnostics store observation seam', () => {
  it('A: delivers the complete new observation after a write', () => {
    const store = new TaskAwareDiagnosticsStore()
    const seen: (TaskAwareCompactionDiagnostics | undefined)[] = []
    store.subscribe('session-1', value => seen.push(value))
    const written = observation('summarizing')
    store.write('session-1', written)
    expect(seen).toEqual([written])
  })

  it('B: commits the owner value before any listener observes it', () => {
    const store = new TaskAwareDiagnosticsStore()
    // The listener reads the store rather than trusting the argument, so the
    // assertion is that the committed value is already visible when it runs.
    const observed: (TaskAwareCompactionDiagnostics | undefined)[] = []
    store.subscribe('session-1', () => observed.push(store.read('session-1')))
    const written = observation('validating')
    store.write('session-1', written)
    expect(observed).toEqual([written])
    expect(store.read('session-1')).toBe(written)
  })

  it('C: announces undefined to listeners of a Session that held a value', () => {
    const store = new TaskAwareDiagnosticsStore()
    const seen: (TaskAwareCompactionDiagnostics | undefined)[] = []
    store.subscribe('session-1', value => seen.push(value))
    store.write('session-1', observation('applied'))
    store.clear()
    expect(seen).toEqual([expect.objectContaining({ status: 'applied' }), undefined])
    expect(store.read('session-1')).toBeUndefined()
  })

  it('does not announce anything for a Session that never held a value', () => {
    const store = new TaskAwareDiagnosticsStore()
    const seen: unknown[] = []
    store.subscribe('session-absent', value => seen.push(value))
    store.write('session-1', observation('applied'))
    store.clear()
    expect(seen).toEqual([])
  })

  it('D: announces undefined to the Session an LRU eviction removed', () => {
    const store = new TaskAwareDiagnosticsStore()
    const evicted: (TaskAwareCompactionDiagnostics | undefined)[] = []
    store.subscribe('session-0', value => evicted.push(value))
    store.write('session-0', observation('applied'))
    const afterSeed = evicted.length
    // The retained bound is 64 Sessions, so writing 64 further Sessions evicts
    // the oldest, which is the one under observation.
    for (let index = 1; index <= 64; index += 1) {
      store.write(`session-${index}`, observation('applied'))
    }
    expect(evicted.slice(afterSeed)).toEqual([undefined])
    expect(store.read('session-0')).toBeUndefined()
    expect(store.read('session-64')).toBeDefined()
  })

  it('E: isolates a throwing listener from the owner, the writer, and later listeners', () => {
    const reported: Array<[string, unknown]> = []
    const store = new TaskAwareDiagnosticsStore((sessionId, error) => reported.push([sessionId, error]))
    const delivered: unknown[] = []
    const failure = new Error('observer exploded')
    store.subscribe('session-1', () => { throw failure })
    store.subscribe('session-1', value => delivered.push(value))
    const written = observation('summarizing')
    // The write itself must succeed and return normally.
    expect(() => { store.write('session-1', written) }).not.toThrow()
    // The owner state is committed, so the writer observed a real transition.
    expect(store.read('session-1')).toBe(written)
    // A later listener on the same Session is still served.
    expect(delivered).toEqual([written])
    expect(reported).toEqual([['session-1', failure]])
  })

  it('E: does not let one observer failure suppress the removal announcement', () => {
    const store = new TaskAwareDiagnosticsStore(() => {})
    const delivered: unknown[] = []
    store.subscribe('session-1', () => { throw new Error('observer exploded') })
    store.subscribe('session-1', value => delivered.push(value))
    store.write('session-1', observation('applied'))
    store.clear()
    expect(delivered).toEqual([expect.objectContaining({ status: 'applied' }), undefined])
  })

  it('F: stops future callbacks on unsubscribe and is idempotent', () => {
    const store = new TaskAwareDiagnosticsStore()
    const seen: (TaskAwareCompactionDiagnostics | undefined)[] = []
    const dispose = store.subscribe('session-1', value => seen.push(value))
    store.write('session-1', observation('assessing'))
    dispose()
    // A second call must be harmless rather than removing an unrelated listener.
    expect(() => { dispose() }).not.toThrow()
    store.write('session-1', observation('summarizing'))
    expect(seen).toEqual([expect.objectContaining({ status: 'assessing' })])
  })

  it('removes only the unsubscribed listener', () => {
    const store = new TaskAwareDiagnosticsStore()
    const first: unknown[] = []
    const second: unknown[] = []
    const disposeFirst = store.subscribe('session-1', value => first.push(value))
    store.subscribe('session-1', value => second.push(value))
    disposeFirst()
    store.write('session-1', observation('applied'))
    expect(first).toEqual([])
    expect(second).toEqual([expect.objectContaining({ status: 'applied' })])
  })

  it('G: does not emit the current observation on registration', () => {
    const store = new TaskAwareDiagnosticsStore()
    store.write('session-1', observation('applied'))
    const seen: unknown[] = []
    store.subscribe('session-1', value => seen.push(value))
    // A caller that must not miss a change registers first and then reads.
    expect(seen).toEqual([])
    expect(store.read('session-1')).toMatchObject({ status: 'applied' })
  })

  it('H: behaves exactly as before when nothing observes it', () => {
    const store = new TaskAwareDiagnosticsStore()
    const before = observation('summarizing')
    store.write('session-1', before)
    expect(store.read('session-1')).toBe(before)
    // A re-write keeps the Session as the most recently used, so it survives an
    // eviction sweep that removes an older key instead.
    store.write('session-0', observation('applied'))
    store.write('session-1', observation('validating'))
    for (let index = 2; index <= 64; index += 1) store.write(`session-${index}`, observation('applied'))
    expect(store.read('session-1')).toMatchObject({ status: 'validating' })
    expect(store.read('session-0')).toBeUndefined()
    store.clear()
    expect(store.read('session-1')).toBeUndefined()
  })

  it('notifies every Session that held a value exactly once per clear', () => {
    const store = new TaskAwareDiagnosticsStore()
    const watcher = vi.fn()
    store.subscribe('session-1', watcher)
    store.write('session-1', observation('applied'))
    store.clear()
    store.clear()
    expect(watcher).toHaveBeenCalledTimes(2)
    expect(watcher).toHaveBeenLastCalledWith(undefined)
  })
})

describe('the diagnostics store exposes no compaction authority', () => {
  it('carries no assess/begin/trigger/record verb on its surface', () => {
    // The transport binds to read/subscribe only. Anything that could start or
    // influence a compaction must not be reachable from the observation seam.
    const surface = Object.getOwnPropertyNames(TaskAwareDiagnosticsStore.prototype)
    expect(surface).toEqual(expect.arrayContaining(['read', 'subscribe', 'write', 'clear']))
    for (const forbidden of ['assess', 'begin', 'trigger', 'recordDiagnostics', 'record']) {
      expect(surface).not.toContain(forbidden)
    }
  })
})
