/** Optional Computer Use contributions through canonical Settings and conversation slots. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import computerUseRemote from '@deepseek-ai/dsh-custom-computer-use-safety/remote'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ComputerUseModel } from './model.ts'
import { ComputerUseSettings, ComputerUseStop, type ControlsInjected } from './controls.tsx'
import { en, zh, type CopyKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'custom.computerUse': CopyKey } }
async function read<T>(operation: Promise<RemoteResult<T>>): Promise<T> {
  const result = await operation
  if (!result.ok) throw new Error('Computer Use Host operation failed')
  return result.value
}
/** Required transport and renderer capabilities; absent bundle contributes no controls. */
export const inject = ['slots', 'locale', 'remote']
/** Register observational controls; no local runtime or enablement owner.
 * @param ctx - Client plugin lifecycle and canonical Remote capabilities.
 * @returns Resolves after the owned Remote namespace and controls activate.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(computerUseRemote)
  await ctx.inject(['remote.computerUse'], mountControls)
}

function mountControls(ctx: Context): void {
  const api = ctx.remote.computerUse
  const model = new ComputerUseModel({ status: () => read(api.status()), stop: () => read(api.stop()),
    resume: () => read(api.resume()), checkPermissions: () => read(api.checkPermissions()),
    requestPermissions: () => read(api.requestPermissions()),
  })
  ctx.effect(() => ctx.locale.register('custom.computerUse', { en, zh }), 'computer-use: dictionaries')
  ctx.effect(() => () => { model.dispose() }, 'computer-use: observation lifetime')
  const inject = (): ControlsInjected => ({ hooks: { computerUse: model }, model, t: ctx.locale.bind('custom.computerUse') })
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'computer-use',
    order: 30, label: () => ctx.locale.bind('custom.computerUse')('title'), inject }, ComputerUseSettings))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'computer-use-stop',
    order: 20, inject }, ComputerUseStop))
}
