/** Browser composition for the compact Run status dock. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-desktop-run-diagnostics/remote'
import type { RunDetailsInjected } from './slots.ts'
import { RunStatusDock } from './RunStatusDock.tsx'
import { en, zh, type RunDetailsKey } from './locales.ts'
import { createRunDetailsSource } from './source.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the compact current-run strip and Run Details dialog. */
    runDetails: RunDetailsKey
  }
}

/** Required renderer, Remote, locale, and Conversation slot services. */
export const inject = ['slots', 'sessions', 'remote', 'remote.desktopRunDiagnostics', 'locale', 'uiConversation']

/** Mount the session-scoped status dock in the existing composer context stack. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('runDetails', { zh, en }), 'ui-run-details: dictionaries')
  const sources = new Map<SessionId, ReturnType<typeof createRunDetailsSource>>()
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'run-details',
    order: 20,
    locale: 'runDetails',
    inject: (sessionId: SessionId): RunDetailsInjected => {
      let source = sources.get(sessionId)
      if (source === undefined) {
        source = createRunDetailsSource({
          watch: signal => ctx.remote.desktopRunDiagnostics.watch(sessionId, signal),
          subscribeReset: listener => ctx.on('connection/reset', listener),
        })
        sources.set(sessionId, source)
      }
      return {
        hooks: { runDiagnostics: source },
        resume: request => ctx.remote.desktopRunDiagnostics.resume(sessionId, request),
      }
    },
  }, RunStatusDock))
}
