/** Deterministic, read-only compatibility audit for an upstream Git range. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, TextDecoder } from 'node:util'

const FORMAT_VERSION = 1
const DEFAULT_BASE = 'HEAD'
const DEFAULT_OUTPUT_DIRECTORY = '.artifacts/upstream-audit'
const DEFAULT_REGISTRY = fileURLToPath(new URL('./upstream-tracking-seams.json', import.meta.url))
const MAX_GIT_OUTPUT = 128 * 1024 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/** The tracked Custom change surface and compatibility seam registry. */
export const DEFAULT_SEAM_REGISTRY_PATH = DEFAULT_REGISTRY

export const RISK_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export const IMPACT_LEVELS = [
  'UNAFFECTED',
  'RELATED_LOW_RISK',
  'REVIEW_REQUIRED',
  'LIKELY_CONFLICT',
  'BLOCKING_CHANGE',
] as const
export const CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const
export const CHANGE_CATEGORIES = [
  'Documentation',
  'Tests',
  'Dependency/version',
  'Build tooling',
  'Desktop shell',
  'Electron packaging',
  'Runtime',
  'Profile',
  'Cordis/composition',
  'Client UI',
  'Agent loop',
  'Session',
  'LLM/provider',
  'Diagnostics/Run State',
  'Schema/type contract',
  'Native dependency',
  'Security',
  'Unknown',
] as const

export type RiskLevel = typeof RISK_LEVELS[number]
export type ImpactLevel = typeof IMPACT_LEVELS[number]
export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number]
export type ChangeCategory = typeof CHANGE_CATEGORIES[number]
export type RecommendedAction = 'NO_ACTION' | 'REVIEW' | 'TEST_REQUIRED' | 'MANUAL_ADAPTATION_REQUIRED'

export interface CustomSurfaceDomain {
  domain: string
  description: string
  customPaths: string[]
  upstreamDependency: string
  riskSignificance: string
}

/** One registered DS Harness compatibility seam and its evidence. */
export interface CompatibilitySeam {
  id: string
  description: string
  upstreamPaths: string[]
  contractPaths: string[]
  customPaths: string[]
  interface: string
  whyItMatters: string
  failureMode: string
  detectionMethod: string
  risk: RiskLevel
  tests: string[]
}

/** The machine-readable Custom change surface and seam registry. */
export interface SeamRegistry {
  formatVersion: number
  baseline: string
  customChangeSurface: CustomSurfaceDomain[]
  seams: CompatibilitySeam[]
}

export interface ChangedPath {
  status: string
  path: string
  oldPath?: string
  categories: ChangeCategory[]
  seamIds: string[]
  directModificationOverlap: boolean
  contractDependency: boolean
  risk: RiskLevel
  impact: ImpactLevel
  confidence: ConfidenceLevel
  reason: string
}

interface CommitIdentity {
  sha: string
  subject: string
}

export interface ChangeGroup {
  id: string
  categories: ChangeCategory[]
  seamIds: string[]
  changedFiles: string[]
  commitCount: number
  commits: CommitIdentity[]
  risk: RiskLevel
  impact: ImpactLevel
  confidence: ConfidenceLevel
  reason: string
  recommendedAction: RecommendedAction
}

export interface UpstreamAuditReport {
  formatVersion: typeof FORMAT_VERSION
  generatedAt: string
  repositoryRoot: string
  identity: {
    base: string
    target: string
    baseSha: string
    targetSha: string
    mergeBaseSha: string
    upstreamRemote: string | null
    upstreamBranch: string | null
    upstreamDefaultBranch: string | null
    commitRange: string
  }
  divergence: {
    baselineOnlyCommits: number
    upstreamOnlyCommits: number
  }
  summary: {
    totalCommits: number
    totalChangedFiles: number
    affectedSeams: string[]
    highestRisk: RiskLevel
    impact: ImpactLevel
    confidence: ConfidenceLevel
    manualReviewRequired: boolean
    recommendedAction: RecommendedAction
    overallResult: string
  }
  customChangeSurface: CustomSurfaceDomain[]
  seamRegistryVersion: number
  changes: ChangedPath[]
  changeGroups: ChangeGroup[]
  limitations: string[]
}

interface AuditOptions {
  base: string
  target: string
  registryPath?: string | undefined
  generatedAt?: string | undefined
}

interface CliOptions extends AuditOptions {
  outputDirectory: string
}

interface RawChangedPath {
  status: string
  path: string
  oldPath?: string
}

