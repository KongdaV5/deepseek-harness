/** Deterministic timing fixture for Agent Run policy tests. */

import type { RunPolicyClock } from './types.ts'

interface ScheduledTask {
  readonly id: number
  readonly dueAt: number
  readonly callback: () => void
}

/** In-memory clock whose caller advances time without waiting on wall time. */
export class FakeClock implements RunPolicyClock {
  private time: number
  private nextId = 0
  private readonly tasks = new Map<number, ScheduledTask>()

  constructor(startAt = 0) {
    this.time = startAt
  }

  /** Current synthetic timestamp. */
  now(): number {
    return this.time
  }

  /** Schedule one callback against synthetic time. */
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId
    this.tasks.set(id, { id, dueAt: this.time + delayMs, callback })
    return id
  }

  /** Cancel one synthetic timer. */
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle)
  }

  /**
   * Advance time and run every due callback in deadline/id order.
   * @param elapsedMs - non-negative safe-integer duration.
   */
  advance(elapsedMs: number): void {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new TypeError('FakeClock elapsedMs must be a non-negative safe integer')
    }
    const target = this.time + elapsedMs
    while (true) {
      const next = [...this.tasks.values()]
        .filter(task => task.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
      if (next === undefined) break
      this.tasks.delete(next.id)
      this.time = next.dueAt
      next.callback()
    }
    this.time = target
  }

  /** Number of timers still awaiting synthetic time. */
  get pendingTimers(): number {
    return this.tasks.size
  }
}
