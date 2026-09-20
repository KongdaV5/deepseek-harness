/** Scheduler-ready upstream refresh orchestration that reuses the deterministic auditor. */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { writeFileAtomic } from '../packages/util/atomic-write/src/index.ts'
import {
  auditUpstreamRange,
  renderMarkdownReport,
  type ConfidenceLevel,
  type ImpactLevel,
  type RecommendedAction,
  type RiskLevel,
  type UpstreamAuditReport,
} from './upstream-audit.ts'

const STATE_VERSION = 1
const DEFAULT_REMOTE = 'origin'
const DEFAULT_BRANCH = 'master'
const DEFAULT_OUTPUT = '.artifacts/upstream-monitor'
const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1_000
const DEFAULT_BASELINE_TAG = 'ds-harness-product-baseline-2026-09-17'
const DEFAULT_EVIDENCE = '.artifacts/upstream-audit/last-audit.json'

export type MonitorOutcome = 'NO_NEW_UPSTREAM_CHANGES' | 'NEW_CHANGES' | 'UPSTREAM_HISTORY_DIVERGENCE' | 'FETCH_FAILED' | 'AUDIT_FAILED' | 'STATE_INVALID' | 'STATE_WRITE_FAILED' | 'REMOTE_NOT_CONFIGURED' | 'UPSTREAM_REF_MISSING' | 'LOCKED' | 'CHECKOUT_MUTATED'

export interface CompatibilityDebt {
  anchorProductSha: string
  auditedUpstreamSha: string
  highestRisk: RiskLevel
  impact: ImpactLevel
  recommendedAction: RecommendedAction
  resolutionStatus: 'UNRESOLVED'
  sourceAuditReport: string
}

export interface IncrementalResult {
  outcome: 'NO_NEW_UPSTREAM_CHANGES' | 'NEW_CHANGES' | 'UPSTREAM_HISTORY_DIVERGENCE'
  previousCursor: string
  targetSha: string
  commitRange?: string | undefined
  newCommits: number
  changedFiles: number
  affectedSeams: string[]
  highestRisk: RiskLevel | null
  impact: ImpactLevel | null
  confidence: ConfidenceLevel | null
  recommendedAction: RecommendedAction | null
  report?: MonitorReportPaths | undefined
}

export interface MonitorReportPaths {
  markdownPath: string
  jsonPath: string
  kind: 'compact' | 'full'
}

export interface MonitorState {
  schemaVersion: typeof STATE_VERSION
  productBaselineTag: string
  productBaselineSha: string
  remote: string
  branch: string
  lastObservedUpstreamSha: string
  lastSuccessfulCheckAt: string | null
  lastFetchAt: string | null
  lastNewChangeAt: string | null
  existingCompatibilityDebt: CompatibilityDebt
  lastIncrementalResult: IncrementalResult | null
  lastReport: MonitorReportPaths | null
  failureState: { outcome: string; message: string; at: string } | null
}

export interface MonitorBootstrap {
  productBaselineTag: string
  productBaselineSha: string
  initialCursorSha: string
  debt: CompatibilityDebt
}

export interface MonitorOptions {
  remote?: string | undefined
  branch?: string | undefined
  dryRun?: boolean | undefined
  noFetch?: boolean | undefined
  outputDirectory?: string | undefined
  statePath?: string | undefined
  bootstrap?: MonitorBootstrap | undefined
  baselineTag?: string | undefined
  bootstrapEvidencePath?: string | undefined
  staleLockMs?: number | undefined
  now?: (() => Date) | undefined
}

export interface MonitorDependencies {
  audit?: (options: { base: string; target: string }, cwd: string) => UpstreamAuditReport
  writeAtomic?: (path: string, contents: string) => Promise<void>
  fetch?: (root: string, remote: string) => void
}

