import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runUpstreamMonitor, type MonitorBootstrap } from './upstream-monitor.ts'

const roots: string[] = []

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
  git(root, ['tag', 'product-baseline', initial])
  git(root, ['tag', 'dsh-custom-baseline-2026-09-17', initial])
  const bootstrap: MonitorBootstrap = {
    productBaselineTag: 'product-baseline', productBaselineSha: initial, initialCursorSha: initial,
    debt: {
      anchorProductSha: initial, auditedUpstreamSha: initial, highestRisk: 'CRITICAL', impact: 'BLOCKING_CHANGE',
      recommendedAction: 'MANUAL_ADAPTATION_REQUIRED', resolutionStatus: 'UNRESOLVED', sourceAuditReport: 'fixture/phase-8b1.json',
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

describe('incremental upstream monitor', () => {
  it('initializes from the fixed cursor and reports no change without creating an audit report', async () => {
    const subject = fixture()
    const before = { head: git(subject.root, ['rev-parse', 'HEAD']), index: readFileSync(join(subject.root, '.git/index')).toString('base64') }
    const monitored = await runUpstreamMonitor(subject.root, options(subject))

    expect(monitored).toMatchObject({ outcome: 'NO_NEW_UPSTREAM_CHANGES', exitCode: 0 })
    expect(state(subject)).toMatchObject({ lastObservedUpstreamSha: subject.cursor, existingCompatibilityDebt: { resolutionStatus: 'UNRESOLVED' }, failureState: null })
    expect(existsSync(join(subject.output, 'reports'))).toBe(false)
    expect({ head: git(subject.root, ['rev-parse', 'HEAD']), index: readFileSync(join(subject.root, '.git/index')).toString('base64') }).toEqual(before)
  })

  it('audits only the new range, stores a compact NONE finding, and remains idempotent on the next run', async () => {
    const subject = fixture()
    const next = commit(subject.upstream, 'document guide', { 'docs/guide.md': '# Guide\n' })
    git(subject.upstream, ['push', 'origin', 'master'])

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

  it('audits every commit in one newly observed range rather than restarting from the product baseline', async () => {
    const subject = fixture()
    commit(subject.upstream, 'first new documentation', { 'docs/one.md': '# One\n' })
    const target = commit(subject.upstream, 'second new documentation', { 'docs/two.md': '# Two\n' })
    git(subject.upstream, ['push', 'origin', 'master'])

    const monitored = await runUpstreamMonitor(subject.root, options(subject))
    expect(monitored).toMatchObject({ outcome: 'NEW_CHANGES', incremental: { previousCursor: subject.cursor, targetSha: target, newCommits: 2, changedFiles: 2, highestRisk: 'NONE' } })
    expect(state(subject).lastObservedUpstreamSha).toBe(target)
  })

  it('retains a full report for a CRITICAL seam finding without claiming that existing debt is resolved', async () => {
    const subject = fixture()
    const next = commit(subject.upstream, 'change desktop identity contract', { 'apps/desktop/src/paths.ts': 'export const product = "next"\n' })
    git(subject.upstream, ['push', 'origin', 'master'])
    const monitored = await runUpstreamMonitor(subject.root, options(subject))

    expect(monitored).toMatchObject({ outcome: 'NEW_CHANGES', incremental: { targetSha: next, highestRisk: 'CRITICAL', impact: 'BLOCKING_CHANGE' }, report: { kind: 'full' } })
    expect(existsSync(join(subject.root, monitored.report!.markdownPath))).toBe(true)
    expect(readFileSync(join(subject.root, monitored.report!.markdownPath), 'utf8')).toContain('UNRESOLVED')
    expect(state(subject).existingCompatibilityDebt.resolutionStatus).toBe('UNRESOLVED')
  })

  it('keeps the cursor unchanged on fetch, audit, and state-write failures', async () => {
    const fetchFailure = fixture()
    await runUpstreamMonitor(fetchFailure.root, options(fetchFailure))
    git(fetchFailure.root, ['remote', 'set-url', 'origin', join(fetchFailure.root, 'missing.git')])
    expect((await runUpstreamMonitor(fetchFailure.root, options(fetchFailure))).outcome).toBe('FETCH_FAILED')
    expect(state(fetchFailure).lastObservedUpstreamSha).toBe(fetchFailure.cursor)

    const auditFailure = fixture()
    const auditTarget = commit(auditFailure.upstream, 'new upstream work', { 'mystery/new.ts': 'export {}\n' })
    git(auditFailure.upstream, ['push', 'origin', 'master'])
    const failedAudit = await runUpstreamMonitor(auditFailure.root, options(auditFailure), { audit: () => { throw new Error('fixture audit failure') } })
    expect(failedAudit.outcome).toBe('AUDIT_FAILED')
    expect(state(auditFailure).lastObservedUpstreamSha).toBe(auditFailure.cursor)
    expect(auditTarget).not.toBe(auditFailure.cursor)

    const writeFailure = fixture()
    const writeTarget = commit(writeFailure.upstream, 'new upstream work', { 'mystery/new.ts': 'export {}\n' })
    git(writeFailure.upstream, ['push', 'origin', 'master'])
    const failedWrite = await runUpstreamMonitor(writeFailure.root, options(writeFailure), {
      writeAtomic: async (path, content) => {
        if (path.endsWith('state.json')) throw new Error('fixture state write failure')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
      },
    })
    expect(failedWrite.outcome).toBe('STATE_WRITE_FAILED')
    expect(existsSync(join(writeFailure.output, 'state.json'))).toBe(false)
    expect(writeTarget).not.toBe(writeFailure.cursor)
  })

  it('rejects fresh contention, recovers a stale lock, and preserves the cursor across rewritten history', async () => {
    const locked = fixture()
    mkdirSync(locked.output, { recursive: true })
    writeFileSync(join(locked.output, 'monitor.lock'), JSON.stringify({ token: 'other', startedAt: new Date().toISOString() }))
    expect((await runUpstreamMonitor(locked.root, options(locked))).outcome).toBe('LOCKED')
    utimesSync(join(locked.output, 'monitor.lock'), new Date(0), new Date(0))
    expect((await runUpstreamMonitor(locked.root, options(locked))).outcome).toBe('NO_NEW_UPSTREAM_CHANGES')

    const subject = fixture()
    const ahead = commit(subject.upstream, 'first upstream work', { 'docs/a.md': 'a\n' })
    git(subject.upstream, ['push', 'origin', 'master'])
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

  it('does not overwrite an invalid state and supports a no-fetch, read-only dry run', async () => {
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
})