interface ClassifiedPath extends ChangedPath {
  matchedSeams: CompatibilitySeam[]
  seamAssessments: Record<string, { risk: RiskLevel; confidence: ConfidenceLevel }>
}

interface GitResult {
  status: number | null
  stdout: Buffer
  stderr: Buffer
  error?: Error | undefined
}

const riskRank = new Map<RiskLevel, number>(RISK_LEVELS.map((value, index) => [value, index]))
const confidenceRank = new Map<ConfidenceLevel, number>(CONFIDENCE_LEVELS.map((value, index) => [value, index]))

function runGit(root: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxBuffer: MAX_GIT_OUTPUT,
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

function decode(bytes: Buffer, context: string): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new Error(`${context}: Git output is not valid UTF-8`)
  }
}

function failure(result: GitResult): string {
  return result.error?.message
    ?? (decode(result.stderr, 'cannot decode Git error').trim() || `Git exited with status ${String(result.status)}`)
}

/** Read Git output without optional worktree locks or lazy object fetching. */
export function requireGit(root: string, args: string[], context: string): string {
  const result = runGit(root, args)
  if (result.status !== 0) throw new Error(`${context}: ${failure(result)}`)
  return decode(result.stdout, context)
}

function repositoryRoot(cwd: string): string {
  return requireGit(cwd, ['rev-parse', '--show-toplevel'], 'cannot locate a Git worktree').trim()
}

function resolveCommit(root: string, label: 'base' | 'target', ref: string): string {
  const result = runGit(root, [
    '-c',
    'core.warnAmbiguousRefs=true',
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ])
  const stderr = decode(result.stderr, `cannot resolve ${label} ref`)
  if (/\bambiguous\b/iu.test(stderr)) {
    throw new Error(`${label} ref ${JSON.stringify(ref)} is ambiguous; use a fully qualified ref or commit ID`)
  }
  if (result.status !== 0) {
    throw new Error(`${label} ref ${JSON.stringify(ref)} does not resolve to a commit: ${failure(result)}`)
  }
  const commits = decode(result.stdout, `cannot resolve ${label} ref`).trim().split(/\r?\n/u).filter(Boolean)
  if (commits.length !== 1) throw new Error(`${label} ref ${JSON.stringify(ref)} did not resolve to exactly one commit`)
  return commits[0] as string
}

/** Require a unique, real merge base rather than selecting an arbitrary ancestor. */
export function mergeBase(root: string, baseSha: string, targetSha: string): string {
  const output = requireGit(root, ['merge-base', '--all', baseSha, targetSha], 'cannot resolve merge base')
  const commits = output.trim().split(/\r?\n/u).filter(Boolean)
  if (commits.length !== 1) {
    throw new Error(`base and target do not have a unique merge base; found ${commits.length}`)
  }
  return commits[0] as string
}

