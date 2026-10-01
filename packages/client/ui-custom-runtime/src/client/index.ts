import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
/** Custom controls contributed through official Models extension slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RuntimeSettingsModel } from './model.ts'
import { RuntimeCards, type RuntimeCardsInjected } from './cards.tsx'
import { en, zh, type CopyKey } from './locales.ts'
export type { RuntimeCardsInjected } from './cards.tsx'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'custom.runtime': CopyKey } }
async function readResult<T>(operation: Promise<RemoteResult<T>>): Promise<T> {
  const result = await operation
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Remote namespaces required by the mounted Custom composition. */
export const inject = ['slots', 'locale', 'remote.localModels', 'remote.codexSubscription']
/** Register one read-only status join and bind explicit user control verbs.
 * @param ctx - Client plugin lifecycle and Remote capabilities.
 */
export function apply(ctx: Context): void {
  const model = new RuntimeSettingsModel({
    localStatus: () => readResult(ctx.remote.localModels.status()), codexStatus: () => readResult(ctx.remote.codexSubscription.status()),
    start: profile => readResult(ctx.remote.localModels.start(profile)), stop: () => readResult(ctx.remote.localModels.stop()),
    select: preference => readResult(ctx.remote.codexSubscription.selectRuntime(preference)),
    reconnect: () => readResult(ctx.remote.codexSubscription.reconnect()),
    connect: () => readResult(ctx.remote.codexSubscription.connect()),
    disconnect: () => readResult(ctx.remote.codexSubscription.disconnect()),
    cancelLogin: () => readResult(ctx.remote.codexSubscription.cancelLogin()),
  })
  ctx.effect(() => ctx.locale.register('custom.runtime', { en, zh }), 'custom-runtime: copy')
  ctx.effect(() => {
    const refresh = () => { void model.refresh() }
    const disposers = [ctx.remote.$on('llm/adapters-updated', refresh), ctx.on('connection/reset', refresh)]
    return () => { model.dispose(); for (const dispose of disposers) dispose() }
  }, 'custom-runtime: lifecycle')
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'custom-runtime', order: 10,
    inject: (): RuntimeCardsInjected => ({ hooks: { runtime: model }, model, t: ctx.locale.bind('custom.runtime') }),
  }, RuntimeCards))
}
