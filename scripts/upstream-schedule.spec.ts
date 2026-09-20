import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  installScheduler,
  materialNotification,
  renderLaunchAgent,
  runScheduled,
  schedulerStatus,
  uninstallScheduler,
  type SchedulerDependencies,
  type SchedulerPaths,
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

interface Fixture { root: string; home: string; output: string }

function fixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-upstream-schedule-'))
  roots.push(parent)
  const root = join(parent, 'repo')
  const home = join(parent, 'home')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=master', root], { encoding: 'utf8' })
  // The scheduler's runtime probe requires the repository entrypoint to exist.
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'upstream-schedule.ts'), '// fixture entrypoint\n')
  writeFileSync(join(home, 'Library', 'LaunchAgents', '.keep'), '')
  return { root, home, output: join(parent, 'artifacts') }
}

function paths(subject: Fixture): SchedulerPaths {
  return {
    root: subject.root, output: subject.output, state: join(subject.output, 'scheduler-state.json'),
    log: join(subject.output, 'logs/scheduler.log'), errorLog: join(subject.output, 'logs/scheduler.err.log'),
    plist: join(subject.home, 'Library/LaunchAgents/dev.dsh.upstream-monitor.plist'),
    script: join(subject.root, 'scripts/upstream-schedule.ts'),
  }
}

