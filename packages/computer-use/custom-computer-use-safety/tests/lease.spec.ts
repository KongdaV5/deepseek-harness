/**
 * The desktop lease owns the two properties the rest of Computer Use depends on:
 * exactly one turn may change the desktop, and the desktop is only handed over
 * after the previous holder's calls are proven to have settled.
 *
 * The drain tests drive a test-controlled dormancy gate instead of a wall clock,
 * so the release-after-abort race is decided by the test rather than by timing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DesktopLease,
  defaultDormancyWaiter,
  type DesktopLeaseOwner,
  type DormancyWaiter,
} from '../src/lease.ts'

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

/** One in-flight call the test decides when to settle. */
interface Gate {
  /** Whether every accounted call has settled, as the seal sees it. */
  readonly settled: () => boolean
  /** Answer the bounded wait with the observable truth at answer time. */
  readonly answer: (quiesced: boolean) => void
}

/**
 * A lease whose drain window is driven by the test: each drain registers a gate
 * the test answers explicitly, so no assertion depends on elapsed time.
 */
function gatedLease(): { lease: DesktopLease; gates: Gate[] } {
  const gates: Gate[] = []
  const waiter: DormancyWaiter = (_timeoutMs, settled) =>
    new Promise<boolean>((resolve) => {
      gates.push({ settled, answer: resolve })
    })
  const lease = new DesktopLease(ctx(), { drainTimeoutMs: 5_000, waitForDormancy: waiter })
  return { lease, gates }
}

/** A fresh context owning one lease under test. */
function ctx(): Context {
  const context = new Context()
  contexts.push(context)
  return context
}

/** A plain lease over the real bounded waiter. */
function lease(): DesktopLease {
  return new DesktopLease(ctx(), { drainTimeoutMs: 5_000 })
}

const ALICE: DesktopLeaseOwner = { sessionId: 'alice', turn: 1, kind: 'foreground' }
const BOB: DesktopLeaseOwner = { sessionId: 'bob', turn: 1, kind: 'foreground' }

describe('desktop ownership', () => {
  it('never takes the desktop for an observation', () => {
    const target = lease()
    expect(target.admit(ALICE, 'observe', false)).toEqual({ kind: 'allow' })
    expect(target.snapshot()).toMatchObject({ state: 'released', inFlight: 0, actApproved: false })
    expect(target.snapshot().owner).toBeUndefined()
  })

  it('acquires the desktop on the first action and asks for that one approval', () => {
    const target = lease()
    const verdict = target.admit(ALICE, 'act', false)
    expect(verdict).toMatchObject({ kind: 'ask' })
    expect(verdict.kind === 'ask' && verdict.reason).toContain('one approval')
    expect(target.snapshot()).toMatchObject({ state: 'active', owner: ALICE, actApproved: false })
  })

  it('stops asking once the holding turn has passed its approval', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')

    expect(target.admit(ALICE, 'act', false)).toEqual({ kind: 'allow' })
    expect(target.snapshot().actApproved).toBe(true)
  })

  it('asks again for every high-risk action, even inside an approved turn', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')

    const verdict = target.admit(ALICE, 'act', true)
    expect(verdict).toMatchObject({ kind: 'ask' })
    expect(verdict.kind === 'ask' && verdict.reason).toContain('cannot be undone')
  })

  it('refuses a second session while one turn owns the desktop', () => {
    const target = lease()
    expect(target.admit(ALICE, 'act', false).kind).toBe('ask')

    const verdict = target.admit(BOB, 'act', false)
    expect(verdict.kind).toBe('deny')
    expect(verdict.kind === 'deny' && verdict.reason).toContain('in use by session alice (turn 1)')
    expect(target.snapshot().owner).toEqual(ALICE)
  })

  it('lets a second session observe even while another turn owns the desktop', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    expect(target.admit(BOB, 'observe', false)).toEqual({ kind: 'allow' })
    expect(target.snapshot().owner).toEqual(ALICE)
  })

  it('gives the same turn the same answer, but not a different turn of the same session', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    expect(target.admit(ALICE, 'act', false).kind).toBe('ask')

    const nextTurn = { ...ALICE, turn: 2 }
    expect(target.admit(nextTurn, 'act', false).kind).toBe('deny')
  })

  it.each([
    ['schedule', 'scheduled tasks'],
    ['external', 'Codex external route'],
    ['subagent', 'subagent may not control the desktop'],
  ] as const)('refuses a %s turn every call, even an observation on a free desktop', (kind, expected) => {
    const target = lease()
    const owner: DesktopLeaseOwner = { sessionId: 'x', turn: 1, kind }

    for (const toolClass of ['act', 'observe'] as const) {
      const verdict = target.admit(owner, toolClass, false)
      expect(verdict.kind).toBe('deny')
      expect(verdict.kind === 'deny' && verdict.reason).toContain(expected)
    }
    expect(target.snapshot().state).toBe('released')
  })

  it('allows a host-plane observation but refuses a host-plane action', () => {
    const target = lease()
    expect(target.admit(undefined, 'observe', false)).toEqual({ kind: 'allow' })
    expect(target.admit(undefined, 'act', false).kind).toBe('deny')
  })
})

