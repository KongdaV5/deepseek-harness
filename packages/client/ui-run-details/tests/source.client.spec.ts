import { describe, expect, it, vi } from 'vitest'
import type { DesktopRunDiagnosticsSnapshot } from '@deepseek-ai/dsh-desktop-run-diagnostics/client'
import { createRunDetailsSource } from '../src/client/source.ts'

const first = { version: 1, revision: 1, observedAt: 1, run: null } as DesktopRunDiagnosticsSnapshot

describe('Run details Remote source', () => {
  it('starts only for observers and cancels its Remote stream on the final unsubscribe', async () => {
    let abort: AbortSignal | undefined
    const watch = vi.fn((signal: AbortSignal): AsyncIterable<DesktopRunDiagnosticsSnapshot> => ({
      async *[Symbol.asyncIterator]() {
        abort = signal
        yield first
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      },
    }))
    const source = createRunDetailsSource({ watch, subscribeReset: () => () => {} })
    expect(watch).not.toHaveBeenCalled()
    const dispose = source.subscribe(() => {})
    await Promise.resolve()
    expect(watch).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(source.getSnapshot()).toEqual(first) })
    expect(source.getSnapshot()).toEqual(first)
    dispose()
    expect(abort?.aborted).toBe(true)
  })

  it('accepts a new Host revision sequence after an explicit connection reset', async () => {
    let reset: (() => void) | undefined
    let invocation = 0
    const second = { ...first, revision: 1, observedAt: 2 } as DesktopRunDiagnosticsSnapshot
    const source = createRunDetailsSource({
      watch: signal => ({
        async *[Symbol.asyncIterator]() {
          invocation++
          yield invocation === 1 ? first : second
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        },
      }),
      subscribeReset: (listener) => {
        reset = listener
        return () => { reset = undefined }
      },
    })
    const dispose = source.subscribe(() => {})
    await vi.waitFor(() => { expect(source.getSnapshot()).toEqual(first) })
    reset?.()
    await vi.waitFor(() => { expect(source.getSnapshot()?.observedAt).toBe(2) })
    dispose()
  })
})
