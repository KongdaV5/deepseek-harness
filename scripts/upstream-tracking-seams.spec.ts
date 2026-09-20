import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSeamRegistry, matchesAnyPath } from './upstream-audit.ts'

const registryPath = resolve(import.meta.dirname, 'upstream-tracking-seams.json')

const STABLE_SEAM_IDS = [
  'desktop-product-identity-isolation',
  'desktop-packaging-runtime-tree',
  'package-set-custom-composition',
  'client-package-export-loader',
  'profile-settings-session-boundary',
  'agent-run-event-contract',
  'llm-provider-stream-contract',
  'session-projection-persistence-contract',
  'compaction-token-surface-contract',
  'diagnostics-remote-ui-contract',
  'native-runtime-abi-closure',
]

/** Stage 1–11 custom capability packages the auditor must still watch. */
const CURRENT_CAPABILITY_PACKAGES = [
  'packages/session/task-checkpoint',
  'packages/session/session-checkpoint-policy',
  'packages/runtime-diagnostics/agent-lifecycle-facts',
  'packages/runtime-diagnostics/agent-run-state',
  'packages/runtime-diagnostics/reasoning-policy',
  'packages/runtime-diagnostics/agent-run-policy',
  'packages/runtime-diagnostics/run-details',
  'packages/compaction/compaction-task-aware-policy',
  'packages/compaction/compaction-basic',
  'packages/api/runtime-diagnostics-controller',
  'packages/client/ui-run-details',
  'packages/llm/llm-retry',
  'packages/bundle/desktop-custom',
]

