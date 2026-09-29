// @vitest-environment jsdom
/**
 * Run Details display acceptance: the dock adapter hides the strip when there
 * is no Run (never a "Run: None" placeholder), renders the host-computed cut
 * verbatim, keeps an unobserved backend at `Unknown`, keeps a compaction's
 * auxiliary reasoning in its own advanced row rather than beside the main run's,
 * shows the Stage 8 guarded-resume decision read-only, and exposes only native
 * disclosure controls—not actions that can mutate the Run.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { RunDetailsView } from '@deepseek-ai/dsh-run-details/client'
import type { TaskCheckpointProjection } from '@deepseek-ai/dsh-task-checkpoint/client'
import type { RunDetailsDockProps } from '../src/client/RunDetailsDock.tsx'
import { RunDetailsDock, RunDetailsPanel } from '../src/client/RunDetailsDock.tsx'
import {
  TRANSIENT_COMPACTION_SCHEMA,
  TRANSIENT_COMPACTION_TOPIC,
  transientCompaction,
  transientCompactionAddress,
  type TransientCompaction,
  type TransientResourceSnapshot,
} from '../src/client/transient.ts'
import { NS, en, zh } from '../src/client/locales.ts'
import { apply, inject as requiredServices } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const t: RunDetailsDockProps['t'] = makeTranslate(zh, commonZh)

/** The transient row's absent state: no transport is mounted to ask. */
const HIDDEN: TransientCompaction = { state: 'hidden' }

/** One resource snapshot, as the resource model would report it. */
function snapshot(overrides: Partial<TransientResourceSnapshot> = {}): TransientResourceSnapshot {
  return { status: 'loading', value: undefined, failure: undefined, ...overrides }
}

