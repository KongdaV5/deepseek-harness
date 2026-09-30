/** Deterministic official-catalog and isolated Git fixtures for the read-only maintenance contract. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedPaths, matchesAnyPath, mergeBase } from './upstream-audit.ts'
import { assertHistory, assertOfficialRemote, cachedCatalog, checkUpstream, customHead, evidenceStates, inspectTarget, loadPolicy, loadRegistry, OFFICIAL_REPOSITORY, OFFICIAL_URL, officialCatalog, ownerFor, parseCatalog, propagate, renderInspect, renderPlan, resolveTarget, runSafePlan, selectTests, validatedPlan, writeIgnoredArtifact, type Catalog, type Registry } from './upstream-maintenance.ts'
import { runUpstreamCheck } from './upstream-check.ts'
import { runUpstreamInspect } from './upstream-inspect.ts'
import { runUpstreamTest } from './upstream-test.ts'

const allocated = new Set<string>()
afterEach(() => { for (const root of allocated) rmSync(root, { recursive: true, force: true }); allocated.clear() })
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function put(root: string, path: string, contents: string): void { mkdirSync(resolve(root, path, '..'), { recursive: true }); writeFileSync(resolve(root, path), contents) }
function commit(root: string, subject: string): string { git(root, 'add', '.'); git(root, 'commit', '--no-gpg-sign', '-m', subject); return customHead(root) }
const tag = 'dsh-v0.2.0-rc.2'; const baselineTag = 'dsh-v0.1.6-alpha.2'
const spec = 'scripts/upstream-maintenance.spec.ts'
function registryFixture(): Registry {
  return {
    ownershipRevision: 1, contractRevision: 1, defaultOwner: 'UPSTREAM', invariants: { NO_REPLAY: 'Do not replay side effects.' }, seams: [{ tests: [spec] }],
    ownershipRules: [
      { id: 'codex', patterns: ['packages/core/agent-codex/**'], owner: 'CUSTOM', reason: 'Canonical projection', dependsOn: ['settings-api', 'session-history'], affectedTests: [spec], impactFloor: 3, invariants: ['NO_REPLAY'], technicalTags: [] },
      { id: 'ui', patterns: ['packages/client/ui-model-selection/**'], owner: 'MIXED', reason: 'Custom selector leaf', dependsOn: [], affectedTests: [spec], impactFloor: 2, invariants: [], technicalTags: [] },
      { id: 'technical', patterns: ['scripts/**', '.gitignore', 'pnpm-lock.yaml'], owner: 'MIXED', reason: 'Tool declarations', dependsOn: [], affectedTests: [], impactFloor: 1, invariants: [], technicalTags: ['GENERATED', 'LOCKFILE'] },
    ],
    contracts: [
      { id: 'session-format', patterns: ['packages/core/session/src/types.ts'], impactFloor: 3, dependsOn: [], affectedTests: [spec], symbols: [{ path: 'packages/core/session/src/types.ts', name: 'SESSION_FORMAT_VERSION' }] },
      { id: 'session-history', patterns: ['packages/core/session/src/history.ts'], impactFloor: 3, dependsOn: ['session-format'], affectedTests: [spec], symbols: [] },
      { id: 'settings-api', patterns: ['packages/settings/settings/src/**'], impactFloor: 3, dependsOn: [], affectedTests: [spec], symbols: [] },
      { id: 'codex-auth', patterns: ['packages/core/agent-codex/src/auth.ts'], impactFloor: 4, dependsOn: ['settings-api'], affectedTests: [spec], symbols: [] },
    ],
    evidence: [
      { id: 'codex-settings', dependsOn: ['settings-api'], invalidatedBy: [], invariants: [] },
      { id: 'codex-q1-auth', dependsOn: ['codex-auth'], invalidatedBy: ['codex-auth'], invariants: [] },
      { id: 'codex-q1-thread', dependsOn: ['session-history'], invalidatedBy: ['session-format'], invariants: ['NO_REPLAY'] },
      { id: 'codex-runtime-maintenance', dependsOn: [], invalidatedBy: [], invariants: [] },
    ],
  }
}
function fixture(): { root: string; base: string; catalog: Catalog; registry: Registry } {
  const root = mkdtempSync(resolve(tmpdir(), 'dsh-maintenance-fixture-')); allocated.add(root)
  git(root, 'init', '-b', 'custom'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'commit.gpgSign', 'false'); git(root, 'config', 'core.hooksPath', resolve(root, 'empty-hooks')); git(root, 'remote', 'add', 'origin', OFFICIAL_URL)
  put(root, '.gitignore', '.artifacts/\n')
  put(root, 'packages/core/session/src/types.ts', 'export const SESSION_FORMAT_VERSION = 3\n')
  put(root, 'packages/core/session/src/history.ts', 'export const history = 1\n')
  put(root, 'packages/settings/settings/src/index.ts', 'export const settings = 1\n')
  put(root, 'packages/client/ui-model-selection/src/index.ts', 'export const selector = 1\n')
  put(root, 'packages/leaf/no-consumer/src/index.ts', 'export const leaf = 1\n')
  put(root, 'docs/guide.md', '# Fixture\n')
  put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  const base = commit(root, 'official baseline'); git(root, 'tag', baselineTag)
  put(root, 'packages/core/agent-codex/src/index.ts', 'export const consumer = 1\n')
  put(root, spec, 'export {}\n')
  for (const name of ['upstream-maintenance', 'upstream-audit', 'upstream-check', 'upstream-inspect', 'upstream-test']) put(root, `scripts/${name}.ts`, 'export {}\n')
  const registry = registryFixture(); put(root, 'scripts/upstream-tracking-seams.json', JSON.stringify(registry))
  put(root, 'scripts/upstream-maintenance.json', JSON.stringify({ schemaVersion: 1, ownershipRevision: 1, contractRevision: 1, trackedChannels: ['published-rc', 'published-stable'], lastSynced: { tag: baselineTag, sha: base }, policy: { officialRepository: OFFICIAL_REPOSITORY, officialRemote: 'origin' } }))
  commit(root, 'Custom consumer tail')
  const catalog: Catalog = { repository: OFFICIAL_REPOSITORY, sourceVerification: 'LIVE_OFFICIAL', fetchedAt: '2026-09-30T00:00:00Z', masterSha: base, tags: { [baselineTag]: base, [tag]: base }, releases: [{ tag, sha: base, prerelease: true, publishedAt: '2026-09-29T00:00:00Z' }] }
  return { root, base, catalog, registry }
}
function target(f: ReturnType<typeof fixture>, changes: Record<string, string>): void {
  git(f.root, 'checkout', '-b', 'official-next', f.base)
  for (const [path, contents] of Object.entries(changes)) put(f.root, path, contents)
  const sha = commit(f.root, 'official target'); git(f.root, 'tag', tag)
  git(f.root, 'checkout', 'custom'); f.catalog.tags[tag] = sha; f.catalog.masterSha = sha; f.catalog.releases[0]!.sha = sha
}
function alterRegistry(root: string, edit: (registry: Registry) => void): void { const registry = loadRegistry(root); edit(registry); put(root, 'scripts/upstream-tracking-seams.json', JSON.stringify(registry)) }
function snapshot(root: string): string {
  const files = git(root, 'ls-files', '-z').split('\0').filter(Boolean)
  return JSON.stringify({ status: git(root, 'status', '--porcelain=v1', '-z'), head: customHead(root), branch: git(root, 'symbolic-ref', 'HEAD'), index: git(root, 'ls-files', '--stage'), files: files.map(path => [path, readFileSync(resolve(root, path), 'utf8')]), data: readFileSync(resolve(root, '.artifacts/user-data/conversation.json'), 'utf8') })
}

describe('official release identity', () => {
  it('separates RC, stable, draft and unpublished tags; peels annotated tags', () => {
    const first = 'a'.repeat(40); const second = 'b'.repeat(40)
    const catalog = parseCatalog(`${first}\trefs/heads/master\n${first}\trefs/tags/${tag}\n${second}\trefs/tags/${tag}^{}\n${first}\trefs/tags/dsh-v0.2.0\n${first}\trefs/tags/dsh-v0.2.0-rc.3`, [
      { tag_name: tag, prerelease: true, draft: false, published_at: '2026-09-29' },
      { tag_name: 'dsh-v0.2.0', prerelease: false, draft: false, published_at: '2026-09-30' },
      { tag_name: 'dsh-v0.2.0-rc.3', prerelease: true, draft: true, published_at: null },
    ])
    expect(catalog.tags[tag]).toBe(second)
    expect(catalog.releases.map(release => release.tag)).toEqual(['dsh-v0.2.0', tag])
    expect(resolveTarget(catalog, tag).release?.prerelease).toBe(true)
  })
  it('reads only canonical network endpoints and detects persisted tag movement', () => {
    const f = fixture(); const calls: string[][] = []
    const transport = (command: string, args: string[]): string => {
      calls.push([command, ...args])
      return command === 'git' ? `${f.base} refs/heads/master\n${f.base} refs/tags/${baselineTag}\n${f.base} refs/tags/${tag}`
        : JSON.stringify([[{ tag_name: tag, prerelease: true, draft: false, published_at: '2026-09-29' }]])
    }
    const catalog = officialCatalog(f.root, loadPolicy(f.root, loadRegistry(f.root)), transport)
    expect(calls[0]).toContain(OFFICIAL_URL); expect(calls[0]?.[1]).toBe('ls-remote')
    expect(calls[1]).toContain(`repos/${OFFICIAL_REPOSITORY}/releases?per_page=100`)
    writeIgnoredArtifact(f.root, '.artifacts/upstream-maintenance/catalog.json', catalog)
    catalog.tags[tag] = 'd'.repeat(40)
    catalog.releases[0]!.sha = catalog.tags[tag]!
    writeIgnoredArtifact(f.root, '.artifacts/upstream-maintenance/catalog.json', catalog)
    expect(() => officialCatalog(f.root, loadPolicy(f.root, loadRegistry(f.root)), transport)).toThrow(/TAG_MOVED_OR_REMOVED/u)
    expect(() => officialCatalog(f.root, loadPolicy(f.root, loadRegistry(f.root)), () => { throw new Error('OFFLINE') })).toThrow(/OFFLINE/u)
  })
  it('reports null stable and missing objects without a fake merge base/count', () => {
    const f = fixture(); f.catalog.tags[tag] = 'e'.repeat(40); f.catalog.releases[0]!.sha = 'e'.repeat(40)
    const check = checkUpstream(f.root, f.catalog)
    expect(check.latestPublishedStable).toBeNull(); expect(check.objects).toBe('OBJECTS_MISSING'); expect(check.mergeBase).toBeNull(); expect(check.summary).toBeNull()
    expect(() => inspectTarget(f.root, f.catalog, tag)).toThrow(/OBJECTS_MISSING/u)
  })
  it('checks stable-only and already integrated releases', () => {
    const f = fixture(); f.catalog.releases = [{ tag: baselineTag, sha: f.base, prerelease: false, publishedAt: '2026-09-29' }]
    const check = checkUpstream(f.root, f.catalog)
    expect(check.latestPublishedRC).toBeNull(); expect(check.newerInspectionTargetAvailable).toBe(false)
    expect(inspectTarget(f.root, f.catalog, baselineTag).ancestry.upstreamOnlyCommits).toBe(0)
  })
  it('rejects moved, unknown, raw SHA, fork, mirror and wrong integration pins', () => {
    const f = fixture()
    expect(() => resolveTarget(f.catalog, tag, { targetTag: tag, targetSha: 'f'.repeat(40) })).toThrow(/TAG_MOVED/u)
    expect(() => resolveTarget(f.catalog, 'dsh-v99.0.0')).toThrow(/UNKNOWN/u)
    expect(() => resolveTarget(f.catalog, f.base)).toThrow(/UNTRUSTED/u)
    expect(() => resolveTarget({ ...f.catalog, repository: 'fork/repo' } as unknown as Catalog, tag)).toThrow(/UNTRUSTED/u)
    git(f.root, 'remote', 'set-url', 'origin', 'https://github.com/fork/deepseek-harness.git')
    expect(() => assertOfficialRemote(f.root, 'origin')).toThrow(/UNTRUSTED_REMOTE/u)
    git(f.root, 'remote', 'set-url', 'origin', 'https://mirror.example/deepseek-ai/deepseek-harness.git')
    expect(() => inspectTarget(f.root, f.catalog, tag)).toThrow(/UNTRUSTED_REMOTE/u)
    git(f.root, 'remote', 'set-url', 'origin', OFFICIAL_URL); f.catalog.tags[baselineTag] = 'a'.repeat(40)
    expect(() => inspectTarget(f.root, f.catalog, tag)).toThrow(/LAST_SYNCED_TAG/u)
  })
})

describe('U0–U4 and dependency causality', () => {
  it.each([
    ['U0', 'docs/guide.md', '# Changed documentation\n'],
    ['U1', 'packages/leaf/no-consumer/src/index.ts', 'export const leaf = 2\n'],
    ['U2', 'packages/client/ui-model-selection/src/index.ts', 'export const selector = 2\n'],
    ['U3', 'packages/core/session/src/history.ts', 'export const history = 2\n'],
    ['U4', 'packages/core/session/src/types.ts', 'export const SESSION_FORMAT_VERSION = 4\n'],
  ])('%s follows semantics rather than version/count', (level, path, contents) => {
    const f = fixture(); target(f, { [path]: contents }); const report = inspectTarget(f.root, f.catalog, tag)
    expect(report.impact).toBe(level)
    expect(report.ancestry.customOnlyCommits).toBe(1)
    expect(report.ancestry.upstreamOnlyCommits).toBe(1)
    if (level === 'U0') expect(report.evidence.every(evidence => evidence.state === 'UNCHANGED')).toBe(true)
    if (level === 'U4') expect(report.findings.map(finding => finding.code)).toContain('SESSION_FORMAT_V4')
  })
  it('propagates settings without Codex path overlap, while auth/runtime proof boundaries remain separate', () => {
    const f = fixture(); target(f, { 'packages/settings/settings/src/index.ts': 'export const settings = 2\n' })
    const report = inspectTarget(f.root, f.catalog, tag)
    expect(report.statistics.directOverlap).toBe(0); expect(report.consumers.map(consumer => consumer.id)).toContain('codex')
    expect(report.evidence.find(evidence => evidence.id === 'codex-settings')?.state).toBe('AFFECTED')
    expect(report.evidence.find(evidence => evidence.id === 'codex-q1-auth')?.state).toBe('AFFECTED')
    expect(report.evidence.find(evidence => evidence.id === 'codex-runtime-maintenance')?.state).toBe('UNCHANGED')
    expect(report.affectedTests[0]?.contracts).toContain('settings-api')
    expect(report.impact).toBe('U3')
  })
  it('invalidates auth evidence only when its security contract directly changes', () => {
    const registry = registryFixture(); const direct = new Set(['codex-auth'])
    expect(evidenceStates(registry, propagate(registry, direct), direct).find(evidence => evidence.id === 'codex-q1-auth')?.state).toBe('INVALIDATED')
    const ui = new Set<string>()
    expect(evidenceStates(registry, propagate(registry, ui), ui).find(evidence => evidence.id === 'codex-q1-auth')?.state).toBe('UNCHANGED')
  })
  it('recognizes changed storage schema independently of the release number', () => {
    const f = fixture()
    put(f.root, 'packages/storage/test/src/schema.ts', 'export const STORAGE_SCHEMA_VERSION = 1\n')
    const base = commit(f.root, 'Storage schema foundation')
    f.base = base
    f.catalog.tags[baselineTag] = base
    put(f.root, 'scripts/upstream-maintenance.json', JSON.stringify({ schemaVersion: 1, ownershipRevision: 1, contractRevision: 1, trackedChannels: ['published-rc'], lastSynced: { tag: baselineTag, sha: base }, policy: { officialRepository: OFFICIAL_REPOSITORY, officialRemote: 'origin' } }))
    commit(f.root, 'Integration pin')
    target(f, { 'packages/storage/test/src/schema.ts': 'export const STORAGE_SCHEMA_VERSION = 2\n' })
    const report = inspectTarget(f.root, f.catalog, tag)
    expect(report.impact).toBe('U4'); expect(report.findings.map(finding => finding.code)).toContain('PERSISTENCE_SCHEMA_CHANGED')
  })
  it('detects literal storage-domain version changes using declarations', () => {
    const f = fixture()
    put(f.root, 'packages/storage/test/src/domain.ts', 'export const domain = defineDomain({ version: 1 })\n')
    const base = commit(f.root, 'Domain foundation'); f.base = base; f.catalog.tags[baselineTag] = base
    const policy = loadPolicy(f.root, loadRegistry(f.root)); policy.lastSynced.sha = base
    put(f.root, 'scripts/upstream-maintenance.json', JSON.stringify(policy)); commit(f.root, 'Integration pin')
    target(f, { 'packages/storage/test/src/domain.ts': 'export const domain = defineDomain({ version: 2 })\n' })
    expect(inspectTarget(f.root, f.catalog, tag).findings.map(finding => finding.code)).toContain('STORAGE_DOMAIN_VERSION_CHANGED')
  })
  it('reports extension conversion risk from tagged migration source and Custom projection source', () => {
    const f = fixture()
    put(f.root, 'packages/core/agent-codex/src/projection.ts', "if (event.type === 'codex/subscription-state') {}\n"); commit(f.root, 'Custom projection')
    target(f, { 'packages/core/session/src/types.ts': 'export const SESSION_FORMAT_VERSION = 4\n', 'packages/session/session-format-v3-to-v4/src/extension-identities.ts': 'const migration = event.ignorable ? `plugin:${event.type}` : event.type\n' })
    expect(inspectTarget(f.root, f.catalog, tag).findings.map(finding => finding.code)).toContain('CUSTOM_EXTENSION_EVENT_MIGRATION_RISK')
  })
})

describe('registry validation and ownership', () => {
  it('defaults official files to UPSTREAM and explicitly classifies Custom/Mixed/technical', () => {
    const f = fixture(); const registry = loadRegistry(f.root)
    expect(ownerFor('packages/leaf/no-consumer/src/index.ts', registry).owner).toBe('UPSTREAM')
    expect(ownerFor('packages/core/agent-codex/src/index.ts', registry).owner).toBe('CUSTOM')
    expect(ownerFor('packages/client/ui-model-selection/src/index.ts', registry).owner).toBe('MIXED')
    expect(ownerFor('pnpm-lock.yaml', registry).technicalTags).toContain('LOCKFILE')
  })
  it('does not mistake a comment for an existing contract declaration', () => {
    const f = fixture()
    put(f.root, 'packages/core/session/src/types.ts', '// SESSION_FORMAT_VERSION has been removed\nexport {}\n')
    expect(() => loadRegistry(f.root)).toThrow(/STALE_SYMBOL/u)
  })
  it('refuses missing tests, stale ownership, stale symbols and cyclic dependencies', () => {
    const f = fixture(); const original = readFileSync(resolve(f.root, 'scripts/upstream-tracking-seams.json'), 'utf8')
    const cases: [(registry: Registry) => void, RegExp][] = [
      [(registry) => { registry.ownershipRules[0]!.affectedTests = ['scripts/missing.spec.ts'] }, /MISSING_TEST/u],
      [(registry) => { registry.ownershipRules[0]!.patterns.push('packages/retired/**') }, /STALE_RULE/u],
      [(registry) => { registry.contracts[0]!.symbols[0]!.name = 'RETIRED_SYMBOL' }, /STALE_SYMBOL/u],
      [(registry) => { registry.contracts[0]!.dependsOn = ['session-history'] }, /CYCLE/u],
    ]
    for (const [edit, error] of cases) { alterRegistry(f.root, edit); expect(() => loadRegistry(f.root)).toThrow(error); put(f.root, 'scripts/upstream-tracking-seams.json', original) }
  })
  it('reports unknown Custom semantics instead of silently treating them as safe', () => {
    const f = fixture(); put(f.root, 'packages/custom/new/src/index.ts', 'export const unregistered = true\n'); commit(f.root, 'Unknown Custom seam')
    target(f, { 'docs/guide.md': '# Updated\n' })
    const report = inspectTarget(f.root, f.catalog, tag)
    expect(report.reviewRequired).toContain('packages/custom/new/src/index.ts'); expect(report.recommendedAction).toBe('REVIEW_REQUIRED')
  })
  it('anchors core contract providers to actual boot/vendor and runtime source', () => {
    const root = resolve(import.meta.dirname, '..'); const registry = loadRegistry(root)
    const providers = [
      ['plugin-composition', 'vendor/cordis/src/context.ts'],
      ['profile-config', 'vendor/loader/src/config/tree.ts'],
      ['agent-recovery', 'packages/core/agent-loop/src/agent.ts'],
      ['runtime-process-lifecycle', 'packages/api/settings-controller/src/local-model-runtime.ts'],
      ['model-admission', 'packages/api/session-controller/src/catalog.ts'],
      ['codex-auth', 'packages/core/agent-codex/src/runtime.ts'],
    ]
    for (const [id, path] of providers) {
      expect(path && existsSync(resolve(root, path))).toBe(true)
      expect(path && matchesAnyPath(path, registry.contracts.find(contract => contract.id === id)?.patterns ?? [])).toBe(true)
    }
    expect(ownerFor('vendor/cordis/src/context.ts', registry).technicalTags).toContain('VENDOR')
  })
  it('validates real registry tests, contracts, symbols and ancestry policy', () => {
    const root = resolve(import.meta.dirname, '..'); const registry = loadRegistry(root)
    expect(registry.contracts.length).toBeGreaterThanOrEqual(16)
    expect(loadPolicy(root, registry).lastSynced.tag).toBe(baselineTag)
  })
})

describe('ancestry and rename policy', () => {
  it('counts a rename once and refuses to treat copies as renames', () => {
    const f = fixture(); git(f.root, 'checkout', '-b', 'renames', f.base)
    put(f.root, 'packages/leaf/no-consumer/src/copy.ts', readFileSync(resolve(f.root, 'packages/leaf/no-consumer/src/index.ts'), 'utf8'))
    git(f.root, 'mv', 'docs/guide.md', 'docs/renamed.md'); const head = commit(f.root, 'Rename and copy')
    const changes = changedPaths(f.root, f.base, head)
    expect(changes).toHaveLength(2); expect(changes.filter(change => change.status.startsWith('R'))).toHaveLength(1)
    expect(changes.find(change => change.path.endsWith('copy.ts'))?.status).toBe('A')
  })
  it('rejects shallow, replace and operation states', () => {
    const f = fixture()
    put(f.root, '.git/shallow', f.base+'\n'); expect(() => assertHistory(f.root)).toThrow(/SHALLOW/u); rmSync(resolve(f.root, '.git/shallow'))
    git(f.root, 'replace', customHead(f.root), f.base); expect(() => assertHistory(f.root)).toThrow(/REPLACE/u); git(f.root, 'replace', '-d', customHead(f.root))
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'info/grafts']) { put(f.root, `.git/${marker}`, f.base); expect(() => assertHistory(f.root)).toThrow(/IN_PROGRESS_OR_GRAFTED/u); rmSync(resolve(f.root, `.git/${marker}`)) }
    for (const marker of ['rebase-merge', 'rebase-apply', 'sequencer']) { mkdirSync(resolve(f.root, `.git/${marker}`)); expect(() => assertHistory(f.root)).toThrow(/IN_PROGRESS_OR_GRAFTED/u); rmSync(resolve(f.root, `.git/${marker}`), { recursive: true }) }
  })
  it('refuses unrelated histories and multiple merge bases', () => {
    const f = fixture(); const tree = git(f.root, 'rev-parse', `${f.base}^{tree}`)
    const a = git(f.root, 'commit-tree', tree, '-p', f.base, '-m', 'A'); const b = git(f.root, 'commit-tree', tree, '-p', f.base, '-m', 'B')
    const ab = git(f.root, 'commit-tree', tree, '-p', a, '-p', b, '-m', 'AB'); const ba = git(f.root, 'commit-tree', tree, '-p', b, '-p', a, '-m', 'BA')
    expect(() => mergeBase(f.root, ab, ba)).toThrow(/unique merge base/u)
    const orphan = git(f.root, 'commit-tree', tree, '-m', 'Orphan')
    expect(() => mergeBase(f.root, f.base, orphan)).toThrow(/merge base/u)
  })
  it('recognizes linear upstream ahead and integrated targets', () => {
    const f = fixture(); target(f, { 'docs/guide.md': '# Changed\n' })
    const retained = ['scripts/upstream-tracking-seams.json','scripts/upstream-maintenance.json',spec,'scripts/upstream-maintenance.ts','scripts/upstream-audit.ts','scripts/upstream-check.ts','scripts/upstream-inspect.ts','scripts/upstream-test.ts','packages/core/agent-codex/src/index.ts'].map(path => [path, readFileSync(resolve(f.root,path),'utf8')] as const)
    git(f.root, 'checkout', '--detach', f.base)
    for (const [path, contents] of retained) put(f.root,path,contents)
    expect(inspectTarget(f.root, f.catalog, tag).ancestry.relation).toBe('UPSTREAM_AHEAD')
    git(f.root, 'checkout', '--detach', f.catalog.tags[tag]!)
    expect(inspectTarget(f.root, f.catalog, tag).ancestry.relation).toBe('ALREADY_INTEGRATED')
  })
})

describe('staleness, planning and mutation boundaries', () => {
  it('refuses changed HEAD, ownership revision, contract revision, unchanged-revision edits, tool edits and moved tags', () => {
    const f = fixture(); target(f, { 'docs/guide.md': '# Update\n' }); const report = inspectTarget(f.root, f.catalog, tag)
    const original = readFileSync(resolve(f.root, 'scripts/upstream-tracking-seams.json'), 'utf8')
    for (const field of ['ownershipRevision', 'contractRevision'] as const) {
      alterRegistry(f.root, (registry) => { registry[field]++ }); expect(() => validatedPlan(f.root, report, f.catalog)).toThrow(/STALE_REGISTRY/u); put(f.root, 'scripts/upstream-tracking-seams.json', original)
    }
    alterRegistry(f.root, (registry) => { registry.ownershipRules[0]!.reason += 'changed' }); expect(() => validatedPlan(f.root, report, f.catalog)).toThrow(/STALE_REGISTRY/u); put(f.root, 'scripts/upstream-tracking-seams.json', original)
    put(f.root, 'scripts/upstream-check.ts', 'export const changed = 1\n'); expect(() => validatedPlan(f.root, report, f.catalog)).toThrow(/STALE_REGISTRY_OR_TOOL/u); put(f.root, 'scripts/upstream-check.ts', 'export {}\n')
    const catalog = structuredClone(f.catalog); catalog.tags[tag] = f.base
    expect(() => validatedPlan(f.root, report, catalog)).toThrow(/TAG_MOVED/u)
    put(f.root, 'docs/another.md', '# Change\n'); commit(f.root, 'HEAD changed')
    expect(() => validatedPlan(f.root, report, f.catalog)).toThrow(/STALE_HEAD/u)
  })
  it('recomputes plans and ignores report-injected executable commands', () => {
    const f = fixture(); target(f, { 'packages/settings/settings/src/index.ts': 'export const settings = 2\n' }); const report = inspectTarget(f.root, f.catalog, tag)
    report.affectedTests = [{ path: '../../shell.spec.ts', contracts: ['fake'], consumers: [], execution: 'SAFE_UNIT' }]
    const plan = validatedPlan(f.root, report, f.catalog)
    expect(plan.affectedTests.map(test => test.path)).toEqual([spec]); expect(renderPlan(plan, false)).toContain('DRY RUN')
    expect(selectTests(f.registry, propagate(f.registry, new Set(['settings-api'])), ['codex'])[0]?.contracts).toContain('settings-api')
  })
  it('refuses refresh during integration and distinguishes missing offline metadata', () => {
    const f = fixture()
    expect(() => runUpstreamCheck(f.root, ['--offline'])).toThrow(/OFFLINE_CACHE_MISSING/u)
    put(f.root, '.git/MERGE_HEAD', f.base)
    expect(() => runUpstreamCheck(f.root, ['--refresh'])).toThrow(/IN_PROGRESS/u)
    expect(() => runUpstreamInspect(f.root, ['--tag', tag, '--refresh'])).toThrow(/IN_PROGRESS/u)
    expect(existsSync(resolve(f.root, '.artifacts/upstream-maintenance/catalog.json'))).toBe(false)
  })
  it('dispatches only allowlisted units and keeps qualification checks explicit', () => {
    const f = fixture(); target(f, { 'packages/settings/settings/src/index.ts': 'export const settings = 2\n' })
    const report = inspectTarget(f.root, f.catalog, tag); const executed: string[][] = []
    runSafePlan(f.root, report, (tests) => { executed.push(tests); return 0 })
    expect(executed).toEqual([[spec]])
    expect(() => runSafePlan(f.root, { ...report, official: { ...report.official, sourceVerification: 'CACHED_UNVERIFIED' } }, () => 0)).toThrow(/LIVE_OFFICIAL_SOURCE/u)
    expect(() => runSafePlan(f.root, { ...report, affectedTests: [{ path: 'apps/desktop/package.ts', contracts: [], consumers: [], execution: 'SAFE_UNIT' }] }, () => 0)).toThrow(/NO_SAFE_TESTS/u)
  })
  it('never advances committed lastSynced when inspection and watch observations advance', () => {
    const f = fixture(); target(f, { 'docs/guide.md': '# Updated\n' })
    const policy = readFileSync(resolve(f.root, 'scripts/upstream-maintenance.json'), 'utf8')
    const report = inspectTarget(f.root, f.catalog, tag)
    writeIgnoredArtifact(f.root, '.artifacts/upstream-maintenance/last-inspected.json', report.identity)
    writeIgnoredArtifact(f.root, '.artifacts/upstream-maintenance/watch-cursor.json', { tag, sha: report.identity.targetSha })
    expect(checkUpstream(f.root, f.catalog).lastSynced).toEqual({ tag: baselineTag, sha: f.base })
    expect(readFileSync(resolve(f.root, 'scripts/upstream-maintenance.json'), 'utf8')).toBe(policy)
  })
  it('proves offline check/inspect/planner preserve source, index, branch, policy and user data', () => {
    const f = fixture(); target(f, { 'packages/core/session/src/types.ts': 'export const SESSION_FORMAT_VERSION = 4\n' })
    put(f.root, '.artifacts/user-data/conversation.json', '{"preserve":true}')
    writeIgnoredArtifact(f.root, '.artifacts/upstream-maintenance/catalog.json', f.catalog)
    const before = snapshot(f.root); const catalog = cachedCatalog(f.root)
    const check = checkUpstream(f.root, catalog); const report = inspectTarget(f.root, catalog, tag)
    expect(check.sourceVerification).toBe('CACHED_UNVERIFIED'); expect(renderInspect(report)).toContain('U4')
    writeIgnoredArtifact(f.root, '.artifacts/report.json', report)
    runUpstreamCheck(f.root, ['--offline']); runUpstreamInspect(f.root, ['--tag', tag, '--offline']); runUpstreamTest(f.root, ['--report', '.artifacts/report.json', '--offline'])
    expect(snapshot(f.root)).toBe(before)
    expect(readFileSync(resolve(f.root, '.artifacts/report.json'), 'utf8')).not.toContain(f.root)
    expect(existsSync(resolve(f.root, '.artifacts/upstream-maintenance/last-inspected.json'))).toBe(false)
    expect(() => runUpstreamTest(f.root, ['--report', '.artifacts/report.json', '--run', '--offline'])).toThrow(/LIVE_OFFICIAL_SOURCE/u)
  })
  it('refuses output outside ignored artifacts, tracked paths, and symlink escape', () => {
    const f = fixture()
    expect(() => writeIgnoredArtifact(f.root, 'docs/output.json', {})).toThrow(/OUTPUT/u)
    expect(() => writeIgnoredArtifact(f.root, '../outside.json', {})).toThrow(/OUTPUT/u)
    mkdirSync(resolve(f.root, '.artifacts')); git(f.root, 'add', '-f', '.gitignore')
    const outside = mkdtempSync(resolve(tmpdir(), 'dsh-maintenance-outside-')); allocated.add(outside)
    execFileSync(process.execPath, ['-e', 'require("node:fs").symlinkSync(process.argv[1],process.argv[2],"dir")', outside, resolve(f.root, '.artifacts/link')])
    expect(() => writeIgnoredArtifact(f.root, '.artifacts/link/escape.json', {})).toThrow(/SYMLINK/u)
    put(f.root, '.artifacts/tracked.json', '{}'); git(f.root, 'add', '-f', '.artifacts/tracked.json')
    expect(() => writeIgnoredArtifact(f.root, '.artifacts/tracked.json', {})).toThrow(/TRACKED/u)
    expect(existsSync(resolve(outside, 'escape.json'))).toBe(false)
  })
})