describe('current compatibility seam registry', () => {
  it('keeps one registry per maintenance baseline and the eleven stable seam IDs', () => {
    const registry = loadSeamRegistry(registryPath)

    expect(registry.formatVersion).toBe(1)
    expect(registry.baseline).toBe('ds-harness-product-baseline-2026-09-17')
    expect(registry.seams.map(seam => seam.id)).toEqual(STABLE_SEAM_IDS)
  })

  it('gives every seam complete, non-empty contract evidence', () => {
    const registry = loadSeamRegistry(registryPath)

    for (const seam of registry.seams) {
      expect(seam.description.length).toBeGreaterThan(0)
      expect(seam.interface.length).toBeGreaterThan(0)
      expect(seam.whyItMatters.length).toBeGreaterThan(0)
      expect(seam.failureMode.length).toBeGreaterThan(0)
      expect(seam.detectionMethod.length).toBeGreaterThan(0)
      expect(seam.upstreamPaths.length).toBeGreaterThan(0)
      expect(seam.contractPaths.length).toBeGreaterThan(0)
      expect(seam.customPaths.length).toBeGreaterThan(0)
      expect(seam.tests.length).toBeGreaterThan(0)
      for (const contractPath of seam.contractPaths) {
        expect(matchesAnyPath(contractPath, seam.upstreamPaths)).toBe(true)
      }
    }
  })

  it('retires the historical package-set implementation while keeping the seam ID', () => {
    const registry = loadSeamRegistry(registryPath)
    const composition = registry.seams.find(seam => seam.id === 'package-set-custom-composition')

    expect(composition?.description).toMatch(/desktop-custom/u)
    expect(composition?.description).toMatch(/retired/u)
    // The obsolete package-set packages must not be tracked as current evidence.
    for (const path of [...(composition?.customPaths ?? []), ...(composition?.upstreamPaths ?? [])]) {
      expect(path).not.toMatch(/desktop-(?:custom|dev)-composition/u)
    }
    expect(composition?.customPaths).toContain('packages/bundle/desktop-custom/**')
  })

  it('tracks the Stage 11 transport primitives under the existing diagnostics seam', () => {
    const registry = loadSeamRegistry(registryPath)
    const diagnostics = registry.seams.find(seam => seam.id === 'diagnostics-remote-ui-contract')

    for (const primitive of [
      'packages/typert/**/src/**',
      'packages/api/gateway/src/**',
      'packages/api/remotes/src/**',
      'packages/client/connection/src/client/resources/**',
      'packages/client/ui-dockkit/src/**',
    ]) {
      expect(diagnostics?.contractPaths).toContain(primitive)
    }
    expect(diagnostics?.customPaths).toContain('packages/runtime-diagnostics/run-details/**')
    expect(diagnostics?.customPaths).toContain('packages/api/runtime-diagnostics-controller/**')
    expect(diagnostics?.customPaths).toContain('packages/compaction/compaction-task-aware-policy/src/diagnostics-transport.ts')
    expect(diagnostics?.customPaths).toContain('packages/client/ui-run-details/**')
  })

  it('tracks the Stage 10 compaction and Stage 8 task-continuity contracts', () => {
    const registry = loadSeamRegistry(registryPath)
    const compaction = registry.seams.find(seam => seam.id === 'compaction-token-surface-contract')
    const session = registry.seams.find(seam => seam.id === 'session-projection-persistence-contract')
    const events = registry.seams.find(seam => seam.id === 'agent-run-event-contract')

    expect(compaction?.customPaths).toContain('packages/compaction/compaction-task-aware-policy/**')
    expect(compaction?.upstreamPaths).toContain('packages/llm/token-meter/**')
    expect(compaction?.contractPaths).toContain('packages/llm/token-meter/src/**')

    expect(session?.customPaths).toContain('packages/session/session-checkpoint-policy/**')
    expect(session?.upstreamPaths).toContain('packages/api/session-controller/**')
    expect(session?.contractPaths).toContain('packages/session/session-persistence/src/storage-contract.ts')

    expect(events?.customPaths).toContain('packages/runtime-diagnostics/agent-lifecycle-facts/**')
    expect(events?.upstreamPaths).toContain('packages/core/agent-loop/**')
  })

  it('never tracks a retired package root that the current workspace no longer contains', () => {
    const source = readFileSync(registryPath, 'utf8')
    const registry = loadSeamRegistry(registryPath)
    const tracked = registry.seams.flatMap(seam => [
      ...seam.upstreamPaths,
      ...seam.contractPaths,
      ...seam.customPaths,
    ])

    // `packages/agent`, `packages/provider`, `packages/token-meter`,
    // `packages/profile`, `packages/config`, `packages/core/loader` and
    // `packages/guard/*` belonged to the historical product surface only.
    expect(tracked.some(path => path.startsWith('packages/agent/'))).toBe(false)
    expect(tracked.some(path => path.startsWith('packages/provider/'))).toBe(false)
    expect(tracked.some(path => path === 'packages/token-meter/**')).toBe(false)
    expect(tracked.some(path => path.startsWith('packages/profile/'))).toBe(false)
    expect(tracked.some(path => path.startsWith('packages/config/'))).toBe(false)
    expect(tracked.some(path => path.startsWith('packages/core/loader/'))).toBe(false)
    expect(tracked.some(path => path.startsWith('packages/guard/'))).toBe(false)
    expect(tracked.some(path => path.startsWith('packages/session/session-controller/'))).toBe(false)

    // A registry is evidence, not a source of stale commit identifiers.
    expect(source).not.toMatch(/"[0-9a-f]{7,40}"/u)
    expect(source).not.toMatch(/[0-9a-f]{40}/u)
  })

  it('resolves every tracked Stage 6-11 capability package in the current workspace', () => {
    const registry = loadSeamRegistry(registryPath)
    const customPaths = registry.seams.flatMap(seam => seam.customPaths)

    for (const capability of CURRENT_CAPABILITY_PACKAGES) {
      expect(customPaths.some(pattern => (
        pattern === `${capability}/**`
        || pattern === `${capability}/src/**`
        || pattern.startsWith(`${capability}/src/`)
      ))).toBe(true)
    }
  })
})
