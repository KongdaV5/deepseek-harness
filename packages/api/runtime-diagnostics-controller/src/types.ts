/**
 * Wire vocabulary for the generic transient runtime-diagnostics transport.
 *
 * The transport is deliberately domain-neutral. It knows one thing: some owner
 * — a compaction policy, a scheduler, a later maintenance plane — can be asked
 * for its *current* observation of a Session, and can announce replacements.
 * It knows nothing about what the observation means, so it can never become a
 * second authority over it: it holds no phase map, validates no semantics, and
 * persists nothing.
 *
 * Two shapes carry that contract:
 *
 * - {@link RuntimeDiagnosticsProvider} is what an owner implements. It is
 *   read-only: `read` reports the owner's current observation, and `subscribe`
 *   announces replacements. There is no writer, no trigger, and no phase verb.
 * - {@link RuntimeDiagnosticsFrame} is what crosses the wire. Every frame is a
 *   *complete replacement* rather than a patch, so a client that missed frames
 *   while disconnected cannot end up with a half-applied state; it only has to
 *   take the last frame it received in the current generation.
 *
 * The observation is a detached JSON-compatible value. A frame that cannot be
 * serialized is a transport failure, not a silently truncated value, so a
 * client never renders a partially transported observation as current.
 *
 * @module @deepseek-ai/dsh-api-runtime-diagnostics-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The follow request named no topic, no Session, or a malformed pair. */
    'runtime-diagnostics/invalid-request': Record<string, never>
    /** No provider is registered for the requested topic. */
    'runtime-diagnostics/provider-unavailable': { readonly topic: string }
    /** A provider produced a value that is not detached JSON. */
    'runtime-diagnostics/invalid-observation': { readonly topic: string }
    /** The resource address does not name a runtime-diagnostics target. */
    'runtime-diagnostics/invalid-address': Record<string, never>
    /** The Client declares no schema for the addressed topic, so it cannot be read. */
    'runtime-diagnostics/unknown-schema': { readonly topic: string }
    /** A frame violated the stream contract (order, identity, or schema). */
    'runtime-diagnostics/unexpected-frame': { readonly detail: string }
  }
}

/**
 * One topic's declared identity.
 *
 * A topic is the unit of routing, and the schema pair is the unit of
 * compatibility: a client that does not recognize a schema must refuse the
 * observation rather than interpret it, because the alternative is casting an
 * untrusted payload and rendering a value the producer never sent.
 */
export interface RuntimeDiagnosticsTopicDeclaration {
  /** The routing key. One provider owns one topic. */
  readonly topic: string
  /** Stable identity of the observation schema this topic carries. */
  readonly schemaId: string
  /** Version of that schema. A change is a new value, never a reinterpretation. */
  readonly schemaVersion: number
}

/**
 * The detached JSON an observation value may be.
 *
 * The transport is domain-neutral, so it cannot name the fields a topic's
 * observation has — but a Remote boundary cannot carry open `unknown` data and
 * still be codec-checked, and a client must never render a value nobody
 * validated. A concrete recursive JSON type is the intersection of those two
 * constraints: the owner's value keeps whatever fields its topic declares, the
 * generated codec validates the whole tree on the wire, and the transport still
 * learns nothing about what the fields mean.
 */
export type RuntimeDiagnosticsValue =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeDiagnosticsValue[]
  | { readonly [key: string]: RuntimeDiagnosticsValue }

/**
 * One observation, present or explicitly absent.
 *
 * Absence is a value, not an error: an owner that has observed nothing for a
 * Session reports `present: false`, which is different from the transport
 * failing and different again from no provider existing at all.
 */
export type RuntimeDiagnosticsObservation =
  | { readonly present: false }
  | { readonly present: true; readonly value: RuntimeDiagnosticsValue }

/**
 * One complete replacement crossing the wire.
 *
 * `topic` and `sessionId` are repeated on every frame so a client can verify
 * them against the address it asked for; `schemaId`/`schemaVersion` are repeated
 * so a client validates the contract on every frame rather than only once.
 */
export interface RuntimeDiagnosticsFrame {
  /** `snapshot` opens a generation; `change` replaces the value within one. */
  readonly type: 'snapshot' | 'change'
  /** The routing key the frame belongs to. */
  readonly topic: string
  /** The Session the observation is about. */
  readonly sessionId: string
  /** The observation schema identity the value obeys. */
  readonly schemaId: string
  /** The observation schema version the value obeys. */
  readonly schemaVersion: number
  /** The complete observation, never a patch. */
  readonly observation: RuntimeDiagnosticsObservation
}

/** The request that opens one follow generation. */
export interface RuntimeDiagnosticsFollowRequest {
  /** The topic to observe. Exactly one registered provider must serve it. */
  readonly topic: string
  /** The Session to observe. */
  readonly sessionId: string
}

/**
 * What an owner reports before the transport detaches it.
 *
 * An owner states its value as an `object` because a topic's field names are the
 * topic's business, not the transport's. This is the only looseness in the
 * protocol, and it stops here: the value is walked into
 * {@link RuntimeDiagnosticsValue} before any frame is built, and a value that
 * cannot be walked fails the stream rather than travelling half-serialized.
 */
export type RuntimeDiagnosticsProviderObservation =
  | { readonly present: false }
  | { readonly present: true; readonly value: object }

/**
 * One owner's read-only observation face.
 *
 * Implementing this interface is the whole integration: the owner keeps its own
 * state and its own semantics, and lends the transport a read and a
 * subscription. Neither method may mutate the owner.
 */
export interface RuntimeDiagnosticsProvider extends RuntimeDiagnosticsTopicDeclaration {
  /**
   * Read the owner's current observation for one Session.
   * @param sessionId - the Session identity.
   * @returns the current observation, or `undefined` when the owner holds none.
   *  `undefined` and `{ present: false }` both travel as `present: false`.
   */
  read(sessionId: string): RuntimeDiagnosticsProviderObservation | undefined
  /**
   * Observe one Session's replacements until the disposer runs.
   *
   * Registration must not synchronously deliver the current observation: a
   * caller closes the snapshot/change race by subscribing and then reading with
   * no await in between, which is only sound when registration is silent.
   * @param sessionId - the Session identity.
   * @param listener - receives each complete replacement, or `undefined` on removal.
   * @returns an idempotent disposer.
   */
  subscribe(
    sessionId: string,
    listener: (observation: RuntimeDiagnosticsProviderObservation | undefined) => void,
  ): () => void
}
