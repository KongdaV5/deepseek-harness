/** Object-layer join of redacted runtime snapshots and explicit operations. */
import type { CodexSubscriptionStatus, CodexRuntimePreference } from '@deepseek-ai/dsh-agent-codex/types'
import type { LocalModelRuntimeSnapshot, LocalModelProfileId } from '@deepseek-ai/dsh-custom-foundation/local-runtime-types'
/** Complete observed facts; failure replaces stale status. */
export interface RuntimeSnapshot { local?: LocalModelRuntimeSnapshot; codex?: CodexSubscriptionStatus; loading: boolean; error?: string }
/** Explicit Host verbs; no auth or process ownership resides in this layer. */
export interface RuntimeOperations {
  localStatus(this: void): Promise<LocalModelRuntimeSnapshot>
  codexStatus(this: void): Promise<CodexSubscriptionStatus>
  start(this: void, profile: LocalModelProfileId): Promise<unknown>
  restart(this: void, profile: LocalModelProfileId): Promise<unknown>
  stop(this: void): Promise<unknown>
  select(this: void, preference: CodexRuntimePreference): Promise<unknown>
  reconnect(this: void): Promise<unknown>
  connect(this: void): Promise<unknown>
  disconnect(this: void): Promise<unknown>
  cancelLogin(this: void): Promise<unknown>
}
/** Observable domain read join with generation-safe refresh and operation serialization. */
export class RuntimeSettingsModel {
  private snapshot: RuntimeSnapshot = { loading: true }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private disposed = false
  private busy = false
  /** @param operations - Explicit remote closures bound by the plugin. */
  constructor(readonly operations: RuntimeOperations) {}
  /** Read the complete latest observation.
   * @returns the current read join.
   */
  getSnapshot(): RuntimeSnapshot { return this.snapshot }
  /** Observe complete replacement publications.
   * @param listener - Renderer invalidation callback.
   * @returns unsubscribe from this observation owner.
   */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(snapshot: RuntimeSnapshot): void { this.snapshot = snapshot; for (const notify of this.listeners) notify() }
  /** Read a fresh pair; a retired response never installs a stale healthy view. */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    try {
      const [local, codex] = await Promise.all([this.operations.localStatus(), this.operations.codexStatus()])
      if (!this.disposed && generation === this.generation) this.publish({ local, codex, loading: this.busy })
    } catch (error: unknown) {
      if (!this.disposed && generation === this.generation) this.publish({ loading: this.busy,
        error: error instanceof Error ? error.message : String(error) })
    }
  }
  /** Execute one explicit interaction and refresh owner facts after settlement.
   * @param operation - Already-bound Host verb selected by a user action.
   */
  async run(operation: () => Promise<unknown>): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true; ++this.generation; this.publish({ ...this.snapshot, loading: true })
    try { await operation(); this.busy = false; await this.refresh() }
    catch (error: unknown) {
      this.busy = false
      // A response may settle after the plugin that admitted it was retired.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (!this.disposed) this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  /** Retire pending responses and renderer observers. */
  dispose(): void { this.disposed = true; ++this.generation; this.listeners.clear() }
}
