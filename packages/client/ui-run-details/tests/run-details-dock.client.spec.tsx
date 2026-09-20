// @vitest-environment jsdom
/**
 * Run Details display acceptance: the dock adapter hides the strip when there
 * is no Run (never a "Run: None" placeholder), renders the host-computed cut
 * verbatim, keeps an unobserved backend at `Unknown`, keeps a compaction's
 * auxiliary reasoning in its own row rather than beside the main run's, shows
 * the Stage 8 guarded-resume decision read-only, and carries no control a click
 * could reach.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { RunDetailsView } from '@deepseek-ai/dsh-run-details/client'
import type { TaskCheckpointProjection } from '@deepseek-ai/dsh-task-checkpoint/client'
import type { RunDetailsDockProps } from '../src/client/RunDetailsDock.tsx'
import { RunDetailsDock, RunDetailsPanel } from '../src/client/RunDetailsDock.tsx'
import { NS, en, zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const t: RunDetailsDockProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

/** A complete served cut, as the host fold produces it. */
function cut(overrides: Partial<Extract<RunDetailsView, { hasRun: true }>> = {}): Extract<RunDetailsView, { hasRun: true }> {
  return {
    sessionId: 's1' as never,
    hasRun: true,
    runId: 'run:v1:2:s1:1' as never,
    turn: 1,
    active: true,
    phase: 'executing',
    health: 'unknown',
    startedAt: 1_000,
    updatedAt: 2_000,
    lastActivityAt: 2_000,
    repairClosure: false,
    stepCount: 2,
    openStep: 1,
    retryCount: 1,
    maxRetryCount: 3,
    secondaryErrors: [],
    backend: {
      observerId: 'run-details:none' as never,
      observedAt: 1_000,
      source: 'none',
      directness: 'unavailable',
      reachability: 'unknown',
      activity: 'unknown',
    },
    reasoning: null,
    compaction: null,
    guardedResume: null,
    ...overrides,
  }
}

/** A task projection with one durable checkpoint and one repair hazard. */
function task(withHazard = false): TaskCheckpointProjection {
  return {
    tasks: [
      {
        taskId: 'task-1' as never,
        taskType: 'task',
        sessionId: 's1' as never,
        originRunId: 'run:v1:2:s1:1' as never,
        latestRunId: 'run:v1:2:s1:1' as never,
        revision: 2,
        status: 'running',
        createdAt: 1_000,
        lastActivityAt: 2_000,
        originExecution: { provider: 'deepseek', model: 'deepseek-chat' },
        execution: { provider: 'deepseek', model: 'deepseek-chat' },
        completedSteps: [],
        currentStep: { id: 'step-1' as never, title: 'step' },
        pendingSteps: [{ id: 'step-2' as never, title: 'next' }],
      } as never,
    ],
    latestTaskId: 'task-1' as never,
    repairHazards: withHazard
      ? [{ taskId: 'task-1' as never, callId: 'c1', code: 'TOOL_NOT_STARTED', eventSeq: 3 as never } as never]
      : [],
  }
}

/** A guarded-resume fact row, as the Stage 8 decision is projected to the wire. */
function resume(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'allowed',
    reason: 'PENDING_ONLY',
    detail: 'Continue only the pending steps.',
    taskId: 'task-1',
    checkpointRevision: 1,
    pendingStepCount: 1,
    hazardCodes: [],
    planStepCount: 1,
    ...overrides,
  }
}