export interface MonitorResult {
  outcome: MonitorOutcome
  exitCode: 0 | 2 | 3
  statePath: string
  state: MonitorState | null
  incremental: IncrementalResult | null
  message: string
  report: MonitorReportPaths | null
}

function git(root: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error | undefined } {
  const result = spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error }
}

function fail(result: ReturnType<typeof git>): string {
  return result.error?.message ?? (result.stderr.trim() || `Git exited with status ${String(result.status)}`)
}

function requireGit(root: string, args: string[], subject: string): string {
  const result = git(root, args)
  if (result.status !== 0) throw new Error(`${subject}: ${fail(result)}`)
  return result.stdout
}

function rootOf(cwd: string): string {
  return requireGit(cwd, ['rev-parse', '--show-toplevel'], 'cannot locate Git worktree').trim()
}

function commitOf(root: string, ref: string, subject: string): string {
  const result = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  if (result.status !== 0) throw new Error(`${subject}: ${fail(result)}`)
  const sha = result.stdout.trim()
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`${subject}: expected a full commit SHA`)
  return sha
}

function ancestor(root: string, older: string, newer: string): boolean {
  const result = git(root, ['merge-base', '--is-ancestor', older, newer])
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`cannot inspect ancestry: ${fail(result)}`)
}

function timeOf(options: MonitorOptions): string {
  return (options.now?.() ?? new Date()).toISOString()
}

function outputOf(root: string, options: MonitorOptions): string {
  const value = options.outputDirectory ?? DEFAULT_OUTPUT
  return isAbsolute(value) ? value : resolve(root, value)
}

function stateOf(root: string, options: MonitorOptions): string {
  const value = options.statePath ?? join(outputOf(root, options), 'state.json')
  return isAbsolute(value) ? value : resolve(root, value)
}

function rel(root: string, value: string): string {
  return relative(root, value) || value
}

function initialState(bootstrap: MonitorBootstrap, remote: string, branch: string): MonitorState {
  return {
    schemaVersion: STATE_VERSION, productBaselineTag: bootstrap.productBaselineTag, productBaselineSha: bootstrap.productBaselineSha,
    remote, branch, lastObservedUpstreamSha: bootstrap.initialCursorSha,
    lastSuccessfulCheckAt: null, lastFetchAt: null, lastNewChangeAt: null,
    existingCompatibilityDebt: bootstrap.debt, lastIncrementalResult: null, lastReport: null, failureState: null,
  }
}

/**
 * Derive the fixed bootstrap identity from the repository instead of embedding
 * commit identifiers in source.
 *
 * The product baseline is resolved from its immutable tag, and the initial
 * monitoring cursor is read from the audited Phase 8B.1 evidence (`last-audit.json`)
 * for that exact baseline. The evidence is the same handoff the historical
 * literal duplicated, so a missing or inconsistent evidence file fails closed
 * rather than silently inventing a cursor.
 */
