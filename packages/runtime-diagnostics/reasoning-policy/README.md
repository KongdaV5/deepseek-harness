---
description: "Capability-aware reasoning policy for DS Harness: resolve what an exact provider/model route will actually be asked for, keeping requested and resolved reasoning distinct and failing closed on an unsupported request."
kind: "package-library"
---

# @deepseek-ai/dsh-reasoning-policy

English | [中文](README.zh.md)

## Summary

Answer what reasoning an exact provider/model route will really be asked for, before the request exists. The package reads the route's own advertised capability, keeps the *requested* value and the *resolved* value apart, and refuses an unsupported request instead of silently dropping, escalating, or guessing it. Resolution is pure and total: every input yields either a supported resolution that names its source, or an explicit reason it cannot be honored. It is a library with no plugin entry, no Session event, and no persisted state.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

Its capability input is the current upstream `LlmResolvedModelInfo.reasoning` an adapter already publishes for one exact provider/model route. There is no second capability database and no repository-owned reasoning level enum, because the adapter that will serialize the request is already the only authority on what that route accepts.

```ts
import {
  resolveReasoning,
  requireResolvedReasoning,
  applyReasoningResolution,
  taskReasoningMetadata,
} from '@deepseek-ai/dsh-reasoning-policy'
import type { LlmCallConfig, LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

declare const modelInfo: LlmResolvedModelInfo
declare const requested: ReasoningEffortId | undefined
declare const baseCallConfig: LlmCallConfig

const resolution = resolveReasoning({
  provider: modelInfo.provider,
  model: modelInfo.id,
  requested,
  capability: modelInfo.reasoning,
})

// Fail closed before any request is proposed: an unsupported effort throws
// here, at the policy boundary, instead of depending on a backend rejection.
const config = applyReasoningResolution(baseCallConfig, requireResolvedReasoning(resolution))

taskReasoningMetadata(resolution)
// { requestedReasoning?: 'high', resolvedReasoning?: 'medium' }
```

### Requested is not resolved

The whole reason this package exists is one distinction. A *requested* effort is what a task, profile, or caller asked for. A *resolved* effort is what the exact route can accept and what the request will actually carry. A resolution never reports a level as resolved merely because it was requested, and a caller can always see which of the three sources supplied it:

- `request` — the request named an effort the route advertises, used unchanged;
- `provider-default` — the request named nothing, so the route's declared default is used;
- `omitted` — the request named nothing and the route declares no default, so the request genuinely carries no reasoning preference.

`omitted` is a real answer rather than a missing one. Reporting a default that was never sent would claim a setting the provider never received.

### An unsupported request is terminal, not recoverable

A request the route cannot honor resolves to `kind: 'unsupported'` with the value asked for, the value set the route *does* advertise, and one of two reasons: `route-declares-no-reasoning` or `effort-not-offered`. Nothing is downgraded, nothing is upgraded, and no request is formed. `requireResolvedReasoning` is the fail-closed bridge: it throws `ReasoningPolicyError` with `UNSUPPORTED_REASONING_EFFORT_CODE` so an invalid configuration surfaces at the policy boundary rather than as a provider surprise.

### The capability is validated, not trusted

A route that advertises reasoning must advertise its own declared default. A capability whose `defaultEffort` is not among its advertised `efforts` is incoherent configuration and raises `INVALID_CAPABILITY` rather than being rounded into a resolution. Capability reads go through `reasoningCapabilityOf`, `advertisedReasoningEfforts`, and `advertisesReasoningEffort`, so membership is answered the same way everywhere.

-----

<a id="api"></a>
## API

```ts
import {
  advertisedReasoningEfforts,
  advertisesReasoningEffort,
  applyReasoningResolution,
  reasoningCapabilityOf,
  reasoningMetadataFromHeader,
  requireResolvedReasoning,
  resolveReasoning,
  ReasoningPolicyError,
  taskReasoningMetadata,
  UNSUPPORTED_REASONING_EFFORT_CODE,
} from '@deepseek-ai/dsh-reasoning-policy'

import type { ReasoningCapability, ReasoningPolicyInput, ReasoningResolution } from '@deepseek-ai/dsh-reasoning-policy/types'
```

| Export | Role |
|---|---|
| `resolveReasoning(input)` | Resolve one exact route and one optional request into a supported or unsupported resolution; never throws on an unsupported effort. |
| `requireResolvedReasoning(resolution)` | Return a supported resolution, or throw `ReasoningPolicyError` at the policy boundary. |
| `applyReasoningResolution(config, resolved)` | Write the resolved effort onto a call config, clearing any inherited effort first so an unrequested value cannot leak through. |
| `reasoningCapabilityOf(model)` | Read the upstream capability off a resolved model info, or `undefined`. |
| `advertisedReasoningEfforts(capability)` / `advertisesReasoningEffort(capability, effort)` | Read the advertised set, or test one effort's membership. |
| `taskReasoningMetadata(resolution)` | Produce the two truthful fields (`requestedReasoning`, `resolvedReasoning`) a durable task execution record can carry. |
| `reasoningMetadataFromHeader(header)` | Split an epoch header into requested and resolved by reading `adapterDefaults.reasoningEffort`, so an adapter-materialized value is never reported as a caller request. |
| `ReasoningPolicyError` / `UNSUPPORTED_REASONING_EFFORT_CODE` | The fail-closed error and the code it carries. |
| `ReasoningCapability` / `ReasoningPolicyInput` / `ReasoningResolution` | The capability contract, one resolution input, and the resolution union. |

The `/types` outlet carries the contracts with no runtime import.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the per-call reasoning field it validates into the `dsh-llm` request.

#### KV Cache effect

Reasoning effort travels as a request parameter rather than as part of the cached prompt prefix, so keeping, clearing, or substituting it changes what the provider is asked to do without invalidating a reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Resolution is only as truthful as the adapter's capability** — a route that publishes an incomplete `reasoning` block is reflected exactly, so a wrong capability is fixed in the adapter rather than compensated for here.
- **No repository-owned reasoning levels are introduced** — efforts remain the upstream `ReasoningEffortId` brand, so this package cannot express a level a provider has not declared.
- **The policy is not wired into request assembly by this package** — a composition must call `resolveReasoning` and `applyReasoningResolution` at its own seam, because this library mounts no plugin entry and installs no listener.
- **No capability caching or discovery is performed** — every call reads the capability its caller supplies, so there is no second store to keep in sync with the adapters and nothing to invalidate.
- **An adapter-materialized default is reported as resolved, never as requested** — `reasoningMetadataFromHeader` reads `adapterDefaults.reasoningEffort` to make that split, so a header that lost that fact cannot be separated afterwards.
- **No runtime invariant companion is published because the resolution is a pure total function of its inputs and the package holds no mutable runtime state** — its contracts are proven by the package spec rather than by a runtime observer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The resolution is a pure function of `(provider, model, requested, capability)`, which is what makes it safe to call before a request exists and cheap to re-derive: equal inputs give an equal resolution.

This package adds no durable vocabulary, so it does not participate in the persistence catalog and needs no `docs/persistence-changes` record. Its `TaskReasoningMetadata` field names match the restored v1 `TaskExecutionMetadata` contract exactly, so a producer spreads it without translation.

</details>
