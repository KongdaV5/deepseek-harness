/** User-level launchd scheduling and quiet material-change notification for the upstream monitor. */

import { spawnSync } from 'node:child_process'
import { accessSync, existsSync, readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { writeFileAtomic } from '../packages/util/atomic-write/src/index.ts'
import {
  runUpstreamMonitor,
  type MonitorOutcome,
  type MonitorResult,
} from './upstream-monitor.ts'

const SCHEDULER_STATE_VERSION = 1
const LABEL = 'dev.dsh.upstream-monitor'
const PROJECT = 'DS Harness upstream monitor'
const DEFAULT_HOUR = 9
const DEFAULT_MINUTE = 0
const DEFAULT_THRESHOLD: NotificationRisk = 'MEDIUM'
const MAX_LOG_BYTES = 256 * 1024
const MAX_NOTIFIED_KEYS = 50
const FETCH_FAILURE_NOTIFY_AT = 2

export type NotificationRisk = 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type SchedulerExitCode = 0 | 2 | 3 | 4
export type NotificationKind = 'MATERIAL_CHANGE' | 'FETCH_FAILURE' | 'INTEGRITY_FAILURE'

export interface NotificationEvent {
  eventKey: string
  kind: NotificationKind
  targetSha: string | null
  title: string
  subtitle: string
  body: string
  createdAt: string
}

export interface SchedulerState {
  schemaVersion: typeof SCHEDULER_STATE_VERSION
  lastRunAt: string | null
  lastExecution: {
    startedAt: string
    completedAt: string | null
    monitorOutcome: MonitorOutcome
    schedulerExitCode: SchedulerExitCode
  } | null
  consecutiveFetchFailures: number
  lastNotifiedEventKey: string | null
  lastNotifiedTargetSha: string | null
  lastNotifiedAt: string | null
  lastNotificationKind: NotificationKind | null
  lastFailureNotificationKey: string | null
  notifiedEventKeys: string[]
  pendingNotifications: NotificationEvent[]
  lastNotificationError: string | null
  lastSchedulerError: string | null
}

export interface SchedulerPaths {
  root: string
  output: string
  state: string
  log: string
  errorLog: string
  plist: string
  script: string
}

export interface SchedulerRuntime {
  nodePath: string
  tsxCliPath: string
}

export interface VerifiedSchedulerRuntime extends SchedulerRuntime {
  nodeVersion: string
  architecture: string
}

export interface SchedulerOptions {
  hour?: number | undefined
  minute?: number | undefined
  notifyThreshold?: NotificationRisk | undefined
  homeDirectory?: string | undefined
  outputDirectory?: string | undefined
  statePath?: string | undefined
  now?: (() => Date) | undefined
}

export interface SchedulerDependencies {
  monitor?: (root: string) => Promise<MonitorResult>
  notify?: (event: NotificationEvent) => void
  command?: (program: string, args: string[]) => CommandResult
  runtime?: (paths: SchedulerPaths) => SchedulerRuntime
}

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error | undefined
}

export interface ScheduledRunResult {
  exitCode: SchedulerExitCode
  monitor: MonitorResult
  notification: NotificationEvent | null
  notificationDelivered: boolean | null
  state: SchedulerState
}

export interface InstallResult {
  installed: boolean
  loaded: boolean
  plist: string
  label: string
  schedule: string
}

const riskRank = new Map<NotificationRisk, number>([
  ['MEDIUM', 0], ['HIGH', 1], ['CRITICAL', 2],
])