/** One served transient observation, as the transport delivers it. */
function observed(value: object) {
  return { status: 'live' as const, value: { present: true as const, value: value as never }, failure: undefined }
}

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
  it('starts collapsed with a compact status summary and keeps Session identity out of it', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} transient={HIDDEN} t={t} />)
    const panel = screen.getByTestId('run-details') as HTMLDetailsElement
    expect(panel.open).toBe(false)
    expect(screen.getByTestId('run-details-session').textContent).toBe('s1')
    expect(screen.getByTestId('run-details-toggle').tagName).toBe('SUMMARY')
    expect(screen.getByTestId('run-details-toggle').textContent).not.toContain('s1')
    expect(screen.getByTestId('run-details-phase').textContent).toBe('执行中')
    expect(screen.getByTestId('run-details-health').textContent).toBe('未知')
    expect(screen.getByTestId('run-details-summary-steps').textContent).toBe('2 步')
  })

  it('opens the Session facts and keeps engineering diagnostics in Advanced details', () => {
    render(<RunDetailsPanel details={cut({ phase: 'completed', health: 'healthy', stepCount: 4 })} task={undefined} transient={HIDDEN} t={t} />)
    const panel = screen.getByTestId('run-details') as HTMLDetailsElement
    const toggle = screen.getByTestId('run-details-toggle')
    expect(toggle.textContent).toContain('已完成')
    expect(toggle.textContent).toContain('健康')
    expect(toggle.textContent).toContain('4 步')
    expect(toggle.textContent).toContain('详情')
    expect(toggle.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(toggle)
    expect(panel.open).toBe(true)
    expect(screen.getByTestId('run-details-session').textContent).toBe('s1')
    expect(screen.getByTestId('run-details-steps').textContent).toBe('4 步 · 第 1 步进行中')
    expect(screen.getByTestId('run-details-task').textContent).toBe('无任务')

    const advanced = screen.getByTestId('run-details-advanced-toggle')
    expect(advanced.textContent).toContain('高级详情')
    expect((advanced.parentElement as HTMLDetailsElement).open).toBe(false)
    fireEvent.click(advanced)
    expect((advanced.parentElement as HTMLDetailsElement).open).toBe(true)
    expect(screen.getByTestId('run-details-backend').textContent).toBe('未知')
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('未设置')
  })

  it('keeps an unobserved backend at Unknown instead of a friendlier answer', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-backend').textContent).toBe('未知')
  })

  it('shows steps and retries from the durable cut', () => {
    render(<RunDetailsPanel
      details={cut({ stepCount: 2, openStep: 1, retryCount: 1, maxRetryCount: 3 })}
      task={undefined}
      transient={HIDDEN}
      t={t}
    />)
    expect(screen.getByTestId('run-details-steps').textContent).toBe('2 步 · 第 1 步进行中')
    expect(screen.getByTestId('run-details-retries').textContent).toBe('1 / 3 次')
  })

  it('shows a step count alone while no step is open', () => {
    // The absence is rendered as an absence: with nothing in flight the row is
    // the count and nothing else, so a finished step can never read as a running
    // one and no synthetic step number is invented to fill the gap.
    render(<RunDetailsPanel details={cut({ openStep: null })} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-steps').textContent).toBe('2 步')
  })

  it('shows a retry count without a limit when the host serves none', () => {
    // A Run whose durable events never carried a ceiling must not borrow one:
    // the row drops the `/ max` half rather than showing an invented bound.
    render(<RunDetailsPanel details={cut({ retryCount: 1 })} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-retries').textContent).toBe('1 次')
  })

  it('falls back to the requested reasoning effort when the host resolved none', () => {
    render(<RunDetailsPanel
      details={cut({ reasoning: { requested: 'high', adapterMaterialized: false, atSeq: 0 as never, at: 0 } })}
      task={undefined}
      transient={HIDDEN}
      t={t}
    />)
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('high')
    cleanup()
    render(<RunDetailsPanel
      details={cut({ reasoning: { adapterMaterialized: false, atSeq: 0 as never, at: 0 } })}
      task={undefined}
      transient={HIDDEN}
      t={t}
    />)
    // Neither resolved nor requested is a rendered absence, not a guessed effort.
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('未设置')
  })

  it('reports no task when the latest task id names no checkpoint', () => {
    // A dangling pointer is an absence, not a task: the row says no task rather
    // than echoing an id that no committed checkpoint backs.
    render(<RunDetailsPanel details={cut()} task={{ ...task(), latestTaskId: 'task-2' as never }} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-task').textContent).toBe('无任务')
  })

  it('shows a run id whole when it carries no derivable scheme', () => {
    // The strip shortens only the identity this programme issued; anything that
    // does not carry the run scheme is shown verbatim rather than reshaped.
    render(<RunDetailsPanel details={cut({ runId: 'run:v1' as never })} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-run-id').textContent).toBe('run:v1')
  })

  it('offers disclosure only and no Run-mutating controls', () => {
    const { container } = render(<RunDetailsPanel details={cut()} task={task()} transient={HIDDEN} t={t} />)
    expect(container.querySelectorAll('button, input, select, textarea, a[href]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="run-details-toggle"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="run-details-advanced-toggle"]')).toHaveLength(1)
  })

  it('renders the main run reasoning, and calls out an adapter-materialized effort', () => {
    render(<RunDetailsPanel
      details={cut({ reasoning: { requested: 'high', resolved: 'high', adapterMaterialized: false, atSeq: 0 as never, at: 0 } })}
      task={undefined}
      transient={HIDDEN}
      t={t}
    />)
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('high')
    cleanup()
    render(<RunDetailsPanel
      details={cut({ reasoning: { resolved: 'medium', adapterMaterialized: true, atSeq: 0 as never, at: 0 } })}
      task={undefined}
      transient={HIDDEN}
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
    render(<RunDetailsPanel details={details} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('high')
    expect(screen.getByTestId('run-details-compaction').textContent).toBe('context-overflow，2 次候选')
    expect(screen.getByTestId('run-details-compaction-reasoning').textContent).toBe('low')
  })

  it('omits compaction rows before a summary commits an audit', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.queryByTestId('run-details-compaction')).toBeNull()
    expect(screen.queryByTestId('run-details-compaction-reasoning')).toBeNull()
    expect(screen.getByTestId('run-details-reasoning').textContent).toBe('未设置')
  })

  it('renders durable task continuity and its repair hazards', () => {
    render(<RunDetailsPanel details={cut()} task={task(true)} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-task').textContent).toBe('task-1 · running')
    expect(screen.getByTestId('run-details-hazards').textContent).toBe('1 处修复隐患')
  })

  it('reports no task rather than inventing one', () => {
    render(<RunDetailsPanel details={cut()} task={{ tasks: [], repairHazards: [] }} transient={HIDDEN} t={t} />)
    expect(screen.getByTestId('run-details-task').textContent).toBe('无任务')
    expect(screen.queryByTestId('run-details-hazards')).toBeNull()
  })

  it('shows the classified error code when the run carries one', () => {
    render(<RunDetailsPanel
      details={cut({ primaryError: { code: 'CONTEXT_OVERFLOW', message: 'overflow', severity: 'fatal', origin: 'provider', time: 5 } })}
      task={undefined}
      transient={HIDDEN}
      t={t}
    />)
    expect(screen.getByTestId('run-details-error').textContent).toBe('CONTEXT_OVERFLOW')
  })

  it('renders the guarded-resume decision class and its raw reason code', () => {
    render(<RunDetailsPanel details={cut({ guardedResume: resume() as never })} task={undefined} transient={HIDDEN} t={t} />)
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
      transient={HIDDEN}
      t={t}
    />)
    expect(screen.getByTestId('run-details-guarded-resume').textContent).toBe('需确认 · TOOL_OUTCOME_UNKNOWN · 1 处隐患')
    cleanup()
    render(<RunDetailsPanel
      details={cut({ guardedResume: resume({ hazardCodes: ['TOOL_NOT_STARTED'] }) as never })}
      task={undefined}
      transient={HIDDEN}
      t={t}
    />)
    const text = screen.getByTestId('run-details-guarded-resume').textContent ?? ''
    expect(text).toContain('PENDING_ONLY')
    expect(text).not.toContain('TOOL_OUTCOME_UNKNOWN')
    expect(text).not.toContain('需确认')
  })

  it('renders no guarded-resume row when the host serves no decision', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.queryByTestId('run-details-guarded-resume')).toBeNull()
  })
})