describe('RunDetailsPanel', () => {
  it('renders the Run identity, phase, and health the host served', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} t={t} />)
    expect(screen.getByTestId('run-details')).toBeTruthy()
    expect(screen.getByTestId('run-details-run-id').textContent).toBe('s1#1')
    expect(screen.getByTestId('run-details-phase').textContent).toBe('执行中')
    expect(screen.getByTestId('run-details-health').textContent).toBe('未知')
  })

  it('keeps an unobserved backend at Unknown instead of a friendlier answer', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} t={t} />)
    expect(screen.getByTestId('run-details-backend').textContent).toBe('未知')
  })

  it('shows steps and retries from the durable cut', () => {
    render(<RunDetailsPanel details={cut({ stepCount: 2, openStep: 1, retryCount: 1, maxRetryCount: 3 })} task={undefined} t={t} />)
    expect(screen.getByTestId('run-details-steps').textContent).toBe('2 步 · 第 1 步进行中')
    expect(screen.getByTestId('run-details-retries').textContent).toBe('1 / 3 次')
  })

  it('renders no control a click could reach', () => {
    const { container } = render(<RunDetailsPanel details={cut()} task={task()} t={t} />)
    expect(container.querySelectorAll('button, input, select, textarea, a[href]')).toHaveLength(0)
  })

  it('renders the main run reasoning, and calls out an adapter-materialized effort', () => {
    render(<RunDetailsPanel
      details={cut({ reasoning: { requested: 'high', resolved: 'high', adapterMaterialized: false, atSeq: 0 as never, at: 0 } })}
      task={undefined}
      t={t}
    />)
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('high')
    cleanup()
    render(<RunDetailsPanel
      details={cut({ reasoning: { resolved: 'medium', adapterMaterialized: true, atSeq: 0 as never, at: 0 } })}
      task={undefined}
      t={t}
    />)
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('medium (适配器默认)')
  })

  it('keeps compaction auxiliary reasoning out of the main reasoning row', () => {
    const details = cut({
      reasoning: { requested: 'high', resolved: 'high', adapterMaterialized: false, atSeq: 0 as never, at: 0 },
      compaction: {
        policyId: 'p',
        policyVersion: '1',
        trigger: 'context-overflow',
        candidateAttempts: 2,
        requestedReasoning: 'low',
        resolvedReasoning: 'low',
        reasoningSource: 'policy',
        atSeq: 4 as never,
        at: 4_000,
      },
    })
    render(<RunDetailsPanel details={details} task={undefined} t={t} />)
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('high')
    expect(screen.getByTestId('run-details-compaction').textContent).toBe('context-overflow，2 次候选')
    expect(screen.getByTestId('run-details-compaction-reasoning').textContent).toBe('low')
  })

  it('omits compaction rows before a summary commits an audit', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} t={t} />)
    expect(screen.queryByTestId('run-details-compaction')).toBeNull()
    expect(screen.queryByTestId('run-details-compaction-reasoning')).toBeNull()
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('未设置')
  })

  it('renders durable task continuity and its repair hazards', () => {
    render(<RunDetailsPanel details={cut()} task={task(true)} t={t} />)
    expect(screen.getByTestId('run-details-task').textContent).toBe('task-1 · running')
    expect(screen.getByTestId('run-details-hazards').textContent).toBe('1 处修复隐患')
  })

  it('reports no task rather than inventing one', () => {
    render(<RunDetailsPanel details={cut()} task={{ tasks: [], repairHazards: [] }} t={t} />)
    expect(screen.getByTestId('run-details-task').textContent).toBe('无任务')
    expect(screen.queryByTestId('run-details-hazards')).toBeNull()
  })

  it('shows the classified error code when the run carries one', () => {
    render(<RunDetailsPanel
      details={cut({ primaryError: { code: 'CONTEXT_OVERFLOW', message: 'overflow', severity: 'fatal', origin: 'provider', time: 5 } })}
      task={undefined}
      t={t}
    />)
    expect(screen.getByTestId('run-details-error').textContent).toBe('CONTEXT_OVERFLOW')
  })

  it('renders the guarded-resume decision class and its raw reason code', () => {
    render(<RunDetailsPanel details={cut({ guardedResume: resume() as never })} task={undefined} t={t} />)
    // The class is a label, the reason stays the structured Stage 8 code, and the
    // admissible plan is shown as a count rather than offered as an action.
    expect(screen.getByTestId('run-details-guarded-resume').textContent).toBe('可继续 · PENDING_ONLY · 1 步待续')
  })

  it('keeps an unstarted tool distinct from an unknown tool outcome', () => {
    // The distinction the strip must preserve is the one the decision encodes: an
    // unknown outcome is what gates resumption behind a confirmation, while an
    // unstarted tool stays admissible and must never be relabelled as unknown.
    render(<RunDetailsPanel
      details={cut({ guardedResume: resume({ decision: 'requires_confirmation', reason: 'TOOL_OUTCOME_UNKNOWN', hazardCodes: ['TOOL_OUTCOME_UNKNOWN'], planStepCount: 0 }) as never })}
      task={undefined}
      t={t}
    />)
    expect(screen.getByTestId('run-details-guarded-resume').textContent).toBe('需确认 · TOOL_OUTCOME_UNKNOWN · 1 处隐患')
    cleanup()
    render(<RunDetailsPanel
      details={cut({ guardedResume: resume({ hazardCodes: ['TOOL_NOT_STARTED'] }) as never })}
      task={undefined}
      t={t}
    />)
    const text = screen.getByTestId('run-details-guarded-resume').textContent ?? ''
    expect(text).toContain('PENDING_ONLY')
    expect(text).not.toContain('TOOL_OUTCOME_UNKNOWN')
    expect(text).not.toContain('需确认')
  })

  it('renders no guarded-resume row when the host serves no decision', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} t={t} />)
    expect(screen.queryByTestId('run-details-guarded-resume')).toBeNull()
  })
})