function bootstrapFromRepository(root: string, options: MonitorOptions): MonitorBootstrap {
  const productBaselineTag = options.baselineTag ?? DEFAULT_BASELINE_TAG
  const productBaselineSha = commitOf(root, productBaselineTag, `product baseline tag ${productBaselineTag} does not resolve`)
  const evidencePath = options.bootstrapEvidencePath ?? join(root, DEFAULT_EVIDENCE)
  if (!existsSync(evidencePath)) {
    throw new Error(`cannot bootstrap the monitor cursor: audited evidence is absent at ${rel(root, evidencePath)}`)
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Partial<{
    baseSha: unknown
    targetSha: unknown
    overallResult: unknown
  }>
  if (typeof evidence.baseSha !== 'string' || typeof evidence.targetSha !== 'string') {
    throw new Error(`audited evidence ${rel(root, evidencePath)} does not record a base and target commit`)
  }
  if (!/^[0-9a-f]{40}$/u.test(evidence.baseSha) || !/^[0-9a-f]{40}$/u.test(evidence.targetSha)) {
    throw new Error(`audited evidence ${rel(root, evidencePath)} does not record full commit identifiers`)
  }
  if (evidence.baseSha !== productBaselineSha) {
    throw new Error('audited evidence does not match the current product baseline tag')
  }
  if (evidence.overallResult !== 'BLOCKING_CHANGE') {
    throw new Error('audited evidence does not establish the fixed unresolved compatibility debt')
  }
  return {
    productBaselineTag,
    productBaselineSha,
    initialCursorSha: evidence.targetSha,
    debt: {
      anchorProductSha: productBaselineSha,
      auditedUpstreamSha: evidence.targetSha,
      highestRisk: 'CRITICAL',
      impact: 'BLOCKING_CHANGE',
      recommendedAction: 'MANUAL_ADAPTATION_REQUIRED',
      resolutionStatus: 'UNRESOLVED',
      sourceAuditReport: rel(root, evidencePath),
    },
  }
}

function validDebt(value: unknown, bootstrap: MonitorBootstrap): CompatibilityDebt {
  if (typeof value !== 'object' || value === null) throw new Error('existingCompatibilityDebt is invalid')
  const debt = value as Partial<CompatibilityDebt>
  if (debt.anchorProductSha !== bootstrap.productBaselineSha || debt.auditedUpstreamSha !== bootstrap.initialCursorSha || debt.resolutionStatus !== 'UNRESOLVED') throw new Error('existing compatibility debt does not match the fixed unresolved baseline debt')
  if (!/^[0-9a-f]{40}$/u.test(debt.auditedUpstreamSha ?? '') || typeof debt.sourceAuditReport !== 'string') throw new Error('existing compatibility debt is incomplete')
  return debt as CompatibilityDebt
}

function validState(value: unknown, bootstrap: MonitorBootstrap, remote: string, branch: string): MonitorState {
  if (typeof value !== 'object' || value === null) throw new Error('state is not an object')
  const state = value as Partial<MonitorState>
  if (state.schemaVersion !== STATE_VERSION) throw new Error(`unsupported state schema: ${String(state.schemaVersion)}`)
  if (state.productBaselineTag !== bootstrap.productBaselineTag || state.productBaselineSha !== bootstrap.productBaselineSha) throw new Error('state product baseline differs from the monitor bootstrap')
  if (state.remote !== remote || state.branch !== branch) throw new Error('state remote/branch differs from the monitor invocation')
  if (!/^[0-9a-f]{40}$/u.test(state.lastObservedUpstreamSha ?? '')) throw new Error('state cursor is not a full Git SHA')
  validDebt(state.existingCompatibilityDebt, bootstrap)
  for (const field of ['lastSuccessfulCheckAt', 'lastFetchAt', 'lastNewChangeAt'] as const) {
    if (state[field] !== null && typeof state[field] !== 'string') throw new Error(`state ${field} is invalid`)
  }
  if (state.lastIncrementalResult !== null && typeof state.lastIncrementalResult !== 'object') throw new Error('state lastIncrementalResult is invalid')
  if (state.lastReport !== null && typeof state.lastReport !== 'object') throw new Error('state lastReport is invalid')
  if (state.failureState !== null && typeof state.failureState !== 'object') throw new Error('state failureState is invalid')
  return state as MonitorState
}

async function atomic(path: string, content: string, deps: MonitorDependencies): Promise<void> {
  if (deps.writeAtomic !== undefined) return deps.writeAtomic(path, content)
  await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
}

async function persist(path: string, state: MonitorState, deps: MonitorDependencies): Promise<void> {
  await atomic(path, `${JSON.stringify(state, null, 2)}\n`, deps)
}

interface CheckoutSnapshot {
  head: string
  index: Buffer
  status: string
  baseline: string
  customBaseline: string
}

function checkoutSnapshot(root: string, baselineTag: string): CheckoutSnapshot {
  const gitDir = requireGit(root, ['rev-parse', '--git-dir'], 'cannot locate Git directory').trim()
  const indexPath = isAbsolute(gitDir) ? join(gitDir, 'index') : join(root, gitDir, 'index')
  return {
    head: commitOf(root, 'HEAD', 'cannot inspect checkout HEAD'),
    index: existsSync(indexPath) ? readFileSync(indexPath) : Buffer.alloc(0),
    status: requireGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'cannot inspect checkout status'),
    baseline: commitOf(root, baselineTag, 'cannot inspect product baseline tag'),
    customBaseline: commitOf(root, 'dsh-custom-baseline-2026-09-17', 'cannot inspect custom baseline tag'),
  }
}

