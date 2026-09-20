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
    readonly prerequisite?: string
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
      phase: '8C.2k',
      status: 'stage-12-complete',
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
    expect(manifest.portOrder.slice(0, 12).map(stage => stage.status)).toEqual([
      'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE',
      'COMPLETE', 'COMPLETE', 'COMPLETE',
    ])
    expect(manifest.portOrder.slice(12).every(stage => stage.status === 'PENDING')).toBe(true)
    expect(manifest.compositionQualification).toEqual({
      profile: 'desktop-custom',
      upstreamTemplate: 'web',
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@deepseek-ai/dsh-desktop-custom',
      ],
      profilePatch: 'upstream-init-empty',
      customEntryIds: [
        'task-checkpoint',
        'agent-run-policy',
        'compaction-task-aware-policy',
        'runtime-diagnostics-controller',
        'compaction-task-aware-diagnostics-transport',
        'run-details',
        'ui-run-details',
      ],
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

  it('records the Stage 7 run state adaptation and its sixteen locked decisions', () => {
    const stageSeven = manifest.portOrder.filter(stage => stage.stage === 7)
    expect(stageSeven.length).toBe(1)
    expect(stageSeven.map(stage => stage.status)).toEqual(['COMPLETE'])
    expect(stageSeven.map(stage => stage.deliverables)).toEqual([[
      'packages/runtime-diagnostics/agent-run-state',
    ]])
    expect(stageSeven.flatMap(stage => stage.decisions ?? [])
      .map(decision => decision.slice(0, decision.indexOf(' ')))).toEqual([
      'D7.1', 'D7.2', 'D7.3', 'D7.4', 'D7.5', 'D7.6', 'D7.7', 'D7.8',
      'D7.9', 'D7.10', 'D7.11', 'D7.12', 'D7.13', 'D7.14', 'D7.15', 'D7.16',
    ])
    // Stages beyond the completed prefix stay pending, and Stage 7 introduces
    // no new durable event.
    expect(manifest.portOrder.filter(stage => stage.stage > 12).map(stage => stage.status))
      .toEqual(['PENDING'])
    expect(manifest.dataBoundary.sessionCompatibility.restoredFirstPartyRequiredEvents)
      .toEqual(['task/checkpoint', 'task/result-manifest'])
    expect(manifest.capabilities.filter(capability =>
      capability.id === 'run-state'
      || capability.id === 'backend-observation'
      || capability.id === 'error-classification',
    ).map(capability => capability.implementationStatus)).toEqual([
      'IMPLEMENTED_STAGE_7_TURN_SCOPED_RUN_IDENTITY',
      'IMPLEMENTED_STAGE_7_CONTRACT_ONLY_NO_ADAPTER',
      'IMPLEMENTED_STAGE_7_STRUCTURED_PRECEDENCE',
    ])
  })

  it('records the Stage 8 producers, guarded resume, and its twenty-one locked decisions', () => {
    const stageEight = manifest.portOrder.filter(stage => stage.stage === 8)
    expect(stageEight.length).toBe(1)
    expect(stageEight.map(stage => stage.status)).toEqual(['COMPLETE'])
    // The typed ignorable append seam landed before Stage 8 and is recorded as
    // its prerequisite, so the stage is auditable back to the seam commit.
    expect(stageEight.map(stage => stage.prerequisite)).toEqual(['5262a0cabb'])
    expect(stageEight.map(stage => stage.deliverables)).toEqual([[
      'packages/session/task-checkpoint',
      'packages/core/session',
    ]])
    expect(stageEight.flatMap(stage => stage.decisions ?? [])
      .map(decision => decision.slice(0, decision.indexOf(' ')))).toEqual([
      'D8.1', 'D8.2', 'D8.3', 'D8.4', 'D8.5', 'D8.6', 'D8.7', 'D8.8', 'D8.9', 'D8.10', 'D8.11',
      'D8.12', 'D8.13', 'D8.14', 'D8.15', 'D8.16', 'D8.17', 'D8.18', 'D8.19', 'D8.20', 'D8.21',
    ])
    expect(manifest.capabilities.find(capability => capability.id === 'task-checkpoint'))
      .toMatchObject({ implementationStatus: 'IMPLEMENTED_STAGE_8_PRODUCERS_AND_GUARDED_RESUME' })
    // Stage 8 restores guarded task continuity without adding a durable event.
    expect(manifest.dataBoundary.sessionCompatibility.restoredFirstPartyRequiredEvents)
      .toEqual(['task/checkpoint', 'task/result-manifest'])
    expect(manifest.portOrder.filter(stage => stage.stage > 12).map(stage => stage.status))
      .toEqual(['PENDING'])
  })

  it('records the Stage 9 reasoning and bounded retry policies and its fifteen locked decisions', () => {
    const stageNine = manifest.portOrder.filter(stage => stage.stage === 9)
    expect(stageNine.length).toBe(1)
    expect(stageNine.map(stage => stage.status)).toEqual(['COMPLETE'])
    expect(stageNine.map(stage => stage.deliverables)).toEqual([[
      'packages/runtime-diagnostics/reasoning-policy',
      'packages/runtime-diagnostics/agent-run-policy',
    ]])
    expect(stageNine.flatMap(stage => stage.decisions ?? [])
      .map(decision => decision.slice(0, decision.indexOf(' ')))).toEqual([
      'D9.1', 'D9.2', 'D9.3', 'D9.4', 'D9.5', 'D9.6', 'D9.7', 'D9.8',
      'D9.9', 'D9.10', 'D9.11', 'D9.12', 'D9.13', 'D9.14', 'D9.15',
    ])
    expect(manifest.capabilities.filter(capability =>
      capability.id === 'reasoning' || capability.id === 'run-policy',
    ).map(capability => capability.implementationStatus)).toEqual([
      'IMPLEMENTED_STAGE_9_BOUNDED_GATE_OVER_LLM_RETRY',
      'IMPLEMENTED_STAGE_9_CAPABILITY_RESOLVED_REQUESTED_VS_RESOLVED',
    ])
    // Stage 9 bounds reasoning and retry without adding a durable event, so the
    // restored required-event set is exactly the Stage 6 pair.
    expect(manifest.dataBoundary.sessionCompatibility.restoredFirstPartyRequiredEvents)
      .toEqual(['task/checkpoint', 'task/result-manifest'])
    expect(manifest.portOrder.filter(stage => stage.stage > 12).map(stage => stage.status))
      .toEqual(['PENDING'])
  })

  it('records the Stage 10 task-aware compaction adapter and its twenty-two locked decisions', () => {
    const stageTen = manifest.portOrder.filter(stage => stage.stage === 10)
    expect(stageTen.length).toBe(1)
    expect(stageTen.map(stage => stage.status)).toEqual(['COMPLETE'])
    expect(stageTen.map(stage => stage.deliverables)).toEqual([[
      'packages/compaction/compaction-task-aware-policy',
      'packages/compaction/compaction',
      'packages/compaction/compaction-basic',
      'packages/bundle/desktop-custom',
      'packages/session/task-checkpoint',
      'packages/runtime-diagnostics/agent-run-policy',
      'packages/llm/llm-retry',
      'apps/desktop',
    ]])
    const decisions = stageTen.flatMap(stage => stage.decisions ?? [])
    expect(decisions.map(decision => decision.slice(0, decision.indexOf(' ')))).toEqual([
      'D10.1', 'D10.2', 'D10.3', 'D10.4', 'D10.5', 'D10.6', 'D10.7', 'D10.8',
      'D10.9', 'D10.10', 'D10.11', 'D10.12', 'D10.13', 'D10.14', 'D10.15', 'D10.16',
      'D10.17', 'D10.18', 'D10.19', 'D10.20', 'D10.21', 'D10.22',
    ])
    // Every locked decision is pinned by its unique semantic anchor, so removing
    // a decision, renumbering it, or restating it more weakly fails this test
    // instead of passing on a count alone. The anchors are the architecture
    // review's D10.1-D10.22 claims, one per decision.
    const anchors: readonly (readonly [string, string])[] = [
      ['D10.1', 'sole compaction executor'],
      ['D10.2', 'thin generic candidate-policy seam'],
      ['D10.3', 'append-only replacement and audit events'],
      ['D10.4', 'latest authoritative TaskCheckpoint'],
      ['D10.5', 'completed-step evidence identities'],
      ['D10.6', 'ResultManifest remains separate authority'],
      ['D10.7', 'TOOL_NOT_STARTED and TOOL_OUTCOME_UNKNOWN remain distinct'],
      ['D10.8', 'objective, constraints, decisions, and criticalContext are protected'],
      ['D10.9', 'only non-authoritative historical narrative and context may be summarized'],
      ['D10.10', 'only safely discardable model-context material may be pruned'],
      ['D10.11', 'does not invent generic tool/result blob offload'],
      ['D10.12', 'protected context over capacity fails closed'],
      ['D10.13', 'stale compaction candidates fail publication'],
      ['D10.14', 'no second lock, lease, or generation'],
      ['D10.15', 'no projection cache and no new invalidation authority'],
      ['D10.16', 'deterministic and structural'],
      ['D10.17', 'low then at most medium'],
      ['D10.18', 'remain unchanged by auxiliary compaction reasoning'],
      ['D10.19', 'delegates to compaction recovery rather than ordinary Stage 9 retry'],
      ['D10.20', 'typed read-only compaction diagnostics'],
      ['D10.21', 'adds no new Session event type'],
      ['D10.22', 'package ownership'],
    ]
    expect(anchors.map(([id]) => id)).toEqual(decisions.map(decision => decision.slice(0, decision.indexOf(' '))))
    for (const [id, anchor] of anchors) {
      const decision = decisions.find(candidate => candidate.startsWith(`${id} `))
      expect(decision, id).toBeDefined()
      expect(decision, id).toContain(anchor)
    }
    expect(manifest.capabilities.find(capability => capability.id === 'compaction'))
      .toMatchObject({ implementationStatus: 'IMPLEMENTED_STAGE_10_TASK_AWARE_CANDIDATE_POLICY' })
    // The custom layer appends to the upstream composition prefix instead of
    // replacing it, so base and web-app stay first and the layer is the tail.
    expect(manifest.compositionQualification.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-desktop-custom',
    ])
    // Stage 10 left three custom rows; Stage 11 appended the diagnostics
    // carrier and the two Run Details rows to the same tail layer, so the
    // Stage 10 prefix is still first.
    expect(manifest.compositionQualification.customEntryIds.slice(0, 3)).toEqual([
      'task-checkpoint',
      'agent-run-policy',
      'compaction-task-aware-policy',
    ])
    // Stage 10 protects durable authority without adding a durable event, so the
    // restored required-event set is exactly the Stage 6 pair.
    expect(manifest.dataBoundary.sessionCompatibility.restoredFirstPartyRequiredEvents)
      .toEqual(['task/checkpoint', 'task/result-manifest'])
    expect(manifest.portOrder.filter(stage => stage.stage > 12).map(stage => stage.status))
      .toEqual(['PENDING'])
  })

  it('records the Stage 11 current-client Run Details integration and its twenty locked decisions', () => {
    const stageEleven = manifest.portOrder.filter(stage => stage.stage === 11)
    expect(stageEleven.length).toBe(1)
    expect(stageEleven.map(stage => stage.status)).toEqual(['COMPLETE'])
    expect(stageEleven.map(stage => stage.deliverables)).toEqual([[
      'packages/runtime-diagnostics/run-details',
      'packages/api/runtime-diagnostics-controller',
      'packages/compaction/compaction-task-aware-policy',
      'packages/client/ui-run-details',
      'packages/session/task-checkpoint',
      'packages/bundle/desktop-custom',
      'apps/desktop',
    ]])
    const decisions = stageEleven.flatMap(stage => stage.decisions ?? [])
    expect(decisions.map(decision => decision.slice(0, decision.indexOf(' ')))).toEqual([
      'D11.1', 'D11.2', 'D11.3', 'D11.4', 'D11.5', 'D11.6', 'D11.7',
      'D11.8', 'D11.9', 'D11.10', 'D11.11', 'D11.12', 'D11.13', 'D11.14',
      'D11.15', 'D11.16', 'D11.17', 'D11.18', 'D11.19', 'D11.20',
    ])
    // Every locked decision is pinned by its unique semantic anchor, so removing
    // a decision, renumbering it, or restating it more weakly fails this test
    // instead of passing on a count alone.
    const anchors: readonly (readonly [string, string])[] = [
      ['D11.1', 'narrow seam'],
      ['D11.2', 'idle closure'],
      ['D11.3', 'runIdFor'],
      ['D11.4', 'Unknown stays Unknown'],
      ['D11.5', 'no backend adapter'],
      ['D11.6', 'classified structured code'],
      ['D11.7', 'separate rows'],
      ['D11.8', 'consumed through one read-only reactive stream instead of staying unread'],
      ['D11.9', 'read-only'],
      ['D11.10', 'no new Session event type'],
      ['D11.11', 'desktop-custom tail patch'],
      ['D11.12', 'all folding happens in the host'],
      ['D11.13', 'change feed quiet'],
      ['D11.14', 'taskCheckpoint projection'],
      ['D11.15', 'guarded-resume decision is consumed read-only'],
      ['D11.16', 'distinct fact from the process-local transient diagnostics'],
      ['D11.17', 'generic transport-agnostic controller'],
      ['D11.18', 'separate ./diagnostics-transport entry point'],
      ['D11.19', 'existing ResourceRegistry useResource seat'],
      ['D11.20', 'never promoted to durable authority'],
    ]
    expect(anchors.map(([id]) => id)).toEqual(decisions.map(decision => decision.slice(0, decision.indexOf(' '))))
    for (const [id, anchor] of anchors) {
      const decision = decisions.find(candidate => candidate.startsWith(`${id} `))
      expect(decision, id).toBeDefined()
      expect(decision, id).toContain(anchor)
    }
    expect(manifest.capabilities.find(capability => capability.id === 'diagnostics-ui'))
      .toMatchObject({ implementationStatus: 'IMPLEMENTED_STAGE_11_READ_ONLY_PROJECTION_AND_DOCK' })
    // Stage 11 inserts into the current client instead of forking it: the
    // diagnostics carrier and both Run Details rows are appended to the same
    // tail layer, so base and web-app stay first and the official client roster
    // is untouched.
    expect(manifest.compositionQualification.customEntryIds).toEqual([
      'task-checkpoint',
      'agent-run-policy',
      'compaction-task-aware-policy',
      'runtime-diagnostics-controller',
      'compaction-task-aware-diagnostics-transport',
      'run-details',
      'ui-run-details',
    ])
    // Run Details is a read-only surface over already-committed events, so the
    // restored required-event set is still exactly the Stage 6 pair.
    expect(manifest.dataBoundary.sessionCompatibility.restoredFirstPartyRequiredEvents)
      .toEqual(['task/checkpoint', 'task/result-manifest'])
    expect(manifest.portOrder.filter(stage => stage.stage > 12).map(stage => stage.status))
      .toEqual(['PENDING'])
  })

  it('records the Stage 12 maintenance plane port and its sixteen locked decisions', () => {
    const stageTwelve = manifest.portOrder.filter(stage => stage.stage === 12)
    expect(stageTwelve.length).toBe(1)
    expect(stageTwelve.map(stage => stage.status)).toEqual(['COMPLETE'])
    expect(stageTwelve.map(stage => stage.deliverables)).toEqual([[
      'scripts/upstream-audit.ts',
      'scripts/upstream-monitor.ts',
      'scripts/upstream-schedule.ts',
      'scripts/upstream-tracking-seams.json',
      'scripts/upstream-audit.spec.ts',
      'scripts/upstream-tracking-seams.spec.ts',
      'scripts/upstream-monitor.spec.ts',
      'scripts/upstream-schedule.spec.ts',
      '.agents/notes/implemented/architecture/2026-09-17-upstream-tracking-read-only-auditor.md',
      '.agents/notes/implemented/architecture/2026-09-17-incremental-upstream-monitor.md',
      '.agents/notes/implemented/architecture/2026-09-17-upstream-monitor-scheduling-and-notification.md',
      '.agents/notes/implemented/architecture/2026-09-17-upstream-scheduler-maintenance-runtime-resilience.md',
      'package.json',
    ]])
    const decisions = stageTwelve.flatMap(stage => stage.decisions ?? [])
    expect(decisions.map(decision => decision.slice(0, decision.indexOf(' ')))).toEqual([
      'D12.1', 'D12.2', 'D12.3', 'D12.4', 'D12.5', 'D12.6', 'D12.7', 'D12.8',
      'D12.9', 'D12.10', 'D12.11', 'D12.12', 'D12.13', 'D12.14', 'D12.15', 'D12.16',
    ])
    // Every locked decision is pinned by its unique semantic anchor, so removing
    // a decision, renumbering it, or restating it more weakly fails this test
    // instead of passing on a count alone.
    const anchors: readonly (readonly [string, string])[] = [
      ['D12.1', 'repository-plane only'],
      ['D12.2', 'eleven stable seam IDs'],
      ['D12.3', 'no new seam'],
      ['D12.4', 'retained even though the historical package-set implementation is retired'],
      ['D12.5', 'read-only and separate from fetch'],
      ['D12.6', 'no commit identifier is embedded'],
      ['D12.7', 'no migration'],
      ['D12.8', 'advances only after'],
      ['D12.9', 'debounced'],
      ['D12.10', 'cannot trigger a notification'],
      ['D12.11', 'pending'],
      ['D12.12', 'lexical stable'],
      ['D12.13', 'ownership'],
      ['D12.14', 'never auto-adapts'],
      ['D12.15', 'retired package roots'],
      ['D12.16', 'temporary'],
    ]
    expect(anchors.map(([id]) => id)).toEqual(decisions.map(decision => decision.slice(0, decision.indexOf(' '))))
    for (const [id, anchor] of anchors) {
      const decision = decisions.find(candidate => candidate.startsWith(`${id} `))
      expect(decision, id).toBeDefined()
      expect(decision, id).toContain(anchor)
    }
    // The maintenance plane lands outside the product runtime, adds no capability,
    // and leaves the debt classification and the eleven seams untouched.
    expect(manifest.compositionQualification.customEntryIds).toEqual([
      'task-checkpoint',
      'agent-run-policy',
      'compaction-task-aware-policy',
      'runtime-diagnostics-controller',
      'compaction-task-aware-diagnostics-transport',
      'run-details',
      'ui-run-details',
    ])
    expect(manifest.seams.map(seam => seam.id).sort()).toEqual([...seamIds].sort())
    expect(manifest.compatibilityDebt).toMatchObject({
      severity: 'CRITICAL', impact: 'BLOCKING_CHANGE', resolution: 'UNRESOLVED',
    })
    // Stage 12 touches no Session event, so the restored required-event set is
    // still exactly the Stage 6 pair.
    expect(manifest.dataBoundary.sessionCompatibility.restoredFirstPartyRequiredEvents)
      .toEqual(['task/checkpoint', 'task/result-manifest'])
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
