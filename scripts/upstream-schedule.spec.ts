import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  installScheduler,
  materialNotification,
  renderLaunchAgent,
  runScheduled,
  uninstallScheduler,
  type SchedulerDependencies,
  type SchedulerState,
} from './upstream-schedule.ts'
import type { MonitorOutcome, MonitorResult } from './upstream-monitor.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function state(): SchedulerState {
  return {
    schemaVersion: 1, lastRunAt: null, lastExecution: null, consecutiveFetchFailures: 0,
    lastNotifiedEventKey: null, lastNotifiedTargetSha: null, lastNotifiedAt: null, lastNotificationKind: null,
    lastFailureNotificationKey: null, notifiedEventKeys: [], pendingNotifications: [], lastNotificationError: null,
    lastSchedulerError: null,
  }
}

function monitor(outcome: MonitorOutcome, risk: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null = null, target = 'a'.repeat(40)): MonitorResult {
  const incremental = outcome === 'NEW_CHANGES' ? {
    outcome: 'NEW_CHANGES' as const, previousCursor: 'b'.repeat(40), targetSha: target, commitRange: 'range', newCommits: 3, changedFiles: 4,
    affectedSeams: risk === null ? [] : ['agent-run-event-contract'], highestRisk: risk!, impact: risk === 'MEDIUM' ? 'REVIEW_REQUIRED' as const : 'BLOCKING_CHANGE' as const,
    confidence: 'HIGH' as const, recommendedAction: risk === 'MEDIUM' ? 'REVIEW' as const : 'MANUAL_ADAPTATION_REQUIRED' as const,
  } : null
  return {
    outcome, exitCode: outcome === 'LOCKED' ? 3 : outcome === 'NO_NEW_UPSTREAM_CHANGES' || outcome === 'NEW_CHANGES' ? 0 : 2,
    statePath: '/fixture/state.json', state: {
      schemaVersion: 1, productBaselineTag: 'baseline', productBaselineSha: 'c'.repeat(40), remote: 'origin', branch: 'master',
      lastObservedUpstreamSha: target, lastSuccessfulCheckAt: null, lastFetchAt: null, lastNewChangeAt: null,
      existingCompatibilityDebt: { anchorProductSha: 'c'.repeat(40), auditedUpstreamSha: 'd'.repeat(40), highestRisk: 'CRITICAL', impact: 'BLOCKING_CHANGE', recommendedAction: 'MANUAL_ADAPTATION_REQUIRED', resolutionStatus: 'UNRESOLVED', sourceAuditReport: 'fixture' },
      lastIncrementalResult: null, lastReport: null, failureState: null,
    }, incremental, message: outcome, report: null,
  }
}

function fixture(): { root: string; home: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upstream-schedule-'))
  roots.push(root)
  return { root: process.cwd(), home: root, output: join(root, 'artifacts') }
}

