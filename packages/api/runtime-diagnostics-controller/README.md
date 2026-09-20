---
description: "Domain-neutral transient runtime diagnostics transport: one topic-keyed provider registry, a typed Remote stream that opens with a synchronous snapshot and delivers ordered full replacements, and a Client resource provider that publishes each observation as a live resource."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-runtime-diagnostics-controller

English | [中文](README.zh.md)

## Summary

Use this package to move a runtime's *current* observation of a Session to the web client without making the transport a second authority over it. An owner publishes through a read-only provider; the controller routes one stream per topic and Session; the client reads it as a live resource. Every frame is a complete replacement, absence is a value, and a stream that ends or fails is reported as unavailable rather than as a stale value still looking current.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Publish an observation from the Host

A domain package registers one provider per topic. The provider is read-only: it reports its current observation and observes replacements, and it exposes no writer, no trigger, and no phase vocabulary. `undefined` and `{ present: false }` describe the same absence.

```ts
import type { RuntimeDiagnosticsProvider } from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/types'

declare const policy: {
  diagnostics(sessionId: string): object | undefined
  subscribeDiagnostics(sessionId: string, listener: (value: object | undefined) => void): () => void
}

const provider: RuntimeDiagnosticsProvider = {
  topic: 'task-aware-compaction',
  schemaId: 'dsh.task-aware-compaction-diagnostics',
  schemaVersion: 1,
  read: sessionId => {
    const value = policy.diagnostics(sessionId)
    return value === undefined ? undefined : { present: true, value }
  },
  subscribe: (sessionId, listener) => policy.subscribeDiagnostics(
    sessionId,
    value => listener(value === undefined ? undefined : { present: true, value }),
  ),
}
```

| Method | Returns | Purpose |
|---|---|---|
| `registerProvider(provider)` | disposer | Binds one topic to one provider; a second provider for the same topic throws, and the disposer ends that topic's open streams |
| `follow({ topic, sessionId }, signal)` | stream of `RuntimeDiagnosticsFrame` | One generation: exactly one `snapshot` frame, then `change` frames in commit order |

### Read an observation from the Client

The client mounts the generated contribution, declares the schema each topic carries, and reaches the transport through the resource model — `useResource(runtimeDiagnosticsAddress(topic, sessionId))`. A topic nobody declared fails closed, because rendering an observation nobody validated is worse than showing none.

```ts
// Type-only: the observation vocabulary this surface decodes. The `./client`
// half also exports `runtimeDiagnosticsAddress`, which builds the address below.
import type { RuntimeDiagnosticsObservation } from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/types'

declare const runtimeDiagnosticsTopics: {
  declare(topic: string, schema: { schemaId: string; schemaVersion: number }): () => void
}
// Supplied by the controller's client mount over the resource model.
declare function useResource(address: string): {
  status: 'none' | 'loading' | 'live' | 'failed'
  value: RuntimeDiagnosticsObservation | undefined
}
declare function runtimeDiagnosticsAddress(topic: string, sessionId: string): string

runtimeDiagnosticsTopics.declare('task-aware-compaction', {
  schemaId: 'dsh.task-aware-compaction-diagnostics',
  schemaVersion: 1,
})

export function readTransientCompaction(sessionId: string): RuntimeDiagnosticsObservation | undefined {
  return useResource(runtimeDiagnosticsAddress('task-aware-compaction', sessionId)).value
}
```

The address grammar is `dsh-resource://runtime-diagnostics/<topic>/<sessionId>`, parsed strictly: exactly two path segments, each the canonical encoding of what it decodes to. An address that names two things, or names one thing two ways, names nothing.

### Wire vocabulary

| Type | Meaning |
|---|---|
| `RuntimeDiagnosticsFrame` | `{ type, topic, sessionId, schemaId, schemaVersion, observation }` — one complete replacement |
| `RuntimeDiagnosticsObservation` | `{ present: false }`, or `{ present: true, value }` where the value is detached JSON |
| `RuntimeDiagnosticsValue` | The recursive JSON an observation value may be |
| `RuntimeDiagnosticsFollowRequest` | `{ topic, sessionId }` — the pair one stream serves |

