import type {} from '@deepseek-ai/dsh-custom-foundation'
/** Custom Codex runtime composition over canonical Config and external Agent turns. */
import type { Context } from '@deepseek-ai/cordis'
import { CodexFoundation, type Config } from './config.ts'
import { CodexSubscriptionController } from './controller.ts'
import { CodexSubscriptionRuntime } from './runtime.ts'
export * from './config.ts'
export { CodexSubscriptionRuntime } from './runtime.ts'
export type { CodexRuntimeInternals } from './runtime.ts'
export { codexRuntimePackageVersion, codexServerArgv } from './app-server.ts'

/** One Config lifetime owns the runtime, provider directory, and process cleanup. */
export default class CodexPlugin extends CodexFoundation {
  static override inject = ['sessionProjections', 'configEditor', 'sessions', 'customFoundation']
  /** Mount Config, runtime and external execution for this profile entry.
   * @param ctx Profile-owned plugin context.
   * @param config Canonical live Config fields.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const runtime = new CodexSubscriptionRuntime(ctx, { enabled: () => ctx.customFoundation.snapshot().codexSubscription })
    runtime.attachConfig(this)
    new CodexSubscriptionController(ctx, runtime)
    ctx.provide('externalModelProviders', runtime)
    ctx.on('agent/resolve-external-turn', async ({ selection, signal }, next) => {
      if (selection.provider !== runtime.id) return next()
      return runtime.executorFor(selection, signal)
    })
    ctx.effect(() => async () => { await runtime.dispose() }, 'agent-codex: owned App Server lifecycle')
  }
}