describe('the transient compaction row', () => {
  it('renders nothing at all when no transport is mounted to ask', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} transient={HIDDEN} t={t} />)
    expect(screen.queryByTestId('run-details-compaction-live')).toBeNull()
  })

  it('reads loading, none, live, and failed as four different states', () => {
    render(<RunDetailsPanel details={cut()} task={undefined} transient={transientCompaction(snapshot())} t={t} />)
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('加载中')
    cleanup()
    render(<RunDetailsPanel
      details={cut()}
      task={undefined}
      transient={transientCompaction(snapshot({ status: 'live', value: { present: false } }))}
      t={t}
    />)
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('无进行中的压缩')
    cleanup()
    render(<RunDetailsPanel
      details={cut()}
      task={undefined}
      transient={transientCompaction(snapshot(observed({ status: 'summarizing', candidateAttempt: 2 })))}
      t={t}
    />)
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('summarizing · 候选 2')
    cleanup()
    render(<RunDetailsPanel
      details={cut()}
      task={undefined}
      transient={transientCompaction(snapshot({ status: 'failed', failure: { code: 'runtime-diagnostics/unexpected-frame' } }))}
      t={t}
    />)
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('runtime-diagnostics/unexpected-frame')
    cleanup()
    render(<RunDetailsPanel
      details={cut()}
      task={undefined}
      transient={transientCompaction(snapshot({ status: 'failed', failure: {
        code: 'runtime-diagnostics/transport-failure', details: { detail: 'carrier-failure' },
      } }))}
      t={t}
    />)
    expect(screen.getByTestId('run-details-compaction-live').textContent)
      .toBe('runtime-diagnostics/transport-failure · carrier-failure')
  })

  it('never renders an idle observation as a live compaction', () => {
    render(<RunDetailsPanel
      details={cut()}
      task={undefined}
      transient={transientCompaction(snapshot(observed({ status: 'idle' })))}
      t={t}
    />)
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('无进行中的压缩')
  })

  it('keeps the transient row separate from the durable audit row', () => {
    const details = cut({
      compaction: {
        policyId: 'p',
        policyVersion: '1',
        trigger: 'context-overflow',
        candidateAttempts: 1,
        atSeq: 4 as never,
        at: 4_000,
      },
    })
    render(<RunDetailsPanel
      details={details}
      task={undefined}
      transient={transientCompaction(snapshot(observed({ status: 'validating' })))}
      t={t}
    />)
    // The durable row is the audit a committed summary published; the transient
    // row is what the policy is doing right now. Both are visible, and neither
    // is derived from the other.
    expect(screen.getByTestId('run-details-compaction').textContent).toBe('context-overflow，1 次候选')
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('validating')
  })

  it('keeps compaction observations read-only apart from disclosure controls', () => {
    const { container } = render(<RunDetailsPanel
      details={cut({
        compaction: {
          policyId: 'p',
          policyVersion: '1',
          trigger: 'context-overflow',
          candidateAttempts: 1,
          atSeq: 4 as never,
          at: 4_000,
        },
      })}
      task={undefined}
      transient={transientCompaction(snapshot(observed({ status: 'applied' })))}
      t={t}
    />)
    expect(container.querySelectorAll('button, input, select, textarea, a[href]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="run-details-toggle"]')).toHaveLength(1)
  })
})

