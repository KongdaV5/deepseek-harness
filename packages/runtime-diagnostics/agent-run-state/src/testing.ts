/** Controllable backend observer for unit tests and diagnostics fixtures. */

import type { BackendObservation, LocalBackendObserver } from './types.ts'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { BackendObserverId } from './brand.ts'

/** In-memory observer whose caller explicitly emits every state transition. */
export class FakeBackendObserver implements LocalBackendObserver {
  readonly id: BackendObserverId
  private readonly listeners = new Set<(observation: BackendObservation) => void>()
  private probeCount = 0

  constructor(id = 'fake-backend') {
    this.id = BackendObserverId(id)
  }

  /** Subscribe until the returned idempotent disposer is called. */
  subscribe(listener: (observation: BackendObservation) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Publish one controlled observation bearing this observer's identity.
   * @param observation - complete fake snapshot except the observer-owned id.
   */
  emit(observation: Omit<BackendObservation, 'observerId'>): void {
    const complete = { ...observation, observerId: this.id }
    for (const listener of this.listeners) listener(complete)
  }

  /** Record one immediate evidence refresh without inventing observations. */
  probe(): Promise<void> {
    this.probeCount += 1
    return Promise.resolve()
  }

  /** Number of active subscriptions, exposed only by the testing adapter. */
  get subscriberCount(): number {
    return this.listeners.size
  }

  /** Number of policy-triggered evidence refreshes. */
  get probes(): number {
    return this.probeCount
  }
}

/** Deterministic AssistantStreamFrame source; it performs no I/O itself. */
export class FakeStream {
  /** Stable process-local request identity carried by every synthetic frame. */
  readonly attemptId: LlmAttemptId
  private index = 0

  constructor(
    id: string,
    private readonly turn: number,
    private readonly step: number,
    private readonly revision = 1,
  ) {
    this.attemptId = LlmAttemptId(id)
  }

  /**
   * Open the synthetic attempt.
   * @returns the first stream frame for this request identity.
   */
  start(): AssistantStreamFrame {
    return { type: 'start', attemptId: this.attemptId, revision: this.revision, turn: this.turn, step: this.step }
  }

  /**
   * Emit the next dense chunk frame.
   * @param time - explicit activity timestamp.
   * @param chunk - model stream chunk carried by the frame.
   * @returns the next monotonically indexed synthetic frame.
   */
  chunk(time: number, chunk: StreamChunk): AssistantStreamFrame {
    return { type: 'chunk', attemptId: this.attemptId, revision: this.revision, index: this.index++, time, chunk }
  }

  /**
   * Close the synthetic attempt without inventing a durable settlement.
   * @returns an abandoned terminal frame for the fake stream.
   */
  end(): AssistantStreamFrame {
    return {
      type: 'end',
      attemptId: this.attemptId,
      revision: this.revision,
      index: this.index,
      outcome: { kind: 'abandoned' },
    }
  }
}

/** Controlled worker facade used to express backend component failures in tests. */
export class FakeWorker {
  constructor(readonly observer: FakeBackendObserver) {}

  /**
   * Publish a caller-supplied backend-neutral worker snapshot.
   * @param observation - component/activity facts to send through the fake observer.
   */
  observe(observation: Omit<BackendObservation, 'observerId'>): void {
    this.observer.emit(observation)
  }
}
