/**
 * Host-authoritative desktop lease: the one component that decides which turn
 * may change the physical desktop, and the one that proves the desktop is idle
 * before handing it to anyone else.
 *
 * The lease owns exclusivity and quiescence only. It is not a scheduler, holds
 * no queue, and persists nothing: a second requester is told the desktop is
 * busy rather than parked, and the whole state dies with the Host process.
 *
 * Releasing the desktop is never synchronous with an abort. A stop moves the
 * lease to `draining`, aborts the in-flight calls it accounts for, and waits for
 * them to settle; only a proven-empty in-flight set releases the lease. A drain
 * that cannot prove quiescence inside its bounded window poisons the lease, and
 * so does an action that never came back at all — a disconnected or crashing
 * driver leaves the same unprovable desktop as a hung call. A poisoned lease
 * refuses every acquisition until an explicit recovery, so no turn inherits a
 * desktop on which an earlier action may still be running.
 *
 * @module @deepseek-ai/dsh-custom-computer-use-safety/lease
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopLease: DesktopLease
  }
}

import type { DesktopLeaseState, ComputerUseStopState, DesktopTurnKind, DesktopLeaseOwner, DesktopLeaseSnapshot, AdmissionVerdict, InFlightCall } from './types.ts'
export type { DesktopLeaseState, ComputerUseStopState, DesktopTurnKind, DesktopLeaseOwner, DesktopLeaseSnapshot, AdmissionVerdict, InFlightCall } from './types.ts'

/** Bounded wait for quiescence, injected so tests need no wall-clock delay. */
export type DormancyWaiter = (timeoutMs: number, settled: () => boolean) => Promise<boolean>

/**
 * Default dormancy wait: poll the in-flight counter until it reaches zero or the
 * window closes. Polling keeps the check on the counter itself, so a call that
 * settles between polls is never missed and no resolver list can leak.
 * @param timeoutMs - bounded window in milliseconds.
 * @param settled - predicate reporting whether every accounted call has settled.
 * @returns whether quiescence was proven inside the window.
 */
export const defaultDormancyWaiter: DormancyWaiter = async (timeoutMs, settled) => {
  if (settled()) return true
  const deadline = Date.now() + timeoutMs
  const interval = 10
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, interval) })
    if (settled()) return true
  }
  return settled()
}

/** Options for {@link DesktopLease}. */
export interface DesktopLeaseOptions {
  /** Bounded window to prove quiescence before poisoning the lease. */
  readonly drainTimeoutMs: number
  /** Replacement for the bounded wait, used by deterministic tests. */
  readonly waitForDormancy?: DormancyWaiter
}

/**
 * The single desktop controlling turn plus the Host stop flag.
 *
 * Observation never acquires the desktop: it changes no desktop state, so it
 * neither needs nor takes an ownership slot. An observation is still admitted
 * through this service, because eligibility is decided here — a turn that may not
 * use Computer Use at all may not observe either.
 *
 * Two facts poison the lease, because both leave the desktop unattestable: a
 * drain that could not prove quiescence ({@link stopAll}), and an action whose
 * outcome never came back ({@link markUncertain}).
 */
export class DesktopLease extends Service {
  private state: DesktopLeaseState = 'released'
  private stop: ComputerUseStopState = 'running'
  private owner: DesktopLeaseOwner | undefined
  private actApproved = false
  private detail: string | undefined
  private calls = 0
  private readonly tokens = new Set<number>()
  private nextToken = 1
  private epoch = 0
  /**
   * Cancellation for the calls the current hold accounts for.
   *
   * Every transition aborts this controller — a stop cancels what it accounts
   * for, and an unconfirmed action must not leave callers attached to a hold
   * that no longer owns the desktop — and the state that results from it gets a
   * fresh one, because calls are still admitted in all of them. Replacing the
   * field cannot un-cancel anything already in flight: `enterCall` evaluated
   * `this.abort.signal` when it fused the call's signal, so an outstanding call
   * keeps pointing at the controller that was aborted.
   */
  private abort = new AbortController()
  private stopping: Promise<DesktopLeaseSnapshot> | undefined
  private readonly drainTimeoutMs: number
  private readonly waitForDormancy: DormancyWaiter

