/**
 * The Stage 10 → Stage 11 transport adapter.
 *
 * What matters here is that the adapter publishes the policy's own values and
 * adds no authority of its own: it names one topic and one schema, maps exactly
 * one read and one subscription onto the policy's read-only face, registers
 * nothing when the mounted policy has no such face, and retires its provider
 * with the fiber that mounted it.
 */

import { Context } from '@deepseek-ai/cordis'
import type { RuntimeDiagnosticsProvider } from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/types'
import { describe, expect, it } from 'vitest'
import {
  apply,
  createTaskAwareCompactionDiagnosticsProvider,
  inject,
  isTaskAwareDiagnosticsSource,
  TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA,
  TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC,
} from '../src/diagnostics-transport.ts'
import type { TaskAwareCompactionDiagnostics, TaskAwareDiagnosticsListener } from '../src/types.ts'

/** One complete observation for a Session. */
function observation(status: TaskAwareCompactionDiagnostics['status']): TaskAwareCompactionDiagnostics {
  return { status, protectedEvidenceCount: 3, mainRunReasoningUnchanged: true }
}

/**
 * A scripted stand-in for the policy's read-only diagnostics face.
 *
 * Registering is silent and `emit` replays a committed replacement, so the
 * adapter is exercised against the same contract Stage 10's store guarantees.
 */
class ScriptedSource {
  readonly reads = new Map<string, TaskAwareCompactionDiagnostics>()
  readonly listeners = new Map<string, Set<TaskAwareDiagnosticsListener>>()
  readonly readsOf: string[] = []

  diagnostics(sessionId: string): TaskAwareCompactionDiagnostics | undefined {
    this.readsOf.push(sessionId)
    return this.reads.get(sessionId)
  }

  subscribeDiagnostics(sessionId: string, listener: TaskAwareDiagnosticsListener): () => void {
    let listeners = this.listeners.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    let observing = true
    return () => {
      if (!observing) return
      observing = false
      listeners.delete(listener)
    }
  }

  emit(sessionId: string, value: TaskAwareCompactionDiagnostics | undefined): void {
    for (const listener of [...this.listeners.get(sessionId) ?? []]) listener(value)
  }
}

/** One host fixture: a Context carrying the policy and an observing transport. */
function host(policy: unknown) {
  const ctx = new Context()
  const registered: RuntimeDiagnosticsProvider[] = []
  const released: string[] = []
  ctx.provide('compactionCandidatePolicy', policy as never)
  ctx.provide('runtimeDiagnostics', {
    registerProvider: (provider: RuntimeDiagnosticsProvider) => {
      registered.push(provider)
      return () => { released.push(provider.topic) }
    },
  } as never)
  return { ctx, registered, released }
}

describe('the task-aware compaction diagnostics topic', () => {
  it('pins the topic and the schema version Stage 11 clients validate against', () => {
    expect(TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC).toBe('task-aware-compaction')
    expect(TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA).toEqual({
      schemaId: 'dsh.task-aware-compaction-diagnostics',
      schemaVersion: 1,
    })
  })
})

describe('isTaskAwareDiagnosticsSource', () => {
  it('accepts a policy that publishes both the read and the subscription', () => {
    expect(isTaskAwareDiagnosticsSource(new ScriptedSource())).toBe(true)
  })

  it('rejects a policy that is not an object, or lacks either half of the face', () => {
    expect(isTaskAwareDiagnosticsSource(undefined)).toBe(false)
    expect(isTaskAwareDiagnosticsSource(null)).toBe(false)
    expect(isTaskAwareDiagnosticsSource('policy')).toBe(false)
    // A foreign candidate policy satisfies the compaction contract without
    // publishing diagnostics, so it must publish nothing rather than throw.
    expect(isTaskAwareDiagnosticsSource({})).toBe(false)
    expect(isTaskAwareDiagnosticsSource({ diagnostics: () => undefined })).toBe(false)
    expect(isTaskAwareDiagnosticsSource({ subscribeDiagnostics: () => () => {} })).toBe(false)
  })
})

describe('createTaskAwareCompactionDiagnosticsProvider', () => {
  it('declares the topic and schema on every provider it builds', () => {
    const provider = createTaskAwareCompactionDiagnosticsProvider(new ScriptedSource())
    expect(provider.topic).toBe(TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC)
    expect(provider.schemaId).toBe(TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA.schemaId)
    expect(provider.schemaVersion).toBe(TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA.schemaVersion)
  })

  it('reports the observation the policy holds right now, and absence when it holds none', () => {
    const source = new ScriptedSource()
    const provider = createTaskAwareCompactionDiagnosticsProvider(source)
    expect(provider.read('session-1')).toBeUndefined()
    const current = observation('assessing')
    source.reads.set('session-1', current)
    // The value is forwarded, not copied: the store never mutates an
    // observation in place, so the reference stays the policy's own.
    expect(provider.read('session-1')).toEqual({ present: true, value: current })
    expect(source.readsOf).toEqual(['session-1', 'session-1'])
  })

  it('forwards each committed replacement, and forwards removal as absence', () => {
    const source = new ScriptedSource()
    const provider = createTaskAwareCompactionDiagnosticsProvider(source)
    const seen: unknown[] = []
    const dispose = provider.subscribe('session-1', value => seen.push(value))
    const summarizing = observation('summarizing')
    source.emit('session-1', summarizing)
    source.emit('session-1', undefined)
    expect(seen).toEqual([{ present: true, value: summarizing }, undefined])
    dispose()
    source.emit('session-1', observation('applied'))
    expect(seen).toHaveLength(2)
  })
})

describe('the transport adapter plugin', () => {
  it('registers one provider for the mounted policy, and retires it with the fiber', async () => {
    const policy = new ScriptedSource()
    const { ctx, registered, released } = host(policy)
    apply(ctx)
    expect(inject).toEqual(['compactionCandidatePolicy', 'runtimeDiagnostics'])
    expect(registered.map(provider => provider.topic)).toEqual([TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC])
    // The registered provider really serves the mounted policy.
    policy.reads.set('session-1', observation('validating'))
    expect(registered[0]!.read('session-1')).toMatchObject({ present: true })
    await ctx.fiber.dispose()
    expect(released).toEqual([TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC])
  })

  it('publishes nothing when the mounted policy has no diagnostics face', () => {
    const { ctx, registered } = host({})
    apply(ctx)
    // A foreign policy is not an error: this adapter is optional instrumentation.
    expect(registered).toEqual([])
  })
})