/** A launchctl/Node stand-in that never touches the real system. */
function fakeCommands(overrides: { version?: string; architecture?: string } = {}) {
  let loaded = false
  const calls: string[][] = []
  const command = (_program: string, args: string[]) => {
    calls.push(args)
    if (args[0] === '--version') return { status: 0, stdout: `${overrides.version ?? 'v24.21.0'}\n`, stderr: '' }
    if (args[0] === '-p') return { status: 0, stdout: `${overrides.architecture ?? 'arm64'}\n`, stderr: '' }
    if (args[0] === 'print') return { status: loaded ? 0 : 113, stdout: '', stderr: '' }
    if (args[0] === 'bootstrap') { loaded = true; return { status: 0, stdout: '', stderr: '' } }
    if (args[0] === 'bootout') { loaded = false; return { status: 0, stdout: '', stderr: '' } }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { command, calls, isLoaded: () => loaded, setLoaded: (value: boolean) => { loaded = value } }
}

/** Create a stable opt-path Node plus a repository-local tsx entrypoint. */
function stableRuntime(subject: Fixture): { node: string; tsx: string; symlinkTo: (path: string) => void } {
  const node = join(subject.home, 'opt/node@24/bin/node')
  const tsx = join(subject.root, 'node_modules/tsx/dist/cli.mjs')
  mkdirSync(dirname(node), { recursive: true })
  mkdirSync(dirname(tsx), { recursive: true })
  symlinkSync(process.execPath, node)
  writeFileSync(tsx, '// fixture tsx\n')
  return { node, tsx, symlinkTo: (target) => { rmSync(node); symlinkSync(target, node) } }
}

function storedState(subject: Fixture): SchedulerState {
  return JSON.parse(readFileSync(join(subject.output, 'scheduler-state.json'), 'utf8')) as SchedulerState
}

describe('upstream scheduler notification policy', () => {
  it('AE/AF/AG/AH/AL. is silent for no change, NONE, LOW, locks, and existing debt alone', () => {
    const base = state()
    for (const current of [monitor('NO_NEW_UPSTREAM_CHANGES'), monitor('NEW_CHANGES', 'NONE'), monitor('NEW_CHANGES', 'LOW'), monitor('LOCKED')]) {
      expect(materialNotification(current, base, 'MEDIUM', '2026-09-17T00:00:00.000Z')).toBeNull()
    }
    // Existing CRITICAL unresolved debt is carried into state, never an event trigger.
    expect(base.notifiedEventKeys).toEqual([])
  })

  it('AI/AJ/AK/AM/AN. notifies for MEDIUM, HIGH, and CRITICAL, dedupes, and allows an escalation', async () => {
    const subject = fixture()
    let notifications = 0
    const deps: SchedulerDependencies = { monitor: async () => monitor('NEW_CHANGES', 'MEDIUM'), notify: () => { notifications += 1 } }
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    const first = await runScheduled(subject.root, options, deps)
    expect(first.notification?.eventKey).toContain(':MEDIUM:')
    expect(notifications).toBe(1)
    await runScheduled(subject.root, options, deps)
    expect(notifications).toBe(1)
    const escalated = await runScheduled(subject.root, options, { ...deps, monitor: async () => monitor('NEW_CHANGES', 'HIGH') })
    expect(escalated.notification?.eventKey).toContain(':HIGH:')
    expect(notifications).toBe(2)
    const critical = await runScheduled(subject.root, options, { ...deps, monitor: async () => monitor('NEW_CHANGES', 'CRITICAL') })
    expect(critical.notification?.eventKey).toContain(':CRITICAL:')
    expect(notifications).toBe(3)
  })

  it('AO/AP/AQ. debounces fetch failures, resets after success, and immediately reports integrity failures', async () => {
    const subject = fixture()
    let notifications = 0
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    const deps: SchedulerDependencies = { monitor: async () => monitor('FETCH_FAILED'), notify: () => { notifications += 1 } }
    expect((await runScheduled(subject.root, options, deps)).notification).toBeNull()
    expect(storedState(subject).consecutiveFetchFailures).toBe(1)
    expect((await runScheduled(subject.root, options, deps)).notification?.kind).toBe('FETCH_FAILURE')
    await runScheduled(subject.root, options, deps)
    expect(notifications).toBe(1)
    await runScheduled(subject.root, options, { ...deps, monitor: async () => monitor('NO_NEW_UPSTREAM_CHANGES') })
    expect(storedState(subject).consecutiveFetchFailures).toBe(0)
    const integrity = await runScheduled(subject.root, options, { ...deps, monitor: async () => monitor('STATE_INVALID') })
    expect(integrity.notification?.kind).toBe('INTEGRITY_FAILURE')
    expect(notifications).toBe(2)
  })

  it('AT/AU/AV/AW. notifies immediately for every maintenance integrity failure', async () => {
    const immediate: MonitorOutcome[] = ['STATE_INVALID', 'UPSTREAM_HISTORY_DIVERGENCE', 'CHECKOUT_MUTATED', 'REMOTE_NOT_CONFIGURED', 'UPSTREAM_REF_MISSING']
    for (const outcome of immediate) {
      const subject = fixture()
      const result = await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, {
        monitor: async () => monitor(outcome), notify: () => {},
      })
      expect(result.notification?.kind).toBe('INTEGRITY_FAILURE')
      expect(result.notification?.eventKey).toBe(`integrity:${outcome}:${'a'.repeat(40)}`)
    }
  })

  it('AR/AS. retains a pending notification when Notification Center fails without changing the monitor cursor', async () => {
    const subject = fixture()
    const current = monitor('NEW_CHANGES', 'CRITICAL', 'e'.repeat(40))
    const result = await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, {
      monitor: async () => current,
      notify: () => { throw new Error('Notification Center unavailable') },
    })

    expect(result).toMatchObject({ exitCode: 4, notificationDelivered: false })
    expect(result.monitor.state?.lastObservedUpstreamSha).toBe('e'.repeat(40))
    expect(storedState(subject).pendingNotifications).toHaveLength(1)
    expect(storedState(subject).lastNotificationError).toBe('Notification Center unavailable')

    // A later run retries the same retained event without re-auditing it.
    const retried = await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, {
      monitor: async () => current, notify: () => {},
    })
    expect(retried.notificationDelivered).toBe(true)
    expect(storedState(subject).pendingNotifications).toHaveLength(0)
  })

  it('BK. bounds scheduler logs and rotates the previous file', async () => {
    const subject = fixture()
    mkdirSync(join(subject.output, 'logs'), { recursive: true })
    const { log } = paths(subject)
    writeFileSync(log, 'x'.repeat(300 * 1024))

    await runScheduled(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, {
      monitor: async () => monitor('NO_NEW_UPSTREAM_CHANGES'), notify: () => {},
    })

    expect(existsSync(`${log}.1`)).toBe(true)
    expect(statSync(log).size).toBeLessThan(256 * 1024)
  })

  it('reports scheduler status without touching the real system', async () => {
    const subject = fixture()
    const runtime = stableRuntime(subject)
    const commands = fakeCommands()
    const deps: SchedulerDependencies = {
      runtime: () => ({ nodePath: runtime.node, tsxCliPath: runtime.tsx }),
      command: commands.command,
    }
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }

    const absent = schedulerStatus(subject.root, options, deps)
    expect(absent).toMatchObject({ label: 'dev.dsh.upstream-monitor', installed: false, ownership: 'absent', loaded: false })

    await installScheduler(subject.root, options, deps)
    const installed = schedulerStatus(subject.root, options, deps)
    expect(installed).toMatchObject({ installed: true, ownership: 'owned', loaded: true, schedule: '09:00 local', stateError: null })
    expect(installed.maintenanceRuntimeError).toBeNull()
  })
})

