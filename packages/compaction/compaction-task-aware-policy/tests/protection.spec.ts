/**
 * The code-rendered protection graph: canonical serialization, the deterministic
 * digest, the delimited block, and the fail-closed capture rules.
 */

import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  manifestReferenceDigest,
  protectTaskAuthority,
  protectionDigest,
  taskRepairHazards,
  unknownOutcomeHazard,
} from '../src/protection.ts'
import {
  headerField,
  parseTaskProtectionBlocks,
  protectedContextExceedsCapacity,
  renderTaskProtectionBlock,
  taskProtectionContent,
  taskProtectionSupplement,
  textOfContent,
  usableInputTokens,
} from '../src/context.ts'
import { TaskAwarePolicyError } from '../src/errors.ts'
import { TASK_COMPACTION_BLOCK_CLOSE, TASK_COMPACTION_BLOCK_OPEN } from '../src/types.ts'
import {
  OUTPUT_ID,
  STEP_ID,
  TASK_ID,
  TOOL_EVENT_SEQ,
} from './fixtures.ts'
import { checkpoint, foreignHazard, hazard, manifest, protection, snapshot, tasklessSnapshot } from './fixtures.ts'

describe('canonical serialization', () => {
  it('is independent of object key order and omits undefined properties', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson({ a: { d: 1, c: [1, { z: 1, y: 2 }] } }))
      .toBe('{"a":{"c":[1,{"y":2,"z":1}],"d":1}}')
  })

  it('preserves array order because array order is data', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]')
  })

  it('rejects a value no durable record could carry instead of coercing it', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow('not a finite number')
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow('not a finite number')
    expect(() => canonicalJson({ f: () => 1 })).toThrow('unsupported value of type function')
    expect(() => canonicalJson(undefined)).toThrow('unsupported value of type undefined')
  })
})