describe('release on turn end', () => {
  it('releases the desktop for the turn that owned it', async () => {
    const target = lease()
    target.admit(ALICE, 'act', false)

    await expect(target.endTurn('alice', 1)).resolves.toMatchObject({ state: 'released' })
    expect(target.snapshot().owner).toBeUndefined()
  })

  it('is a no-op for a turn that owned nothing', async () => {
    const target = lease()
    target.admit(ALICE, 'act', false)

    await expect(target.endTurn('bob', 1)).resolves.toBeUndefined()
    await expect(target.endTurn('alice', 2)).resolves.toBeUndefined()
    expect(target.snapshot().owner).toEqual(ALICE)
  })

  it('is a no-op before anything acquired the desktop', async () => {
    await expect(lease().endTurn('alice', 1)).resolves.toBeUndefined()
  })

  it('hands the desktop to the next turn once the previous turn ended', async () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    await target.endTurn('alice', 1)

    expect(target.admit(BOB, 'act', false).kind).toBe('ask')
    expect(target.snapshot().owner).toEqual(BOB)
  })

  it('admits the next observation with a live signal after a release', async () => {
    // Regression: a drain aborts the hold's signal, so a lease that returns to
    // `released` must renew it. Otherwise the next observation — which never
    // acquires, and so never re-created a controller — would be admitted with an
    // already-aborted signal and cancelled immediately.
    const target = lease()
    target.admit(ALICE, 'act', false)
    const action = target.enterCall(new AbortController().signal, 'act')
    target.leaveCall()
    await target.endTurn('alice', 1)

    expect(action.signal.aborted).toBe(true)

    const observation = target.enterCall(new AbortController().signal, 'observe')
    expect(observation.signal.aborted).toBe(false)
    target.leaveCall()
  })
})