describe('transientCompaction', () => {
  it('maps the resource model four statuses onto the row', () => {
    expect(transientCompaction({ status: 'none', value: undefined, failure: undefined })).toEqual({ state: 'hidden' })
    expect(transientCompaction({ status: 'loading', value: undefined, failure: undefined })).toEqual({ state: 'loading' })
    expect(transientCompaction({ status: 'failed', value: undefined, failure: { code: 'x' } })).toEqual({ state: 'failed', code: 'x' })
    expect(transientCompaction({
      status: 'failed', value: undefined,
      failure: { code: 'runtime-diagnostics/unexpected-frame', details: { detail: 'unexpected-end' } },
    })).toEqual({ state: 'failed', code: 'runtime-diagnostics/unexpected-frame', detail: 'unexpected-end' })
  })

  it('falls back to a classified code when a failure carries none', () => {
    expect(transientCompaction({ status: 'failed', value: undefined, failure: undefined }))
      .toEqual({ state: 'failed', code: 'runtime-diagnostics/transport-failure' })
  })

  it('treats a value it cannot read a status from as none rather than as a status', () => {
    // The transport proves a value is detached JSON, never what its fields mean,
    // so a non-record or a non-textual status is unrenderable and reads as no
    // compaction instead of being cast into the row.
    expect(transientCompaction({
      status: 'live',
      value: { present: true, value: 'not-a-record' as never },
      failure: undefined,
    })).toEqual({ state: 'none' })
    expect(transientCompaction({
      status: 'live',
      value: { present: true, value: { status: 7 } as never },
      failure: undefined,
    })).toEqual({ state: 'none' })
  })

  it('omits the candidate attempt when the observation carries none', () => {
    expect(transientCompaction(observed({ status: 'assessing' }))).toEqual({ state: 'live', status: 'assessing' })
  })

  it('pins the topic, schema, and address the transport parses strictly', () => {
    expect(TRANSIENT_COMPACTION_TOPIC).toBe('task-aware-compaction')
    expect(TRANSIENT_COMPACTION_SCHEMA).toEqual({
      schemaId: 'dsh.task-aware-compaction-diagnostics',
      schemaVersion: 1,
    })
    expect(transientCompactionAddress('s1')).toBe('dsh-resource://runtime-diagnostics/task-aware-compaction/s1')
    // The transport re-encodes every segment and refuses an over- or
    // under-escaped one, so the address must be built escaped.
    expect(transientCompactionAddress('a/b')).toBe('dsh-resource://runtime-diagnostics/task-aware-compaction/a%2Fb')
  })
})

/**
 * Dock props stub: the adapter reads two projections and one resource address.
 * The owner share and the session kit beyond `sessionId` are unused.
 */
