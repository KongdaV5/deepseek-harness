/** Observable redacted Host snapshots; no permission, lease or execution authority. */
import type { ComputerUseStatus } from '@deepseek-ai/dsh-custom-computer-use-safety/types'
/** Explicit UI operations owned by the Host. */
export interface Operations {
  status(): Promise<ComputerUseStatus>
  stop(): Promise<ComputerUseStatus>
  resume(): Promise<ComputerUseStatus>
  checkPermissions(): Promise<ComputerUseStatus>
  requestPermissions(): Promise<ComputerUseStatus>
}
/** Client-only loading and failure presentation. */
export interface Snapshot { status?: ComputerUseStatus; error?: string }
/** One disposable observation shared by Settings and every visible conversation. */
export class ComputerUseModel {
  private value: Snapshot = {}
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private revision = 0
  private disposed = false
  private started = false
  private pending = 0
  /** @param operations - Remote closures; Global Stop bypasses ongoing status reads. */
  constructor(readonly operations: Operations) {}
  /** Read the latest complete Host observation. */
  getSnapshot(): Snapshot { return this.value }
  /** Observe while mounted; polls only redacted status, never permissions or screen contents.
   * @param listener - Renderer invalidation callback.
   * @returns mounted observation disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.timer === undefined) {
      if (!this.started) { this.started = true; void this.refresh() }
      this.timer = setInterval(() => { void this.refresh() }, 1_000)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
    }
  }
  /** Observe a user operation; a stale read cannot overwrite a newer stop observation.
   * @param operation - User-selected Host verb, or status read.
   */
  async run(operation: () => Promise<ComputerUseStatus>): Promise<void> {
    if (this.disposed) return
    const revision = ++this.revision
    this.pending += 1
    try {
      const status = await operation()
      if (!this.isCurrent(revision)) return
      this.value = { status }
    } catch {
      if (!this.isCurrent(revision)) return
      this.value = { error: 'host-unavailable' }
    } finally {
      this.pending -= 1
    }
    for (const notify of this.listeners) notify()
  }
  private isCurrent(revision: number): boolean { return !this.disposed && revision === this.revision }
  /** Poll only while idle so status reads cannot retire an explicit user operation. */
  async refresh(): Promise<void> {
    if (this.pending === 0) await this.run(() => this.operations.status())
  }
  /** Retire polling and pending publications. */
  dispose(): void {
    this.disposed = true; ++this.revision
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined; this.listeners.clear()
  }
}