describe('draining and the release race', () => {
  it('is draining, not released, while a cancelled call has not settled', () => {
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    const action = target.enterCall(new AbortController().signal, 'act')

    const stopping = target.stopAll('user pressed Global Stop')

    // A stop aborts the in-flight call...
    expect(action.signal.aborted).toBe(true)
    // ...but it must not hand the desktop to anyone yet.
    expect(target.snapshot()).toMatchObject({ state: 'draining', stop: 'stopping', inFlight: 1 })
    expect(gates[0]?.settled()).toBe(false)
    const bobVerdict = target.admit(BOB, 'act', false)
    expect(bobVerdict.kind).toBe('deny')
    // The stop flag dominates every other explanation, so the refusal names the
    // stop the user asked for rather than the internal drain.
    expect(bobVerdict.kind === 'deny' && bobVerdict.reason).toContain('Computer Use is stopping')

    // The call settles, which is the only thing that may release the desktop.
    target.leaveCall()
    gates[0]?.answer(gates[0].settled())
    return stopping.then((snapshot) => {
      expect(snapshot).toMatchObject({ state: 'released', stop: 'stopped' })
      expect(snapshot.owner).toBeUndefined()
    })
  })

  it('poisons the lease rather than releasing it when quiescence cannot be proven', async () => {
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')

    const stopping = target.stopAll('driver stopped answering')
    gates[0]?.answer(false)

    const snapshot = await stopping
    expect(snapshot.state).toBe('poisoned')
    expect(snapshot.owner).toBeUndefined()
    expect(snapshot.detail).toContain('did not settle')

    // The critical property: no second owner inherits a desktop that may still
    // be changing under an earlier action.
    const bobVerdict = target.admit(BOB, 'act', false)
    expect(bobVerdict.kind).toBe('deny')
    // The stop flag dominates the verdict, but the unproven quiescence must
    // still reach the caller rather than be swallowed by the stop message.
    expect(bobVerdict.kind === 'deny' && bobVerdict.reason).toContain('did not settle')
    expect(target.snapshot().owner).toBeUndefined()
  })

  it('explains the poisoned lease when the desktop was released only by a turn ending', async () => {
    // With no stop in effect, the poisoned explanation is the whole verdict.
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')

    const ending = target.endTurn('alice', 1)
    gates[0]?.answer(false)
    await ending

    const verdict = target.admit(BOB, 'act', false)
    expect(verdict.kind).toBe('deny')
    expect(verdict.kind === 'deny' && verdict.reason).toContain('poisoned')
    expect(verdict.kind === 'deny' && verdict.reason).toContain('Restart the Host and driver')
  })

  it('stays poisoned after the late call settles, so nothing silently reopens', async () => {
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')
    const stopping = target.stopAll('stop')
    gates[0]?.answer(false)
    await stopping

    target.leaveCall()

    expect(target.snapshot()).toMatchObject({ state: 'poisoned', inFlight: 0 })
    expect(target.admit(ALICE, 'act', false).kind).toBe('deny')
  })

  it('refuses every call, including observations, while stopped', async () => {
    const target = lease()
    await target.stopAll('stop')

    expect(target.admit(ALICE, 'observe', false).kind).toBe('deny')
    expect(target.admit(ALICE, 'act', false).kind).toBe('deny')
    expect(target.admit(undefined, 'observe', false).kind).toBe('deny')
  })

  it('drains once for concurrent stop requests', async () => {
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')

    const first = target.stopAll('first')
    const second = target.stopAll('second')

    expect(gates).toHaveLength(1)
    expect(target.snapshot().detail).toBe('first')

    target.leaveCall()
    gates[0]?.answer(gates[0].settled())
    expect(await first).toMatchObject({ state: 'released', stop: 'stopped' })
    expect(await second).toMatchObject({ state: 'released', stop: 'stopped' })
  })

  it('routes turn end through the same drain as a stop', async () => {
    // Section 7: one release path. A turn that ends while its own call is
    // unsettled must poison exactly as a Global Stop would.
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')

    const ending = target.endTurn('alice', 1)
    // With no stop in effect, the drain itself is the explanation a second
    // owner receives — so a turn ending mid-action cannot look like a free
    // desktop to anyone else.
    const bobVerdict = target.admit(BOB, 'act', false)
    expect(bobVerdict.kind === 'deny' && bobVerdict.reason).toContain('still draining')
    gates[0]?.answer(false)

    expect(await ending).toMatchObject({ state: 'poisoned' })
    expect(target.snapshot().stop).toBe('running')
    expect(target.admit(BOB, 'act', false).kind).toBe('deny')
  })

  it('refuses premature resume after a timed-out drain', async () => {
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    const call = target.enterCall(new AbortController().signal, 'act')
    const stopping = target.stopAll('stop')
    gates[0]?.answer(false)
    await stopping
    expect(target.resume('user checked the desktop')).toMatchObject({ state: 'poisoned', stop: 'stopped' })
    target.leaveCall(call.token)
    expect(target.resume('late settlement')).toMatchObject({ state: 'poisoned' })
    expect(target.admit(BOB, 'act', false).kind).toBe('deny')
  })

  it('renews the cancellation signal on recovery', async () => {
    const target = lease()
    const action = target.enterCall(new AbortController().signal, 'act')
    target.leaveCall()
    await target.stopAll('stop')
    expect(action.signal.aborted).toBe(true)

    target.resume('recovery')
    expect(target.enterCall(new AbortController().signal, 'observe').signal.aborted).toBe(false)
  })

  it('is a no-op when resume is called on a healthy lease', () => {
    const target = lease()
    const before = target.snapshot()
    expect(target.resume('nothing to recover')).toEqual(before)
  })

  it('drops the holding turn on release, so its approval does not carry over', async () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')
    expect(target.snapshot().actApproved).toBe(true)
    target.leaveCall()

    await target.endTurn('alice', 1)
    expect(target.admit(ALICE, 'act', false)).toMatchObject({ kind: 'ask' })
  })
})