function assertCheckoutUnchanged(root: string, baselineTag: string, before: CheckoutSnapshot): void {
  const after = checkoutSnapshot(root, baselineTag)
  if (before.head !== after.head || !before.index.equals(after.index) || before.status !== after.status
    || before.baseline !== after.baseline || before.customBaseline !== after.customBaseline) {
    throw new Error('fetch unexpectedly changed checkout, index, worktree, or protected baseline tags')
  }
}

interface LockHandle { path: string; token: string }

async function acquireLock(lockPath: string, staleMs: number, now: string): Promise<LockHandle | null> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const token = `${process.pid}-${Math.random().toString(16).slice(2)}`
  const body = `${JSON.stringify({ token, startedAt: now })}\n`
  try {
    await writeFile(lockPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return { path: lockPath, token }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  try {
    const stats = statSync(lockPath)
    if (Date.now() - stats.mtimeMs <= staleMs) return null
    await rm(lockPath, { force: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await writeFile(lockPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return { path: lockPath, token }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }
}

async function releaseLock(lock: LockHandle): Promise<void> {
  try {
    const value = JSON.parse(await readFile(lock.path, 'utf8')) as { token?: unknown }
    if (value.token === lock.token) await rm(lock.path, { force: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function result(
  outcome: MonitorOutcome,
  statePath: string,
  message: string,
  state: MonitorState | null = null,
  incremental: IncrementalResult | null = null,
  report: MonitorReportPaths | null = null,
): MonitorResult {
  return { outcome, exitCode: outcome === 'NO_NEW_UPSTREAM_CHANGES' || outcome === 'NEW_CHANGES' ? 0 : outcome === 'LOCKED' ? 3 : 2, statePath, state, incremental, message, report }
}

function reportPaths(root: string, output: string, previous: string, target: string, kind: 'compact' | 'full'): MonitorReportPaths {
  const directory = kind === 'compact' ? output : join(output, 'reports')
  const stem = kind === 'compact' ? 'latest-compact' : `incremental-${previous.slice(0, 12)}__${target.slice(0, 12)}`
  return { markdownPath: rel(root, join(directory, `${stem}.md`)), jsonPath: rel(root, join(directory, `${stem}.json`)), kind }
}

function absoluteReport(root: string, value: MonitorReportPaths): { markdownPath: string; jsonPath: string } {
  return { markdownPath: resolve(root, value.markdownPath), jsonPath: resolve(root, value.jsonPath) }
}

function incremental(previousCursor: string, targetSha: string, audit: UpstreamAuditReport): IncrementalResult {
  return {
    outcome: 'NEW_CHANGES', previousCursor, targetSha, commitRange: audit.identity.commitRange,
    newCommits: audit.summary.totalCommits, changedFiles: audit.summary.totalChangedFiles,
    affectedSeams: audit.summary.affectedSeams, highestRisk: audit.summary.highestRisk,
    impact: audit.summary.impact, confidence: audit.summary.confidence,
    recommendedAction: audit.summary.recommendedAction,
  }
}

function debtMarkdown(state: MonitorState): string {
  const debt = state.existingCompatibilityDebt
  return [
    '## Existing compatibility debt / 既有兼容性债务', '',
    `- Product baseline: \`${state.productBaselineTag}\` / \`${state.productBaselineSha}\``,
    `- Audited upstream anchor: \`${debt.auditedUpstreamSha}\``,
    `- Status: **${debt.resolutionStatus}** — ${debt.highestRisk} / ${debt.impact} / ${debt.recommendedAction}`,
    `- Evidence: \`${debt.sourceAuditReport}\``, '',
    'Incremental NONE/LOW findings do not resolve or lower this existing debt.', '',
  ].join('\n')
}

function monitorMarkdown(
  state: MonitorState, item: IncrementalResult, audit?: UpstreamAuditReport,
  failure?: string, monitorOutcome: MonitorOutcome = item.outcome,
): string {
  const lines = [
    '# DS Harness incremental upstream monitor', '',
    `- Outcome: **${monitorOutcome}**`,
    `- Previous cursor: \`${item.previousCursor}\``,
    `- Target: \`${item.targetSha}\``,
    `- New commits: ${item.newCommits}; changed files: ${item.changedFiles}`,
    `- Incremental risk: ${item.highestRisk ?? 'Unknown'}; impact: ${item.impact ?? 'Unknown'}; confidence: ${item.confidence ?? 'Unknown'}`,
    failure === undefined ? '' : `- Failure detail: ${failure}`,
    '', debtMarkdown(state),
  ]
  if (audit !== undefined) lines.push('## Incremental audit / 增量审计', '', renderMarkdownReport(audit))
  return lines.join('\n')
}

async function writeReport(
  root: string,
  state: MonitorState,
  item: IncrementalResult,
  output: string,
  deps: MonitorDependencies,
  audit?: UpstreamAuditReport,
  failure?: string,
  monitorOutcome: MonitorOutcome = item.outcome,
): Promise<MonitorReportPaths> {
  const kind = item.highestRisk === 'NONE' || item.highestRisk === 'LOW' ? 'compact' : 'full'
  const paths = reportPaths(root, output, item.previousCursor, item.targetSha, kind)
  const absolute = absoluteReport(root, paths)
  const payload = {
    generatedAt: new Date().toISOString(), monitorOutcome, state, incremental: item,
    audit: audit ?? null, failure: failure ?? null,
  }
  await atomic(absolute.markdownPath, monitorMarkdown(state, item, audit, failure, monitorOutcome), deps)
  await atomic(absolute.jsonPath, `${JSON.stringify(payload, null, 2)}\n`, deps)
  return paths
}

async function writeFailure(
  root: string,
  statePath: string,
  state: MonitorState,
  output: string,
  outcome: Exclude<MonitorOutcome, 'NO_NEW_UPSTREAM_CHANGES' | 'NEW_CHANGES' | 'LOCKED'>,
  message: string,
  options: MonitorOptions,
  deps: MonitorDependencies,
  targetSha = state.lastObservedUpstreamSha,
): Promise<MonitorResult> {
  const at = timeOf(options)
  const item: IncrementalResult = {
    outcome: outcome === 'UPSTREAM_HISTORY_DIVERGENCE' ? outcome : 'UPSTREAM_HISTORY_DIVERGENCE',
    previousCursor: state.lastObservedUpstreamSha, targetSha, newCommits: 0, changedFiles: 0,
    affectedSeams: [], highestRisk: null, impact: null, confidence: null, recommendedAction: null,
  }
  state.failureState = { outcome, message, at }
  let report: MonitorReportPaths | null = null
  try {
    if (!options.dryRun) report = await writeReport(root, state, item, output, deps, undefined, message, outcome)
    state.lastReport = report
    if (!options.dryRun) await persist(statePath, state, deps)
  } catch (error) {
    return result('STATE_WRITE_FAILED', statePath, `could not persist ${outcome}: ${(error as Error).message}`, state, item, report)
  }
  return result(outcome, statePath, message, state, outcome === 'UPSTREAM_HISTORY_DIVERGENCE' ? item : null, report)
}

function loadState(statePath: string, bootstrap: MonitorBootstrap, remote: string, branch: string): MonitorState | null {
  if (!existsSync(statePath)) return null
  return validState(JSON.parse(readFileSync(statePath, 'utf8')), bootstrap, remote, branch)
}

function validateBootstrap(root: string, state: MonitorState, bootstrap: MonitorBootstrap): void {
  if (state.productBaselineSha !== commitOf(root, bootstrap.productBaselineTag, 'product baseline tag does not resolve')) throw new Error('product baseline tag SHA has changed')
  commitOf(root, state.lastObservedUpstreamSha, 'monitor cursor does not resolve')
}

async function monitorLocked(root: string, options: MonitorOptions, deps: MonitorDependencies): Promise<MonitorResult> {
  const remote = options.remote ?? DEFAULT_REMOTE
  const branch = options.branch ?? DEFAULT_BRANCH
  const output = outputOf(root, options)
  const statePath = stateOf(root, options)
  let state: MonitorState
  try {
    const bootstrap = options.bootstrap ?? bootstrapFromRepository(root, options)
    state = loadState(statePath, bootstrap, remote, branch) ?? initialState(bootstrap, remote, branch)
    validateBootstrap(root, state, bootstrap)
  } catch (error) {
    return result('STATE_INVALID', statePath, (error as Error).message)
  }

  const remoteCheck = git(root, ['remote', 'get-url', remote])
  if (remoteCheck.status !== 0) return writeFailure(root, statePath, state, output, 'REMOTE_NOT_CONFIGURED', `remote ${remote} is not configured`, options, deps)

  if (!options.noFetch && !options.dryRun) {
    const before = checkoutSnapshot(root, state.productBaselineTag)
    try {
      if (deps.fetch !== undefined) deps.fetch(root, remote)
      else requireGit(root, ['fetch', remote, '--prune'], `cannot fetch ${remote}`)
    } catch (error) {
      return writeFailure(root, statePath, state, output, 'FETCH_FAILED', (error as Error).message, options, deps)
    }
    try {
      assertCheckoutUnchanged(root, state.productBaselineTag, before)
    } catch (error) {
      return writeFailure(root, statePath, state, output, 'CHECKOUT_MUTATED', (error as Error).message, options, deps)
    }
    state.lastFetchAt = timeOf(options)
  }

  const remoteRef = `refs/remotes/${remote}/${branch}`
  let target: string
  try {
    target = commitOf(root, remoteRef, `remote tracking ref ${remote}/${branch} is unavailable`)
  } catch (error) {
    return writeFailure(root, statePath, state, output, 'UPSTREAM_REF_MISSING', (error as Error).message, options, deps)
  }

  if (target === state.lastObservedUpstreamSha) {
    const item: IncrementalResult = { outcome: 'NO_NEW_UPSTREAM_CHANGES', previousCursor: target, targetSha: target, newCommits: 0, changedFiles: 0, affectedSeams: [], highestRisk: null, impact: null, confidence: null, recommendedAction: null }
    state.lastSuccessfulCheckAt = timeOf(options)
    state.lastIncrementalResult = item
    state.failureState = null
    if (!options.dryRun) {
      try { await persist(statePath, state, deps) } catch (error) { return result('STATE_WRITE_FAILED', statePath, (error as Error).message, state, item) }
    }
    return result('NO_NEW_UPSTREAM_CHANGES', statePath, 'no new upstream commits since the monitor cursor', state, item)
  }

  try {
    if (!ancestor(root, state.lastObservedUpstreamSha, target)) {
      return await writeFailure(
        root, statePath, state, output, 'UPSTREAM_HISTORY_DIVERGENCE',
        `cursor ${state.lastObservedUpstreamSha} is not an ancestor of ${target}; manual review required`,
        options, deps, target,
      )
    }
  } catch (error) {
    return writeFailure(root, statePath, state, output, 'STATE_INVALID', (error as Error).message, options, deps, target)
  }

  let audit: UpstreamAuditReport
  try {
    audit = (deps.audit ?? auditUpstreamRange)({ base: state.lastObservedUpstreamSha, target }, root)
  } catch (error) {
    return writeFailure(root, statePath, state, output, 'AUDIT_FAILED', (error as Error).message, options, deps, target)
  }
  const item = incremental(state.lastObservedUpstreamSha, target, audit)
  const stateBeforeAdvance = structuredClone(state)
  try {
    const report = options.dryRun ? null : await writeReport(root, state, item, output, deps, audit)
    item.report = report ?? undefined
    state.lastObservedUpstreamSha = target
    state.lastSuccessfulCheckAt = timeOf(options)
    state.lastNewChangeAt = timeOf(options)
    state.lastIncrementalResult = item
    state.lastReport = report
    state.failureState = null
    if (!options.dryRun) await persist(statePath, state, deps)
    return result('NEW_CHANGES', statePath, `audited ${item.newCommits} new upstream commit(s)`, state, item, report)
  } catch (error) {
    state = stateBeforeAdvance
    return result('STATE_WRITE_FAILED', statePath, `report/state persistence failed; cursor was not advanced: ${(error as Error).message}`, state, item)
  }
}

/** Run the monitor without changing checkout, product baseline, application, or user state. */
export async function runUpstreamMonitor(
  cwd: string, options: MonitorOptions = {}, deps: MonitorDependencies = {},
): Promise<MonitorResult> {
  let root: string
  try { root = rootOf(cwd) } catch (error) { return result('STATE_INVALID', stateOf(resolve(cwd), options), (error as Error).message) }
  if (options.dryRun) return monitorLocked(root, options, deps)
  const lockPath = join(outputOf(root, options), 'monitor.lock')
  let lock: LockHandle | null
  try { lock = await acquireLock(lockPath, options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, timeOf(options)) } catch (error) { return result('STATE_WRITE_FAILED', stateOf(root, options), (error as Error).message) }
  if (lock === null) return result('LOCKED', stateOf(root, options), `monitor is already running: ${rel(root, lockPath)}`)
  try { return await monitorLocked(root, options, deps) } finally { await releaseLock(lock) }
}

export async function runUpstreamMonitorCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({ args: argv, options: {
    remote: { type: 'string' }, branch: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    'no-fetch': { type: 'boolean', default: false }, 'output-dir': { type: 'string' }, state: { type: 'string' },
    'baseline-tag': { type: 'string' }, 'bootstrap-evidence': { type: 'string' },
    help: { type: 'boolean', default: false },
  }, strict: true })
  if (parsed.values.help) {
    process.stdout.write('Usage: pnpm upstream:monitor [--remote origin] [--branch master] [--dry-run] [--no-fetch] [--output-dir PATH] [--state PATH] [--baseline-tag TAG] [--bootstrap-evidence PATH]\n')
    return 0
  }
  const monitored = await runUpstreamMonitor(process.cwd(), {
    remote: parsed.values.remote, branch: parsed.values.branch, dryRun: parsed.values['dry-run'], noFetch: parsed.values['no-fetch'],
    outputDirectory: parsed.values['output-dir'], statePath: parsed.values.state,
    baselineTag: parsed.values['baseline-tag'], bootstrapEvidencePath: parsed.values['bootstrap-evidence'],
  })
  process.stdout.write(`${JSON.stringify({ outcome: monitored.outcome, exitCode: monitored.exitCode, message: monitored.message, statePath: monitored.statePath, report: monitored.report }, null, 2)}\n`)
  return monitored.exitCode
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void runUpstreamMonitorCli().then((code) => { process.exitCode = code }).catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`)
    process.exitCode = 2
  })
}
