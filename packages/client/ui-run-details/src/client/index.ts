/**
 * Run Details surface plugin, browser half: the read-only strip in the
 * `conversation.input.dock` row above the composer.
 *
 * Both facts it renders arrive through the standard projection seats —
 * `runDetails` for the Run's own cut and `taskCheckpoint` for durable task
 * continuity — so the strip holds no domain logic, no Remote call, and no
 * polling: the host is the only computation site. The entry contributes no
 * injected face at all, which is what makes the surface structurally read-only.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `runDetails` projection-key merge (single source, the domain's pure outlet).
import type {} from '@deepseek-ai/dsh-run-details/client'
// Type-only: pulls the `taskCheckpoint` projection-key merge.
import type {} from '@deepseek-ai/dsh-task-checkpoint/client'
// Type-only: pulls the Session standard useProjection seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the Conversation service and input-dock slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, NS, zh, type RunDetailsKey } from './locales.ts'
import { RunDetailsDock } from './RunDetailsDock.tsx'

export { RunDetailsDock, RunDetailsPanel } from './RunDetailsDock.tsx'
export type { RunDetailsDockProps, RunDetailsPanelProps } from './RunDetailsDock.tsx'
export { NS, en, zh } from './locales.ts'
export type { RunDetailsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Run Details strip's copy. */
    runDetails: RunDetailsKey
  }
}

/** Required services for the dock slot and the strip's copy. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: the Run Details dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-run-details: dictionaries')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'run-details',
    order: 30,
    locale: NS,
  }, RunDetailsDock))
}
