// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DesktopRunDiagnosticsSnapshot } from '@deepseek-ai/dsh-desktop-run-diagnostics/client'
import { RunStatusDock } from '../src/client/RunStatusDock.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
type TestDockProps = {
  readonly useRunDiagnostics: <T>(select: (current: DesktopRunDiagnosticsSnapshot | undefined) => T) => T
  readonly resume: (...args: never[]) => unknown
  readonly t: typeof t
}
const TestRunStatusDock = RunStatusDock as unknown as (props: TestDockProps) => ReactElement

function snapshot(over: Record<string, unknown> = {}): DesktopRunDiagnosticsSnapshot {
  return {
    version: 1,
    revision: 1,
    observedAt: 1,
    run: {
      sessionId: 'session-1',
      runId: 'run-1',
      turn: 1,
      phase: 'generating',
      health: 'healthy',
      startedAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      lastMeaningfulActivityAt: 1,
      retryCount: 0,
      reasoning: { resolvedReasoning: 'xhigh' },
      context: { pressureState: 'normal' },
      backend: {
        attribution: { kind: 'unknown' },
        processHealth: 'unknown',
        modelHealth: 'unknown',
        generationHealth: 'unknown',
      },
      secondaryErrors: [],
    },
    ...over,
  } as unknown as DesktopRunDiagnosticsSnapshot
}

function renderDock(value: DesktopRunDiagnosticsSnapshot) {
  const resume = vi.fn(() => Promise.resolve({ ok: true as const, value: { status: 'started' } } as never))
  const useRunDiagnostics = <T,>(select: (current: DesktopRunDiagnosticsSnapshot | undefined) => T): T => select(value)
  return {
    resume,
    ...render(<TestRunStatusDock useRunDiagnostics={useRunDiagnostics} resume={resume} t={t} />),
  }
}

describe('RunStatusDock', () => {
  it('uses the existing phase vocabulary and keeps prefill unknown rather than fabricating a percent', () => {
    renderDock(snapshot({ run: { ...snapshot().run!, phase: 'prefill', backend: {
      ...snapshot().run!.backend,
      prefill: { current: 512, source: 'backend-log', confidence: 'provisional' },
    } } }))
    expect(screen.getByText('正在预填充')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看运行详情' }))
    expect(screen.getByText('512 / 未知 · backend-log · provisional')).toBeTruthy()
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('gives the primary Metal failure precedence over a secondary BrokenPipe', () => {
    const run = snapshot().run!
    renderDock(snapshot({ run: {
      ...run,
      phase: 'failed', health: 'fatal',
      primaryError: { code: 'RESOURCE_LIMIT', message: 'Metal limit', severity: 'fatal', origin: 'backend', time: 1 },
      secondaryErrors: [{ code: 'STREAM_DISCONNECTED', message: 'BrokenPipe', severity: 'degraded', origin: 'transport', time: 2 }],
    } }))
    expect(screen.getByText('生成已停止：Metal 资源限制')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看运行详情' }))
    expect(screen.getByText('RESOURCE_LIMIT: Metal limit')).toBeTruthy()
    expect(screen.getByText('STREAM_DISCONNECTED: BrokenPipe')).toBeTruthy()
  })

  it('shows retry, stop confirmation, and critical Context without inventing a health state', () => {
    const run = snapshot().run!
    const { rerender } = renderDock(snapshot({ run: { ...run, phase: 'waiting_retry', retryCount: 1, maxRetryCount: 2 } }))
    expect(screen.getByText('正在重试 1 / 2')).toBeTruthy()

    rerender(<TestRunStatusDock
      useRunDiagnostics={select => select(snapshot({ run: { ...run, cancellation: { status: 'unconfirmed', requestedAt: 1, resolvedAt: 2 } } }))}
      resume={vi.fn()} t={t}
    />)
    expect(screen.getByText('停止请求已发送，后台状态尚未确认')).toBeTruthy()

    rerender(<TestRunStatusDock
      useRunDiagnostics={select => select(snapshot({ run: { ...run, context: { pressureState: 'critical' } } }))}
      resume={vi.fn()} t={t}
    />)
    expect(screen.getByText('上下文已达到安全上限，请缩短任务或新建会话。')).toBeTruthy()
  })

  it('keeps Benchmark explicit and never exposes a reasoning selector', () => {
    renderDock(snapshot({ preset: 'benchmark' }))
    expect(screen.getByText('Benchmark 模式 · xhigh 已锁定')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('renders compaction as an auxiliary low request and keeps safe Resume explicit', () => {
    const run = snapshot().run!
    const { resume } = renderDock(snapshot({
      run: { ...run, phase: 'compacting' },
      compaction: {
        pressureState: 'compact', eligibility: 'eligible',
        reasoning: { requested: 'low', resolved: 'low', wireValue: 'low', source: 'compaction-policy' },
        attempt: { ordinal: 1, validation: 'passed' }, taskFactsInjected: true, toolResultsPruned: true,
      },
      checkpoint: {
        task: { taskId: 'task-1', status: 'paused' },
        resume: { eligibility: 'SAFE_TO_RESUME', requested: false, started: false }, outputs: [], repairHazards: [],
      },
    }))
    expect(screen.getByText('正在整理上下文…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看运行详情' }))
    expect(screen.getByText('low')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续任务' }))
    expect(resume).toHaveBeenCalledWith({ taskId: 'task-1' })
  })

  it('does not offer Resume when TOOL_OUTCOME_UNKNOWN blocks safe continuation', () => {
    const run = snapshot().run!
    renderDock(snapshot({
      run: { ...run, phase: 'failed' },
      checkpoint: {
        task: { taskId: 'task-1', status: 'failed' },
        resume: { eligibility: 'BLOCKED_UNKNOWN_SIDE_EFFECT', requested: false, started: false }, outputs: [], repairHazards: [],
      },
    }))
    fireEvent.click(screen.getByRole('button', { name: '查看运行详情' }))
    expect(screen.getByText('暂时无法继续：上一次工具执行结果无法确认。请先确认外部状态。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '继续任务' })).toBeNull()
  })
})
