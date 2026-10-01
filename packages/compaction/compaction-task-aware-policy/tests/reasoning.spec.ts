/**
 * The compacting auxiliary reasoning ladder: exactly `low` then `medium`, never
 * the main Run's effort, and never an effort the route does not advertise.
 */

import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ReasoningCapability } from '@deepseek-ai/dsh-reasoning-policy'
import { AUXILIARY_REASONING_LADDER, resolveAuxiliaryReasoning } from '../src/reasoning.ts'
import { TaskAwarePolicyError } from '../src/errors.ts'

/** One advertised effort listing. */
function capability(efforts: readonly string[], defaultEffort?: string): ReasoningCapability {
  return {
    efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
    ...defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) },
  }
}

/** The ladder, for a route advertising all of it. */
const FULL = capability(['none', 'low', 'medium', 'high', 'xhigh'], 'xhigh')

describe('the ladder', () => {
  it('is exactly two rungs, cheapest first', () => {
    expect(AUXILIARY_REASONING_LADDER).toEqual(['low', 'medium'])
  })

  it('resolves rung zero to low and rung one to medium', () => {
    expect(resolveAuxiliaryReasoning('p', 'm', FULL, 0)).toMatchObject({ attempt: 0, label: 'low' })
    expect(resolveAuxiliaryReasoning('p', 'm', FULL, 1)).toMatchObject({ attempt: 1, label: 'medium' })
  })

  it('has no third rung and no fallback to the main Run effort', () => {
    for (const attempt of [2, 3, -1]) {
      try {
        resolveAuxiliaryReasoning('p', 'm', FULL, attempt)
        throw new Error(`expected rung ${String(attempt)} to be refused`)
      } catch (error) {
        expect(error).toBeInstanceOf(TaskAwarePolicyError)
        expect((error as TaskAwarePolicyError).code).toBe('TASK_AUXILIARY_REASONING_UNSUPPORTED')
      }
    }
  })

  it('reports the truthful resolution, including the provider default', () => {
    const step = resolveAuxiliaryReasoning('p', 'm', FULL, 0)
    expect(step.resolution.kind).toBe('resolved')
    expect(step.resolution.kind === 'resolved' && step.resolution.source).toBe('request')
    expect(step.resolution.kind === 'resolved' && step.resolution.requested).toBe(ReasoningEffortId('low'))
  })
})

describe('routes that do not advertise a rung', () => {
  it('refuses to request an effort the route does not publish', () => {
    // Asking anyway would turn a policy question into a provider error.
    const lowOnly = capability(['low'])
    expect(resolveAuxiliaryReasoning('p', 'm', lowOnly, 0).label).toBe('low')
    try {
      resolveAuxiliaryReasoning('p', 'm', lowOnly, 1)
      throw new Error('expected the unsupported rung to fail closed')
    } catch (error) {
      expect((error as TaskAwarePolicyError).code).toBe('TASK_AUXILIARY_REASONING_UNSUPPORTED')
      expect((error as TaskAwarePolicyError).message).toContain('medium')
    }
  })

  it('fails closed when the route declares no reasoning capability at all', () => {
    try {
      resolveAuxiliaryReasoning('p', 'm', undefined, 0)
      throw new Error('expected a route with no capability to fail closed')
    } catch (error) {
      expect((error as TaskAwarePolicyError).code).toBe('TASK_AUXILIARY_REASONING_UNSUPPORTED')
      expect((error as TaskAwarePolicyError).message).toContain('route-declares-no-reasoning')
    }
  })

  it('never resolves above the ladder, even when the route advertises more', () => {
    const step = resolveAuxiliaryReasoning('p', 'm', FULL, 1)
    expect(step.resolution.kind).toBe('resolved')
    const resolved = step.resolution.kind === 'resolved' ? step.resolution.requested : undefined
    expect(resolved).toBe(ReasoningEffortId('medium'))
    expect(String(resolved)).not.toBe('xhigh')
  })
})
