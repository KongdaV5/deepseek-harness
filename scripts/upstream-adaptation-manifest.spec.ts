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
  readonly dataBoundary: {
    readonly official: { readonly profile: string; readonly settings: string; readonly sessions: string }
    readonly dsHarness: { readonly profile: string; readonly settings: string; readonly sessions: string; readonly candidateMode: string }
    readonly candidateRehearsal: {
      readonly liveSharedDataMigrationAllowed: boolean
      readonly pathEscape: string
    }
    readonly profileCompatibility: { readonly classification: string }
    readonly settingsCompatibility: {
      readonly classification: string
      readonly automaticWritebackOnRead: boolean
      readonly baselineProviderBlob: string
      readonly targetProviderBlob: string
    }
    readonly sessionCompatibility: {
      readonly baselineVersion: number
      readonly targetVersion: number
      readonly persistenceProviderUnchanged: boolean
      readonly baselineProviderBlob: string
      readonly targetProviderBlob: string
      readonly migrationTrigger: string
      readonly mutationMode: string
      readonly rollbackClassification: string
      readonly targetOnlyRequiredEvents: readonly string[]
      readonly removedRequiredCustomEvents: readonly string[]
      readonly restoredFirstPartyRequiredEvents: readonly string[]
      readonly customEventBehavior: string
    }
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
  readonly compositionQualification: {
    readonly profile: string
    readonly upstreamTemplate: string
    readonly bundles: readonly string[]
    readonly profilePatch: string
    readonly customEntryIds: readonly string[]
    readonly upstreamNativeOwner: readonly string[]
    readonly legacyComposition: string
  }
  readonly portOrder: readonly {
    readonly stage: number
    readonly status: string
    readonly stopGate: string
    readonly tests: readonly string[]
    readonly deliverables?: readonly string[]
    readonly decisions?: readonly string[]
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
      phase: '8C.2e',
      status: 'stage-6-complete',
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
    expect(manifest.capabilities.find(capability => capability.id === 'data-boundaries')).toMatchObject({
      status: 'REWRITE_REQUIRED', action: 'REIMPLEMENT', implementationStatus: 'IMPLEMENTED_STAGE_3',
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
    expect(manifest.portOrder.slice(0, 6).map(stage => stage.status)).toEqual([
      'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE',
    ])
    expect(manifest.portOrder.slice(6).every(stage => stage.status === 'PENDING')).toBe(true)
    expect(manifest.compositionQualification).toEqual({
      profile: 'desktop-custom',
      upstreamTemplate: 'web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      profilePatch: 'upstream-init-empty',
      customEntryIds: [],
      upstreamNativeOwner: [
        'Cordis bundle layering',
        'generated client module roster',
        'agent/session/checkpoint/retry/compaction services',
      ],
      legacyComposition: 'REJECTED_FAIL_CLOSED',
    })
  })

  it('records the Stage 3 sharing, compatibility, and rollback classifications', () => {
    expect(manifest.dataBoundary.official).toMatchObject({
      profile: 'desktop', settings: 'shared-global', sessions: 'shared-global',
    })
    expect(manifest.dataBoundary.dsHarness).toMatchObject({
      profile: 'desktop-custom', settings: 'shared-global', sessions: 'shared-global',
      candidateMode: 'REHEARSAL_ONLY',
    })
    expect(manifest.dataBoundary.candidateRehearsal).toEqual({
      selector: 'DSH_DESKTOP_DATA_MODE=candidate-rehearsal',
      root: 'DSH_DESKTOP_REHEARSAL_ROOT',
      dshHomeChild: 'dsh-home',
      electronChild: 'electron/<flavor-id>',
      historicalSessionRead: 'FIXTURE_COPY_ONLY',
      liveSharedDataMigrationAllowed: false,
      pathEscape: 'FAIL_CLOSED',
    })
    expect(manifest.dataBoundary.profileCompatibility.classification).toBe('MIGRATION_REQUIRED')
    expect(manifest.dataBoundary.settingsCompatibility).toMatchObject({
      classification: 'BIDIRECTIONAL_COMPATIBLE', automaticWritebackOnRead: false,
    })
    expect(manifest.dataBoundary.settingsCompatibility.baselineProviderBlob)
      .toBe(manifest.dataBoundary.settingsCompatibility.targetProviderBlob)
    expect(manifest.dataBoundary.sessionCompatibility).toMatchObject({
      baselineVersion: 3,
      targetVersion: 3,
      persistenceProviderUnchanged: true,
      migrationTrigger: 'READ_OPEN_PREPARES_IN_MEMORY_WRITE_OPEN_PUBLISHES_SUCCESSOR',
      mutationMode: 'IMMUTABLE_SUCCESSOR_GENERATION',
      rollbackClassification: 'ROLLBACK_SAFE_WITH_BACKUP_RESTORE',
      targetOnlyRequiredEvents: ['image/offload', 'workspace/changes'],
      removedRequiredCustomEvents: [],
      customEventBehavior: 'RESTORED_FIRST_PARTY_REQUIRED_EVENTS_READ_WITHOUT_REWRITE',
    })
    expect(manifest.dataBoundary.sessionCompatibility.baselineProviderBlob)
      .toBe(manifest.dataBoundary.sessionCompatibility.targetProviderBlob)
  })

  it('records the Stage 6 event restoration and its six locked decisions', () => {
    expect(manifest.dataBoundary.sessionCompatibility.restoredFirstPartyRequiredEvents)
      .toEqual(['task/checkpoint', 'task/result-manifest'])
    const stageSix = manifest.portOrder.filter(stage => stage.stage === 6)
    expect(stageSix.length).toBe(1)
    expect(stageSix.map(stage => stage.status)).toEqual(['COMPLETE'])
    expect(stageSix.map(stage => stage.deliverables)).toEqual([[
      'packages/session/task-checkpoint',
      'packages/runtime-diagnostics/agent-lifecycle-facts',
      'docs/persistence-changes/2026-09-18-restore-task-checkpoint-events',
    ]])
    expect(stageSix.flatMap(stage => stage.decisions ?? []).map(decision => decision.slice(0, 3))).toEqual([
      'D1 ', 'D2 ', 'D3 ', 'D4 ', 'D5 ', 'D6 ',
    ])
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