  /**
   * @param ctx - owning Host context; the service is registered as `ctx.desktopLease`.
   * @param options - bounded drain window and an optional deterministic waiter.
   */
  constructor(ctx: Context, options: DesktopLeaseOptions) {
    super(ctx, 'desktopLease')
    this.drainTimeoutMs = options.drainTimeoutMs
    this.waitForDormancy = options.waitForDormancy ?? defaultDormancyWaiter
    ctx.effect(() => () => {
      // Teardown cannot wait for an uncooperative driver, but it must not leave
      // the desktop attributed to a disposed turn either.
      this.abort.abort(new Error('computer use safety layer unloaded'))
      this.reset(this.calls === 0 ? 'released' : 'poisoned', this.detail ?? 'safety layer unloaded with outstanding calls')
    }, 'computer-use-safety: release on unload')
  }

  /** Admission revision invalidated synchronously by every stop or uncertainty. */
  get admissionEpoch(): number { return this.epoch }

  /** Immutable observation of the lease, stop flag, and owning turn. */
  snapshot(): DesktopLeaseSnapshot {
    return Object.freeze({
      state: this.state,
      stop: this.stop,
      inFlight: this.calls,
      actApproved: this.actApproved,
      ...this.owner === undefined ? {} : { owner: this.owner },
      ...this.detail === undefined ? {} : { detail: this.detail },
    })
  }

  /**
   * Decide one Computer Use call against the stop flag, the turn's origin, and
   * the current owner.
   *
   * Eligibility is decided before the class: a turn that may not use Computer Use
   * is refused everything, observation included, so V1 has one rule per origin
   * rather than a partial capability. A permitted observation is then allowed
   * without the desktop, while a permitted action must own it.
   * @param owner - identity of the calling turn, or `undefined` for a Host-plane call.
   * @param toolClass - the call's classification.
   * @param reconfirm - whether the action needs a fresh confirmation every time.
   * @returns the admission verdict; `ask` routes through the canonical approval channel.
   */
  admit(owner: DesktopLeaseOwner | undefined, toolClass: 'observe' | 'act', reconfirm: boolean): AdmissionVerdict {
    if (this.stop !== 'running') {
      return { kind: 'deny', reason: `Computer Use is ${this.stop === 'stopping' ? 'stopping' : 'stopped'}: new desktop calls are refused until the stop is cleared with /computer-use-resume.${this.detail === undefined ? '' : ` Last stop: ${this.detail}`}` }
    }
    if (owner === undefined) {
      return toolClass === 'observe'
        ? { kind: 'allow' }
        : { kind: 'deny', reason: 'a desktop action requires a foreground Agent turn; a Host-plane call has no turn to attribute it to' }
    }
    // Before the observe shortcut: an ineligible origin is refused Computer Use
    // outright, so a scheduled or external turn cannot even read the desktop.
    if (owner.kind !== 'foreground') {
      return { kind: 'deny', reason: describeOriginatedTurn(owner.kind) }
    }
    if (toolClass === 'observe') return { kind: 'allow' }
    switch (this.state) {
      case 'draining':
        return { kind: 'deny', reason: 'the desktop is still draining: an earlier Computer Use action has not settled, so the desktop is not available yet' }
      case 'poisoned':
        return { kind: 'deny', reason: `the desktop lease is poisoned: an earlier action could not be proven settled. Restart the Host and driver after checking the desktop; resume cannot clear an uncertain outcome.${this.detail === undefined ? '' : ` Detail: ${this.detail}`}` }
      case 'released':
        this.acquire(owner)
        return this.actionVerdict(reconfirm)
      case 'active':
        if (this.owner === undefined || !sameOwner(this.owner, owner)) {
          return { kind: 'deny', reason: `the desktop is in use by ${describeOwner(this.owner)}; Computer Use is serialized, so retry after that turn releases it` }
        }
        return this.actionVerdict(reconfirm)
    }
  }

  /** Recheck authority after asynchronous approval, without acquiring or approving a lease.
   * @param owner - canonical caller identity.
   * @param toolClass - observation or mutation.
   * @returns denial if the stop or owner changed while approval was pending.
   */
  check(owner: DesktopLeaseOwner | undefined, toolClass: 'observe' | 'act'): string | undefined {
    if (this.stop !== 'running') return 'Computer Use stopped while this call was awaiting admission'
    if (owner !== undefined && owner.kind !== 'foreground') return describeOriginatedTurn(owner.kind)
    if (toolClass === 'observe') return undefined
    if (owner === undefined || this.state !== 'active' || this.owner === undefined || !sameOwner(this.owner, owner)) {
      return 'Computer Use authority changed; this call will not be dispatched or replayed'
    }
    return undefined
  }

