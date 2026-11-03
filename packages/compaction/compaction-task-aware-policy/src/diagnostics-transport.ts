/**
 * The Stage 10 → Stage 11 transport adapter.
 *
 * Stage 10 owns a process-local, read-only view of what the task-aware
 * compaction policy is doing right now. This module publishes that view on the
 * generic transient diagnostics transport under the topic this domain owns, and
 * it does nothing else: it maps one `read` and one `subscribe` onto the
 * policy's own read-only face, states the schema its frames must carry, and
 * registers the provider for as long as the adapter is mounted.
 *
 * The adapter is deliberately separable from the policy. The policy is a
 * deployment-independent capability; publishing its transient view is a
 * deployment's decision, so the transport is a subpath a composition mounts
 * only when it also mounts the transport itself. A policy mounted with no
 * transport behaves exactly as before, and a transport mounted with no provider
 * serves no topic.
 *
 * The adapter owns no state: it keeps no cache, arms no timer, recomputes
 * nothing, and persists nothing. Every frame it conveys is a value the policy
 * had already committed when the transport asked for it.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/diagnostics-transport
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-runtime-diagnostics-controller'
import type { RuntimeDiagnosticsProvider } from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/types'
import type {} from '@deepseek-ai/dsh-compaction'
import type { TaskAwareCompactionDiagnostics, TaskAwareDiagnosticsSource } from './types.ts'

/** The transport topic this domain owns. One provider serves one topic. */
export const TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC = 'task-aware-compaction'

/**
 * The observation schema identity and version every frame on that topic carries.
 *
 * The pair travels on the wire so a client that does not recognize it refuses
 * the observation instead of interpreting it. A change to the observation's
 * fields is a new version, never a reinterpretation of this one.
 */
export const TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA = Object.freeze({
  schemaId: 'dsh.task-aware-compaction-diagnostics',
  schemaVersion: 1,
})

/**
 * Whether a mounted candidate policy also publishes the read-only diagnostics face.
 *
 * The compaction policy contract is task-agnostic and exposes no diagnostics
 * verb, so a deployment may legitimately mount some other policy under the same
 * service name. This narrows at runtime rather than assuming, so the adapter
 * publishes only for a policy that really has the face.
 * @param value - the mounted candidate policy.
 * @returns `true` when the value can be observed as a diagnostics source.
 */
export function isTaskAwareDiagnosticsSource(value: unknown): value is TaskAwareDiagnosticsSource {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['diagnostics'] === 'function'
    && typeof candidate['subscribeDiagnostics'] === 'function'
}

/**
 * Build the provider that publishes one policy's transient observations.
 *
 * `read` reports the observation the policy holds at that instant and
 * `subscribe` forwards each complete replacement it commits, so the transport
 * conveys exactly the policy's own values and nothing this adapter derived.
 * The store replaces its observation object on every write and never mutates
 * one in place, so forwarding the reference can never publish a value the
 * policy has since changed underneath it.
 * @param source - the policy's read-only diagnostics face.
 * @returns the provider to register with the transient diagnostics transport.
 */
export function createTaskAwareCompactionDiagnosticsProvider(
  source: TaskAwareDiagnosticsSource,
): RuntimeDiagnosticsProvider {
  const present = (
    observation: TaskAwareCompactionDiagnostics | undefined,
  ): { readonly present: true; readonly value: object } | undefined =>
    observation === undefined ? undefined : { present: true, value: observation }
  return {
    topic: TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC,
    schemaId: TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA.schemaId,
    schemaVersion: TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA.schemaVersion,
    read: sessionId => present(source.diagnostics(sessionId)),
    subscribe: (sessionId, listener) => source.subscribeDiagnostics(
      sessionId,
      (observation) => { listener(present(observation)) },
    ),
  }
}

/** Stable Cordis plugin name. */
export const name = 'compaction-task-aware-diagnostics-transport'

/** The policy this adapter observes, and the transport it publishes through. */
export const inject = ['compactionCandidatePolicy', 'runtimeDiagnostics']

/**
 * Publish the mounted policy's transient observations on the transport.
 *
 * The provider is registered inside an owned effect, so unmounting the adapter
 * — or the policy, or the transport — retires it and ends every stream opened
 * on it. A mounted policy without the diagnostics face publishes nothing rather
 * than failing: this adapter is optional instrumentation, not a dependency.
 * @param ctx - the owning context.
 */
export function apply(ctx: Context): void {
  const policy = ctx.compactionCandidatePolicy
  if (!isTaskAwareDiagnosticsSource(policy)) return
  ctx.effect(
    () => ctx.runtimeDiagnostics.registerProvider(createTaskAwareCompactionDiagnosticsProvider(policy)),
    `${name}: provider`,
  )
}
