import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Manifest {
  readonly formatVersion: number
  readonly phase: string
  readonly status: string
  readonly target: { readonly sha: string }
  readonly source: {
    readonly productBaselineTag: string
    readonly productBaselineSha: string
    readonly technicalBaselineTag: string
    readonly technicalBaselineSha: string
  }
  readonly statusValues: readonly string[]
  readonly actionValues: readonly string[]
  readonly capabilities: readonly {
    readonly id: string
    readonly status: string
    readonly action: string
    readonly implementationStatus?: string
    readonly validation: readonly string[]
  }[]
  readonly seams: readonly {
    readonly id: string
    readonly oldContract: string
    readonly newContract: string
    readonly breakage: string
    readonly migration: string
    readonly risk: string
    readonly validation: readonly string[]
  }[]
  readonly strategy: { readonly chosen: string }
  readonly portOrder: readonly {
    readonly stage: number
    readonly status: string
    readonly stopGate: string
    readonly tests: readonly string[]
  }[]
  readonly contractEvidencePaths: readonly string[]
  readonly compatibilityDebt: { readonly severity: string; readonly impact: string; readonly resolution: string }
}

const root = resolve(import.meta.dirname, '..')
const path = resolve(root, '.agents/notes/implemented/architecture/2026-09-17-upstream-adaptation-strategy.manifest.json')
const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest

const seamIds = [
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
] as const

describe('Phase 8C upstream adaptation manifest', () => {
  it('locks the audited target and immutable source baselines', () => {
    expect(manifest).toMatchObject({
      formatVersion: 1,
      phase: '8C.2a',
      status: 'stage-2-complete',
      target: { sha: 'ddefc45fbc7f8e46dd73185e68295696d1297887' },
      source: {
        productBaselineTag: 'ds-harness-product-baseline-2026-09-17',
        productBaselineSha: 'bfba98b9bd9390735242ad57840050850a3c11b5',
        technicalBaselineTag: 'dsh-custom-baseline-2026-09-17',
        technicalBaselineSha: '9d9762e7d2567248050559f2ac1b04e9f2a766f2',
      },
    })
  })

  it('classifies every capability with declared values and concrete validation', () => {
    expect(manifest.capabilities.length).toBeGreaterThanOrEqual(10)
    expect(new Set(manifest.capabilities.map(item => item.id)).size).toBe(manifest.capabilities.length)
    for (const capability of manifest.capabilities) {
      expect(manifest.statusValues).toContain(capability.status)
      expect(manifest.actionValues).toContain(capability.action)
      expect(capability.validation.length).toBeGreaterThan(0)
    }
    expect(manifest.capabilities.find(capability => capability.id === 'product-identity')).toMatchObject({
      status: 'PORT_WITH_ADAPTATION', action: 'PORT', implementationStatus: 'IMPLEMENTED_STAGE_2',
    })
  })

  it('covers the eleven registered seams with migration and validation contracts', () => {
    expect(manifest.seams.map(seam => seam.id).sort()).toEqual([...seamIds].sort())
    for (const seam of manifest.seams) {
      expect(seam.oldContract.length).toBeGreaterThan(10)
      expect(seam.newContract.length).toBeGreaterThan(10)
      expect(seam.breakage.length).toBeGreaterThan(10)
      expect(seam.migration.length).toBeGreaterThan(10)
      expect(['MEDIUM', 'HIGH', 'CRITICAL']).toContain(seam.risk)
      expect(seam.validation.length).toBeGreaterThan(0)
    }
  })

  it('selects exactly the latest-upstream semantic-port strategy and fail-fast stages', () => {
    expect(manifest.strategy.chosen).toBe('B')
    expect(manifest.portOrder.map(stage => stage.stage)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1))
    for (const stage of manifest.portOrder) {
      expect(stage.tests.length).toBeGreaterThan(0)
      expect(stage.stopGate.length).toBeGreaterThan(10)
    }
    expect(manifest.portOrder.slice(0, 2).map(stage => stage.status)).toEqual(['COMPLETE', 'COMPLETE'])
    expect(manifest.portOrder.slice(2).every(stage => stage.status === 'PENDING')).toBe(true)
  })

  it('keeps compatibility debt unresolved and every cited contract path discoverable', () => {
    expect(manifest.compatibilityDebt).toMatchObject({
      severity: 'CRITICAL', impact: 'BLOCKING_CHANGE', resolution: 'UNRESOLVED',
    })
    expect(manifest.contractEvidencePaths.length).toBeGreaterThan(10)
    for (const evidencePath of manifest.contractEvidencePaths) {
      expect(existsSync(resolve(root, evidencePath)), evidencePath).toBe(true)
    }
  })
})