function command(program: string, args: string[]): CommandResult {
  const result = spawnSync(program, args, { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error }
}

function commandFailure(result: CommandResult): string {
  return result.error?.message ?? (result.stderr.trim() || `command exited with status ${String(result.status)}`)
}

function requiredCommand(deps: SchedulerDependencies, program: string, args: string[], subject: string): CommandResult {
  const result = (deps.command ?? command)(program, args)
  if (result.status !== 0) throw new Error(`${subject}: ${commandFailure(result)}`)
  return result
}

function rootOf(cwd: string): string {
  const result = command('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (result.status !== 0) throw new Error(`cannot locate repository root: ${commandFailure(result)}`)
  return result.stdout.trim()
}

function at(options: SchedulerOptions): string {
  return (options.now?.() ?? new Date()).toISOString()
}

function risk(value: unknown): value is NotificationRisk {
  return value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL'
}

function thresholdOf(options: SchedulerOptions): NotificationRisk {
  return options.notifyThreshold ?? DEFAULT_THRESHOLD
}

function scheduleOf(options: SchedulerOptions): { hour: number; minute: number } {
  const hour = options.hour ?? DEFAULT_HOUR
  const minute = options.minute ?? DEFAULT_MINUTE
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('schedule hour must be an integer from 0 to 23')
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('schedule minute must be an integer from 0 to 59')
  return { hour, minute }
}

function pathsOf(root: string, options: SchedulerOptions): SchedulerPaths {
  const outputValue = options.outputDirectory ?? '.artifacts/upstream-monitor'
  const output = isAbsolute(outputValue) ? outputValue : resolve(root, outputValue)
  const stateValue = options.statePath ?? join(output, 'scheduler-state.json')
  const state = isAbsolute(stateValue) ? stateValue : resolve(root, stateValue)
  const home = options.homeDirectory ?? homedir()
  return {
    root, output, state, log: join(output, 'logs', 'scheduler.log'), errorLog: join(output, 'logs', 'scheduler.err.log'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`), script: join(root, 'scripts', 'upstream-schedule.ts'),
  }
}

function emptyState(): SchedulerState {
  return {
    schemaVersion: SCHEDULER_STATE_VERSION, lastRunAt: null, lastExecution: null, consecutiveFetchFailures: 0,
    lastNotifiedEventKey: null, lastNotifiedTargetSha: null, lastNotifiedAt: null, lastNotificationKind: null,
    lastFailureNotificationKey: null, notifiedEventKeys: [], pendingNotifications: [], lastNotificationError: null,
    lastSchedulerError: null,
  }
}

function readState(path: string): SchedulerState {
  if (!existsSync(path)) return emptyState()
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SchedulerState>
  if (value.schemaVersion !== SCHEDULER_STATE_VERSION || !Array.isArray(value.notifiedEventKeys)
    || !Array.isArray(value.pendingNotifications)
    || !Number.isInteger(value.consecutiveFetchFailures) || (value.consecutiveFetchFailures ?? -1) < 0) {
    throw new Error('scheduler state is invalid; preserve the file and repair it before retrying')
  }
  return value as SchedulerState
}

async function writeState(path: string, state: SchedulerState): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

async function rotate(path: string): Promise<void> {
  if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return
  await rm(`${path}.1`, { force: true })
  await rename(path, `${path}.1`)
}

async function log(paths: SchedulerPaths, line: Record<string, unknown>, error = false): Promise<void> {
  const destination = error ? paths.errorLog : paths.log
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await rotate(destination)
  await appendFile(destination, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function messageForMaterial(monitor: MonitorResult, createdAt: string): NotificationEvent | null {
  if (monitor.outcome !== 'NEW_CHANGES' || monitor.incremental === null || !risk(monitor.incremental.highestRisk)) return null
  const item = monitor.incremental
  const target = item.targetSha
  const affected = item.affectedSeams.length === 0 ? 'no registered seams' : `${item.affectedSeams.length} compatibility seam${item.affectedSeams.length === 1 ? '' : 's'}`
  return {
    eventKey: `material:${target}:${item.highestRisk}:${item.impact ?? 'Unknown'}`,
    kind: 'MATERIAL_CHANGE', targetSha: target, title: 'DS Harness Upstream',
    subtitle: `New ${item.highestRisk} upstream change`,
    body: `${item.newCommits} new commits · ${affected}\n${item.recommendedAction?.replaceAll('_', ' ') ?? 'Review required'}${monitor.state?.existingCompatibilityDebt.resolutionStatus === 'UNRESOLVED' ? '\nExisting blocker remains unresolved' : ''}`,
    createdAt,
  }
}

function messageForIntegrity(monitor: MonitorResult, createdAt: string): NotificationEvent | null {
  const immediate = new Set<MonitorOutcome>([
    'UPSTREAM_HISTORY_DIVERGENCE', 'STATE_INVALID', 'CHECKOUT_MUTATED', 'REMOTE_NOT_CONFIGURED', 'UPSTREAM_REF_MISSING',
  ])
  if (!immediate.has(monitor.outcome)) return null
  const target = monitor.incremental?.targetSha ?? monitor.state?.lastObservedUpstreamSha ?? null
  return {
    eventKey: `integrity:${monitor.outcome}:${target ?? 'unknown'}`,
    kind: 'INTEGRITY_FAILURE', targetSha: target, title: 'DS Harness Upstream', subtitle: 'Monitor integrity issue',
    body: `${monitor.outcome.replaceAll('_', ' ')}\nManual review required`, createdAt,
  }
}

function messageForFetchFailure(state: SchedulerState, monitor: MonitorResult, createdAt: string): NotificationEvent | null {
  if (monitor.outcome !== 'FETCH_FAILED' || state.consecutiveFetchFailures < FETCH_FAILURE_NOTIFY_AT) return null
  return {
    eventKey: `fetch-failure:${FETCH_FAILURE_NOTIFY_AT}`,
    kind: 'FETCH_FAILURE', targetSha: null, title: 'DS Harness Upstream', subtitle: 'Upstream fetch is failing',
    body: `${state.consecutiveFetchFailures} consecutive fetch failures\nMonitoring will retry quietly.`, createdAt,
  }
}

/** Decide only from the new monitor result; pre-existing compatibility debt is never an event trigger. */
export function materialNotification(
  monitor: MonitorResult, state: SchedulerState, threshold: NotificationRisk, createdAt: string,
): NotificationEvent | null {
  const material = messageForMaterial(monitor, createdAt)
  const incrementalRisk = monitor.incremental?.highestRisk
  const incrementalRank = risk(incrementalRisk) ? riskRank.get(incrementalRisk) : undefined
  const thresholdRank = riskRank.get(threshold)
  if (material !== null && incrementalRank !== undefined && thresholdRank !== undefined && incrementalRank >= thresholdRank) return material
  return messageForIntegrity(monitor, createdAt) ?? messageForFetchFailure(state, monitor, createdAt)
}

function eventAlreadyKnown(state: SchedulerState, event: NotificationEvent): boolean {
  return state.notifiedEventKeys.includes(event.eventKey) || state.pendingNotifications.some(value => value.eventKey === event.eventKey)
}

function markDelivered(state: SchedulerState, event: NotificationEvent, timestamp: string): void {
  state.lastNotifiedEventKey = event.eventKey
  state.lastNotifiedTargetSha = event.targetSha
  state.lastNotifiedAt = timestamp
  state.lastNotificationKind = event.kind
  if (event.kind === 'FETCH_FAILURE') state.lastFailureNotificationKey = event.eventKey
  state.notifiedEventKeys = [...state.notifiedEventKeys.filter(value => value !== event.eventKey), event.eventKey].slice(-MAX_NOTIFIED_KEYS)
  state.pendingNotifications = state.pendingNotifications.filter(value => value.eventKey !== event.eventKey)
  state.lastNotificationError = null
}

function notify(event: NotificationEvent): void {
  const args = [
    '-e', `display notification ${JSON.stringify(event.body)} with title ${JSON.stringify(event.title)} subtitle ${JSON.stringify(event.subtitle)}`,
  ]
  const result = command('/usr/bin/osascript', args)
  if (result.status !== 0) throw new Error(`Notification Center delivery failed: ${commandFailure(result)}`)
}

function monitoredExitCode(monitor: MonitorResult): SchedulerExitCode {
  if (monitor.exitCode === 0) return 0
  if (monitor.exitCode === 3) return 3
  return 2
}

/** Execute the actual maintenance path invoked by launchd, then apply policy without re-auditing a result. */
export async function runScheduled(
  root: string, options: SchedulerOptions = {}, deps: SchedulerDependencies = {},
): Promise<ScheduledRunResult> {
  const paths = pathsOf(root, options)
  let state: SchedulerState
  try { state = readState(paths.state) } catch (_error) {
    const monitor = await (deps.monitor ?? (cwd => runUpstreamMonitor(cwd)))(root)
    return { exitCode: 2, monitor, notification: null, notificationDelivered: null, state: emptyState() }
  }
  const startedAt = at(options)
  const monitor = await (deps.monitor ?? (cwd => runUpstreamMonitor(cwd)))(root)
  state.lastRunAt = startedAt
  state.lastExecution = { startedAt, completedAt: null, monitorOutcome: monitor.outcome, schedulerExitCode: monitoredExitCode(monitor) }
  state.consecutiveFetchFailures = monitor.outcome === 'FETCH_FAILED' ? state.consecutiveFetchFailures + 1 : 0
  const candidate = materialNotification(monitor, state, thresholdOf(options), startedAt)
  if (candidate !== null && !eventAlreadyKnown(state, candidate)) state.pendingNotifications.push(candidate)
  try {
    await writeState(paths.state, state)
  } catch (error) {
    await log(paths, { at: startedAt, error: (error as Error).message, stage: 'state-before-notification' }, true)
    return { exitCode: 2, monitor, notification: null, notificationDelivered: null, state }
  }

  const event = state.pendingNotifications[0] ?? null
  let delivered: boolean | null = null
  let exitCode = monitoredExitCode(monitor)
  if (event !== null) {
    try {
      ;(deps.notify ?? notify)(event)
      delivered = true
      markDelivered(state, event, at(options))
    } catch (error) {
      delivered = false
      exitCode = 4
      state.lastNotificationError = (error as Error).message
      await log(paths, { at: at(options), eventKey: event.eventKey, error: state.lastNotificationError, stage: 'notification' }, true)
    }
  }
  state.lastExecution = { startedAt, completedAt: at(options), monitorOutcome: monitor.outcome, schedulerExitCode: exitCode }
  state.lastSchedulerError = exitCode === 2 ? monitor.message : null
  try { await writeState(paths.state, state) } catch (_error) { exitCode = 2 }
  await log(paths, { at: at(options), monitorOutcome: monitor.outcome, exitCode, notification: event?.eventKey ?? null, delivered })
  return { exitCode, monitor, notification: event, notificationDelivered: delivered, state }
}

function runtime(paths: SchedulerPaths, deps: SchedulerDependencies): SchedulerRuntime {
  if (deps.runtime !== undefined) return deps.runtime(paths)
  const prefix = requiredCommand(deps, 'brew', ['--prefix', 'node@24'], 'cannot discover stable Homebrew node@24 prefix').stdout.trim()
  if (prefix === '' || prefix.includes('/Cellar/')) throw new Error('Homebrew did not return a stable node@24 formula prefix')
  return {
    nodePath: join(prefix, 'bin', 'node'),
    tsxCliPath: join(paths.root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  }
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function stringArray(values: string[]): string {
  return `<array>${values.map(value => `<string>${xml(value)}</string>`).join('')}</array>`
}

/** Render an owned user LaunchAgent; no product runtime path or shell command is embedded. */
export function renderLaunchAgent(
  paths: SchedulerPaths, schedule: { hour: number; minute: number }, threshold: NotificationRisk,
  usedRuntime: SchedulerRuntime, installedAt: string,
): string {
  const args = [usedRuntime.nodePath, usedRuntime.tsxCliPath, paths.script, 'scheduled', '--notify-threshold', threshold]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key>${stringArray(args)}
<key>WorkingDirectory</key><string>${xml(paths.root)}</string>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${schedule.hour}</integer><key>Minute</key><integer>${schedule.minute}</integer></dict>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
<key>DSHProject</key><string>${PROJECT}</string>
<key>DSHRepository</key><string>${xml(paths.root)}</string>
<key>DSHSchedule</key><string>${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} local</string>
<key>DSHNotifyThreshold</key><string>${threshold}</string>
<key>DSHEntrypoint</key><string>${xml(paths.script)}</string>
<key>DSHInstalledAt</key><string>${xml(installedAt)}</string>
</dict></plist>
`
}

function plistValue(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const found = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`, 'u').exec(text)
  return found?.[1]?.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&') ?? null
}

function assertOwnedPlist(path: string, paths: SchedulerPaths): void {
  if (!existsSync(path)) throw new Error(`LaunchAgent plist is absent: ${path}`)
  const text = readFileSync(path, 'utf8')
  if (plistValue(text, 'Label') !== LABEL || plistValue(text, 'DSHProject') !== PROJECT || plistValue(text, 'DSHRepository') !== paths.root) {
    throw new Error(`refusing to modify non-DS-Harness LaunchAgent: ${path}`)
  }
}

function launchDomain(): string { return `gui/${process.getuid?.() ?? 0}` }

function isLoaded(deps: SchedulerDependencies): boolean {
  return (deps.command ?? command)('/bin/launchctl', ['print', `${launchDomain()}/${LABEL}`]).status === 0
}

function verifyRuntime(paths: SchedulerPaths, deps: SchedulerDependencies): VerifiedSchedulerRuntime {
  const value = runtime(paths, deps)
  if (value.nodePath.includes('/Cellar/')) throw new Error('refusing to persist a version-pinned Homebrew Cellar Node path')
  if (value.tsxCliPath.includes('/node_modules/.pnpm/')) throw new Error('refusing to persist a version-pinned pnpm internal tsx path')
  accessSync(value.nodePath)
  accessSync(value.tsxCliPath)
  accessSync(paths.script)
  const version = requiredCommand(deps, value.nodePath, ['--version'], 'maintenance Node version probe failed').stdout.trim()
  const major = /^v(\d+)\./u.exec(version)?.[1]
  if (major !== '24') throw new Error(`maintenance Node major must be 24, got ${version || 'unknown'}`)
  const architecture = requiredCommand(deps, value.nodePath, ['-p', 'process.arch'], 'maintenance Node architecture probe failed').stdout.trim()
  if (architecture !== 'arm64') throw new Error(`maintenance Node architecture must be arm64, got ${architecture || 'unknown'}`)
  requiredCommand(deps, value.nodePath, [value.tsxCliPath, paths.script, 'runtime-probe'], 'LaunchAgent runtime probe failed')
  return { ...value, nodeVersion: version, architecture }
}

/** Install or safely reload only the owned user-level LaunchAgent. */
export async function installScheduler(
  cwd: string, options: SchedulerOptions = {}, deps: SchedulerDependencies = {},
): Promise<InstallResult> {
  const root = rootOf(cwd)
  const paths = pathsOf(root, options)
  const schedule = scheduleOf(options)
  const threshold = thresholdOf(options)
  const usedRuntime = verifyRuntime(paths, deps)
  const exists = existsSync(paths.plist)
  if (exists) assertOwnedPlist(paths.plist, paths)
  else if (isLoaded(deps)) throw new Error(`refusing install: ${LABEL} is loaded but no owned plist exists at ${paths.plist}`)
  const current = exists ? readFileSync(paths.plist, 'utf8') : null
  const rendered = renderLaunchAgent(paths, schedule, threshold, usedRuntime, current === null ? at(options) : (plistValue(current, 'DSHInstalledAt') ?? at(options)))
  if (current !== rendered) await writeFileAtomic(paths.plist, rendered, { mode: 0o600, dirMode: 0o700 })
  requiredCommand(deps, '/usr/bin/plutil', ['-lint', paths.plist], 'LaunchAgent plist validation failed')
  if (isLoaded(deps)) requiredCommand(deps, '/bin/launchctl', ['bootout', launchDomain(), paths.plist], 'could not unload owned LaunchAgent')
  requiredCommand(deps, '/bin/launchctl', ['bootstrap', launchDomain(), paths.plist], 'could not bootstrap LaunchAgent')
  if (!isLoaded(deps)) throw new Error('LaunchAgent bootstrap returned success but service is not registered')
  return { installed: true, loaded: true, plist: paths.plist, label: LABEL, schedule: `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} local` }
}

export async function uninstallScheduler(cwd: string, options: SchedulerOptions = {}, deps: SchedulerDependencies = {}): Promise<boolean> {
  const root = rootOf(cwd)
  const paths = pathsOf(root, options)
  assertOwnedPlist(paths.plist, paths)
  const running = isLoaded(deps)
  if (running) requiredCommand(deps, '/bin/launchctl', ['bootout', launchDomain(), paths.plist], 'could not unload owned LaunchAgent')
  await rm(paths.plist)
  return true
}

export function schedulerStatus(cwd: string, options: SchedulerOptions = {}, deps: SchedulerDependencies = {}): Record<string, unknown> {
  const root = rootOf(cwd)
  const paths = pathsOf(root, options)
  const installed = existsSync(paths.plist)
  let ownership: 'owned' | 'invalid' | 'absent' = 'absent'
  if (installed) {
    try { assertOwnedPlist(paths.plist, paths); ownership = 'owned' } catch { ownership = 'invalid' }
  }
  let state: SchedulerState | null = null
  let stateError: string | null = null
  try { state = readState(paths.state) } catch (error) { stateError = (error as Error).message }
  let maintenanceRuntime: VerifiedSchedulerRuntime | null = null
  let maintenanceRuntimeError: string | null = null
  try { maintenanceRuntime = verifyRuntime(paths, deps) } catch (error) { maintenanceRuntimeError = (error as Error).message }
  return {
    label: LABEL, installed, ownership, loaded: isLoaded(deps), schedule: installed ? plistValue(readFileSync(paths.plist, 'utf8'), 'DSHSchedule') : null,
    repository: root, repositoryExists: existsSync(root), plist: paths.plist, logs: [paths.log, paths.errorLog], statePath: paths.state,
    state, stateError, maintenanceRuntime, maintenanceRuntimeError,
  }
}

async function kickstartAndWait(cwd: string, options: SchedulerOptions = {}, deps: SchedulerDependencies = {}): Promise<SchedulerState> {
  const root = rootOf(cwd)
  const paths = pathsOf(root, options)
  assertOwnedPlist(paths.plist, paths)
  if (!isLoaded(deps)) throw new Error('LaunchAgent is not loaded; run upstream:schedule:install first')
  const requestedAt = Date.now()
  requiredCommand(deps, '/bin/launchctl', ['kickstart', '-k', `${launchDomain()}/${LABEL}`], 'could not kickstart LaunchAgent')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const state = readState(paths.state)
      const execution = state.lastExecution
      if (execution !== null && execution.completedAt !== null && Date.parse(execution.startedAt) >= requestedAt) return state
    } catch { /* wait for the wrapper to create a complete state file */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('LaunchAgent kickstart did not publish a completed scheduler state within 60 seconds')
}

function cliHelp(): string {
  return [
    'Usage: pnpm upstream:schedule:<install|status|run|uninstall|test-notification>', '',
    'The scheduler is a user-level macOS LaunchAgent. It runs daily at 09:00 local time by default.',
    'It observes upstream only; it never updates DS Harness, baseline tags, apps, profiles, or Sessions.',
  ].join('\n')
}

export async function runUpstreamScheduleCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [commandName, ...rest] = argv
  const parsed = parseArgs({ args: rest, options: {
    hour: { type: 'string' }, minute: { type: 'string' }, 'notify-threshold': { type: 'string' }, help: { type: 'boolean', default: false },
  }, strict: true })
  if (parsed.values.help || commandName === undefined) { process.stdout.write(`${cliHelp()}\n`); return 0 }
  const threshold = parsed.values['notify-threshold']
  if (threshold !== undefined && !risk(threshold)) throw new Error('notify threshold must be MEDIUM, HIGH, or CRITICAL')
  const options: SchedulerOptions = {
    hour: parsed.values.hour === undefined ? undefined : Number.parseInt(parsed.values.hour, 10),
    minute: parsed.values.minute === undefined ? undefined : Number.parseInt(parsed.values.minute, 10), notifyThreshold: threshold,
  }
  if (commandName === 'runtime-probe') { process.stdout.write(`${JSON.stringify({ node: process.execPath, repository: rootOf(process.cwd()) })}\n`); return 0 }
  if (commandName === 'scheduled') return (await runScheduled(rootOf(process.cwd()), options)).exitCode
  if (commandName === 'install') { process.stdout.write(`${JSON.stringify(await installScheduler(process.cwd(), options), null, 2)}\n`); return 0 }
  if (commandName === 'status') { process.stdout.write(`${JSON.stringify(schedulerStatus(process.cwd(), options), null, 2)}\n`); return 0 }
  if (commandName === 'run') { process.stdout.write(`${JSON.stringify(await kickstartAndWait(process.cwd(), options), null, 2)}\n`); return 0 }
  if (commandName === 'uninstall') { process.stdout.write(`${JSON.stringify({ removed: await uninstallScheduler(process.cwd(), options) })}\n`); return 0 }
  if (commandName === 'test-notification') {
    notify({ eventKey: 'test', kind: 'MATERIAL_CHANGE', targetSha: null, title: 'DS Harness Upstream', subtitle: 'TEST', body: 'Notification test successful.', createdAt: at(options) })
    process.stdout.write('{"delivered":true,"stateChanged":false}\n')
    return 0
  }
  throw new Error(`unknown scheduler command: ${commandName}`)
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  void runUpstreamScheduleCli().then((code) => { process.exitCode = code }).catch((error: unknown) => {
    process.stderr.write(`upstream schedule failed: ${(error as Error).message}\n`)
    process.exitCode = 2
  })
}
