import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { auditUpstreamRange, runUpstreamAuditCli } from './upstream-audit.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upstream-audit-'))
  fixtureRoots.push(root)
  const hooks = join(root, '.disabled-hooks')
  mkdirSync(hooks)
  git(root, ['init', '--initial-branch=master'])
  git(root, ['config', 'user.name', 'Upstream Audit Tests'])
  git(root, ['config', 'user.email', 'upstream-audit@example.com'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['config', 'core.hooksPath', hooks])
  write(root, 'README.md', '# Fixture\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '-m', 'initial'])
  return root
}

function commit(root: string, message: string, files: Record<string, string>): string {
  for (const [path, contents] of Object.entries(files)) write(root, path, contents)
  git(root, ['add', '--all'])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function audit(root: string, base: string, target = 'HEAD') {
  return auditUpstreamRange({
    base,
    target,
    generatedAt: '2026-09-17T00:00:00.000Z',
  }, root)
}

describe('upstream compatibility auditor', () => {
  it('A. reports no upstream changes without inventing a target delta', () => {
    const root = fixture()
    const head = git(root, ['rev-parse', 'HEAD'])

    const report = audit(root, head)

    expect(report.summary).toMatchObject({
      totalCommits: 0,
      totalChangedFiles: 0,
      affectedSeams: [],
      highestRisk: 'NONE',
      impact: 'UNAFFECTED',
      manualReviewRequired: false,
      recommendedAction: 'NO_ACTION',
      overallResult: 'NO_NEW_UPSTREAM_CHANGES',
    })
  })

  it('B. classifies docs-only changes as NONE with high confidence', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'document behavior', { 'README.md': '# Fixture\n\nDocumented.\n' })

    const report = audit(root, base)

    expect(report.summary).toMatchObject({ highestRisk: 'NONE', confidence: 'HIGH', manualReviewRequired: false })
    expect(report.changes[0]).toMatchObject({ categories: ['Documentation'], seamIds: [], risk: 'NONE' })
  })

  it('C. keeps an unrelated package manifest change LOW instead of treating every dependency as native risk', () => {
    const root = fixture()
    commit(root, 'add unrelated package', { 'packages/tool/unrelated/package.json': '{"name":"unrelated","version":"1.0.0"}\n' })
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'bump unrelated package', { 'packages/tool/unrelated/package.json': '{"name":"unrelated","version":"1.0.1"}\n' })

    const report = audit(root, base)

    expect(report.summary).toMatchObject({ highestRisk: 'LOW', impact: 'RELATED_LOW_RISK', manualReviewRequired: false })
    expect(report.changes[0]).toMatchObject({ seamIds: [], risk: 'LOW', confidence: 'HIGH' })
  })

  it('D. flags a known product identity contract with direct overlap as CRITICAL', () => {
    const root = fixture()
    commit(root, 'establish desktop path', { 'apps/desktop/src/paths.ts': 'export const profile = "desktop"\n' })
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'change desktop path', { 'apps/desktop/src/paths.ts': 'export const profile = "next"\n' })

    const report = audit(root, base)
    const change = report.changes[0]

    expect(change).toMatchObject({
      directModificationOverlap: true,
      contractDependency: true,
      risk: 'CRITICAL',
      confidence: 'HIGH',
    })
    expect(change?.seamIds).toContain('desktop-product-identity-isolation')
    expect(report.summary).toMatchObject({ impact: 'BLOCKING_CHANGE', recommendedAction: 'MANUAL_ADAPTATION_REQUIRED' })
  })

  it('E. retains rename/move identity and requires review when an old or new path hits a seam', () => {
    const root = fixture()
    commit(root, 'add packaging input', { 'apps/desktop/scripts/prepare-dsh.ts': 'export const prepare = true\n' })
    const base = git(root, ['rev-parse', 'HEAD'])
    git(root, ['mv', 'apps/desktop/scripts/prepare-dsh.ts', 'apps/desktop/scripts/prepare-runtime-v2.ts'])
    git(root, ['commit', '-m', 'move packaging input'])

    const report = audit(root, base)
    const change = report.changes[0]

    expect(change?.status).toMatch(/^R/u)
    expect(change).toMatchObject({
      oldPath: 'apps/desktop/scripts/prepare-dsh.ts',
      path: 'apps/desktop/scripts/prepare-runtime-v2.ts',
      risk: 'HIGH',
    })
    expect(change?.seamIds).toContain('desktop-packaging-runtime-tree')
  })

  it('F. raises a dependency version change only when it carries a registered Electron/native signal', () => {
    const root = fixture()
    commit(root, 'establish electron version', { 'package.json': '{"devDependencies":{"electron":"40.0.0"}}\n' })
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'bump electron', { 'package.json': '{"devDependencies":{"electron":"41.0.0"}}\n' })

    const report = audit(root, base)

    expect(report.changes[0]?.seamIds).toContain('native-runtime-abi-closure')
    expect(report.changes[0]).toMatchObject({ risk: 'HIGH', contractDependency: true })
  })

  it('G. treats an unclassified path as REVIEW_REQUIRED with LOW confidence', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'add opaque source', { 'mystery/opaque.asset': 'opaque\n' })

    const report = audit(root, base)

    expect(report.changes[0]).toMatchObject({
      categories: ['Unknown'],
      risk: 'MEDIUM',
      impact: 'REVIEW_REQUIRED',
      confidence: 'LOW',
    })
    expect(report.summary.manualReviewRequired).toBe(true)
  })

  it('H. aggregates multiple medium seam changes into a HIGH cumulative range risk', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'change adjacent contracts', {
      'packages/llm/llm-pi-ai/src/internal.ts': 'export const llmInternal = true\n',
      'packages/client/connection/src/client/internal.ts': 'export const clientInternal = true\n',
    })

    const report = audit(root, base)

    expect(report.changes).toHaveLength(2)
    expect(report.changes.every(change => change.risk === 'MEDIUM')).toBe(true)
    expect(report.summary).toMatchObject({
      highestRisk: 'HIGH',
      impact: 'LIKELY_CONFLICT',
      manualReviewRequired: true,
      recommendedAction: 'TEST_REQUIRED',
    })
  })

  it('I/J/K. rejects missing, ambiguous, and non-commit refs without modifying refs', () => {
    const root = fixture()
    git(root, ['branch', 'collision'])
    git(root, ['tag', 'collision'])
    write(root, 'blob.txt', 'blob\n')
    const blob = git(root, ['hash-object', '-w', 'blob.txt'])
    git(root, ['tag', 'blob-ref', blob])
    const refsBefore = git(root, ['for-each-ref', '--format=%(refname) %(objectname)'])

    expect(() => audit(root, 'missing')).toThrow(/base ref .* does not resolve to a commit/u)
    expect(() => audit(root, 'collision')).toThrow(/base ref .* is ambiguous/u)
    expect(() => audit(root, 'blob-ref')).toThrow(/base ref .* does not resolve to a commit/u)
    expect(() => audit(root, 'HEAD', 'missing')).toThrow(/target ref .* does not resolve to a commit/u)
    expect(git(root, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore)
  })

  it('L. writes Markdown, JSON, and deletable state while leaving Git refs, HEAD, and index unchanged', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'document upstream', { 'docs/upstream.md': '# Upstream\n' })
    const output = join(root, '.artifacts/upstream-audit')
    const before = {
      head: git(root, ['rev-parse', 'HEAD']),
      refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
      index: readFileSync(join(root, '.git/index')).toString('base64'),
    }

    const rendered = runUpstreamAuditCli([
      '--base', base,
      '--target', 'HEAD',
      '--output-dir', output,
    ], root)
    const paths = JSON.parse(rendered) as { markdown: string; json: string; state: string }

    expect(existsSync(join(root, paths.markdown))).toBe(true)
    expect(existsSync(join(root, paths.json))).toBe(true)
    expect(existsSync(join(root, paths.state))).toBe(true)
    expect(readFileSync(join(root, paths.markdown), 'utf8')).toContain('does not assert that an update is safe')
    expect(JSON.parse(readFileSync(join(root, paths.json), 'utf8'))).toMatchObject({
      identity: { base, target: 'HEAD' },
      summary: { overallResult: 'NO_CURRENTLY_DETECTED_COMPATIBILITY_SEAM_IMPACT' },
    })
    expect({
      head: git(root, ['rev-parse', 'HEAD']),
      refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
      index: readFileSync(join(root, '.git/index')).toString('base64'),
    }).toEqual(before)
  })

  it('M. maps a current Stage 6-11 agent-loop contract path onto the agent event seam', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'extend the agent turn lifecycle', { 'packages/core/agent-loop/src/turn-lifecycle.ts': 'export const turn = 1\n' })

    const report = audit(root, base)

    expect(report.changes[0]?.seamIds).toEqual(['agent-run-event-contract'])
    expect(report.changes[0]).toMatchObject({ contractDependency: true, risk: 'HIGH', confidence: 'HIGH' })
  })

  it('N. maps the Stage 11 Runtime diagnostics transport path onto the diagnostics seam', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'change the gateway stream contract', {
      'packages/api/gateway/src/stream.ts': 'export const stream = 2\n',
      'packages/client/connection/src/client/resources/index.ts': 'export const seat = 2\n',
    })

    const report = audit(root, base)
    const byPath = new Map(report.changes.map(change => [change.path, change]))

    expect(report.changes).toHaveLength(2)
    // The Gateway stream face is unambiguously the diagnostics transport.
    expect(byPath.get('packages/api/gateway/src/stream.ts')).toMatchObject({
      seamIds: ['diagnostics-remote-ui-contract'], contractDependency: true, risk: 'HIGH',
    })
    // The Resource Registry seat is shared by the client export/loader seam and
    // the diagnostics seam, so both are recorded rather than one silently winning.
    expect(byPath.get('packages/client/connection/src/client/resources/index.ts')).toMatchObject({
      seamIds: ['client-package-export-loader', 'diagnostics-remote-ui-contract'], contractDependency: true, risk: 'HIGH',
    })
    expect(report.summary.affectedSeams).toEqual(['client-package-export-loader', 'diagnostics-remote-ui-contract'])
  })

  it('O. maps Stage 10 task-aware compaction and token-meter changes onto the compaction seam', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'change the compaction executor surface', {
      'packages/compaction/compaction-basic/src/index.ts': 'export const compact = 2\n',
      'packages/llm/token-meter/src/index.ts': 'export const meter = 2\n',
    })

    const report = audit(root, base)
    const byPath = new Map(report.changes.map(change => [change.path, change]))

    expect(report.changes).toHaveLength(2)
    expect(byPath.get('packages/compaction/compaction-basic/src/index.ts')).toMatchObject({
      seamIds: ['compaction-token-surface-contract'], contractDependency: true, risk: 'HIGH',
    })
    // The token meter now lives under `packages/llm`, so it is attributed to the
    // compaction surface seam and the LLM provider seam together.
    expect(byPath.get('packages/llm/token-meter/src/index.ts')).toMatchObject({
      seamIds: ['compaction-token-surface-contract', 'llm-provider-stream-contract'], contractDependency: true, risk: 'HIGH',
    })
    expect(report.summary.affectedSeams).toEqual(['compaction-token-surface-contract', 'llm-provider-stream-contract'])
  })

  it('P. maps a current desktop-custom composition change onto the composition seam', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'change the base bundle patch schema', { 'packages/bundle/base/cordis.patch.yml': '# Fixture\npatches: []\n' })

    const report = audit(root, base)

    expect(report.changes[0]?.seamIds).toEqual(['package-set-custom-composition'])
    expect(report.changes[0]).toMatchObject({ contractDependency: true, risk: 'HIGH' })
  })

  it('surfaces the registered Custom change surface and the seam registry version', () => {
    const root = fixture()
    const base = git(root, ['rev-parse', 'HEAD'])
    commit(root, 'document upstream again', { 'docs/another.md': '# Another\n' })

    const report = audit(root, base)

    expect(report.seamRegistryVersion).toBe(1)
    expect(report.customChangeSurface.map(domain => domain.domain)).toEqual([
      'desktop-product-identity',
      'desktop-packaging',
      'desktop-custom-composition',
      'stage-6-11-capabilities',
      'profile-runtime-boundary',
      'ui-integration',
      'tests',
      'documentation',
      'workspace-build-graph',
    ])
  })
})