  /**
   * Account one admitted call and fuse its cancellation with this lease's stop.
   * @param signal - the caller's cancellation signal.
   * @param toolClass - the call's classification.
   * @returns the correlation token and the signal the body must observe.
   */
  enterCall(signal: AbortSignal, toolClass: 'observe' | 'act'): InFlightCall {
    const token = this.nextToken++
    this.tokens.add(token)
    this.calls = this.tokens.size
    if (toolClass === 'act') this.actApproved = true
    return Object.freeze({
      token,
      signal: AbortSignal.any([signal, this.abort.signal]),
    })
  }

  /** Release one accounted call; reaching zero proves quiescence to a waiting drain. */
  leaveCall(token = this.tokens.values().next().value): void {
    if (token !== undefined) this.tokens.delete(token)
    this.calls = this.tokens.size
  }

  /**
   * End the desktop authority of one turn: drain what it owns, then release.
   * A turn that owns nothing is a no-op.
   * @param sessionId - session that finished a turn.
   * @param turn - the turn that finished.
   * @returns the snapshot after the drain attempt, or `undefined` when this turn owned nothing.
   */
  async endTurn(sessionId: string, turn: number): Promise<DesktopLeaseSnapshot | undefined> {
    if (this.owner === undefined || this.owner.sessionId !== sessionId || this.owner.turn !== turn) {
      return undefined
    }
    return await this.drain(`turn ${turn} of session ${sessionId} ended`)
  }

  /**
   * Stop Computer Use for the whole Host: refuse new calls, cancel accounted
   * in-flight calls, prove quiescence, and release the desktop.
   *
   * A stop never claims to undo an action that already reached the desktop.
   * @param reason - human-readable cause recorded on the lease.
   * @returns the snapshot after the drain attempt.
   */
  stopAll(reason: string): Promise<DesktopLeaseSnapshot> {
    if (this.stopping !== undefined) return this.stopping
    this.stop = this.stop === 'running' ? 'stopping' : this.stop
    // A lease already poisoned by an unconfirmed action keeps that reason: it is
    // the diagnostic a person actually needs, and the stop that follows cannot
    // improve on it. Every other state records the stop's own reason, so the
    // draining window reports why the desktop is being withheld.
    if (this.state !== 'poisoned') this.detail = reason
    this.stopping = this.drain(reason)
      // Settle the stop flag before observing, so the returned snapshot reports
      // the state admission will actually apply. Taking the drain's own snapshot
      // instead would hand every caller — the stop command, and any surface bound
      // to this promise — a permanent "stopping" that never became "stopped".
      .then((_drained) => {
        if (this.stop === 'stopping') this.stop = 'stopped'
        return this.snapshot()
      })
      .finally(() => {
        this.stopping = undefined
      })
    return this.stopping
  }

  /**
   * Record that a desktop action did not come back, so its outcome is unknown.
   *
   * A driver that disconnects, crashes, or rejects mid-action leaves the desktop
   * in a state nobody can attest to: the click may or may not have reached the
   * application. Treating that as "nothing happened" is the one inference V1 may
   * never make, because the next turn would then inherit a desktop that an
   * unobserved action may already have changed. The lease is therefore poisoned,
   * exactly as an unprovable drain is: no other turn receives the desktop, and
   * nothing replays the call. Recovery requires verifying that old work has stopped and restarting
   * the Host and driver; resume alone cannot clear this uncertainty. A cancelled
   * dispatched call also reaches here. A concurrent drain must retain its poison.
   * @param reason - what could not be confirmed, recorded as the lease detail.
   * @returns the snapshot after recording the unknown outcome.
   */
  markUncertain(reason: string): DesktopLeaseSnapshot {
    this.epoch += 1
    // The previous controller may still have live callers attached to it, so it
    // is aborted before the reset: an uncertain action must not stay reachable.
    this.abort.abort(new Error(reason))
    this.reset('poisoned', reason)
    return this.snapshot()
  }

  /** Resume only a proven-idle stop. Poison, drain and outstanding calls remain blocked.
   * @param reason - Explicit user recovery attribution.
   * @returns unchanged blocked state, or reopened idle state; never clears poison.
   */
  resume(reason: string): DesktopLeaseSnapshot {
    if (this.calls > 0 || this.stopping !== undefined || this.state === 'draining' || this.state === 'poisoned') return this.snapshot()
    if (this.stop === 'running') return this.snapshot()
    this.stop = 'running'
    // The released reset renews the cancellation signal, so every call admitted
    // from here on fuses a signal that no previous stop has already aborted.
    this.reset('released', reason)
    return this.snapshot()
  }

  /** The owner of the desktop, when one exists. */
  get currentOwner(): DesktopLeaseOwner | undefined {
    return this.owner
  }

