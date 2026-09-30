/** Shared release identity, semantic analysis and read-only policy for the upstream commands. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { changedPaths, matchesAnyPath, mergeBase, requireGit } from './upstream-audit.ts'

export const OFFICIAL_REPOSITORY = 'deepseek-ai/deepseek-harness'
export const OFFICIAL_URL = `https://github.com/${OFFICIAL_REPOSITORY}.git`
export const TOOL_VERSION = '1.0.0'
const REGISTRY_PATH = 'scripts/upstream-tracking-seams.json'
const POLICY_PATH = 'scripts/upstream-maintenance.json'
const SHA = /^[a-f0-9]{40}$/u
const TAG = /^dsh-v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u
const TOOL_FILES = ['upstream-maintenance.ts', 'upstream-audit.ts', 'upstream-check.ts', 'upstream-inspect.ts', 'upstream-test.ts']
export type Owner = 'UPSTREAM' | 'CUSTOM' | 'MIXED'
export type EvidenceState = 'UNCHANGED' | 'AFFECTED' | 'INVALIDATED'
interface Area {
  id: string
  patterns: string[]
  dependsOn: string[]
  affectedTests: string[]
  impactFloor: number
}
export interface Contract extends Area { symbols: { path: string; name: string }[] }
export interface OwnershipRule extends Area {
  owner: Owner
  reason: string
  invariants: string[]
  technicalTags: string[]
}
export interface Registry {
  ownershipRevision: number
  contractRevision: number
  defaultOwner: 'UPSTREAM'
  ownershipRules: OwnershipRule[]
  contracts: Contract[]
  invariants: Record<string, string>
  evidence: { id: string; dependsOn: string[]; invalidatedBy: string[]; invariants: string[] }[]
  seams: { tests: string[] }[]
}
export interface Policy {
  schemaVersion: number
  ownershipRevision: number
  contractRevision: number
  trackedChannels: string[]
  lastSynced: { tag: string; sha: string }
  policy: {
    officialRepository: string
    officialRemote: string
    sync: string
    master: string
    featureActivation: string
    statistics: string
  }
}
export interface Release { tag: string; sha: string; prerelease: boolean; publishedAt: string }
export interface Catalog {
  repository: typeof OFFICIAL_REPOSITORY
  sourceVerification: 'LIVE_OFFICIAL' | 'CACHED_UNVERIFIED'
  fetchedAt: string
  masterSha: string
  tags: Record<string, string>
  releases: Release[]
}
export interface Selection { path: string; contracts: string[]; consumers: string[]; execution: 'SAFE_UNIT' | 'QUALIFICATION_REQUIRED' }
export interface Report {
  schemaVersion: 1
  toolVersion: string
  timestamp: string
  identity: {
    customHead: string
    targetTag: string
    targetSha: string
    mergeBase: string
    ownershipRevision: number
    contractRevision: number
    inputsDigest: string
  }
  official: { repository: string; sourceVerification: Catalog['sourceVerification']; release: Release | null; lastSynced: Policy['lastSynced'] }
  ancestry: {
    customOnlyCommits: number
    upstreamOnlyCommits: number
    relation: string
    ranges: { custom: string; sinceLastSynced: string; upstream: string }
    sinceLastSyncedFiles: number
  }
  statistics: {
    policy: string
    filesChanged: number
    packagesChanged: number
    customFilesChanged: number
    directOverlap: number
    sourceOverlap: number
    renames: number
    ownership: Record<Owner, number>
  }
  changes: {
    path: string
    oldPath?: string
    status: string
    owner: Owner
    technicalTags: string[]
    contracts: string[]
    impact: string
    directOverlap: boolean
  }[]
  contracts: { id: string; direct: boolean; triggeredBy: string[]; impact: string }[]
  consumers: { id: string; triggeredBy: string[]; invariants: string[] }[]
  evidence: { id: string; state: EvidenceState; triggeredBy: string[] }[]
  findings: { code: string; evidence: string[] }[]
  reviewRequired: string[]
  impact: string
  surfaces: { persistence: string; session: string; codex: string; local: string; desktop: string }
  features: { automation: Feature; computerUse: Feature }
  affectedTests: Selection[]
  qualificationGaps: string[]
  staticValidation: { kind: 'TYPECHECK' | 'LINT'; paths: string[]; reason: string; execution: 'QUALIFICATION_REQUIRED' }[]
  recommendedAction: string
}
interface Feature { present: boolean; activation: 'EXPLICIT_PRODUCT_DECISION'; changedPaths: string[]; providers: string[] }

function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0) }
function relativePath(path: string): boolean { return path !== '' && !path.startsWith('-') && !path.includes('\\') && !path.includes('\0') && !path.split('/').includes('..') && !path.startsWith('/') }
function jsonFile(root: string, path: string): unknown {
  try { return JSON.parse(readFileSync(resolve(root, path), 'utf8')) }
  catch { throw new Error(`MAINTENANCE_INPUT_MISSING_OR_INVALID: ${path}`) }
}
function git(root: string, args: string[]): string { return requireGit(root, args, 'upstream maintenance Git operation failed').trim() }
function probe(root: string, args: string[]): boolean {
  return spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }, stdio: 'ignore' }).status === 0
}
/** Resolve HEAD without consulting worktree contents. */
export function customHead(root: string): string { return git(root, ['rev-parse', 'HEAD']) }
/** Refuse incomplete or rewritten history and all active integration operations. */
export function assertHistory(root: string): void {
  demand(git(root, ['rev-parse', '--is-shallow-repository']) === 'false', 'SHALLOW_HISTORY: obtain complete official history explicitly')
  demand(git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace']) === '', 'REPLACE_HISTORY: git replace invalidates ancestry')
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'info/grafts']) {
    const path = git(root, ['rev-parse', '--git-path', name])
    demand(!existsSync(resolve(root, path)), `IN_PROGRESS_OR_GRAFTED_HISTORY: ${name}`)
  }
  demand(!git(root, ['ls-files', '--unmerged']), 'UNMERGED_INDEX: resolve conflicts before inspecting')
}
/** Accept only the official repository identity; a similarly named fork is insufficient. */
export function assertOfficialRemote(root: string, remote: string): void {
  demand(/^[a-zA-Z0-9_-]+$/u.test(remote), 'Invalid official remote name')
  const urls = git(root, ['remote', 'get-url', '--all', remote]).split('\n')
  demand(urls.length === 1 && [OFFICIAL_URL, OFFICIAL_URL.slice(0, -4), `git@github.com:${OFFICIAL_REPOSITORY}.git`, `ssh://git@github.com/${OFFICIAL_REPOSITORY}.git`].includes(urls[0] ?? ''), 'UNTRUSTED_REMOTE: only deepseek-ai/deepseek-harness is official')
}
function declaredSymbol(source: string, name: string): boolean {
  const file = ts.createSourceFile('contract.ts', source, ts.ScriptTarget.Latest, true)
  let declared = false
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && node.name.text === name) declared = true
    ts.forEachChild(node, visit)
  }
  visit(file)
  return declared
}
/** Validate the single canonical registry, its references and locally available evidence. */
export function loadRegistry(root: string): Registry {
  const value = jsonFile(root, REGISTRY_PATH)
  demand(object(value) && value.defaultOwner === 'UPSTREAM' && Number.isInteger(value.ownershipRevision) && Number.isInteger(value.contractRevision), 'REGISTRY_INVALID: ownership declaration/revisions')
  demand(Array.isArray(value.ownershipRules) && Array.isArray(value.contracts) && Array.isArray(value.evidence) && Array.isArray(value.seams) && object(value.invariants), 'REGISTRY_INVALID: arrays/invariants')
  const registry = value as unknown as Registry
  const ids = new Set(registry.contracts.map(area => area.id))
  demand(ids.size === registry.contracts.length, 'REGISTRY_INVALID: duplicate contract')
  demand(new Set(registry.ownershipRules.map(rule => rule.id)).size === registry.ownershipRules.length, 'REGISTRY_INVALID: duplicate ownership rule')
  const tracked = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const area of [...registry.contracts, ...registry.ownershipRules]) {
    demand(typeof area.id === 'string' && /^[a-z][a-z0-9-]*$/u.test(area.id) && strings(area.patterns) && stringsOrEmpty(area.dependsOn) && stringsOrEmpty(area.affectedTests), 'REGISTRY_INVALID: area shape')
    demand(Number.isInteger(area.impactFloor) && area.impactFloor >= 0 && area.impactFloor <= 4, `REGISTRY_INVALID: impact ${area.id}`)
    for (const pattern of area.patterns) demand(relativePath(pattern), `REGISTRY_INVALID: path ${area.id}`)
    for (const dep of area.dependsOn) demand(ids.has(dep), `REGISTRY_INVALID: missing contract ${dep}`)
    for (const test of area.affectedTests) assertTest(root, test)
    // Contract patterns may describe an incoming package; ownership rules claim current source.
    if ('owner' in area) {
      demand(['CUSTOM', 'MIXED'].includes(area.owner) && typeof area.reason === 'string' && area.reason.length > 0 && stringsOrEmpty(area.invariants) && stringsOrEmpty(area.technicalTags), `REGISTRY_INVALID: ownership ${area.id}`)
      for (const pattern of area.patterns) demand(tracked.some(path => matchesAnyPath(path, [pattern])), `REGISTRY_STALE_RULE: ${area.id}: ${pattern}`)
      for (const invariant of area.invariants) demand(invariant in registry.invariants, `REGISTRY_INVALID: invariant ${invariant}`)
      demand(area.technicalTags.every(tag => ['GENERATED', 'VENDOR', 'LOCKFILE', 'DERIVED'].includes(tag)), `REGISTRY_INVALID: technical tag ${area.id}`)
    } else {
      demand(Array.isArray(area.symbols), `REGISTRY_INVALID: symbols ${area.id}`)
      for (const symbol of area.symbols) {
        demand(object(symbol) && typeof symbol.path === 'string' && relativePath(symbol.path) && typeof symbol.name === 'string' && /^[a-zA-Z_$][\w$]*$/u.test(symbol.name), 'REGISTRY_INVALID: symbol shape')
        demand(existsSync(resolve(root, symbol.path)) && declaredSymbol(readFileSync(resolve(root, symbol.path), 'utf8'), symbol.name), `REGISTRY_STALE_SYMBOL: ${area.id}: ${symbol.name}`)
      }
    }
  }
  for (const evidence of registry.evidence) {
    demand(typeof evidence.id === 'string' && stringsOrEmpty(evidence.dependsOn) && stringsOrEmpty(evidence.invalidatedBy) && stringsOrEmpty(evidence.invariants), 'REGISTRY_INVALID: evidence')
    for (const id of [...evidence.dependsOn, ...evidence.invalidatedBy]) demand(ids.has(id), `REGISTRY_INVALID: evidence contract ${id}`)
    for (const invariant of evidence.invariants) demand(invariant in registry.invariants, `REGISTRY_INVALID: evidence invariant ${invariant}`)
  }
  for (const seam of registry.seams) for (const test of seam.tests) {
    demand(relativePath(test) && existsSync(resolve(root, test)), `REGISTRY_MISSING_TEST: ${test}`)
  }
  // Dependencies are directed consumer -> provider; cycles conceal causal evidence.
  const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (id: string): void => {
    demand(!visiting.has(id), `REGISTRY_DEPENDENCY_CYCLE: ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dep of registry.contracts.find(contract => contract.id === id)?.dependsOn ?? []) visit(dep)
    visiting.delete(id); visited.add(id)
  }
  for (const id of ids) visit(id)
  return registry
}
function stringsOrEmpty(value: unknown): value is string[] { return Array.isArray(value) && (value.length === 0 || strings(value)) }
function assertTest(root: string, test: string): void {
  demand(relativePath(test) && /\.spec\.ts$/u.test(test) && lstatSync(resolve(root, test), { throwIfNoEntry: false })?.isFile(), `REGISTRY_MISSING_TEST: ${test}`)
}
/** Read committed integration policy; inspection never updates this file. */
export function loadPolicy(root: string, registry: Registry): Policy {
  const value = jsonFile(root, POLICY_PATH)
  demand(object(value) && value.schemaVersion === 1 && value.ownershipRevision === registry.ownershipRevision && value.contractRevision === registry.contractRevision && object(value.lastSynced) && typeof value.lastSynced.tag === 'string' && TAG.test(value.lastSynced.tag) && typeof value.lastSynced.sha === 'string' && SHA.test(value.lastSynced.sha) && object(value.policy) && value.policy.officialRepository === OFFICIAL_REPOSITORY && typeof value.policy.officialRemote === 'string' && strings(value.trackedChannels), 'POLICY_INVALID: identity/revisions/channels')
  demand(Object.keys(value).every(key => ['schemaVersion', 'ownershipRevision', 'contractRevision', 'trackedChannels', 'lastSynced', 'policy'].includes(key)), 'POLICY_INVALID: mutable observation state must be ignored')
  return value as unknown as Policy
}
/** Bind reports to working tool/registry bytes as well as their declared revisions. */
export function inputsDigest(root: string): string {
  return createHash('sha256').update([REGISTRY_PATH, POLICY_PATH, ...TOOL_FILES.map(file => `scripts/${file}`)].map(path => `${path}\0${readFileSync(resolve(root, path), 'utf8')}`).join('\0')).digest('hex')
}
function network(command: string, args: string[], root: string): string {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } })
  demand(result.status === 0, `OFFICIAL_METADATA_UNAVAILABLE: ${command}; retry online or use --offline with an explicit cached catalog`)
  return result.stdout
}
/** Parse live official refs with peeled annotated tags and published releases. */
export function parseCatalog(refs: string, releases: unknown, fetchedAt = new Date().toISOString()): Catalog {
  const tags: Record<string, string> = {}; let masterSha = ''
  for (const line of refs.trim().split('\n')) {
    const [sha, ref] = line.split(/\s+/u)
    if (!sha || !SHA.test(sha) || !ref) continue
    if (ref === 'refs/heads/master') masterSha = sha
    if (ref.startsWith('refs/tags/')) {
      const tag = ref.slice(10).replace(/\^\{\}$/u, '')
      if (TAG.test(tag) && (ref.endsWith('^{}') || !tags[tag])) tags[tag] = sha
    }
  }
  demand(SHA.test(masterSha), 'OFFICIAL_METADATA_INVALID: master SHA missing')
  demand(Array.isArray(releases), 'OFFICIAL_METADATA_INVALID: release response')
  const published: Release[] = []
  for (const release of releases.flat()) {
    demand(object(release), 'OFFICIAL_METADATA_INVALID: release object')
    if (release.draft === true || typeof release.published_at !== 'string' || typeof release.tag_name !== 'string' || !TAG.test(release.tag_name)) continue
    const sha = tags[release.tag_name]
    demand(sha && typeof release.prerelease === 'boolean', 'OFFICIAL_METADATA_INVALID: published tag absent/status missing')
    published.push({ tag: release.tag_name, sha, prerelease: release.prerelease, publishedAt: release.published_at })
  }
  published.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.tag.localeCompare(a.tag))
  return { repository: OFFICIAL_REPOSITORY, sourceVerification: 'LIVE_OFFICIAL', fetchedAt, masterSha, tags, releases: published }
}
/** Query canonical network endpoints without fetching or modifying refs. */
export function officialCatalog(root: string, policy: Policy, transport = network): Catalog {
  assertOfficialRemote(root, policy.policy.officialRemote)
  const catalog = parseCatalog(transport('git', ['ls-remote', OFFICIAL_URL, 'refs/heads/master', 'refs/tags/dsh-v*'], root), JSON.parse(transport('gh', ['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/${OFFICIAL_REPOSITORY}/releases?per_page=100`], root)))
  const cachedPath = resolve(root, '.artifacts/upstream-maintenance/catalog.json')
  if (existsSync(cachedPath)) {
    const previous = cachedCatalog(root)
    for (const [tag, sha] of Object.entries(previous.tags)) demand(catalog.tags[tag] === sha, `TAG_MOVED_OR_REMOVED: ${tag}`)
  }
  return catalog
}
/** Cached metadata is useful offline but cannot establish current official tag immutability. */
export function cachedCatalog(root: string): Catalog {
  demand(existsSync(resolve(root, '.artifacts/upstream-maintenance/catalog.json')), 'OFFLINE_CACHE_MISSING: cache official metadata explicitly with upstream:check --refresh')
  const value = jsonFile(root, '.artifacts/upstream-maintenance/catalog.json')
  demand(object(value) && value.repository === OFFICIAL_REPOSITORY && object(value.tags) && Array.isArray(value.releases) && typeof value.masterSha === 'string' && SHA.test(value.masterSha), 'OFFLINE_CACHE_INVALID')
  demand(Object.entries(value.tags).every(([tag, sha]) => TAG.test(tag) && typeof sha === 'string' && SHA.test(sha)), 'OFFLINE_CACHE_INVALID: tags')
  for (const release of value.releases) {
    demand(object(release) && typeof release.tag === 'string' && TAG.test(release.tag)
      && typeof release.sha === 'string' && value.tags[release.tag] === release.sha
      && typeof release.prerelease === 'boolean' && typeof release.publishedAt === 'string'
      && Number.isFinite(Date.parse(release.publishedAt)), 'OFFLINE_CACHE_INVALID: release identity')
  }
  return { ...(value as unknown as Catalog), sourceVerification: 'CACHED_UNVERIFIED' }
}
/** Resolve only a named official tag or the explicit development branch. */
export function resolveTarget(
  catalog: Catalog, tag: string, previous?: { targetTag: string; targetSha: string },
): { sha: string; release: Release | null } {
  demand(catalog.repository === OFFICIAL_REPOSITORY, 'UNTRUSTED_TARGET: fork/mirror sourceVerification')
  demand(tag === 'master' || TAG.test(tag), 'UNTRUSTED_TARGET: use an official release tag, not an arbitrary SHA')
  const sha = tag === 'master' ? catalog.masterSha : catalog.tags[tag]
  demand(sha && SHA.test(sha), `UNKNOWN_OFFICIAL_TARGET: ${tag}`)
  demand(!previous || previous.targetTag !== tag || previous.targetSha === sha, `TAG_MOVED: ${tag}; inspection cannot authorize a changed target`)
  return { sha, release: catalog.releases.find(release => release.tag === tag) ?? null }
}
/** Missing objects are distinct from zero divergence. */
export function objectsAvailable(root: string, ...shas: string[]): boolean { return shas.every(sha => SHA.test(sha) && probe(root, ['cat-file', '-e', `${sha}^{commit}`])) }
/** Explicit refresh updates official object storage only, without moving tags or writing FETCH_HEAD. */
export function refreshObjects(root: string, catalog: Catalog, sha: string): void {
  assertHistory(root)
  demand(catalog.sourceVerification === 'LIVE_OFFICIAL' && (catalog.masterSha === sha || Object.values(catalog.tags).includes(sha)), 'REFRESH_REQUIRES_LIVE_OFFICIAL_TARGET')
  network('git', ['-c', 'fetch.writeCommitGraph=false', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', OFFICIAL_URL, sha], root)
}
function blob(root: string, sha: string, path: string): string {
  if (!probe(root, ['cat-file', '-e', `${sha}:${path}`])) return ''
  return git(root, ['show', `${sha}:${path}`])
}
function pathsAt(root: string, sha: string): string[] { return git(root, ['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean) }
function paths(change: { path: string; oldPath?: string }): string[] {
  return change.oldPath ? [change.path, change.oldPath] : [change.path]
}
function packageNames(changes: { path: string; oldPath?: string }[]): string[] {
  const names = changes.flatMap(paths).map(path => /^(packages\/[^/]+\/[^/]+)\//u.exec(path)?.[1])
  return [...new Set(names.filter((name): name is string => name !== undefined))]
}
function nonfunctional(path: string): boolean {
  return /(?:^docs\/|^\.agents\/|\.md$|\.i18n\.yaml$|\/(?:locale|locales)\/|\.(?:css|scss)$)/u.test(path)
}
/** Later declarations override broad ownership with documentation/test/technical semantics. */
export function ownerFor(path: string, registry: Registry): { owner: Owner; rule?: OwnershipRule; technicalTags: string[] } {
  const rules = registry.ownershipRules.filter(rule => matchesAnyPath(path, rule.patterns))
  const rule = rules.at(-1)
  return rule ? { owner: rule.owner, rule, technicalTags: [...new Set(rules.flatMap(item => item.technicalTags))] } : { owner: 'UPSTREAM', technicalTags: path.startsWith('vendor/') ? ['VENDOR'] : [] }
}
/** Propagate provider changes through contracts, while preserving the originating causes. */
export function propagate(registry: Registry, direct: Set<string>): Map<string, Set<string>> {
  const causes = new Map([...direct].map(id => [id, new Set([id])]))
  let changed = true
  while (changed) {
    changed = false
    for (const contract of registry.contracts) {
      const incoming = contract.dependsOn.flatMap(id => [...(causes.get(id) ?? [])])
      if (!incoming.length) continue
      const old = causes.get(contract.id) ?? new Set<string>(); const size = old.size
      for (const id of incoming) old.add(id)
      causes.set(contract.id, old)
      if (old.size !== size) changed = true
    }
  }
  return causes
}
/** Evidence invalidation uses directly changed proof boundaries, not every propagated consumer. */
export function evidenceStates(registry: Registry, causes: Map<string, Set<string>>, direct: Set<string>): Report['evidence'] {
  return registry.evidence.map((evidence) => {
    const triggeredBy = [...new Set([...evidence.dependsOn, ...evidence.invalidatedBy].flatMap(id => [...(causes.get(id) ?? [])]))].sort()
    const invalid = evidence.invalidatedBy.some(id => direct.has(id))
    return { id: evidence.id, state: invalid ? 'INVALIDATED' : triggeredBy.length ? 'AFFECTED' : 'UNCHANGED', triggeredBy }
  })
}
// Only reviewed, keyless mock/unit specs are executable. Everything else stays a qualification requirement.
const SAFE_UNITS = new Set([
  'scripts/upstream-maintenance.spec.ts', 'scripts/upstream-audit.spec.ts', 'scripts/upstream-monitor.spec.ts', 'scripts/upstream-tracking-seams.spec.ts',
  'packages/core/agent-codex/tests/runtime.spec.ts', 'packages/core/agent-codex/tests/home.spec.ts', 'packages/core/agent-codex/tests/plugin.spec.ts', 'packages/core/agent-codex/tests/app-server.spec.ts',
  'packages/core/agent-loop/tests/external-turn.spec.ts', 'packages/core/agent-loop/tests/runtime-context.spec.ts',
  'packages/core/agent-default-model/tests/agent-default-model.spec.ts', 'packages/client/ui-model-selection/tests/catalog.client.spec.ts',
  'packages/runtime-diagnostics/reasoning-policy/tests/policy.spec.ts', 'packages/runtime-diagnostics/agent-run-policy/tests/policy.spec.ts',
])
function staticValidation(root: string, registry: Registry, causes: Map<string, Set<string>>): Report['staticValidation'] {
  const consumerIds = registry.ownershipRules.filter(rule => rule.dependsOn.some(id => causes.has(id))).map(rule => rule.id)
  const specs = selectTests(registry, causes, consumerIds)
  const scopes = [...new Set(specs.map(spec => spec.path.split('/tests/')[0]).filter((path): path is string => path !== undefined && path.startsWith('packages/')))]
  const configs = scopes.flatMap(path => ['tsconfig.host.json', 'tsconfig.client.json'].map(name => `${path}/${name}`))
    .filter(path => existsSync(resolve(root, path)))
  const sources = scopes.map(path => `${path}/src`)
  const checks: Report['staticValidation'] = []
  if (configs.length) checks.push({ kind: 'TYPECHECK', paths: configs, reason: 'Affected contract/consumer package declarations; requires prepared dependency declarations.', execution: 'QUALIFICATION_REQUIRED' })
  if (sources.length) checks.push({ kind: 'LINT', paths: sources, reason: 'Affected contract/consumer source only.', execution: 'QUALIFICATION_REQUIRED' })
  return checks
}
/** Select exact specs and explain contract/consumer causality without trusting report commands. */
export function selectTests(registry: Registry, causes: Map<string, Set<string>>, consumerIds: string[]): Selection[] {
  const selected = new Map<string, Selection>()
  const add = (area: Area, consumer: boolean): void => {
    const reasons = consumer ? area.dependsOn.filter(id => causes.has(id)) : [...(causes.get(area.id) ?? [])]
    for (const path of area.affectedTests) {
      const selection = selected.get(path) ?? { path, contracts: [], consumers: [], execution: SAFE_UNITS.has(path) ? 'SAFE_UNIT' : 'QUALIFICATION_REQUIRED' }
      selection.contracts = [...new Set([...selection.contracts, ...reasons])].sort()
      if (consumer) selection.consumers = [...new Set([...selection.consumers, area.id])].sort()
      selected.set(path, selection)
    }
  }
  for (const contract of registry.contracts) if (causes.has(contract.id)) add(contract, false)
  for (const rule of registry.ownershipRules) if (consumerIds.includes(rule.id)) add(rule, true)
  return [...selected.values()].sort((a, b) => a.path.localeCompare(b.path))
}
function domainVersions(source: string): Map<string, number> {
  const versions = new Map<string, number>()
  const file = ts.createSourceFile('domain.ts', source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && /(?:defineDomain|domainTable)$/u.test(node.initializer.expression.getText(file))) {
      const spec = node.initializer.arguments[0]
      if (spec && ts.isObjectLiteralExpression(spec)) {
        for (const member of spec.properties) if (ts.isPropertyAssignment(member) && member.name.getText(file) === 'version'
          && ts.isNumericLiteral(member.initializer)) versions.set(node.name.text, Number(member.initializer.text))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return versions
}
/** Inspect immutable object ranges and derive semantic impact; no integration or migration occurs. */
export function inspectTarget(root: string, catalog: Catalog, targetTag: string, previous?: Report['identity']): Report {
  assertHistory(root)
  const registry = loadRegistry(root); const policy = loadPolicy(root, registry)
  assertOfficialRemote(root, policy.policy.officialRemote)
  const target = resolveTarget(catalog, targetTag, previous)
  demand(catalog.tags[policy.lastSynced.tag] === policy.lastSynced.sha, 'LAST_SYNCED_TAG_MOVED_OR_MISSING: official integration pin requires review')
  const head = customHead(root)
  demand(objectsAvailable(root, head, target.sha, policy.lastSynced.sha), 'OBJECTS_MISSING: run upstream:check --refresh explicitly; divergence is unknown')
  demand(probe(root, ['merge-base', '--is-ancestor', policy.lastSynced.sha, head]), 'LAST_SYNCED_NOT_INTEGRATED: policy does not describe Custom ancestry')
  const base = mergeBase(root, head, target.sha)
  demand(probe(root, ['merge-base', '--is-ancestor', policy.lastSynced.sha, target.sha]), 'TARGET_OUTSIDE_SYNC_LINEAGE: inspect an official descendant of the integration pin')
  const upstream = changedPaths(root, base, target.sha)
  const custom = changedPaths(root, base, head)
  const sinceSynced = changedPaths(root, policy.lastSynced.sha, target.sha)
  const customPaths = new Set(custom.flatMap(paths))
  const reviewRequired = custom.flatMap(paths).filter(path => !ownerFor(path, registry).rule).sort()
  const direct = new Set<string>()
  let rank = 0
  const ownership: Record<Owner, number> = { UPSTREAM: 0, CUSTOM: 0, MIXED: 0 }
  const changes: Report['changes'] = upstream.map((change) => {
    const sides = paths(change); const classified = sides.map(path => ownerFor(path, registry))
    const chosen = classified.find(item => item.owner === 'CUSTOM') ?? classified.find(item => item.owner === 'MIXED') ?? classified[0]
    demand(chosen, 'Missing change classification')
    let functional = sides.some(path => !nonfunctional(path))
    if (change.status === 'M' && change.path.endsWith('/package.json')) {
      try {
        const before = JSON.parse(blob(root, base, change.path)) as Record<string, unknown>
        const after = JSON.parse(blob(root, target.sha, change.path)) as Record<string, unknown>
        delete before.version; delete after.version
        if (JSON.stringify(before) === JSON.stringify(after)) functional = false
      } catch { /* Malformed/removed manifests need functional review. */ }
    }
    const contracts = functional ? registry.contracts.filter(contract => sides.some(path => matchesAnyPath(path, contract.patterns))) : []
    for (const contract of contracts) direct.add(contract.id)
    const level = functional ? Math.max(chosen.owner === 'UPSTREAM' ? 1 : chosen.rule?.impactFloor ?? 2, ...contracts.map(contract => contract.impactFloor)) : 0
    rank = Math.max(rank, level); ownership[chosen.owner]++
    return { ...change, owner: chosen.owner, technicalTags: [...new Set(classified.flatMap(item => item.technicalTags))], contracts: contracts.map(contract => contract.id), impact: `U${level}`, directOverlap: sides.some(path => customPaths.has(path)) }
  })
  const targetPaths = pathsAt(root, target.sha); const basePaths = pathsAt(root, base)
  const findings: Report['findings'] = []
  const add = (code: string, evidence: string[]): void => { findings.push({ code, evidence }) }
  const formatPath = 'packages/core/session/src/types.ts'
  const format = (sha: string): number | null => {
    const match = /SESSION_FORMAT_VERSION\s*=\s*(\d+)/u.exec(blob(root, sha, formatPath))
    return match ? Number(match[1]) : null
  }
  const baseVersion = format(base); const targetVersion = format(target.sha)
  let persistence = false; let settingsReplaced = false
  if (baseVersion !== null && targetVersion !== null && baseVersion !== targetVersion) {
    rank = 4; persistence = true; direct.add('session-format')
    add(`SESSION_FORMAT_V${targetVersion}`, [`${formatPath}: ${baseVersion} -> ${targetVersion}`])
  }
  const migrations = targetPaths.filter(path =>
    /\/src\/.+(?:migration|migrate)|session-format-.*\/src\/migration/u.test(path) && !basePaths.includes(path))
  if (migrations.some(path => /session|settings|profile|config/u.test(path))) {
    persistence = true; rank = 4
    add('PERSISTENCE_MIGRATION_ADDED', migrations)
  }
  for (const change of upstream.filter(change => /(?:storage|schedule|settings|config|profile).+\/src\/.+\.ts$/u.test(change.path))) {
    const old = blob(root, base, change.oldPath ?? change.path); const next = blob(root, target.sha, change.path)
    const beforeDomains = domainVersions(old)
    for (const [name, version] of domainVersions(next)) if (beforeDomains.has(name) && beforeDomains.get(name) !== version) {
      rank = 4; persistence = true; add('STORAGE_DOMAIN_VERSION_CHANGED', [`${change.path}: ${name} ${beforeDomains.get(name)} -> ${version}`])
    }
    const versions = /\b([A-Z_]*(?:SCHEMA|DOMAIN|FORMAT)_VERSION)\s*=\s*(\d+)/gu
    const previousVersions = new Map([...old.matchAll(versions)].map(match => [match[1], match[2]]))
    for (const match of next.matchAll(versions)) if (previousVersions.has(match[1]) && previousVersions.get(match[1]) !== match[2]) {
      rank = 4; persistence = true; add('PERSISTENCE_SCHEMA_CHANGED', [`${change.path}: ${match[1]} ${previousVersions.get(match[1])} -> ${match[2]}`])
    }
  }
  const settingsPath = 'packages/settings/settings/src/index.ts'
  const settingsSource = blob(root, target.sha, settingsPath)
  settingsReplaced = basePaths.some(path => path.startsWith('packages/settings/settings-file/src/')) && !targetPaths.some(path => path.startsWith('packages/settings/settings-file/src/')) && targetPaths.some(path => path.startsWith('packages/boot/config-editor/src/'))
  if (settingsReplaced) {
    rank = 4; persistence = true; direct.add('settings-api'); direct.add('profile-config')
    add('SETTINGS_ARCHITECTURE_REPLACED', ['packages/settings/settings-file/src/: removed', 'packages/boot/config-editor/src/: profile patch editor added', `${settingsPath}: volatile Config=${/volatile/iu.test(settingsSource)}; legacy import=${/importLegacyDocument/u.test(settingsSource)}; rename before import=${/await rename/u.test(settingsSource)}`])
  }
  const migrationPath = 'packages/session/session-format-v3-to-v4/src/extension-identities.ts'
  const migrationSource = blob(root, target.sha, migrationPath)
  const persistedEvents = [
    ['codex/subscription-state', 'packages/core/agent-codex/src/projection.ts'],
    ['task/checkpoint', 'packages/session/task-checkpoint/src/projection.ts'],
    ['task/result-manifest', 'packages/session/task-checkpoint/src/projection.ts'],
  ].filter(([event, path]) => event !== undefined && path !== undefined && blob(root, head, path).includes(event))
  if (persistedEvents.length && /plugin:\$\{event\.type\}/u.test(migrationSource) && /ignorable/u.test(migrationSource)) {
    rank = 4; persistence = true; direct.add('session-format')
    add('CUSTOM_EXTENSION_EVENT_MIGRATION_RISK', [migrationPath, ...persistedEvents.map(([event, path]) => `${path}: exact ${event} projection would not match plugin:${event}`)])
  }
  const causes = propagate(registry, direct)
  const consumers = registry.ownershipRules.filter(rule => rule.dependsOn.some(id => causes.has(id))).map(rule => ({
    id: rule.id, triggeredBy: rule.dependsOn.filter(id => causes.has(id)), invariants: rule.invariants,
  }))
  if (consumers.length) {
    const floors = consumers.map(consumer => registry.ownershipRules.find(rule => rule.id === consumer.id)?.impactFloor ?? 2)
    rank = Math.max(rank, ...floors)
  }
  if (reviewRequired.length) rank = Math.max(rank, 3)
  if (consumers.some(rule => rule.id === 'codex')) add('CODEX_INTEGRATION_AFFECTED', consumers.find(rule => rule.id === 'codex')?.triggeredBy ?? [])
  if (consumers.some(rule => rule.id === 'local-settings')) add('LOCAL_SETTINGS_AFFECTED', consumers.find(rule => rule.id === 'local-settings')?.triggeredBy ?? [])
  if (direct.has('desktop-host-lifecycle')) add('DESKTOP_LIFECYCLE_AFFECTED', upstream.filter(change => matchesAnyPath(change.path, registry.contracts.find(contract => contract.id === 'desktop-host-lifecycle')?.patterns ?? [])).map(change => change.path))
  const feature = (patterns: string[], providers: string[]): Feature => ({ present: targetPaths.some(path => matchesAnyPath(path, patterns)), activation: 'EXPLICIT_PRODUCT_DECISION', changedPaths: upstream.filter(change => paths(change).some(path => matchesAnyPath(path, patterns))).map(change => change.path), providers: providers.filter(provider => targetPaths.some(path => path.startsWith(`${provider}/src/`))) })
  const automation = feature(registry.contracts.find(contract => contract.id === 'schedule')?.patterns ?? [], ['packages/experimental/schedule-bundle'])
  const computerUse = feature(registry.contracts.find(contract => contract.id === 'computer-use')?.patterns ?? [], ['packages/experimental/computer-use-cua-driver-native', 'packages/experimental/computer-use-cua-driver-mcp'])
  if (automation.present) add('AUTOMATION_AVAILABLE', ['Schedule is available; activation and delivery/recovery qualification require an explicit product decision.'])
  if (computerUse.present) add('COMPUTER_USE_AVAILABLE', ['Exclusive provider registry; host permissions and provider teardown require explicit qualification.', ...computerUse.providers])
  const divergence = git(root, ['rev-list', '--left-right', '--count', `${head}...${target.sha}`]).split(/\s+/u).map(Number)
  const customOnlyCommits = divergence[0]; const upstreamOnlyCommits = divergence[1]
  demand(customOnlyCommits !== undefined && upstreamOnlyCommits !== undefined && divergence.every(Number.isSafeInteger), 'Invalid divergence')
  const overlap = changes.filter(change => change.directOverlap)
  const qualificationGaps: string[] = []
  if (persistence) qualificationGaps.push('Target migration fixtures and Custom extension-event conversion tests must be implemented during staged migration; current Session V3 tests do not qualify V4.')
  if (automation.present && causes.has('schedule')) qualificationGaps.push('Schedule recurrence/recovery/delivery tests belong to explicit future feature integration.')
  if (computerUse.present && causes.has('computer-use')) qualificationGaps.push('Computer Use permission/provider teardown and desktop ownership tests belong to explicit future feature integration.')
  if (causes.has('package-payload')) qualificationGaps.push('Payload/ABI qualification is separate; this planner never builds Native or packages the App.')
  if (rank === 4) add('STAGED_MIGRATION_REQUIRED', ['Persistence/security/configuration contracts require staged semantic migration.'])
  return {
    schemaVersion: 1, toolVersion: TOOL_VERSION, timestamp: new Date().toISOString(),
    identity: {
      customHead: head, targetTag, targetSha: target.sha, mergeBase: base, ownershipRevision: registry.ownershipRevision,
      contractRevision: registry.contractRevision, inputsDigest: inputsDigest(root),
    },
    official: {
      repository: OFFICIAL_REPOSITORY, sourceVerification: catalog.sourceVerification,
      release: target.release, lastSynced: policy.lastSynced,
    },
    ancestry: { customOnlyCommits, upstreamOnlyCommits, relation: upstreamOnlyCommits === 0 ? 'ALREADY_INTEGRATED' : customOnlyCommits === 0 ? 'UPSTREAM_AHEAD' : 'DIVERGED_CUSTOM_TAIL', ranges: { custom: `${base}..${head}`, sinceLastSynced: `${policy.lastSynced.sha}..${target.sha}`, upstream: `${base}..${target.sha}` }, sinceLastSyncedFiles: sinceSynced.length },
    statistics: { policy: 'rename similarity 50%, renameLimit=0, copy detection OFF; rename counts as one logical change', filesChanged: upstream.length, packagesChanged: packageNames(upstream).length, customFilesChanged: custom.length, directOverlap: overlap.length, sourceOverlap: overlap.filter(change => paths(change).some(path => /\/src\//u.test(path))).length, renames: upstream.filter(change => change.status.startsWith('R')).length, ownership },
    changes, contracts: [...causes].map(([id, triggeredBy]) => ({ id, direct: direct.has(id), triggeredBy: [...triggeredBy].sort(), impact: `U${direct.has(id) ? registry.contracts.find(contract => contract.id === id)?.impactFloor ?? 3 : 3}` })),
    consumers, evidence: evidenceStates(registry, causes, direct), findings, reviewRequired, impact: `U${rank}`,
    surfaces: { persistence: persistence ? 'U4' : 'U0', session: persistence ? 'U4' : causes.has('session-history') ? 'U3' : 'U0', codex: consumers.some(consumer => consumer.id === 'codex') ? persistence ? 'U4' : 'U3' : 'U0', local: consumers.some(consumer => consumer.id === 'local-settings') ? settingsReplaced ? 'U4' : 'U3' : 'U0', desktop: causes.has('desktop-host-lifecycle') || causes.has('desktop-profile-boundary') ? 'U3' : 'U0' },
    features: { automation, computerUse },
    affectedTests: selectTests(registry, causes, consumers.map(consumer => consumer.id)), qualificationGaps,
    staticValidation: staticValidation(root, registry, causes),
    recommendedAction: reviewRequired.length ? 'REVIEW_REQUIRED' : rank === 4 ? 'STAGED_SEMANTIC_MIGRATION' : rank >= 2 ? 'FOCUSED_VALIDATION_REQUIRED' : 'REVIEW_EXPLICIT_SYNC_CANDIDATE',
  }
}
/** Fast channel and object status; absent objects produce no fabricated counts or merge base. */
export function checkUpstream(root: string, catalog: Catalog): Record<string, unknown> {
  assertHistory(root)
  const registry = loadRegistry(root); const policy = loadPolicy(root, registry)
  assertOfficialRemote(root, policy.policy.officialRemote)
  const head = customHead(root)
  const rc = catalog.releases.find(release => release.prerelease && /-rc\.\d+$/u.test(release.tag)) ?? null
  const stable = catalog.releases.find(release => !release.prerelease) ?? null
  const target = [rc, stable].filter((release): release is Release => release !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
  demand(catalog.tags[policy.lastSynced.tag] === policy.lastSynced.sha, 'LAST_SYNCED_TAG_MOVED_OR_MISSING')
  const sha = target?.sha ?? policy.lastSynced.sha
  const available = objectsAvailable(root, head, sha, policy.lastSynced.sha)
  let base: string | null = null; let summary: Record<string, unknown> | null = null
  if (available) {
    demand(probe(root, ['merge-base', '--is-ancestor', policy.lastSynced.sha, head]), 'LAST_SYNCED_NOT_INTEGRATED')
    base = mergeBase(root, head, sha)
    const upstream = changedPaths(root, base, sha); const custom = new Set(changedPaths(root, base, head).flatMap(paths))
    summary = {
      filesChanged: upstream.length, packagesChanged: packageNames(upstream).length,
      directOverlap: upstream.filter(change => paths(change).some(path => custom.has(path))).length,
    }
  }
  return { schemaVersion: 1, toolVersion: TOOL_VERSION, timestamp: new Date().toISOString(), customHead: head, officialRemote: OFFICIAL_URL, sourceVerification: catalog.sourceVerification, watchChannels: policy.trackedChannels, lastSynced: policy.lastSynced, latestPublishedRC: rc, latestPublishedStable: stable, latestMasterSha: catalog.masterSha, inspectionTarget: target ?? policy.lastSynced, newerInspectionTargetAvailable: sha !== policy.lastSynced.sha, objects: available ? 'AVAILABLE' : 'OBJECTS_MISSING', mergeBase: base, summary, nextCommand: available ? `pnpm upstream:inspect --tag ${target?.tag ?? policy.lastSynced.tag}` : 'pnpm upstream:check --refresh', syncDebt: 'Measured from lastSynced; inspecting/observing a release never advances integration.' }
}
/** Only explicit ignored artifacts are writable; symlink ancestors and tracked files are refused. */
export function writeIgnoredArtifact(root: string, path: string, value: unknown): void {
  const canonicalRoot = realpathSync(root)
  const inside = relative(resolve(root), resolve(root, path))
  const destination = resolve(canonicalRoot, inside)
  demand(inside.startsWith(`.artifacts${sep}`) && !inside.split(sep).includes('..'), 'OUTPUT_NOT_IGNORED_ARTIFACT: use .artifacts/ inside the repository')
  let cursor = destination
  while (cursor !== canonicalRoot) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false })
    demand(!stat?.isSymbolicLink(), 'OUTPUT_SYMLINK_REFUSED')
    cursor = dirname(cursor)
  }
  demand(!probe(root, ['ls-files', '--error-unmatch', '--', inside]) && probe(root, ['check-ignore', '-q', '--', inside]), 'OUTPUT_TRACKED_OR_NOT_IGNORED')
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, destination)
}
/** Refuse stale or forged reports and recompute causality from current official immutable objects. */
export function validatedPlan(root: string, report: Report, catalog: Catalog): Report {
  demand(object(report) && report.schemaVersion === 1 && report.toolVersion === TOOL_VERSION && object(report.identity), 'REPORT_INVALID: schema/tool version')
  const registry = loadRegistry(root)
  demand(report.identity.customHead === customHead(root), 'REPORT_STALE_HEAD')
  demand(report.identity.ownershipRevision === registry.ownershipRevision && report.identity.contractRevision === registry.contractRevision && report.identity.inputsDigest === inputsDigest(root), 'REPORT_STALE_REGISTRY_OR_TOOL')
  resolveTarget(catalog, report.identity.targetTag, report.identity)
  const fresh = inspectTarget(root, catalog, report.identity.targetTag, report.identity)
  demand(fresh.identity.mergeBase === report.identity.mergeBase && report.official?.repository === OFFICIAL_REPOSITORY, 'REPORT_INVALID_IDENTITY')
  const productDirty = git(root, ['diff', '--name-only', 'HEAD', '--', 'packages', 'apps'])
  demand(productDirty === '' && !git(root, ['ls-files', '--others', '--exclude-standard', '--', 'packages', 'apps']), 'PRODUCT_WORKTREE_DIRTY: report describes committed product source')
  return fresh
}
/** Print a reviewable report without serializing machine paths or user data. */
export function renderInspect(report: Report): string {
  return [
    `Custom ${report.identity.customHead}; official ${report.identity.targetTag} ${report.identity.targetSha}`,
    `Official source ${report.official.sourceVerification}; published release ${report.official.release ? report.official.release.prerelease ? 'PRERELEASE' : 'STABLE' : 'UNPUBLISHED / DEV'}`,
    `Merge base ${report.identity.mergeBase}; Custom-only ${report.ancestry.customOnlyCommits}; upstream-only ${report.ancestry.upstreamOnlyCommits}`,
    `Files ${report.statistics.filesChanged}; packages ${report.statistics.packagesChanged}; overlap ${report.statistics.directOverlap}; source overlap ${report.statistics.sourceOverlap}; renames ${report.statistics.renames}`,
    report.statistics.policy,
    `Impact ${report.impact}; recommendation ${report.recommendedAction}; surfaces ${JSON.stringify(report.surfaces)}`,
    ...report.findings.map(finding => `${finding.code}: ${finding.evidence.join('; ')}`),
    ...report.evidence.map(evidence => `Evidence ${evidence.id}: ${evidence.state}; causes ${evidence.triggeredBy.join(', ') || 'none'}`),
    ...report.reviewRequired.map(path => `REVIEW_REQUIRED: unregistered Custom area ${path}`),
    `Affected specs ${report.affectedTests.length}; default test planner DRY RUN.`,
    ...report.qualificationGaps.map(gap => `Qualification gap: ${gap}`),
    'Source sync and release qualification remain separate explicit operations.',
  ].join('\n')
}
/** Format exact selected specs, scope and evidence for a default dry run. */
export function renderPlan(report: Report, run: boolean): string {
  return [`${run ? 'EXPLICIT SAFE UNIT RUN' : 'DRY RUN — no tests executed'}: ${report.identity.targetTag} ${report.impact}`,
    `Scope: ${report.affectedTests.length} exact specs; ${report.affectedTests.filter(test => test.execution === 'SAFE_UNIT').length} reviewed keyless unit specs executable; remaining specs require separate qualification.`,
    ...report.affectedTests.map(test => `${test.execution}: ${test.path}\n  contracts: ${test.contracts.join(', ')}; consumers: ${test.consumers.join(', ') || 'contract directly affected'}`),
    ...report.evidence.map(evidence => `Evidence ${evidence.id}: ${evidence.state} (${evidence.triggeredBy.join(', ') || 'no changed dependency'})`),
    ...report.qualificationGaps.map(gap => `Qualification gap: ${gap}`),
    ...report.staticValidation.map(check => `${check.kind} / ${check.execution}: ${check.paths.join(', ')}; ${check.reason}`),
    'No Native, packaging, GUI, inference, profile migration, full Codex compat or whole-repository test command is authorized by this planner.',
  ].join('\n')
}
/** Execute only reviewed local unit specs; reports can never supply shell commands. */
export function runSafePlan(root: string, report: Report, execute = (tests: string[]): number | null => {
  return spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests], {
    cwd: root, stdio: 'inherit', env: process.env,
  }).status
}): void {
  demand(report.official.sourceVerification === 'LIVE_OFFICIAL', 'RUN_REQUIRES_LIVE_OFFICIAL_SOURCE')
  demand(report.reviewRequired.length === 0, 'RUN_REQUIRES_RESOLVED_OWNERSHIP')
  const tests = report.affectedTests.filter(test => test.execution === 'SAFE_UNIT').map(test => test.path)
  demand(tests.length > 0 && tests.every(test => SAFE_UNITS.has(test)), 'NO_SAFE_TESTS_SELECTED')
  for (const test of tests) assertTest(root, test)
  demand(execute(tests) === 0, 'FOCUSED_UNIT_TESTS_FAILED')
}
