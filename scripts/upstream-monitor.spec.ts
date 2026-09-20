import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runUpstreamMonitor, type MonitorBootstrap } from './upstream-monitor.ts'

const roots: string[] = []

const BASELINE_TAG = 'ds-harness-product-baseline-2026-09-17'
const CUSTOM_BASELINE_TAG = 'dsh-custom-baseline-2026-09-17'
const EVIDENCE = '.artifacts/upstream-audit/last-audit.json'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } }).trim()
}

function write(root: string, path: string, content: string): void {
  const destination = join(root, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, content)
}

function commit(root: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) write(root, path, content)
  git(root, ['add', '--all'])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

interface Fixture { root: string; upstream: string; bare: string; cursor: string; bootstrap: MonitorBootstrap; output: string }

function fixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-upstream-monitor-'))
  roots.push(parent)
  const bare = join(parent, 'origin.git')
  const upstream = join(parent, 'upstream')
  const root = join(parent, 'product')
  git(parent, ['init', '--bare', bare])
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/master'])
  git(parent, ['clone', bare, upstream])
  git(upstream, ['checkout', '-b', 'master'])
  for (const repo of [upstream]) {
    git(repo, ['config', 'user.name', 'Monitor Tests'])
    git(repo, ['config', 'user.email', 'monitor@example.com'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
  }
  const initial = commit(upstream, 'initial upstream', { 'README.md': '# Fixture\n' })
  git(upstream, ['push', 'origin', 'master'])
  git(parent, ['clone', bare, root])
  git(root, ['config', 'user.name', 'Product Tests'])
  git(root, ['config', 'user.email', 'product@example.com'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['tag', BASELINE_TAG, initial])
  git(root, ['tag', CUSTOM_BASELINE_TAG, initial])
  // The audited Phase 8B.1 evidence the monitor derives its bootstrap from.
  write(root, EVIDENCE, `${JSON.stringify({
    formatVersion: 1, base: BASELINE_TAG, baseSha: initial, target: 'origin/master', targetSha: initial,
    mergeBaseSha: initial, generatedAt: '2026-09-17T00:00:00.000Z', overallResult: 'BLOCKING_CHANGE',
  }, null, 2)}\n`)
  const bootstrap: MonitorBootstrap = {
    productBaselineTag: BASELINE_TAG, productBaselineSha: initial, initialCursorSha: initial,
    debt: {
      anchorProductSha: initial, auditedUpstreamSha: initial, highestRisk: 'CRITICAL', impact: 'BLOCKING_CHANGE',
      recommendedAction: 'MANUAL_ADAPTATION_REQUIRED', resolutionStatus: 'UNRESOLVED', sourceAuditReport: EVIDENCE,
    },
  }
  return { root, upstream, bare, cursor: initial, bootstrap, output: join(root, '.monitor') }
}

function options(subject: Fixture) {
  return { bootstrap: subject.bootstrap, outputDirectory: subject.output }
}

function state(subject: Fixture) {
  return JSON.parse(readFileSync(join(subject.output, 'state.json'), 'utf8')) as { lastObservedUpstreamSha: string; existingCompatibilityDebt: { resolutionStatus: string }; failureState: unknown }
}

function push(subject: Fixture, message: string, files: Record<string, string>): string {
  const sha = commit(subject.upstream, message, files)
  git(subject.upstream, ['push', 'origin', 'master'])
  return sha
}

describe('incremental upstream monitor', () => {
  it('Q. initializes from the fixed cursor and reports no change without creating an audit report', async () => {
    const subject = fixture()
    const before = { head: git(subject.root, ['rev-parse', 'HEAD']), index: readFileSync(join(subject.root, '.git/index')).toString('base64') }
    const monitored = await runUpstreamMonitor(subject.root, options(subject))

    expect(monitored).toMatchObject({ outcome: 'NO_NEW_UPSTREAM_CHANGES', exitCode: 0 })
    expect(state(subject)).toMatchObject({ lastObservedUpstreamSha: subject.cursor, existingCompatibilityDebt: { resolutionStatus: 'UNRESOLVED' }, failureState: null })
    expect(existsSync(join(subject.output, 'reports'))).toBe(false)
    expect({ head: git(subject.root, ['rev-parse', 'HEAD']), index: readFileSync(join(subject.root, '.git/index')).toString('base64') }).toEqual(before)
  })

  it('Q2. derives the bootstrap from the baseline tag and the audited evidence when no bootstrap is injected', async () => {
    const subject = fixture()

    const monitored = await runUpstreamMonitor(subject.root, { outputDirectory: subject.output })

    expect(monitored).toMatchObject({ outcome: 'NO_NEW_UPSTREAM_CHANGES', exitCode: 0 })
    const stored = JSON.parse(readFileSync(join(subject.output, 'state.json'), 'utf8')) as {
      schemaVersion: number
      productBaselineTag: string
      productBaselineSha: string
      existingCompatibilityDebt: { auditedUpstreamSha: string; resolutionStatus: string; sourceAuditReport: string }
    }
    expect(stored.schemaVersion).toBe(1)
    expect(stored.productBaselineTag).toBe(BASELINE_TAG)
    expect(stored.productBaselineSha).toBe(subject.cursor)
    expect(stored.existingCompatibilityDebt).toMatchObject({
      auditedUpstreamSha: subject.cursor, resolutionStatus: 'UNRESOLVED', sourceAuditReport: EVIDENCE,
    })
  })

  it('Q3. fails closed when the audited bootstrap evidence is missing or inconsistent', async () => {
    const missing = fixture()
    rmSync(join(missing.root, EVIDENCE))
    expect((await runUpstreamMonitor(missing.root, { outputDirectory: missing.output })).outcome).toBe('STATE_INVALID')

    const inconsistent = fixture()
    write(inconsistent.root, EVIDENCE, `${JSON.stringify({
      baseSha: inconsistent.cursor, targetSha: inconsistent.cursor, overallResult: 'UNAFFECTED',
    })}\n`)
    const rejected = await runUpstreamMonitor(inconsistent.root, { outputDirectory: inconsistent.output })
    expect(rejected.outcome).toBe('STATE_INVALID')
    expect(rejected.message).toMatch(/fixed unresolved compatibility debt/u)
    expect(existsSync(join(inconsistent.output, 'state.json'))).toBe(false)
  })

  it('Q4. reads a historical monitor state file written under the established contract', async () => {
    const subject = fixture()
    mkdirSync(subject.output, { recursive: true })
    const legacy = {
      schemaVersion: 1,
      productBaselineTag: BASELINE_TAG,
      productBaselineSha: subject.cursor,
      remote: 'origin',
      branch: 'master',
      lastObservedUpstreamSha: subject.cursor,
      lastSuccessfulCheckAt: '2026-09-17T00:00:00.000Z',
      lastFetchAt: '2026-09-17T00:00:00.000Z',
      lastNewChangeAt: null,
      existingCompatibilityDebt: {
        anchorProductSha: subject.cursor, auditedUpstreamSha: subject.cursor, highestRisk: 'CRITICAL',
        impact: 'BLOCKING_CHANGE', recommendedAction: 'MANUAL_ADAPTATION_REQUIRED', resolutionStatus: 'UNRESOLVED',
        sourceAuditReport: EVIDENCE,
      },
      lastIncrementalResult: null,
      lastReport: null,
      failureState: null,
    }
    writeFileSync(join(subject.output, 'state.json'), `${JSON.stringify(legacy, null, 2)}\n`)

    const monitored = await runUpstreamMonitor(subject.root, options(subject))

    // The historical file is accepted and rewritten in place; no migration runs.
    expect(monitored).toMatchObject({ outcome: 'NO_NEW_UPSTREAM_CHANGES', exitCode: 0 })
    expect(state(subject).lastObservedUpstreamSha).toBe(subject.cursor)
  })

  it('R/S. audits only the new range, stores a compact NONE finding, and remains idempotent on the next run', async () => {
    const subject = fixture()
    const next = push(subject, 'document guide', { 'docs/guide.md': '# Guide\n' })

    const first = await runUpstreamMonitor(subject.root, options(subject))
    expect(first).toMatchObject({ outcome: 'NEW_CHANGES', exitCode: 0, incremental: { previousCursor: subject.cursor, targetSha: next, newCommits: 1, highestRisk: 'NONE' }, report: { kind: 'compact' } })
    expect(first.report).not.toBeNull()
    expect(existsSync(join(subject.root, first.report!.jsonPath))).toBe(true)
    expect(state(subject).lastObservedUpstreamSha).toBe(next)
    expect(state(subject).existingCompatibilityDebt.resolutionStatus).toBe('UNRESOLVED')

    const second = await runUpstreamMonitor(subject.root, options(subject))
    expect(second).toMatchObject({ outcome: 'NO_NEW_UPSTREAM_CHANGES', exitCode: 0 })
    expect(state(subject).lastObservedUpstreamSha).toBe(next)
  })

  it('U. audits every commit in one newly observed range rather than restarting from the product baseline', async () => {
    const subject = fixture()
    commit(subject.upstream, 'first new documentation', { 'docs/one.md': '# One\n' })
    const target = commit(subject.upstream, 'second new documentation', { 'docs/two.md': '# Two\n' })
    git(subject.upstream, ['push', 'origin', 'master'])

    const monitored = await runUpstreamMonitor(subject.root, options(subject))
    expect(monitored).toMatchObject({ outcome: 'NEW_CHANGES', incremental: { previousCursor: subject.cursor, targetSha: target, newCommits: 2, changedFiles: 2, highestRisk: 'NONE' } })
    expect(state(subject).lastObservedUpstreamSha).toBe(target)
  })

  it('T/AD. retains a full report for a CRITICAL seam finding without claiming that existing debt is resolved', async () => {
    const subject = fixture()
    const next = push(subject, 'change desktop identity contract', { 'apps/desktop/src/paths.ts': 'export const product = "next"\n' })
    const monitored = await runUpstreamMonitor(subject.root, options(subject))

    expect(monitored).toMatchObject({ outcome: 'NEW_CHANGES', incremental: { targetSha: next, highestRisk: 'CRITICAL', impact: 'BLOCKING_CHANGE' }, report: { kind: 'full' } })
    expect(existsSync(join(subject.root, monitored.report!.markdownPath))).toBe(true)
    const markdown = readFileSync(join(subject.root, monitored.report!.markdownPath), 'utf8')
    expect(markdown).toContain('UNRESOLVED')
    // A CRITICAL incremental range never rewrites the independent historical debt.
    expect(state(subject).existingCompatibilityDebt.resolutionStatus).toBe('UNRESOLVED')
  })

  it('V/W. keeps the cursor unchanged on fetch, audit, and state-write failures', async () => {
    const fetchFailure = fixture()
    await runUpstreamMonitor(fetchFailure.root, options(fetchFailure))
    git(fetchFailure.root, ['remote', 'set-url', 'origin', join(fetchFailure.root, 'missing.git')])
    expect((await runUpstreamMonitor(fetchFailure.root, options(fetchFailure))).outcome).toBe('FETCH_FAILED')
    expect(state(fetchFailure).lastObservedUpstreamSha).toBe(fetchFailure.cursor)

    const auditFailure = fixture()
    const auditTarget = push(auditFailure, 'new upstream work', { 'mystery/new.ts': 'export {}\n' })
    const failedAudit = await runUpstreamMonitor(auditFailure.root, options(auditFailure), { audit: () => { throw new Error('fixture audit failure') } })
    expect(failedAudit.outcome).toBe('AUDIT_FAILED')
    expect(state(auditFailure).lastObservedUpstreamSha).toBe(auditFailure.cursor)
    expect(auditTarget).not.toBe(auditFailure.cursor)

    const writeFailure = fixture()
    const writeTarget = push(writeFailure, 'new upstream work', { 'mystery/new.ts': 'export {}\n' })
    const failedWrite = await runUpstreamMonitor(writeFailure.root, options(writeFailure), {
      writeAtomic: async (path, content) => {
        if (path.endsWith('state.json')) throw new Error('fixture state write failure')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
      },
    })
    expect(failedWrite.outcome).toBe('STATE_WRITE_FAILED')
    expect(failedWrite.state?.lastObservedUpstreamSha).toBe(writeFailure.cursor)
    expect(existsSync(join(writeFailure.output, 'state.json'))).toBe(false)
    expect(writeTarget).not.toBe(writeFailure.cursor)
  })

  it('Y. preserves the cursor across rewritten upstream history instead of silently reclassifying it', async () => {
    const subject = fixture()
    const ahead = push(subject, 'first upstream work', { 'docs/a.md': 'a\n' })
    await runUpstreamMonitor(subject.root, options(subject))
    git(subject.upstream, ['checkout', '--orphan', 'rewritten'])
    git(subject.upstream, ['rm', '-rf', '.'])
    const rewritten = commit(subject.upstream, 'rewritten root', { 'README.md': '# Rewritten\n' })
    git(subject.upstream, ['push', '--force', 'origin', 'HEAD:master'])
    const divergence = await runUpstreamMonitor(subject.root, options(subject))

    expect(divergence).toMatchObject({ outcome: 'UPSTREAM_HISTORY_DIVERGENCE', exitCode: 2 })
    expect(state(subject).lastObservedUpstreamSha).toBe(ahead)
    expect(rewritten).not.toBe(ahead)
  })

  it('Z. detects a checkout mutation caused by the refresh and never repairs it automatically', async () => {
    const subject = fixture()
    push(subject, 'new upstream work', { 'docs/new.md': '# New\n' })
    const head = git(subject.root, ['rev-parse', 'HEAD'])

    const mutated = await runUpstreamMonitor(subject.root, options(subject), {
      fetch: (root) => { write(root, 'untracked-mutation.txt', 'mutated\n') },
    })

    expect(mutated.outcome).toBe('CHECKOUT_MUTATED')
    expect(state(subject).lastObservedUpstreamSha).toBe(subject.cursor)
    // The monitor reports the mutation instead of resetting, stashing, or cleaning it.
    expect(existsSync(join(subject.root, 'untracked-mutation.txt'))).toBe(true)
    expect(git(subject.root, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('X. does not overwrite an invalid state and supports a no-fetch, read-only dry run', async () => {
    const subject = fixture()
    mkdirSync(subject.output, { recursive: true })
    const statePath = join(subject.output, 'state.json')
    writeFileSync(statePath, '{ invalid json')
    const before = readFileSync(statePath, 'utf8')
    expect((await runUpstreamMonitor(subject.root, options(subject))).outcome).toBe('STATE_INVALID')
    expect(readFileSync(statePath, 'utf8')).toBe(before)

    writeFileSync(statePath, JSON.stringify({ schemaVersion: 99 }))
    expect((await runUpstreamMonitor(subject.root, options(subject))).outcome).toBe('STATE_INVALID')
    expect(readFileSync(statePath, 'utf8')).toBe(JSON.stringify({ schemaVersion: 99 }))

    rmSync(statePath)
    const noFetch = await runUpstreamMonitor(subject.root, { ...options(subject), noFetch: true, dryRun: true })
    expect(noFetch).toMatchObject({ outcome: 'NO_NEW_UPSTREAM_CHANGES', exitCode: 0 })
    expect(existsSync(statePath)).toBe(false)
  })

  it('AA. a dry run neither fetches nor writes state or a report', async () => {
    const subject = fixture()
    const target = push(subject, 'new upstream work', { 'docs/dry.md': '# Dry\n' })
    const refBefore = git(subject.root, ['rev-parse', 'refs/remotes/origin/master'])

    const monitored = await runUpstreamMonitor(subject.root, { ...options(subject), dryRun: true })

    expect(monitored.outcome).toBe('NO_NEW_UPSTREAM_CHANGES')
    expect(git(subject.root, ['rev-parse', 'refs/remotes/origin/master'])).toBe(refBefore)
    expect(refBefore).not.toBe(target)
    expect(existsSync(join(subject.output, 'state.json'))).toBe(false)
    expect(existsSync(join(subject.output, 'monitor.lock'))).toBe(false)
    expect(existsSync(join(subject.output, 'reports'))).toBe(false)
  })

  it('AB. no-fetch classifies the already-provided tracking ref instead of refreshing it', async () => {
    const subject = fixture()
    const target = push(subject, 'new upstream work', { 'docs/no-fetch.md': '# No fetch\n' })

    const stale = await runUpstreamMonitor(subject.root, { ...options(subject), noFetch: true })
    expect(stale.outcome).toBe('NO_NEW_UPSTREAM_CHANGES')

    git(subject.root, ['fetch', 'origin', '--prune'])
    const refreshed = await runUpstreamMonitor(subject.root, { ...options(subject), noFetch: true })
    expect(refreshed).toMatchObject({ outcome: 'NEW_CHANGES', incremental: { targetSha: target } })
  })

  it('AC. honours state and output overrides inside a temporary root', async () => {
    const subject = fixture()
    const overrideRoot = mkdtempSync(join(tmpdir(), 'dsh-upstream-monitor-override-'))
    roots.push(overrideRoot)
    const outputDirectory = join(overrideRoot, 'artifacts')
    const statePath = join(overrideRoot, 'custom-state.json')
    push(subject, 'new upstream work', { 'docs/override.md': '# Override\n' })

    const monitored = await runUpstreamMonitor(subject.root, { bootstrap: subject.bootstrap, outputDirectory, statePath })

    expect(monitored.outcome).toBe('NEW_CHANGES')
    expect(monitored.statePath).toBe(statePath)
    expect(existsSync(statePath)).toBe(true)
    expect(existsSync(join(subject.output, 'state.json'))).toBe(false)
  })

  it('detects fresh contention and recovers a stale lock without fetching', async () => {
    const locked = fixture()
    mkdirSync(locked.output, { recursive: true })
    writeFileSync(join(locked.output, 'monitor.lock'), JSON.stringify({ token: 'other', startedAt: new Date().toISOString() }))
    expect((await runUpstreamMonitor(locked.root, options(locked))).outcome).toBe('LOCKED')
    utimesSync(join(locked.output, 'monitor.lock'), new Date(0), new Date(0))
    expect((await runUpstreamMonitor(locked.root, options(locked))).outcome).toBe('NO_NEW_UPSTREAM_CHANGES')
  })
})