  private actionVerdict(reconfirm: boolean): AdmissionVerdict {
    if (!this.actApproved) {
      return {
        kind: 'ask',
        // The reason is the model-facing diagnostic, so it must stay
        // comprehensible when nothing can answer the approval and this text is
        // all the model ever sees.
        reason: 'Computer Use needs one approval before it can control the desktop in this turn',
        displayReason: {
          en: 'Computer Use wants to control the desktop (move the pointer, click, or type). Approve once for this turn?',
          zh: 'Computer Use 想要控制桌面（移动指针、点击或输入）。是否批准本轮的一次操作？',
        },
      }
    }
    if (reconfirm) {
      return {
        kind: 'ask',
        reason: 'this Computer Use action can change something that cannot be undone, so it needs a fresh confirmation',
        displayReason: {
          en: 'This Computer Use action can change something that cannot be undone (send, submit, delete, install, purchase, account, or credential). Confirm this specific action?',
          zh: '此 Computer Use 动作可能造成不可撤销的变更（发送、提交、删除、安装、购买、账号或凭据）。是否确认这次操作？',
        },
      }
    }
    return { kind: 'allow' }
  }

  private acquire(owner: DesktopLeaseOwner): void {
    this.owner = owner
    this.state = 'active'
    this.actApproved = false
    this.detail = undefined
  }

  private async drain(reason: string): Promise<DesktopLeaseSnapshot> {
    this.epoch += 1
    // A drain can only withhold the desktop or release a proven-idle one; it can
    // never improve the lease. A lease already poisoned — by an action whose
    // outcome never came back, or by an earlier drain that timed out — keeps its
    // poison and its reason, because the desktop it describes is still
    // unattestable. Clearing it here would let an unrelated stop, or simply a
    // turn ending, hand the next session a desktop on which an unobserved action
    // may already have happened.
    const priorPoison = this.state === 'poisoned' ? this.detail : undefined
    this.state = 'draining'
    this.abort.abort(new Error(reason))
    const quiesced = await this.waitForDormancy(this.drainTimeoutMs, () => this.calls === 0)
    if (quiesced && this.calls === 0) {
      if (priorPoison === undefined && this.snapshot().state !== 'poisoned') this.reset('released', reason)
      else this.reset('poisoned', priorPoison ?? this.detail ?? 'unknown physical outcome')
      return this.snapshot()
    }
    this.reset('poisoned', `${reason}; ${this.calls} desktop call(s) did not settle inside ${this.drainTimeoutMs}ms, so the desktop may still be changing`)
    return this.snapshot()
  }

  private reset(state: DesktopLeaseState, detail: string): void {
    this.state = state
    this.owner = undefined
    this.actApproved = false
    this.detail = detail
    // Every state this reaches is one where calls are still admitted, so the
    // lease must carry a live cancellation signal. The transition that produced
    // it just aborted the previous controller, and without a renewal the next
    // admitted call — an observation, which never acquires and therefore never
    // re-created a controller, and which a poisoned lease still admits so a
    // person's turn can inspect the desktop — would be cancelled on entry.
    //
    // Renewing cannot resurrect an in-flight call: `enterCall` captured the
    // signal object it fused, so a call admitted under the old hold keeps the
    // aborted signal it was given and still settles as cancelled.
    this.abort = new AbortController()
  }
}

/** Whether two owner records describe the same turn. */
function sameOwner(left: DesktopLeaseOwner, right: DesktopLeaseOwner): boolean {
  return left.sessionId === right.sessionId && left.turn === right.turn
}

/** Render the canonical denial for a turn that may never control the desktop. */
function describeOriginatedTurn(kind: DesktopTurnKind): string {
  switch (kind) {
    case 'schedule':
      return 'Computer Use is not supported for scheduled tasks in this version: a background occurrence may not control the physical desktop. Ask the user to run the desktop steps in a foreground session.'
    case 'external':
      return 'Computer Use is not supported on the Codex external route in this version: that runtime owns its own agent loop and cannot be serialized against DSH desktop ownership. Use a Local session for desktop work.'
    case 'subagent':
      return 'a subagent may not control the desktop: desktop authority belongs to the top-level turn that owns the session. Report back and let the foreground turn act.'
    case 'foreground':
      return 'Computer Use requires a foreground turn.'
  }
}

/** Render the current owner for a busy denial. */
function describeOwner(owner: DesktopLeaseOwner | undefined): string {
  if (owner === undefined) return 'another turn'
  return `session ${owner.sessionId} (turn ${owner.turn})`
}