describe('the protection digest', () => {
  it('is a stable lowercase sha-256 over the canonical text', () => {
    const digest = protectionDigest('{"a":1}')
    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(protectionDigest('{"a":1}')).toBe(digest)
    expect(protectionDigest('{"a":2}')).not.toBe(digest)
  })

  it('digests the referenced result revision set deterministically', () => {
    const a = manifestReferenceDigest([{ outputId: String(OUTPUT_ID), revision: 2, status: 'completed', validation: 'passed' }])
    const b = manifestReferenceDigest([{ outputId: String(OUTPUT_ID), revision: 2, status: 'completed', validation: 'passed' }])
    const c = manifestReferenceDigest([{ outputId: String(OUTPUT_ID), revision: 3, status: 'completed', validation: 'passed' }])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('capturing the protection root', () => {
  it('captures one exact citation and one exact result revision, with a self-consistent digest', () => {
    const root = protection()
    expect(root.value.type).toBe('task_protection')
    expect(root.value.taskId).toBe(TASK_ID)
    expect(root.value.checkpointRevision).toBe(3)
    expect(root.value.objective).toBe('prove the task survives compaction')
    expect(root.value.completedSteps.map(step => step.id)).toEqual([STEP_ID])
    expect(root.value.evidence).toEqual([
      { kind: 'tool-result', stepId: String(STEP_ID), eventSeq: TOOL_EVENT_SEQ, callId: 'call-1' },
    ])
    expect(root.value.manifestReferences).toEqual([
      { outputId: OUTPUT_ID, revision: 2, status: 'completed', validation: 'passed', checksum: 'a'.repeat(64) },
    ])
    expect(root.value.currentStep).toBeNull()
    expect(root.value.failureContext).toBeNull()
    expect(root.value.resumeRecord).toBeNull()
    expect(root.digest).toBe(protectionDigest(root.canonical))
    expect(root.payload).toBe(root.canonical)
    expect(root.canonical).toBe(canonicalJson(root.value))
  })

  it('derives the protected view without rewriting any durable fact', () => {
    const cut = snapshot()
    const before = JSON.stringify(cut)
    protectTaskAuthority(cut)
    // The capture is a reader: the cut it was taken from is unchanged.
    expect(JSON.stringify(cut)).toBe(before)
  })

  it('fails closed when the Session tracks no Task', () => {
    expect(() => protectTaskAuthority(tasklessSnapshot()))
      .toThrow(TaskAwarePolicyError)
    try {
      protectTaskAuthority(tasklessSnapshot())
    } catch (error) {
      expect((error as TaskAwarePolicyError).code).toBe('TASK_AUTHORITY_UNAVAILABLE')
    }
  })

  it('fails closed when a completed step cites a tool result this cut cannot resolve', () => {
    const unresolvable = checkpoint({
      completedSteps: [{
        id: STEP_ID,
        title: 'collect evidence',
        completedAt: 1_000,
        evidence: { kind: 'tool-result', eventSeq: TOOL_EVENT_SEQ, callId: 'call-elsewhere' },
      }],
    })
    try {
      protectTaskAuthority(snapshot({ task: unresolvable }))
      throw new Error('expected the capture to fail closed')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskAwarePolicyError)
      expect((error as TaskAwarePolicyError).code).toBe('TASK_CHECKPOINT_EVIDENCE_MISSING')
    }
  })

  it('fails closed when a cited result revision is not the durable one', () => {
    const stale = checkpoint({
      completedSteps: [{
        id: STEP_ID,
        title: 'collect evidence',
        completedAt: 1_000,
        evidence: { kind: 'result-validation', outputId: OUTPUT_ID, manifestRevision: 1 },
      }],
    })
    try {
      protectTaskAuthority(snapshot({ task: stale }))
      throw new Error('expected the capture to fail closed')
    } catch (error) {
      expect((error as TaskAwarePolicyError).code).toBe('TASK_RESULT_MANIFEST_REVISION_MISSING')
    }
  })

  it('fails closed when a named output has no durable revision', () => {
    try {
      protectTaskAuthority(snapshot({ results: [] }))
      throw new Error('expected the capture to fail closed')
    } catch (error) {
      expect((error as TaskAwarePolicyError).code).toBe('TASK_RESULT_MANIFEST_REVISION_MISSING')
    }
  })

  it('protects the highest revision per output and records it once', () => {
    const root = protection({ results: [manifest({ revision: 1 }), manifest({ revision: 2 })] })
    expect(root.value.manifestReferences).toEqual([
      { outputId: OUTPUT_ID, revision: 2, status: 'completed', validation: 'passed', checksum: 'a'.repeat(64) },
    ])
  })

  it('re-reads the digest when the protected facts move', () => {
    const stable = protection()
    const moved = protection({ task: checkpoint({ revision: 4 }) })
    expect(moved.value.checkpointRevision).toBe(4)
    expect(moved.digest).not.toBe(stable.digest)
  })
})

describe('repair hazards and capacity', () => {
  it('reads only the addressed Task\u2019s hazards and finds the unknown-outcome one', () => {
    const mine = [hazard('TOOL_NOT_STARTED'), hazard('TOOL_OUTCOME_UNKNOWN')]
    const cut = snapshot({
      repairHazards: [
        ...mine,
        // A hazard another Task owns; the projection reports it, the filter drops it.
        foreignHazard('TOOL_OUTCOME_UNKNOWN'),
      ],
    })
    expect(taskRepairHazards(cut, String(TASK_ID))).toEqual(mine)
    expect(unknownOutcomeHazard(mine)?.code).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(unknownOutcomeHazard([hazard('TOOL_NOT_STARTED')])).toBeUndefined()
  })

  it('reserves the generation cap out of the window and floors at zero', () => {
    expect(usableInputTokens(10_000, 2_000)).toBe(8_000)
    expect(usableInputTokens(1_000, 2_000)).toBe(0)
    expect(usableInputTokens(0, 0)).toBe(0)
  })

  it('blocks a protected context that already consumes the whole budget', () => {
    expect(protectedContextExceedsCapacity(8_000, 8_000)).toBe(true)
    expect(protectedContextExceedsCapacity(8_001, 8_000)).toBe(true)
    expect(protectedContextExceedsCapacity(7_999, 8_000)).toBe(false)
  })
})

describe('the delimited block', () => {
  it('renders the ownership note outside the delimiters, then the payload inside them', () => {
    const root = protection()
    const block = renderTaskProtectionBlock(root)
    const lines = block.split('\n')
    // The note is model-visible prose, so it stays outside the delimiters: the
    // delimited body must be exactly the canonical payload validation parses.
    expect(lines[0]).toContain('must not be restated, edited, or contradicted')
    expect(lines[0]).not.toContain(TASK_COMPACTION_BLOCK_OPEN)
    expect(lines[1]).toBe(`${TASK_COMPACTION_BLOCK_OPEN} type=task_compaction_context version=1 protectionHash=${root.digest}`)
    expect(lines[2]).toBe(root.payload)
    expect(lines.at(-1)).toBe(TASK_COMPACTION_BLOCK_CLOSE)
  })

  it('round-trips through the parser with the header fields intact', () => {
    const root = protection()
    const parsed = parseTaskProtectionBlocks(renderTaskProtectionBlock(root))
    expect(parsed.malformed).toBe(false)
    expect(parsed.blocks).toHaveLength(1)
    expect(parsed.blocks[0]!.payload).toBe(root.payload)
    expect(headerField(parsed.blocks[0]!.header, 'type')).toBe('task_compaction_context')
    expect(headerField(parsed.blocks[0]!.header, 'version')).toBe('1')
    expect(headerField(parsed.blocks[0]!.header, 'protectionHash')).toBe(root.digest)
    expect(headerField(parsed.blocks[0]!.header, 'absent')).toBeUndefined()
  })

  it('counts every block and reports an unterminated sentinel as malformed', () => {
    const text = renderTaskProtectionBlock(protection())
    expect(parseTaskProtectionBlocks('nothing here').blocks).toEqual([])
    expect(parseTaskProtectionBlocks('nothing here').malformed).toBe(false)
    expect(parseTaskProtectionBlocks(`${text}\n${text}`).blocks).toHaveLength(2)
    expect(parseTaskProtectionBlocks(`${TASK_COMPACTION_BLOCK_OPEN} type=x`).malformed).toBe(true)
    expect(parseTaskProtectionBlocks(`${TASK_COMPACTION_BLOCK_OPEN} type=x\npayload`).malformed).toBe(true)
  })

  it('delivers exactly one text block equal to the rendering', () => {
    const root = protection()
    const content = taskProtectionContent(root)
    expect(content).toHaveLength(1)
    expect(textOfContent(content)).toBe(renderTaskProtectionBlock(root))
  })

  it('keeps the model-visible supplement outside the delimiters', () => {
    const root = protection()
    const supplement = taskProtectionSupplement(root)
    const text = supplement.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(text).toContain('<task-authority-snapshot>')
    expect(text).toContain(root.payload)
    // A model that echoed its prompt must not be able to manufacture a second
    // delimited block, so the delimiter count is a validation rule.
    expect(text).not.toContain(TASK_COMPACTION_BLOCK_OPEN)
    expect(text).not.toContain(TASK_COMPACTION_BLOCK_CLOSE)
  })

  it('keeps the sentinel vocabulary stable, because validation counts it', () => {
    expect(TASK_COMPACTION_BLOCK_OPEN).toBe('[[dsh-task-authority]]')
    expect(TASK_COMPACTION_BLOCK_CLOSE).toBe('[[/dsh-task-authority]]')
    expect(TaskAwarePolicyError.name).toBe('TaskAwarePolicyError')
  })
})
