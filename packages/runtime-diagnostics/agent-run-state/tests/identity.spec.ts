import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { attemptIdFor, runIdFor } from '@deepseek-ai/dsh-agent-run-state'

describe('correlation identity contract', () => {
  it('keeps a retry under one run while assigning a new attempt', () => {
    const run = runIdFor(SessionId('conversation'), 3)
    expect(attemptIdFor(run, 2, 1)).not.toBe(attemptIdFor(run, 2, 2))
    expect(String(attemptIdFor(run, 2, 2))).toContain(String(run))
  })

  it('separates sessions and user-triggered turns', () => {
    expect(runIdFor(SessionId('a'), 1)).not.toBe(runIdFor(SessionId('a'), 2))
    expect(runIdFor(SessionId('a'), 1)).not.toBe(runIdFor(SessionId('b'), 1))
  })

  it('rejects invalid numeric identity components', () => {
    const run = runIdFor(SessionId('a'), 1)
    expect(() => runIdFor(SessionId('a'), 0)).toThrow(/positive safe integer/)
    expect(() => attemptIdFor(run, 0, 1)).toThrow(/attempt step/)
    expect(() => attemptIdFor(run, 1, 0)).toThrow(/attempt ordinal/)
  })
})