function integerOutput(root: string, args: string[], context: string): number {
  const value = Number.parseInt(requireGit(root, args, context).trim(), 10)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${context}: expected a non-negative integer`)
  return value
}

function parseDivergence(root: string, baseSha: string, targetSha: string): [number, number] {
  const output = requireGit(
    root,
    ['rev-list', '--left-right', '--count', `${baseSha}...${targetSha}`],
    'cannot inspect baseline/upstream divergence',
  ).trim()
  const values = output.split(/\s+/u).map(value => Number.parseInt(value, 10))
  if (values.length !== 2 || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('cannot inspect baseline/upstream divergence: unexpected Git output')
  }
  return values as [number, number]
}

function parseNameStatus(bytes: Buffer): RawChangedPath[] {
  const fields = decode(bytes, 'cannot inspect upstream changed paths').split('\0')
  if (fields.at(-1) === '') fields.pop()
  const changes: RawChangedPath[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] as string
    if (/^[RC]\d{1,3}$/u.test(status)) {
      const oldPath = fields[index++]
      const path = fields[index++]
      if (oldPath === undefined || path === undefined) throw new Error('cannot parse renamed/copied Git path')
      changes.push({ status, oldPath, path })
    } else {
      const path = fields[index++]
      if (path === undefined) throw new Error('cannot parse Git changed path')
      changes.push({ status, path })
    }
  }
  return changes
}

/** Count logical changes using full 50% rename detection and no copy detection. */
export function changedPaths(root: string, fromSha: string, targetSha: string): RawChangedPath[] {
  const result = runGit(root, [
    '-c', 'diff.renameLimit=0',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--find-renames=50%',
    '--name-status',
    '-z',
    fromSha,
    targetSha,
    '--',
  ])
  if (result.status !== 0) throw new Error(`cannot inspect upstream changed paths: ${failure(result)}`)
  return parseNameStatus(result.stdout)
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
}

function globRegex(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length;) {
    if (pattern.slice(index, index + 3) === '**/') {
      source += '(?:.*/)?'
      index += 3
    } else if (pattern.slice(index, index + 2) === '**') {
      source += '.*'
      index += 2
    } else if (pattern[index] === '*') {
      source += '[^/]*'
      index += 1
    } else {
      source += escapeRegex(pattern[index] as string)
      index += 1
    }
  }
  return new RegExp(`^${source}$`, 'u')
}

const compiledPatterns = new Map<string, RegExp>()

function matches(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    let compiled = compiledPatterns.get(pattern)
    if (compiled === undefined) {
      compiled = globRegex(pattern)
      compiledPatterns.set(pattern, compiled)
    }
    return compiled.test(path)
  })
}

/**
 * Test one repository-relative path against the registry's glob patterns.
 * @param path - Repository-relative path to test.
 * @param patterns - Registry glob patterns (`**` crosses directories, `*` does not).
 * @returns True when any pattern matches the whole path.
 */
export function matchesAnyPath(path: string, patterns: string[]): boolean {
  return matches(path, patterns)
}

function pathsOf(change: RawChangedPath): string[] {
  return change.oldPath === undefined ? [change.path] : [change.oldPath, change.path]
}

/**
 * Assign non-exclusive taxonomy categories to one changed path.
 *
 * The patterns describe the CURRENT Stage 1–11 workspace layout: the Desktop
 * flavor/data boundary under `apps/desktop/src`, the primary-runtime packaging
 * scripts under `apps/desktop/scripts`, and the DS Harness capability packages
 * under `packages/runtime-diagnostics`, `packages/compaction`, `packages/llm`,
 * `packages/session`, and `packages/api`. Historical `packages/agent`,
 * `packages/provider`, `packages/token-meter`, `packages/profile`,
 * `packages/config`, `packages/core/loader`, and `packages/guard/*` roots no
 * longer exist and are not matched.
 */
function categorize(change: RawChangedPath): ChangeCategory[] {
  const paths = pathsOf(change)
  const categories = new Set<ChangeCategory>()
  const any = (patterns: string[]) => paths.some(path => matches(path, patterns))

  if (any(['**/*.md', '**/*.mdx', '**/*.i18n.yaml', 'docs/**', '.agents/notes/**'])) categories.add('Documentation')
  if (any(['**/tests/**', '**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/__tests__/**'])) categories.add('Tests')
  if (any(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/package.json', '.node-version', '.nvmrc'])) categories.add('Dependency/version')
  if (any(['scripts/**', 'tsconfig*.json', '**/tsconfig*.json', '**/tsdown.config.*', '.github/**', 'vitest*.ts'])) categories.add('Build tooling')
  if (any(['apps/desktop/src/**', 'apps/desktop/scripts/dev.ts'])) categories.add('Desktop shell')
  if (any(['apps/desktop/electron-builder.config.*', 'apps/desktop/scripts/package*.ts', 'apps/desktop/scripts/packaging-run.mjs', 'apps/desktop/scripts/prepare-*.ts', 'apps/desktop/scripts/installed-update-*/**'])) categories.add('Electron packaging')
  if (any(['apps/desktop/src/host-process.ts', 'apps/desktop-host/**', 'apps/desktop/scripts/*runtime*.ts', 'packages/host/**', 'native/system/**', 'python/sdk-runtime/**'])) categories.add('Runtime')
  if (any(['apps/desktop/src/paths.ts', 'apps/desktop/src/data-boundary.ts', 'apps/desktop/src/profile-*.ts', 'apps/desktop/src/project-manager.ts', 'apps/desktop/src/owned-directory.ts', 'packages/settings/**'])) categories.add('Profile')
  if (any(['packages/bundle/**', 'vendor/cordis/**', 'vendor/loader/**', '**/cordis.patch.yml'])) categories.add('Cordis/composition')
  // The Typert/Gateway/remotes faces are the generated client transport the
  // Stage 11 diagnostics stream rides on, so they belong with the client layer.
  if (any(['packages/client/**', 'apps/web/**', 'packages/api/gateway/**', 'packages/api/remotes/**', 'packages/typert/**'])) categories.add('Client UI')
  if (any(['packages/core/agent/**', 'packages/core/agent-loop/**'])) categories.add('Agent loop')
  if (any(['packages/core/session/**', 'packages/session/**', 'packages/api/session-controller/**'])) categories.add('Session')
  if (any(['packages/llm/**'])) categories.add('LLM/provider')
  if (any(['packages/runtime-diagnostics/**', 'packages/compaction/**', 'packages/api/runtime-diagnostics-controller/**'])) categories.add('Diagnostics/Run State')
  if (any(['**/types.ts', '**/schema.ts', '**/contract/**', 'packages/sdk/protocol/**', '**/*.d.ts', '**/*schema*.json'])) categories.add('Schema/type contract')
  if (any(['native/**', '**/*node-pty*', '**/*sharp*', '**/*koffi*', '**/*fs-ext*'])) categories.add('Native dependency')
  if (any(['**/security/**', '.github/workflows/codeql*', '**/permissions/**', '**/sandbox/**'])) categories.add('Security')
  if (categories.size === 0) categories.add('Unknown')
  return CHANGE_CATEGORIES.filter(category => categories.has(category))
}

function dependencyPatch(root: string, fromSha: string, targetSha: string, changes: RawChangedPath[]): string {
  const manifests = [...new Set(changes.flatMap(pathsOf).filter(path => matches(path, [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '**/package.json',
    '.node-version',
    '.nvmrc',
  ])))]
  if (manifests.length === 0) return ''
  return requireGit(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--unified=0',
    fromSha,
    targetSha,
    '--',
    ...manifests,
  ], 'cannot inspect dependency changes')
}

function hasNativeRuntimeSignal(patch: string): boolean {
  return /^[+-].*(?:"electron"|"node"|node-pty|sharp|koffi|fs-ext|darwin-arm64|mac-arm64|abi)/imu.test(patch)
}

function maximumRisk(values: RiskLevel[]): RiskLevel {
  return values.reduce<RiskLevel>((highest, value) => (
    (riskRank.get(value) as number) > (riskRank.get(highest) as number) ? value : highest
  ), 'NONE')
}

function minimumConfidence(values: ConfidenceLevel[]): ConfidenceLevel {
  return values.reduce<ConfidenceLevel>((lowest, value) => (
    (confidenceRank.get(value) as number) < (confidenceRank.get(lowest) as number) ? value : lowest
  ), 'HIGH')
}

function impactFor(risk: RiskLevel): ImpactLevel {
  return IMPACT_LEVELS[riskRank.get(risk) as number] as ImpactLevel
}

function actionFor(risk: RiskLevel): RecommendedAction {
  if (risk === 'NONE' || risk === 'LOW') return 'NO_ACTION'
  if (risk === 'MEDIUM') return 'REVIEW'
  if (risk === 'HIGH') return 'TEST_REQUIRED'
  return 'MANUAL_ADAPTATION_REQUIRED'
}

function classifyPath(
  change: RawChangedPath,
  registry: SeamRegistry,
  nativeRuntimeSignal: boolean,
): ClassifiedPath {
  const categories = categorize(change)
  const candidateSeams = registry.seams.filter(seam => pathsOf(change).some(path => matches(path, seam.upstreamPaths)))
  const matchedSeams = candidateSeams.filter((seam) => {
    if (seam.id !== 'native-runtime-abi-closure') return true
    const onlyGenericManifest = pathsOf(change).every(path => matches(path, ['package.json', 'pnpm-lock.yaml', '**/package.json']))
    return !onlyGenericManifest || nativeRuntimeSignal
  })
  const directModificationOverlap = matchedSeams.some(seam => pathsOf(change).some(path => matches(path, seam.customPaths)))
  const contractDependency = matchedSeams.some(seam => pathsOf(change).some(path => matches(path, seam.contractPaths)))
  const rename = /^[RC]/u.test(change.status)
  const seamAssessments: Record<string, { risk: RiskLevel; confidence: ConfidenceLevel }> = Object.fromEntries(
    matchedSeams.map((seam) => {
      const direct = pathsOf(change).some(path => matches(path, seam.customPaths))
      const contract = pathsOf(change).some(path => matches(path, seam.contractPaths))
      let seamRisk: RiskLevel = direct || contract ? seam.risk : 'MEDIUM'
      if (rename && (riskRank.get(seamRisk) as number) < (riskRank.get('HIGH') as number)) seamRisk = 'HIGH'
      return [seam.id, {
        risk: seamRisk,
        confidence: direct || contract ? 'HIGH' as const : 'MEDIUM' as const,
      }]
    }),
  )
  let risk: RiskLevel
  let confidence: ConfidenceLevel
  let reason: string

  if (matchedSeams.length > 0) {
    risk = maximumRisk(Object.values(seamAssessments).map(assessment => assessment.risk))
    confidence = minimumConfidence(Object.values(seamAssessments).map(assessment => assessment.confidence))
    const evidence = [
      directModificationOverlap ? 'direct Custom modification overlap' : undefined,
      contractDependency ? 'registered contract dependency' : undefined,
      rename ? 'rename/move across a registered seam' : undefined,
    ].filter(Boolean).join(', ') || 'adjacent registered seam path'
    reason = `${evidence}; affected seam${matchedSeams.length === 1 ? '' : 's'}: ${matchedSeams.map(seam => seam.id).join(', ')}`
  } else if (pathsOf(change).every(path => matches(path, [
    '**/*.md',
    '**/*.mdx',
    '**/*.i18n.yaml',
    'docs/**',
    '.agents/notes/**',
    '**/tests/**',
    '**/*.spec.ts',
    '**/*.spec.tsx',
    '**/*.test.ts',
    '**/__tests__/**',
  ]))) {
    risk = 'NONE'
    confidence = 'HIGH'
    reason = 'Documentation/tests only and no registered compatibility seam is affected.'
  } else if (categories.includes('Unknown')) {
    risk = 'MEDIUM'
    confidence = 'LOW'
    reason = 'The path is not covered by the taxonomy or seam registry; fail-open safety claims are not allowed.'
  } else if (categories.includes('Security')) {
    risk = 'MEDIUM'
    confidence = 'MEDIUM'
    reason = 'Security-sensitive source changed outside a registered Custom seam and requires human review.'
  } else {
    risk = 'LOW'
    confidence = 'HIGH'
    reason = 'Known upstream area changed without touching a registered Custom compatibility seam.'
  }

  return {
    ...change,
    categories,
    seamIds: matchedSeams.map(seam => seam.id).sort(),
    matchedSeams,
    seamAssessments,
    directModificationOverlap,
    contractDependency,
    risk,
    impact: impactFor(risk),
    confidence,
    reason,
  }
}

function parseCommitRecords(output: string): CommitIdentity[] {
  const fields = output.split('\0')
  if (fields.at(-1) === '' || fields.at(-1) === '\n') fields.pop()
  const commits: CommitIdentity[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = (fields[index] as string).replace(/^\n/u, '')
    const subject = fields[index + 1] as string
    if (sha !== '') commits.push({ sha, subject })
  }
  return commits
}

function commitsForPaths(root: string, range: string, paths: string[]): CommitIdentity[] {
  if (paths.length === 0) return []
  const output = requireGit(root, [
    'log',
    '--reverse',
    '--format=%H%x00%s%x00',
    range,
    '--',
    ...paths,
  ], 'cannot inspect commits for change group')
  return parseCommitRecords(output)
}

function groupChanges(root: string, range: string, changes: ClassifiedPath[]): ChangeGroup[] {
  const buckets = new Map<string, ClassifiedPath[]>()
  for (const change of changes) {
    const keys = change.seamIds.length > 0
      ? change.seamIds.map(seamId => `seam:${seamId}`)
      : [`area:${change.categories.join('+')}`]
    for (const key of keys) {
      const bucket = buckets.get(key) ?? []
      bucket.push(change)
      buckets.set(key, bucket)
    }
  }
  return [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, bucket]) => {
    const paths = [...new Set(bucket.flatMap(pathsOf))].sort()
    const commits = commitsForPaths(root, range, paths)
    const seamId = id.startsWith('seam:') ? id.slice('seam:'.length) : undefined
    const assessments = seamId === undefined
      ? bucket.map(change => ({ risk: change.risk, confidence: change.confidence }))
      : bucket.flatMap(change => change.seamAssessments[seamId] === undefined ? [] : [change.seamAssessments[seamId]])
    const risk = maximumRisk(assessments.map(assessment => assessment.risk))
    const seamIds = [...new Set(bucket.flatMap(change => change.seamIds))].sort()
    const categories = CHANGE_CATEGORIES.filter(category => bucket.some(change => change.categories.includes(category)))
    return {
      id,
      categories,
      seamIds,
      changedFiles: paths,
      commitCount: commits.length,
      commits: commits.slice(0, 20),
      risk,
      impact: impactFor(risk),
      confidence: minimumConfidence(assessments.map(assessment => assessment.confidence)),
      reason: [...new Set(bucket.map(change => change.reason))].join(' '),
      recommendedAction: actionFor(risk),
    }
  })
}