describe('an action whose outcome never came back', () => {
  it('poisons the lease and records that the outcome is unknown', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)

    const snapshot = target.markUncertain('the click did not return')
    expect(snapshot).toMatchObject({ state: 'poisoned', actApproved: false })
    expect(snapshot.owner).toBeUndefined()
    expect(snapshot.detail).toBe('the click did not return')
  })

  it('withholds the desktop from every later turn, including the one that acted', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    target.markUncertain('the click did not return')

    // Both a different session and the acting turn itself are refused: the
    // desktop cannot be handed on, and nothing may be replayed on it.
    for (const requester of [BOB, ALICE, { ...ALICE, turn: 2 }]) {
      expect(target.admit(requester, 'act', false).kind).toBe('deny')
    }
    expect(target.snapshot().owner).toBeUndefined()
  })

  it('still admits observation, so the desktop can be inspected before recovery', () => {
    const target = lease()
    target.markUncertain('the click did not return')

    expect(target.admit(ALICE, 'observe', false)).toEqual({ kind: 'allow' })
    expect(target.snapshot().state).toBe('poisoned')
  })

  it('a resume request alone never clears unknown physical outcome', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    target.markUncertain('the click did not return')
    expect(target.resume('user checked the desktop')).toMatchObject({ state: 'poisoned' })
    expect(target.admit(BOB, 'act', false).kind).toBe('deny')
  })

  it('cancels the calls the uncertain hold still accounts for', () => {
    const target = lease()
    target.admit(ALICE, 'act', false)
    const call = target.enterCall(new AbortController().signal, 'act')

    target.markUncertain('the click did not return')
    expect(call.signal.aborted).toBe(true)
  })

  it('survives a later, unrelated drain that proves quiescence', async () => {
    // Regression: a drain used to release whatever it found once the in-flight
    // counter reached zero. That let an unrelated stop — or simply the acting
    // turn ending — clear an uncertain outcome, handing the next session a
    // desktop on which an unobserved action may already have happened.
    const target = lease()
    target.admit(ALICE, 'act', false)
    target.markUncertain('the click did not return')

    // The uncertain marker dropped the owner, so ending that turn is a no-op; a
    // Host stop still drains, and the empty set it finds must not reopen.
    expect(await target.endTurn('alice', 1)).toBeUndefined()
    expect(await target.stopAll('unrelated stop')).toMatchObject({ state: 'poisoned' })
    expect(target.snapshot().detail).toBe('the click did not return')
  })

  it('keeps a poison from a failed stop through the next stop', async () => {
    const { lease: target, gates } = gatedLease()
    target.admit(ALICE, 'act', false)
    target.enterCall(new AbortController().signal, 'act')
    const first = target.stopAll('first stop')
    gates[0]?.answer(false)
    await first
    expect(target.snapshot()).toMatchObject({ state: 'poisoned' })

    // The late call settles, so the second stop finds an empty in-flight set —
    // which is exactly the evidence that must not reopen the desktop, and the
    // second stop's own reason must not replace the one that explains why.
    target.leaveCall()
    const second = target.stopAll('second stop')
    gates[1]?.answer(true)
    expect(await second).toMatchObject({ state: 'poisoned' })
    expect(target.snapshot().detail).toContain('did not settle inside')
  })
})

describe('call accounting', () => {
  it('counts a call from entry to settlement and fuses caller cancellation', () => {
    const target = lease()
    const caller = new AbortController()
    const call = target.enterCall(caller.signal, 'observe')
    expect(target.snapshot().inFlight).toBe(1)

    caller.abort()
    expect(call.signal.aborted).toBe(true)

    target.leaveCall()
    expect(target.snapshot().inFlight).toBe(0)
  })

  it('issues a distinct token per call', () => {
    const target = lease()
    const first = target.enterCall(new AbortController().signal, 'observe')
    const second = target.enterCall(new AbortController().signal, 'observe')
    expect(first.token).not.toBe(second.token)
    target.leaveCall()
    target.leaveCall()
  })

  it('never under-counts, so an unmatched settlement cannot fake quiescence', () => {
    const target = lease()
    target.enterCall(new AbortController().signal, 'observe')
    target.leaveCall()
    target.leaveCall()
    expect(target.snapshot().inFlight).toBe(0)
  })
})

describe('the bounded dormancy wait', () => {
  it('returns immediately when the counter is already empty', async () => {
    await expect(defaultDormancyWaiter(5_000, () => true)).resolves.toBe(true)
  })

  it('gives up when the counter never empties', async () => {
    const wait = vi.fn(() => false)
    await expect(defaultDormancyWaiter(30, wait)).resolves.toBe(false)
    expect(wait).toHaveBeenCalled()
  })

  it('observes a settlement that happens between polls', async () => {
    let calls = 1
    setTimeout(() => { calls = 0 }, 15)
    await expect(defaultDormancyWaiter(200, () => calls === 0)).resolves.toBe(true)
  })
})

describe('teardown', () => {
  it('cancels in-flight calls and clears ownership when the layer unloads', async () => {
    const context = ctx()
    const target = new DesktopLease(context, { drainTimeoutMs: 5_000 })
    target.admit(ALICE, 'act', false)
    const action = target.enterCall(new AbortController().signal, 'act')

    await context.fiber.dispose()

    expect(action.signal.aborted).toBe(true)
    expect(target.snapshot()).toMatchObject({ state: 'poisoned' })
    expect(target.snapshot().owner).toBeUndefined()
  })
})
