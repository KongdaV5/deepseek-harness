import { isAbsolute } from 'node:path'
/** One Host-owned llama process on an explicitly configured loopback serving resource. */
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { LocalProfile } from './index.ts'
import type { LocalModelProfileId } from './local-runtime-types.ts'
import type { LocalModelRuntimeDriver, LocalModelRuntimeProbe, RuntimeProfile } from './local-runtime.ts'
import { z } from 'zod'

/** Deployment-owned process settings; argv is never evaluated by a shell. */
export interface OwnedLocalProcessConfig {
  /** Qualified executable path selected by the deployment. */
  binary: string
  /** Child working directory, independent of production Harness data. */
  cwd: string
  /** Extra llama options; model, host, port and alias remain owned by this driver. */
  args: string[]
  /** Loopback serving resource serialized by the Local controller. */
  endpoint: string
}

/** Owned-child driver; a stale or foreign endpoint never establishes process health. */
export class OwnedLocalProcessDriver implements LocalModelRuntimeDriver {
  private child: SubprocessHandle | undefined
  private stopping = false
  private closed = false
  private failed: Error | undefined
  /** Create one process owner without spawning.
   * @param ctx Explicit subprocess capability and lifecycle context.
   * @param config Validated process deployment.
   * @param inventory Canonical persisted profile inventory reader.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: OwnedLocalProcessConfig,
    private readonly inventory: () => readonly LocalProfile[],
  ) {
    if (!isAbsolute(config.binary) || !isAbsolute(config.cwd)) throw new Error('Local executable and working directory must be explicit absolute paths')
    const reserved = new Set(['--model', '-m', '--alias', '-a', '--host', '--port'])
    if (config.args.some(arg => reserved.has(arg.split('=')[0] ?? ''))) throw new Error('Local deployment cannot override the controller-owned model or serving resource')
  }
  /** Read model-file availability without caching runtime health.
   * @returns Currently installed text profiles.
   */
  async profiles(): Promise<RuntimeProfile[]> {
    return Promise.all(this.inventory().filter(p => p.id === 'huihui' || p.id === '38').map(async (p) => {
      let available = false
      try { available = (await stat(p.modelId)).isFile() } catch { /* Missing files are unavailable inventory. */ }
      return { ...p, id: p.id as LocalModelProfileId, manageable: true, available }
    }))
  }
  /** Probe endpoint and recheck the same process owner after awaiting HTTP.
   * @returns Fresh process and exact served-model observations.
   */
  async probe(): Promise<LocalModelRuntimeProbe> {
    let models: string[] = []
    let listening = false
    try {
      const response = await fetch(`${this.config.endpoint}/models`, { signal: AbortSignal.timeout(2000) })
      listening = true
      if (response.ok) models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json()).data.map(m => m.id)
    } catch { /* Connection failure and malformed health make the route unavailable. */ }
    return { available: !this.closed, managed: this.child !== undefined, listening,
      modelIds: this.failed !== undefined || this.stopping ? [] : models }
  }
  /** Start or release only this driver's child; foreign listeners remain untouched.
   * @param command Explicit runtime operation.
   * @param profile Canonical text profile for start.
   * @returns Fulfillment after spawn or complete owned-range shutdown.
   */
  async run(command: 'runtime-start' | 'stop', profile?: LocalModelProfileId): Promise<void> {
    if (command === 'stop') {
      const child = this.child
      if (child === undefined) return
      this.failed = undefined
      this.stopping = true
      child.terminate()
      if (!await child.waitForExit(AbortSignal.timeout(15000))) throw new Error('Local child range did not terminate')
      await child.done
      if (this.child === child) this.child = undefined
      this.stopping = false
      return
    }
    if (this.closed || this.child !== undefined) throw new Error('Local process owner cannot start another child')
    const target = this.inventory().find(p => p.id === profile && p.modality === 'text')
    if (target === undefined) throw new Error('Local profile is not a supported text runtime')
    const endpoint = new URL(this.config.endpoint)
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) throw new Error('Local runtime requires the official subprocess provider')
    const child = subprocess.spawn({
      argv: [this.config.binary, '--model', target.modelId, '--alias', target.modelId, '--host', '127.0.0.1', '--port', endpoint.port,
        ...this.config.args],
      cwd: this.config.cwd, graceMs: 3000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
    })
    this.child = child
    this.stopping = false
    this.failed = undefined
    const exited = (): void => {
      if (this.child !== child) return
      // Outcome alone does not prove the provider-owned process range is empty.
      // Retain the handle until explicit shutdown joins that same range.
      if (!this.stopping) this.failed = new Error('Local process exited unexpectedly')
      this.ctx.emit('llm/adapters-updated')
    }
    void child.done.then(exited, exited)
  }
  /** Wait for a fresh observation, stopping immediately if the owned child fails.
   * @param predicate Required observed state.
   * @param timeoutMs Operation deadline.
   * @returns Observation satisfying the requested state.
   */
  async waitFor(predicate: (probe: LocalModelRuntimeProbe) => boolean, timeoutMs: number): Promise<LocalModelRuntimeProbe> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const state = await this.probe()
      if (predicate(state)) return state
      if (this.closed || Date.now() >= deadline) throw new Error('Local runtime did not reach the requested state')
      if (this.failed !== undefined) throw this.failed
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  /** Dispose the child after the controller's operation queue has drained.
   * @returns Fulfillment after owned process-range exit.
   */
  async dispose(): Promise<void> { this.closed = true; await this.run('stop') }
}