Every frame repeats `topic`, `sessionId`, `schemaId`, and `schemaVersion` so a client validates the contract on every frame rather than only once, and so a frame that lost its identity in transit is refused instead of rendered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The controller owns routing and delivery and nothing else. It keeps no current-value map, caches nothing it delivered, and writes to no provider, so a reconnect re-reads the owner instead of replaying remembered state.

The opening snapshot closes one specific race. A reader that subscribes and then reads has to be sure no change landed in between, so registration is silent by contract and the read is synchronous: no code runs between the two, which makes the gap structurally empty rather than merely narrow.

Delivery is a buffer, not authority. A generation holds the observations the owner already committed, in commit order, and discards them as they are read. A value that has no JSON representation — a function, a symbol, a bigint, a non-finite number, a class instance, a cycle, or an `undefined` member — fails the stream closed rather than being silently truncated, so a client never renders a half-transported observation.

The client provider re-validates every frame instead of casting it. A payload is untrusted input even when the generated codec already parsed it, because the provider is also driven by foreign implementations. A stream must open with exactly one `snapshot`; a second snapshot, a change before the snapshot, a frame for another topic or Session or schema, and an unexpected end are all failure frames. The resource model keeps the last `ok` value through a later failure, so the provider ends a finished generation with a failure rather than letting it end silently — that is what makes a disconnect read as unavailable instead of as the last phase the Host happened to publish before it went away.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `RuntimeDiagnosticsController`: topic registry, one generation per `topic + SessionId`, and the `runtimeDiagnostics.follow` Remote stream |
| [`src/stream.ts`](src/stream.ts) | The strict JSON detach step every observation passes, and one generation's ordering and notifications |
| [`src/types.ts`](src/types.ts) | Wire vocabulary, the read-only provider seam, and the declared failure codes |
| [`src/client/address.ts`](src/client/address.ts) | The `dsh-resource://runtime-diagnostics/…` parser and formatter |
| [`src/client/provider.ts`](src/client/provider.ts) | The resource provider: address to validated value stream |
| [`src/client/mount.ts`](src/client/mount.ts) | The Client topic registry and the mount lifecycle |
| [`src/client/index.ts`](src/client/index.ts) | The `./client` entry binding the generated Host-for-Client artifact |
| — | No runtime invariant companion is published; the controller is a stateless router that holds no shared runtime state, so the transport specs cover its ordering and lifetime algebra. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [API package map](../README.md) — the Host/Client Remote packages this one sits beside.
- [Client resources](../../client/resources/README.md) — the resource model, `useResource`, pins, and provider lifetime.
- [Compaction subsystem](../../../docs/subsystems/compaction.md) — the durable audit a transient observation is deliberately kept separate from.
- [Task-aware compaction policy](../../compaction/compaction-task-aware-policy/README.md) — the first owner that publishes through this transport.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transport is not durable and does not replay.** An observation exists only while its owner holds it, and a client that reconnects reads the owner's current value rather than the history it missed. Anything that must survive a restart belongs on the durable path.
- **One provider serves one topic.** Topics are a flat namespace with no hierarchy, no scoping, and no dynamic precedence: a second provider for a topic is a wiring error rather than an override.
- **The transport validates shape, never meaning.** It proves a value is detached JSON and that a frame names the address it was asked for; it cannot prove the fields mean what a topic's schema says they mean, so a client still decodes the value it renders.
- **Subscription is process-local.** Providers are bound to the Host process that mounted them; there is no cross-process fan-out and no delivery guarantee across a Host restart.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Remote boundary deserves one warning before editing `src/types.ts`: the generated codec rejects open `unknown` data, so an observation value cannot be `Record<string, unknown>`. It is a concrete recursive JSON type instead, and the provider seam stays loose (`object`) precisely so the strict walk in `src/stream.ts` remains the single place that decides what counts as transportable.

The `./client` entry is the only module that imports the generated `…/remote` artifact, which exists only after a build. Everything with behavior lives in `client/mount.ts` so the source lane can cover it, and the entry is excluded from the per-file coverage gate for that reason.

</details>