function aggregateRisk(changes: ClassifiedPath[]): RiskLevel {
  if (changes.length === 0) return 'NONE'
  let risk = maximumRisk(changes.map(change => change.risk))
  const materialSeams = new Set(changes
    .filter(change => (riskRank.get(change.risk) as number) >= (riskRank.get('MEDIUM') as number))
    .flatMap(change => change.seamIds))
  const materialCategories = new Set(changes
    .filter(change => (riskRank.get(change.risk) as number) >= (riskRank.get('MEDIUM') as number))
    .flatMap(change => change.categories))

  if (risk === 'MEDIUM' && (materialSeams.size >= 2 || materialCategories.size >= 3)) risk = 'HIGH'
  else if (risk === 'HIGH' && materialSeams.size >= 4) risk = 'CRITICAL'
  return risk
}

function overallResult(totalCommits: number, risk: RiskLevel, affectedSeams: string[]): string {
  if (totalCommits === 0) return 'NO_NEW_UPSTREAM_CHANGES'
  if (risk === 'NONE' || (risk === 'LOW' && affectedSeams.length === 0)) {
    return 'NO_CURRENTLY_DETECTED_COMPATIBILITY_SEAM_IMPACT'
  }
  return impactFor(risk)
}

function inferRemote(root: string, target: string): { remote: string | null; branch: string | null; defaultBranch: string | null } {
  const remotes = requireGit(root, ['remote'], 'cannot list Git remotes').trim().split(/\r?\n/u).filter(Boolean)
  let remote: string | null = null
  let branch: string | null = null
  for (const candidate of remotes) {
    const prefixes = [`${candidate}/`, `refs/remotes/${candidate}/`]
    const prefix = prefixes.find(value => target.startsWith(value))
    if (prefix !== undefined) {
      remote = candidate
      branch = target.slice(prefix.length)
      break
    }
  }
  if (remote === null) return { remote, branch, defaultBranch: null }
  const result = runGit(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  if (result.status !== 0) return { remote, branch, defaultBranch: null }
  const symbolic = decode(result.stdout, 'cannot inspect upstream default branch').trim()
  return { remote, branch, defaultBranch: symbolic.startsWith(`${remote}/`) ? symbolic.slice(remote.length + 1) : symbolic }
}

/**
 * Load and validate a seam registry.
 * @param path - Absolute or relative path to the JSON registry.
 * @returns The parsed registry, after format and risk validation.
 */
export function loadSeamRegistry(path: string): SeamRegistry {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SeamRegistry
  if (parsed.formatVersion !== 1 || !Array.isArray(parsed.customChangeSurface) || !Array.isArray(parsed.seams)) {
    throw new Error(`unsupported or invalid seam registry: ${path}`)
  }
  for (const seam of parsed.seams) {
    if (!RISK_LEVELS.includes(seam.risk)) throw new Error(`invalid risk for seam ${seam.id}: ${seam.risk}`)
  }
  return parsed
}

function generatedTime(explicit?: string): string {
  const value = explicit ?? (process.env.SOURCE_DATE_EPOCH === undefined
    ? new Date().toISOString()
    : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString())
  if (Number.isNaN(Date.parse(value))) throw new Error(`invalid generated time: ${value}`)
  return value
}

export function auditUpstreamRange(options: AuditOptions, cwd = process.cwd()): UpstreamAuditReport {
  const root = repositoryRoot(cwd)
  const baseSha = resolveCommit(root, 'base', options.base)
  const targetSha = resolveCommit(root, 'target', options.target)
  const mergeBaseSha = mergeBase(root, baseSha, targetSha)
  const range = `${mergeBaseSha}..${targetSha}`
  const rawChanges = changedPaths(root, mergeBaseSha, targetSha)
  const registry = loadSeamRegistry(options.registryPath ?? DEFAULT_REGISTRY)
  const nativeRuntimeSignal = hasNativeRuntimeSignal(dependencyPatch(root, mergeBaseSha, targetSha, rawChanges))
  const classified = rawChanges.map(change => classifyPath(change, registry, nativeRuntimeSignal))
  const totalCommits = integerOutput(root, ['rev-list', '--count', range], 'cannot count upstream commits')
  const [baselineOnlyCommits, upstreamOnlyCommits] = parseDivergence(root, baseSha, targetSha)
  const affectedSeams = [...new Set(classified.flatMap(change => change.seamIds))].sort()
  const risk = aggregateRisk(classified)
  const highestIndividualRisk = maximumRisk(classified.map(item => item.risk))
  const confidence = classified.length === 0
    ? 'HIGH'
    : minimumConfidence(classified
      .filter(change => change.risk === highestIndividualRisk)
      .map(change => change.confidence))
  const remote = inferRemote(root, options.target)
  const groups = groupChanges(root, range, classified)

  return {
    formatVersion: FORMAT_VERSION,
    generatedAt: generatedTime(options.generatedAt),
    repositoryRoot: root,
    identity: {
      base: options.base,
      target: options.target,
      baseSha,
      targetSha,
      mergeBaseSha,
      upstreamRemote: remote.remote,
      upstreamBranch: remote.branch,
      upstreamDefaultBranch: remote.defaultBranch,
      commitRange: range,
    },
    divergence: { baselineOnlyCommits, upstreamOnlyCommits },
    summary: {
      totalCommits,
      totalChangedFiles: rawChanges.length,
      affectedSeams,
      highestRisk: risk,
      impact: impactFor(risk),
      confidence,
      manualReviewRequired: (riskRank.get(risk) as number) >= (riskRank.get('MEDIUM') as number),
      recommendedAction: actionFor(risk),
      overallResult: overallResult(totalCommits, risk, affectedSeams),
    },
    customChangeSurface: registry.customChangeSurface,
    seamRegistryVersion: registry.formatVersion,
    changes: classified.map(({ matchedSeams: _matchedSeams, seamAssessments: _seamAssessments, ...change }) => change),
    changeGroups: groups,
    limitations: [
      'Static path, Git metadata, manifest, and registered contract evidence cannot prove runtime compatibility or mergeability.',
      'The auditor does not fetch, merge, rebase, build, package, install, launch, migrate, or execute recommended actions.',
      'Unregistered or semantically subtle contract changes can only be classified as Unknown/REVIEW_REQUIRED until the registry is updated.',
      'Commit attribution for a group is path-based and displayed samples are capped at 20 commits; group and range counts remain exact.',
    ],
  }
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function shortSha(value: string): string {
  return value.slice(0, 12)
}

function list(values: string[]): string {
  return values.length === 0 ? 'None' : values.map(value => `\`${value}\``).join(', ')
}

export function renderMarkdownReport(report: UpstreamAuditReport): string {
  const lines = [
    '# DS Harness upstream compatibility audit',
    '',
    '> This is a deterministic static-analysis report. It does not assert that an update is safe to merge or replay.',
    '',
    '## Audit identity',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Generated | ${report.generatedAt} |`,
    `| Base | \`${report.identity.base}\` → \`${report.identity.baseSha}\` |`,
    `| Target | \`${report.identity.target}\` → \`${report.identity.targetSha}\` |`,
    `| Merge base | \`${report.identity.mergeBaseSha}\` |`,
    `| Upstream remote | ${report.identity.upstreamRemote === null ? 'Unknown' : `\`${report.identity.upstreamRemote}\``} |`,
    `| Upstream branch | ${report.identity.upstreamBranch === null ? 'Unknown' : `\`${report.identity.upstreamBranch}\``} |`,
    `| Upstream default branch | ${report.identity.upstreamDefaultBranch === null ? 'Unknown' : `\`${report.identity.upstreamDefaultBranch}\``} |`,
    `| Analyzed range | \`${report.identity.commitRange}\` |`,
    '',
    '## Summary',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Result | **${report.summary.overallResult}** |`,
    `| Upstream commits | ${report.summary.totalCommits} |`,
    `| Changed files | ${report.summary.totalChangedFiles} |`,
    `| Baseline-only / upstream-only commits | ${report.divergence.baselineOnlyCommits} / ${report.divergence.upstreamOnlyCommits} |`,
    `| Affected seams | ${list(report.summary.affectedSeams)} |`,
    `| Highest risk | **${report.summary.highestRisk}** |`,
    `| Impact / confidence | ${report.summary.impact} / ${report.summary.confidence} |`,
    `| Manual review required | ${report.summary.manualReviewRequired ? 'YES' : 'NO'} |`,
    `| Recommended action | ${report.summary.recommendedAction} |`,
    '',
    '## Change groups',
    '',
  ]

  if (report.changeGroups.length === 0) {
    lines.push('No upstream changes exist in the analyzed range.', '')
  } else {
    for (const group of report.changeGroups) {
      lines.push(
        `### ${group.id}`,
        '',
        `- Categories: ${list(group.categories)}`,
        `- Relevant Custom seams: ${list(group.seamIds)}`,
        `- Risk / impact / confidence: **${group.risk}** / ${group.impact} / ${group.confidence}`,
        `- Recommended action: ${group.recommendedAction}`,
        `- Commits touching group paths: ${group.commitCount}`,
        `- Reason: ${group.reason}`,
        `- Affected files (${group.changedFiles.length}): ${list(group.changedFiles.slice(0, 30))}${group.changedFiles.length > 30 ? `, … ${group.changedFiles.length - 30} more` : ''}`,
        '',
      )
      if (group.commits.length > 0) {
        lines.push('| Commit sample | Subject |', '| --- | --- |')
        for (const commit of group.commits) {
          lines.push(`| \`${shortSha(commit.sha)}\` | ${markdownCell(commit.subject)} |`)
        }
        lines.push('')
      }
    }
  }

  lines.push(
    '## Registered Custom change surface',
    '',
    '| Domain | Upstream dependency | Risk significance |',
    '| --- | --- | --- |',
  )
  for (const domain of report.customChangeSurface) {
    lines.push(`| ${markdownCell(domain.domain)} | ${markdownCell(domain.upstreamDependency)} | ${markdownCell(domain.riskSignificance)} |`)
  }
  lines.push('', '## Known limitations', '')
  for (const limitation of report.limitations) lines.push(`- ${limitation}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

function safeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 48) || 'ref'
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, contents, 'utf8')
  renameSync(temporary, path)
}

export function writeAuditReports(
  report: UpstreamAuditReport,
  outputDirectory: string,
): { markdownPath: string; jsonPath: string; statePath: string } {
  const root = report.repositoryRoot
  const absoluteOutput = isAbsolute(outputDirectory) ? outputDirectory : resolve(root, outputDirectory)
  const identity = `${safeFilePart(report.identity.base)}-${shortSha(report.identity.baseSha)}__${safeFilePart(report.identity.target)}-${shortSha(report.identity.targetSha)}`
  const markdownPath = join(absoluteOutput, `${identity}.md`)
  const jsonPath = join(absoluteOutput, `${identity}.json`)
  const statePath = join(absoluteOutput, 'last-audit.json')
  atomicWrite(markdownPath, renderMarkdownReport(report))
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  atomicWrite(statePath, `${JSON.stringify({
    formatVersion: FORMAT_VERSION,
    base: report.identity.base,
    baseSha: report.identity.baseSha,
    target: report.identity.target,
    targetSha: report.identity.targetSha,
    mergeBaseSha: report.identity.mergeBaseSha,
    generatedAt: report.generatedAt,
    overallResult: report.summary.overallResult,
  }, null, 2)}\n`)
  return { markdownPath, jsonPath, statePath }
}

function parseOptions(args: string[]): CliOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      base: { type: 'string', default: DEFAULT_BASE },
      target: { type: 'string' },
      'output-dir': { type: 'string', default: DEFAULT_OUTPUT_DIRECTORY },
      registry: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    process.stdout.write([
      'Usage: pnpm upstream:audit --target <commit-or-ref> [options]',
      '',
      `  --base <commit-or-ref>  comparison baseline (default: ${DEFAULT_BASE})`,
      '  --target <commit-or-ref> required upstream target; never guessed',
      `  --output-dir <path>     generated reports/state (default: ${DEFAULT_OUTPUT_DIRECTORY})`,
      '  --registry <path>       alternate seam registry (primarily for tests)',
      '',
      'The command performs no fetch, checkout, merge, rebase, build, package, install, or launch.',
      '',
    ].join('\n'))
    process.exit(0)
  }
  if (values.target === undefined || values.target.trim() === '') {
    throw new Error('missing required --target <commit-or-ref>; the auditor does not guess an upstream target')
  }
  return {
    base: values.base,
    target: values.target,
    outputDirectory: values['output-dir'],
    registryPath: values.registry,
  }
}

export function runUpstreamAuditCli(args: string[], cwd = process.cwd()): string {
  const options = parseOptions(args)
  const report = auditUpstreamRange(options, cwd)
  const paths = writeAuditReports(report, options.outputDirectory)
  const root = report.repositoryRoot
  return `${JSON.stringify({
    result: report.summary.overallResult,
    highestRisk: report.summary.highestRisk,
    manualReviewRequired: report.summary.manualReviewRequired,
    markdown: relative(root, paths.markdownPath),
    json: relative(root, paths.jsonPath),
    state: relative(root, paths.statePath),
  }, null, 2)}\n`
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(runUpstreamAuditCli(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`upstream audit failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
