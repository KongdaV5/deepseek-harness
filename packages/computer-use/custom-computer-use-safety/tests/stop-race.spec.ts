import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { DesktopLease } from '../src/lease.ts'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const first = { sessionId: 'first', turn: 1, kind: 'foreground' } as const
const second = { sessionId: 'second', turn: 1, kind: 'foreground' } as const
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  let answer: (idle: boolean) => void = () => { throw new Error('Drain not started') }
  const lease = new DesktopLease(ctx, { drainTimeoutMs: 1, waitForDormancy: () => new Promise<boolean>((resolve) => { answer = resolve }) })
  return { lease, answer: (idle: boolean) => { answer(idle) } }
}
it('does not hand over on abort or resume before the owned call settles', async () => {
  const { lease, answer } = fixture()
  lease.admit(first, 'act', false)
  const call = lease.enterCall(new AbortController().signal, 'act')
  const stopped = lease.stopAll('stop')
  expect(call.signal.aborted).toBe(true)
  expect(lease.resume('premature').state).toBe('draining')
  expect(lease.admit(second, 'act', false).kind).toBe('deny')
  lease.leaveCall(call.token); answer(true)
  expect((await stopped).state).toBe('released')
  expect(lease.resume('explicit').stop).toBe('running')
  expect(lease.admit(second, 'act', false).kind).toBe('ask')
})
it('never trusts a waiter alone, and a late settlement cannot clear poison', async () => {
  const { lease, answer } = fixture()
  lease.admit(first, 'act', false)
  const call = lease.enterCall(new AbortController().signal, 'act')
  const stopped = lease.stopAll('stop')
  answer(true)
  expect((await stopped).state).toBe('poisoned')
  lease.leaveCall(call.token); lease.leaveCall(call.token)
  expect(lease.snapshot().inFlight).toBe(0)
  expect(lease.resume('unsafe').state).toBe('poisoned')
  expect(lease.admit(second, 'act', false).kind).toBe('deny')
})
it('rechecks authority after approval and retains uncertainty introduced during drain', async () => {
  const { lease, answer } = fixture()
  lease.admit(first, 'act', false)
  const call = lease.enterCall(new AbortController().signal, 'act')
  const stopped = lease.stopAll('stop')
  lease.markUncertain('Cancelled after dispatch')
  lease.leaveCall(call.token); answer(true)
  expect((await stopped).state).toBe('poisoned')
  expect(lease.check(first, 'act')).toContain('stopped')
})