/** Dock props stub: the adapter reads two projections; the owner share is unused. */
function dockProps(values: Record<string, unknown>): RunDetailsDockProps {
  return { useProjection: (key: string) => values[key], t } as unknown as RunDetailsDockProps
}

describe('RunDetailsDock', () => {
  it('renders nothing while the projection has not served', () => {
    const { container } = render(<RunDetailsDock {...dockProps({})} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for an idle session instead of a Run: None placeholder', () => {
    render(<RunDetailsDock {...dockProps({ runDetails: { sessionId: 's1', hasRun: false } })} />)
    expect(screen.queryByTestId('run-details')).toBeNull()
    expect(screen.queryByText(/Run/)).toBeNull()
  })

  it('renders the served cut and the task projection together', () => {
    render(<RunDetailsDock {...dockProps({ runDetails: cut(), taskCheckpoint: task() })} />)
    expect(screen.getByTestId('run-details')).toBeTruthy()
    expect(screen.getByTestId('run-details-task').textContent).toBe('task-1 · running')
  })

  it('opens only the two projection seats and offers no way to act on the decision', () => {
    // The guarded-resume decision is read from the runDetails cut it is folded
    // into; the dock subscribes to no third channel, so it cannot become a second
    // authority, and it exposes no control a reader could use to force a resume.
    const keys: string[] = []
    const values: Record<string, unknown> = { runDetails: cut({ guardedResume: resume() as never }), taskCheckpoint: task() }
    const props = { useProjection: (key: string) => { keys.push(key); return values[key] }, t } as unknown as RunDetailsDockProps
    const { container } = render(<RunDetailsDock {...props} />)
    expect(keys).toEqual(['runDetails', 'taskCheckpoint'])
    expect(screen.getByTestId('run-details-guarded-resume')).toBeTruthy()
    expect(container.querySelectorAll('button, input, select, textarea, a[href]')).toHaveLength(0)
  })
})

describe('ui-run-details plugin', () => {
  it('registers one read-only dock entry with its locale namespace', () => {
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    const localeRegister = vi.fn(() => () => undefined)
    const ctx = {
      slots: { inject, register },
      locale: { register: localeRegister },
      effect: (fn: () => () => void) => fn(),
    }
    apply(ctx as never)
    expect(inject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      { name: 'conversation.input.dock', id: 'run-details', order: 30, locale: NS },
      RunDetailsDock,
    )
    expect(localeRegister).toHaveBeenCalledWith(NS, { zh, en })
  })

  it('keeps the node half inert', () => {
    // Inert means no argument, no result, and no effect: the node half exists
    // only so the host graph can mount the package's row.
    expect(nodeApply.length).toBe(0)
    expect(() => {
      nodeApply()
    }).not.toThrow()
  })
})