describe('upstream scheduler notification policy', () => {
  it('is silent for no change, NONE, LOW, locks, and existing debt alone', () => {
    const base = state()
    for (const current of [monitor('NO_NEW_UPSTREAM_CHANGES'), monitor('NEW_CHANGES', 'NONE'), monitor('NEW_CHANGES', 'LOW'), monitor('LOCKED')]) {
      expect(materialNotification(current, base, 'MEDIUM', '2026-09-17T00:00:00.000Z')).toBeNull()
    }
  })

  it('notifies for MEDIUM, HIGH, and CRITICAL new changes, including a same-target escalation', async () => {
    const subject = fixture()
    let notifications = 0
    const deps: SchedulerDependencies = { monitor: async () => monitor('NEW_CHANGES', 'MEDIUM'), notify: () => { notifications += 1 } }
    const first = await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, deps)
    expect(first.notification?.eventKey).toContain(':MEDIUM:')
    expect(notifications).toBe(1)
    await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, deps)
    expect(notifications).toBe(1)
    const escalated = await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, { ...deps, monitor: async () => monitor('NEW_CHANGES', 'HIGH') })
    expect(escalated.notification?.eventKey).toContain(':HIGH:')
    expect(notifications).toBe(2)
  })

  it('debounces fetch failures, resets after success, and immediately reports integrity failures', async () => {
    const subject = fixture()
    let notifications = 0
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    const deps: SchedulerDependencies = { monitor: async () => monitor('FETCH_FAILED'), notify: () => { notifications += 1 } }
    expect((await runScheduled(subject.root, options, deps)).notification).toBeNull()
    expect((await runScheduled(subject.root, options, deps)).notification?.kind).toBe('FETCH_FAILURE')
    await runScheduled(subject.root, options, deps)
    expect(notifications).toBe(1)
    await runScheduled(subject.root, options, { ...deps, monitor: async () => monitor('NO_NEW_UPSTREAM_CHANGES') })
    const stored = JSON.parse(readFileSync(join(subject.output, 'scheduler-state.json'), 'utf8')) as SchedulerState
    expect(stored.consecutiveFetchFailures).toBe(0)
    const integrity = await runScheduled(subject.root, options, { ...deps, monitor: async () => monitor('STATE_INVALID') })
    expect(integrity.notification?.kind).toBe('INTEGRITY_FAILURE')
    expect(notifications).toBe(2)
  })

  it('retains a pending notification when Notification Center fails without changing the monitor cursor', async () => {
    const subject = fixture()
    const current = monitor('NEW_CHANGES', 'CRITICAL', 'e'.repeat(40))
    const result = await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, {
      monitor: async () => current,
      notify: () => { throw new Error('Notification Center unavailable') },
    })
    expect(result).toMatchObject({ exitCode: 4, notificationDelivered: false })
    expect(result.monitor.state?.lastObservedUpstreamSha).toBe('e'.repeat(40))
    const stored = JSON.parse(readFileSync(join(subject.output, 'scheduler-state.json'), 'utf8')) as SchedulerState
    expect(stored.pendingNotifications).toHaveLength(1)
    expect(stored.lastNotificationError).toContain('unavailable')
  })
})

describe('LaunchAgent integration contract', () => {
  it('renders a daily local 09:00 user agent using the maintenance Node runtime', async () => {
    const subject = fixture()
    const paths = {
      root: subject.root, output: subject.output, state: join(subject.output, 'scheduler-state.json'), log: join(subject.output, 'logs/scheduler.log'), errorLog: join(subject.output, 'logs/scheduler.err.log'),
      plist: join(subject.home, 'Library/LaunchAgents/dev.dsh.upstream-monitor.plist'), script: join(subject.root, 'scripts/upstream-schedule.ts'),
    }
    const rendered = renderLaunchAgent(
      paths, { hour: 9, minute: 0 }, 'MEDIUM',
      { nodePath: '/maintenance/node', tsxCliPath: '/maintenance/tsx-cli.mjs' }, '2026-09-17T00:00:00.000Z',
    )
    expect(rendered).toContain('<key>Label</key><string>dev.dsh.upstream-monitor</string>')
    expect(rendered).toContain('<key>Hour</key><integer>9</integer>')
    expect(rendered).toContain('<key>Minute</key><integer>0</integer>')
    expect(rendered).toContain('/maintenance/node')
    expect(rendered).not.toContain('/Applications/DS Harness.app')
  })

  it('installs idempotently and refuses to uninstall a plist without DS Harness provenance', async () => {
    const subject = fixture()
    let loaded = false
    const deps: SchedulerDependencies = {
      runtime: () => ({ nodePath: process.execPath, tsxCliPath: join(subject.root, 'scripts/upstream-schedule.ts') }),
      command: (_program, args) => {
        if (args[0] === 'print') return { status: loaded ? 0 : 113, stdout: '', stderr: '' }
        if (args[0] === 'bootstrap') { loaded = true; return { status: 0, stdout: '', stderr: '' } }
        if (args[0] === 'bootout') { loaded = false; return { status: 0, stdout: '', stderr: '' } }
        return { status: 0, stdout: '', stderr: '' }
      },
    }
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    await installScheduler(subject.root, options, deps)
    const plist = join(subject.home, 'Library/LaunchAgents/dev.dsh.upstream-monitor.plist')
    const once = readFileSync(plist, 'utf8')
    await installScheduler(subject.root, options, deps)
    expect(readFileSync(plist, 'utf8')).toBe(once)
    writeFileSync(plist, '<plist><dict><key>Label</key><string>dev.dsh.upstream-monitor</string></dict></plist>')
    await expect(uninstallScheduler(subject.root, options, deps)).rejects.toThrow(/refusing to modify/u)
    expect(existsSync(plist)).toBe(true)
  })
})