function dockProps(
  values: Record<string, unknown>,
  resource: TransientResourceSnapshot = { status: 'none', value: undefined, failure: undefined },
  addresses: string[] = [],
  externalActivities: readonly unknown[] = [],
): RunDetailsDockProps {
  return {
    useProjection: (key: string) => values[key],
    useResource: (address: string) => { addresses.push(address); return resource },
    useExternalActivities: () => externalActivities,
    sessionId: 's1',
    t,
  } as unknown as RunDetailsDockProps
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

  it('shows external Codex actions as separate activity, not local tool rows', () => {
    render(<RunDetailsPanel
      details={cut()}
      task={undefined}
      transient={HIDDEN}
      externalActivities={[
        {
          id: 'thread:turn:item', sessionId: 's1', dshTurn: 1, dshStep: 2,
          provider: 'openai-codex-subscription', runtimeSource: 'system', runtimeVersion: '0.158.0',
          codexThreadId: 'thread', codexTurnId: 'turn', codexItemId: 'item',
          eventId: 'event', eventKind: 'item/completed', terminalState: 'modified',
          kind: 'file-change', status: 'modified', label: undefined, path: 'src/example.ts', time: 1,
        },
      ] as never}
      t={t}
    />)
    const activity = screen.getByTestId('run-details-external-activities')
    expect(screen.getByText('外部运行时活动')).toBeTruthy()
    expect(activity.textContent).toContain('文件变更')
    expect(activity.textContent).toContain('已修改')
    expect(activity.textContent).toContain('src/example.ts')
    expect(document.querySelector('[data-testid="run-details-tool-calls"]')).toBeNull()
  })

  it('reads the transient observation from the address of the Session it shows', () => {
    const addresses: string[] = []
    render(<RunDetailsDock
      {...dockProps({ runDetails: cut() }, snapshot(observed({ status: 'validating' })), addresses)}
    />)
    expect(addresses).toEqual(['dsh-resource://runtime-diagnostics/task-aware-compaction/s1'])
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('validating')
  })

  it('keeps the transient row absent when no transport is mounted', () => {
    render(<RunDetailsDock {...dockProps({ runDetails: cut() })} />)
    expect(screen.queryByTestId('run-details-compaction-live')).toBeNull()
    expect(screen.getByTestId('run-details')).toBeTruthy()
  })

  it('reads the projection seats and exposes disclosure without any Run action', () => {
    // The guarded-resume decision is read from the runDetails cut it is folded
    // into, and the transient observation from a resource the host owns: the dock
    // subscribes to no third channel of its own, so it cannot become a second
    // authority, and it exposes no control a reader could use to force a resume
    // or a compaction.
    const keys: string[] = []
    const values: Record<string, unknown> = { runDetails: cut({ guardedResume: resume() as never }), taskCheckpoint: task() }
    const props = {
      useProjection: (key: string) => { keys.push(key); return values[key] },
      useResource: () => snapshot(observed({ status: 'summarizing' })),
      useExternalActivities: () => [],
      sessionId: 's1',
      t,
    } as unknown as RunDetailsDockProps
    const { container } = render(<RunDetailsDock {...props} />)
    expect(keys).toEqual(['runDetails', 'taskCheckpoint'])
    expect(screen.getByTestId('run-details-guarded-resume')).toBeTruthy()
    expect(screen.getByTestId('run-details-compaction-live').textContent).toBe('summarizing')
    expect(container.querySelectorAll('button, input, select, textarea, a[href]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="run-details-toggle"]')).toHaveLength(1)
  })
})

describe('ui-run-details plugin', () => {
  it('registers one read-only dock entry, its copy, and its transient topic', () => {
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    const localeRegister = vi.fn(() => () => undefined)
    const declare = vi.fn(() => () => undefined)
    const ctx = {
      slots: { inject, register },
      locale: { register: localeRegister },
      runtimeDiagnosticsTopics: { declare },
      effect: (fn: () => () => void) => fn(),
    }
    apply(ctx as never)
    expect(inject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      { name: 'conversation.input.dock', id: 'run-details', order: 30, locale: NS },
      RunDetailsDock,
    )
    expect(localeRegister).toHaveBeenCalledWith(NS, { zh, en })
    // The transient row may only open a topic whose schema this client declares.
    expect(declare).toHaveBeenCalledWith(TRANSIENT_COMPACTION_TOPIC, TRANSIENT_COMPACTION_SCHEMA)
  })

  it('requires the module seats the strip actually reads', () => {
    // The registry is a requirement, not an optional lookup: without it the
    // plugin does not activate, so the strip can never open a resource whose
    // frames nobody validated.
    expect(requiredServices).toEqual(['slots', 'locale', 'runtimeDiagnosticsTopics'])
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
