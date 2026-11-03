/**
 * Run Details surface plugin, browser half: the read-only strip in the
 * `conversation.input.dock` row above the composer.
 *
 * The facts it renders arrive through the standard projection seats —
 * `runDetails` for the Run's own cut and `taskCheckpoint` for durable task
 * continuity — plus one resource address for the transient compaction
 * observation. All three are host-owned reads: the strip holds no domain logic,
 * makes no Remote call, and polls nothing, so the host remains the only
 * computation site. The entry contributes no injected face at all, which is what
 * makes the surface structurally read-only.
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
// Type-only: pulls the resource model's global seat and the transient topic registry merge.
import type {} from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/client'
import { en, NS, zh, type RunDetailsKey } from './locales.ts'
import { TRANSIENT_COMPACTION_SCHEMA, TRANSIENT_COMPACTION_TOPIC } from './transient.ts'
import { RunDetailsDock } from './RunDetailsDock.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Run Details strip's copy. */
    runDetails: RunDetailsKey
  }
}

/**
 * Required services for the dock slot, the strip's copy, and the transient topic
 * registry. The registry is what makes the transient read possible at all: with
 * it the strip serves its three rows, and without it the plugin simply does not
 * activate rather than opening a resource it could not validate.
 */
export const inject = ['slots', 'locale', 'runtimeDiagnosticsTopics']

/**
 * Client plugin body: the Run Details dock entry and its transient topic.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-run-details: dictionaries')

  // The topic's schema is declared on the transport's registry rather than in
  // this surface. A topic nobody declared fails the resource closed, so this is
  // what lets the row open without ever rendering an observation the client
  // cannot name the schema for.
  ctx.effect(
    () => ctx.runtimeDiagnosticsTopics.declare(TRANSIENT_COMPACTION_TOPIC, TRANSIENT_COMPACTION_SCHEMA),
    'ui-run-details: transient compaction topic',
  )

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'run-details',
    order: 30,
    locale: NS,
  }, RunDetailsDock))
}
