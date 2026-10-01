/**
 * Task-aware admission: the order of the obstacles, the manual exemption, and
 * the task-less fail-open that keeps a policy-free Session byte-identical.
 */

import { describe, expect, it } from 'vitest'
import { admitTaskAware } from '../src/eligibility.ts'
import { taskRepairHazards } from '../src/protection.ts'
import { TASK_ID, hazard, foreignHazard, protection, snapshot } from './fixtures.ts'

describe('a Session that tracks no Task', () => {
  it('admits exactly as if no policy were installed, and asks for no block', () => {
    const admission = admitTaskAware({
      trigger: 'pressure',
      hazards: [],
      beforeTokens: 10_000,
      protectedTokens: 0,
    })
    expect(admission).toEqual({ admitted: true, taskAware: false, hazards: [] })
    expect(admission.protection).toBeUndefined()
  })

  it('makes no capacity claim even when the surface is enormous', () => {
    expect(admitTaskAware({
      trigger: 'context-overflow',
      hazards: [hazard('TOOL_OUTCOME_UNKNOWN')],
      beforeTokens: 1_000_000,
      protectedTokens: 999_999,
      usableInputTokens: 10,
    }).admitted).toBe(true)
  })
})

describe('an admitted task-aware operation', () => {
  it('carries the captured protection and echoes the hazards', () => {
    const root = protection()
    const hazards = [hazard('TOOL_NOT_STARTED')]
    expect(admitTaskAware({
      trigger: 'pressure',
      hazards,
      protection: root,
      beforeTokens: 10_000,
      protectedTokens: 800,
      usableInputTokens: 8_000,
    })).toEqual({ admitted: true, taskAware: true, protection: root, hazards })
  })

  it('admits a protected context that leaves room in the budget', () => {
    expect(admitTaskAware({
      trigger: 'pressure',
      hazards: [],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 7_999,
      usableInputTokens: 8_000,
    }).admitted).toBe(true)
  })

  it('admits when no capacity could be resolved, asserting no claim it cannot prove', () => {
    expect(admitTaskAware({
      trigger: 'pressure',
      hazards: [],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 9_999,
      usableInputTokens: undefined,
    }).admitted).toBe(true)
  })

  it('admits a not-started tool, because nothing ran', () => {
    expect(admitTaskAware({
      trigger: 'pressure',
      hazards: [hazard('TOOL_NOT_STARTED')],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 100,
      usableInputTokens: 8_000,
    }).admitted).toBe(true)
  })
})

describe('automatic admission refusals', () => {
  it('refuses an unknown external side effect before anything destructive runs', () => {
    const admission = admitTaskAware({
      trigger: 'pressure',
      hazards: [hazard('TOOL_NOT_STARTED'), hazard('TOOL_OUTCOME_UNKNOWN')],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 100,
      usableInputTokens: 8_000,
    })
    expect(admission.admitted).toBe(false)
    expect(admission.taskAware).toBe(false)
    expect(admission.block?.code).toBe('TASK_REPAIR_HAZARD_OUTCOME_UNKNOWN')
    expect(admission.block?.detail).toContain('TOOL_OUTCOME_UNKNOWN')
    // The hazards stay visible even on refusal, so a caller can report them.
    expect(admission.hazards).toHaveLength(2)
  })

  it('refuses the same hazard for the automatic context-overflow entry', () => {
    expect(admitTaskAware({
      trigger: 'context-overflow',
      hazards: [hazard('TOOL_OUTCOME_UNKNOWN')],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 100,
      usableInputTokens: 8_000,
    }).block?.code).toBe('TASK_REPAIR_HAZARD_OUTCOME_UNKNOWN')
  })

  it('lets an explicit human request proceed, because the human already owns the hazard', () => {
    expect(admitTaskAware({
      trigger: 'manual',
      hazards: [hazard('TOOL_OUTCOME_UNKNOWN')],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 100,
      usableInputTokens: 8_000,
    }).admitted).toBe(true)
  })

  it('refuses a protected context that already consumes the whole budget', () => {
    const admission = admitTaskAware({
      trigger: 'pressure',
      hazards: [],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 8_000,
      usableInputTokens: 8_000,
    })
    expect(admission.admitted).toBe(false)
    expect(admission.block?.code).toBe('TASK_PROTECTED_CONTEXT_OVER_CAPACITY')
    expect(admission.block?.detail).toContain('no protected field may be truncated')
  })

  it('lets the most authoritative obstacle decide first', () => {
    // Both obstacles are present: an unknown side effect outranks capacity,
    // because refusing for capacity would invite a caller to make room for a
    // compaction that must not happen at all.
    expect(admitTaskAware({
      trigger: 'pressure',
      hazards: [hazard('TOOL_OUTCOME_UNKNOWN')],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 9_999,
      usableInputTokens: 8_000,
    }).block?.code).toBe('TASK_REPAIR_HAZARD_OUTCOME_UNKNOWN')
  })

  it('reads only the addressed Task\u2019s hazards, which is what the caller passes in', () => {
    const theirs = foreignHazard('TOOL_OUTCOME_UNKNOWN', 'another-task')
    // Admission trusts the hazards it is handed, so the filter that makes that
    // safe is part of the contract: only the addressed Task's own hazards are.
    const cut = snapshot({ repairHazards: [theirs] })
    expect(taskRepairHazards(cut, String(TASK_ID))).toEqual([])
    expect(admitTaskAware({
      trigger: 'pressure',
      hazards: taskRepairHazards(cut, String(TASK_ID)),
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 100,
      usableInputTokens: 8_000,
    }).admitted).toBe(true)
    // Handing in an unfiltered list is the caller's error, and it is not silent.
    expect(admitTaskAware({
      trigger: 'pressure',
      hazards: [theirs],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 100,
      usableInputTokens: 8_000,
    }).block?.code).toBe('TASK_REPAIR_HAZARD_OUTCOME_UNKNOWN')
  })

  it('keeps the protected Task identity out of the refusal path', () => {
    const admission = admitTaskAware({
      trigger: 'pressure',
      hazards: [hazard('TOOL_OUTCOME_UNKNOWN')],
      protection: protection(),
      beforeTokens: 10_000,
      protectedTokens: 100,
      usableInputTokens: 8_000,
    })
    // A refusal publishes nothing, so it must not carry the protection root.
    expect(admission.protection).toBeUndefined()
    expect(String(TASK_ID)).toBe('task-1')
  })
})