describe('LaunchAgent integration contract', () => {
  it('AX/AY/AZ/BA/BB/BC/BD/BE/BF. renders a daily local 09:00 user agent on the stable maintenance runtime', () => {
    const subject = fixture()
    const rendered = renderLaunchAgent(
      paths(subject), { hour: 9, minute: 0 }, 'MEDIUM',
      { nodePath: '/maintenance/node', tsxCliPath: '/maintenance/tsx-cli.mjs' }, '2026-09-17T00:00:00.000Z',
    )

    // AY/AZ: owned label and local 09:00 calendar schedule.
    expect(rendered).toContain('<key>Label</key><string>dev.dsh.upstream-monitor</string>')
    expect(rendered).toContain('<key>Hour</key><integer>9</integer>')
    expect(rendered).toContain('<key>Minute</key><integer>0</integer>')
    expect(rendered).toContain('<key>DSHSchedule</key><string>09:00 local</string>')
    // AX: user-level domain only, no RunAtLoad, no keep-awake, no root/sudo.
    expect(rendered).toContain('<key>DSHProject</key><string>DS Harness upstream monitor</string>')
    expect(rendered).not.toContain('RunAtLoad')
    expect(rendered).not.toContain('KeepAlive')
    expect(rendered).not.toContain('caffeinate')
    expect(rendered).not.toContain('sudo')
    expect(rendered).not.toContain('UserName')
    expect(rendered).not.toMatch(/LaunchDaemons/u)
    // BD/BE: the stable maintenance Node and repository-local tsx are what is stored.
    expect(rendered).toContain('/maintenance/node')
    expect(rendered).toContain('/maintenance/tsx-cli.mjs')
    // BF: never the packaged application runtime.
    expect(rendered).not.toContain('/Applications/DS Harness.app')
    expect(rendered).not.toContain('/Applications/DSH Desktop.app')
    expect(rendered).not.toContain('DS Harness.app')
  })

  it('BG/BH. installs idempotently and refuses to uninstall a plist without DS Harness ownership markers', async () => {
    const subject = fixture()
    const runtime = stableRuntime(subject)
    const commands = fakeCommands()
    const deps: SchedulerDependencies = {
      runtime: () => ({ nodePath: runtime.node, tsxCliPath: runtime.tsx }),
      command: commands.command,
    }
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    await installScheduler(subject.root, options, deps)
    const plist = paths(subject).plist
    const once = readFileSync(plist, 'utf8')

    await installScheduler(subject.root, options, deps)
    expect(readFileSync(plist, 'utf8')).toBe(once)
    expect(commands.calls.filter(args => args[0] === 'bootstrap')).toHaveLength(2)

    writeFileSync(plist, '<plist><dict><key>Label</key><string>dev.dsh.upstream-monitor</string></dict></plist>')
    await expect(uninstallScheduler(subject.root, options, deps)).rejects.toThrow(/refusing to modify/u)
    expect(existsSync(plist)).toBe(true)
  })

  it('BH. refuses to take over a foreign label before installing', async () => {
    const subject = fixture()
    const runtime = stableRuntime(subject)
    const commands = fakeCommands()
    commands.setLoaded(true)
    const deps: SchedulerDependencies = {
      runtime: () => ({ nodePath: runtime.node, tsxCliPath: runtime.tsx }),
      command: commands.command,
    }

    await expect(installScheduler(subject.root, { homeDirectory: subject.home, outputDirectory: subject.output }, deps))
      .rejects.toThrow(/loaded but no owned plist/u)
    expect(existsSync(paths(subject).plist)).toBe(false)
  })

  it('BI/BJ. uninstall removes only the owned plist and preserves state, reports, debt, and tags', async () => {
    const subject = fixture()
    const runtime = stableRuntime(subject)
    const commands = fakeCommands()
    const deps: SchedulerDependencies = {
      runtime: () => ({ nodePath: runtime.node, tsxCliPath: runtime.tsx }),
      command: commands.command,
    }
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    await installScheduler(subject.root, options, deps)
    await runScheduled(subject.root, { ...options, now: () => new Date('2026-09-17T00:00:00.000Z') }, {
      monitor: async () => monitor('NEW_CHANGES', 'HIGH'), notify: () => {},
    })

    const statePath = paths(subject).state
    // Monitor-owned evidence the scheduler must never delete on uninstall.
    const reportDirectory = join(subject.output, 'reports')
    mkdirSync(reportDirectory, { recursive: true })
    const reportFile = join(reportDirectory, 'incremental-fixture.md')
    writeFileSync(reportFile, '# Retained evidence\n')
    expect(existsSync(statePath)).toBe(true)
    expect(existsSync(paths(subject).log)).toBe(true)

    expect(await uninstallScheduler(subject.root, options, deps)).toBe(true)
    expect(existsSync(paths(subject).plist)).toBe(false)
    expect(existsSync(statePath)).toBe(true)
    expect(existsSync(reportFile)).toBe(true)
    // The protected baseline tags are untouched.
    expect(execFileSync('git', ['-C', subject.root, 'tag', '--list'], { encoding: 'utf8' })).not.toContain('dev.dsh')
    expect(commands.isLoaded()).toBe(false)
  })

  it('BD/BE. persists stable symlink paths across simulated Homebrew and pnpm target upgrades', async () => {
    const subject = fixture()
    const nodeV1 = join(subject.home, 'Cellar/node@24/24.21.0/bin/node')
    const nodeV2 = join(subject.home, 'Cellar/node@24/24.22.0/bin/node')
    const tsxV1 = join(subject.root, 'node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs')
    const tsxV2 = join(subject.root, 'node_modules/.pnpm/tsx@4.23.0/node_modules/tsx/dist/cli.mjs')
    for (const path of [nodeV1, nodeV2, tsxV1, tsxV2]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    }
    const stableNode = join(subject.home, 'opt/node@24/bin/node')
    const stableTsx = join(subject.root, 'node_modules/tsx/dist/cli.mjs')
    mkdirSync(dirname(stableNode), { recursive: true })
    mkdirSync(dirname(stableTsx), { recursive: true })
    symlinkSync(nodeV1, stableNode)
    symlinkSync(tsxV1, stableTsx)
    const commands = fakeCommands({ version: 'v24.22.0' })
    const deps: SchedulerDependencies = {
      runtime: () => ({ nodePath: stableNode, tsxCliPath: stableTsx }),
      command: commands.command,
    }
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    await installScheduler(subject.root, options, deps)
    const plist = paths(subject).plist
    const before = readFileSync(plist, 'utf8')

    rmSync(stableNode)
    rmSync(stableTsx)
    symlinkSync(nodeV2, stableNode)
    symlinkSync(tsxV2, stableTsx)
    await installScheduler(subject.root, options, deps)
    const after = readFileSync(plist, 'utf8')

    expect(after).toBe(before)
    expect(after).toContain(stableNode)
    expect(after).toContain(stableTsx)
    expect(after).not.toContain('/Cellar/node@24/24.21.0/')
    expect(after).not.toContain('/.pnpm/tsx@4.22.4/')
  })

  it('BH. rejects version-pinned runtimes and non-Node-24 maintenance probes', async () => {
    const subject = fixture()
    const options = { homeDirectory: subject.home, outputDirectory: subject.output }
    await expect(installScheduler(subject.root, options, {
      runtime: () => ({ nodePath: '/tmp/Cellar/node@24/24.21.0/bin/node', tsxCliPath: '/tmp/tsx/cli.mjs' }),
    })).rejects.toThrow(/version-pinned Homebrew Cellar/u)
    await expect(installScheduler(subject.root, options, {
      runtime: () => ({ nodePath: '/tmp/opt/node@24/bin/node', tsxCliPath: '/tmp/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs' }),
    })).rejects.toThrow(/version-pinned pnpm internal/u)
    await expect(installScheduler(subject.root, options, {
      runtime: () => ({ nodePath: '/tmp/opt/node@24/bin/node', tsxCliPath: '/tmp/node_modules/tsx/dist/cli.mjs' }),
    })).rejects.toThrow(/ENOENT/u)

    const runtime = stableRuntime(subject)
    await expect(installScheduler(subject.root, options, {
      runtime: () => ({ nodePath: runtime.node, tsxCliPath: runtime.tsx }),
      command: (_program, args) => args[0] === '--version'
        ? { status: 0, stdout: 'v25.0.0\n', stderr: '' }
        : { status: 0, stdout: 'arm64\n', stderr: '' },
    })).rejects.toThrow(/major must be 24/u)

    await expect(installScheduler(subject.root, options, {
      runtime: () => ({ nodePath: runtime.node, tsxCliPath: runtime.tsx }),
      command: (_program, args) => args[0] === '--version'
        ? { status: 0, stdout: 'v24.21.0\n', stderr: '' }
        : { status: 0, stdout: 'x64\n', stderr: '' },
    })).rejects.toThrow(/architecture must be arm64/u)
  })
})
