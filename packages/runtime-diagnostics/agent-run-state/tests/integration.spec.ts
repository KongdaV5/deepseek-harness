import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { lifecycleFactsFrom } from '@deepseek-ai/dsh-agent-lifecycle-facts'
import { projectRuns } from '@deepseek-ai/dsh-agent-run-state'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { session, seq } from './fixtures.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Every TypeScript file under one directory tree. */
function sourcesUnder(directory: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourcesUnder(path))
    else if (entry.name.endsWith('.ts')) found.push({ path, text: readFileSync(path, 'utf8') })
  }
  return found
}

/** A committed Session event with only the fields the fold reads. */
function event(type: string, sequence: number, time: number, data: unknown): SessionEvent {
  return { type, seq: seq(sequence), time, data } as unknown as SessionEvent
}

describe('the durable fold of Stage 6 feeds the run projection', () => {
  it('projects one run from a real committed event range', () => {
    const events: SessionEvent[] = [
      event('turn/start', 0, 1_000, { turn: 1 }),
      event('step/start', 1, 1_001, { turn: 1, step: 1 }),
      event('llm/retry', 2, 1_002, {
        retryId: 'retry-a',
        turn: 1,
        step: 1,
        provider: 'local-qwen',
        mode: 'normal',
        policyKey: 'default',
        retry: 1,
        maxRetries: 3,
        delayMs: 250,
        failure: { message: 'upstream timeout', code: 'PROVIDER_TIMEOUT' },
      }),
      event('llm/retry-started', 3, 1_300, { retryId: 'retry-a', turn: 1, step: 1, retry: 1 }),
      event('step/end', 4, 1_900, { turn: 1, step: 1 }),
      event('turn/end', 5, 2_000, { turn: 1, reason: { kind: 'completed' } }),
    ]

    const state = projectRuns(session('session-1'), lifecycleFactsFrom(events))

    expect(state.active).toBeNull()
    expect(state.terminal?.runId).toBe('run:v1:9:session-1:1')
    expect(state.terminal?.phase).toBe('completed')
    expect(state.terminal?.startedAt).toBe(1_000)
    expect(state.terminal?.completedAt).toBe(2_000)
    expect(state.terminal?.retryCount).toBe(1)
    expect(state.terminal?.maxRetryCount).toBe(3)
    expect(state.terminal?.retryReason).toBe('PROVIDER_TIMEOUT')
    expect(state.terminal?.stepCount).toBe(1)
    expect(state.terminal?.openStep).toBeNull()
    expect(state.terminal?.primaryError?.code).toBe('PROVIDER_TIMEOUT')
    expect(state.terminal?.secondaryErrors).toEqual([])
    expect(state.terminal?.lastActivityAt).toBe(2_000)
    expect(state.terminal?.lastMeaningfulActivityAt).toBe(1_900)
  })

  it('projects a repaired crash tail as a terminal run, not a live one', () => {
    const events: SessionEvent[] = [
      event('turn/start', 0, 500, { turn: 1 }),
      event('step/start', 1, 501, { turn: 1, step: 1 }),
      event('turn/end', 2, 600, { turn: 1, reason: { kind: 'interrupted' } }),
    ]

    const state = projectRuns(session('session-2'), lifecycleFactsFrom(events))

    expect(state.active).toBeNull()
    expect(state.terminal?.repairClosure).toBe(true)
    expect(state.terminal?.primaryError?.code).toBe('SESSION_INTERRUPTED')
    expect(state.terminal?.openStep).toBe(1)
  })

  it('leaves the run active while the log has no turn closer', () => {
    const events: SessionEvent[] = [
      event('turn/start', 0, 700, { turn: 3 }),
      event('step/start', 1, 701, { turn: 3, step: 1 }),
    ]

    const state = projectRuns(session('session-3'), lifecycleFactsFrom(events))

    expect(state.active?.turn).toBe(3)
    expect(state.active?.phase).toBe('executing')
    expect(state.terminal).toBeNull()
  })
})

describe('Stage 7 adds no Session vocabulary and no new authority', () => {
  const ownSources = sourcesUnder(join(packageRoot, 'src'))

  it('declares no Session event or projection augmentation', () => {
    for (const { path, text } of ownSources) {
      expect(text, path).not.toContain("declare module '@deepseek-ai/dsh-session/types'")
      expect(text, path).not.toContain("declare module '@deepseek-ai/dsh-session-projection/types'")
    }
  })

  it('allocates no identity from a random value, a clock, or a counter', () => {
    for (const { path, text } of ownSources) {
      expect(text, path).not.toMatch(/randomUUID|Math\.random|crypto\./)
    }
  })

  it('keeps the Stage 6 first-party required events known', () => {
    const known = readFileSync(join(repoRoot, 'packages/core/session/src/known-event-types.ts'), 'utf8')
    expect(known).toContain("'task/checkpoint'")
    expect(known).toContain("'task/result-manifest'")
  })

  it('leaves the Stage 6 task-checkpoint package independent of run state', () => {
    const stageSix = sourcesUnder(join(repoRoot, 'packages/session/task-checkpoint/src'))
    expect(stageSix.length).toBeGreaterThan(0)
    for (const { path, text } of stageSix) {
      // The restored v1 contract stays opaque about the Stage 7 RunId: no module
      // imports or re-exports the run-state owner.
      expect(text, path).not.toMatch(/from '@deepseek-ai\/dsh-agent-run-state/)
      expect(text, path).not.toMatch(/from '\.\/agent-run-state/)
    }
  })
})
