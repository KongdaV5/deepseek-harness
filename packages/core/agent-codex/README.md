---
description: "Run explicitly selected Codex models through the official App Server subscription path. Discover available models from the active runtime and keep DSH conversation history canonical. Restore private thread mappings without repeating uncertain dispatches. Runtime preference changes preserve authentication generation and refuse active-turn replacement."
kind: package-reference
---

# @deepseek-ai/dsh-agent-codex

English | [中文](README.zh.md)

## Summary

Run explicitly selected Codex models through the official App Server subscription path. Discover available models from the active runtime and keep DSH conversation history canonical. Restore private thread mappings without repeating uncertain dispatches. Runtime preference changes preserve authentication generation and refuse active-turn replacement.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the Custom profile composition and the Models subscription controls. Verified System discovery and the pinned Bundled runtime supply the explicit auto/system/bundled choices. No API-key substitute or hosted fallback is admitted. An unavailable account or selected model fails visibly; reconnect does not imply login or authorize replay.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Codex Config owns runtime preference, authGeneration and the pending auth transition marker. The transaction owner alone updates lifecycle fields through ConfigEditor; generic Settings exposes only preference. CodexSubscriptionRuntime owns the child, process-local epoch, leases, account transactions and private thread protocol. Canonical plugin-qualified Session snapshots preserve thread binding and reconciliation obligations; native assistant settlement proves answer delivery. The external AgentLoop seam keeps DSH turn/cancellation/history ownership with the native driver. The state leaf face gives format catalogs pure projection types without importing Host Context into Client contracts.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Custom foundation ledger](../../../docs/custom-foundation.md)
- [AgentLoop](../agent-loop/README.md)
- [Session foundation](../session/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### Runtime integration

#### What the model sees

The external runtime receives the current user request and bounded canonical public history when a private thread needs bootstrap. `plugin:codex/subscription-state` mapping metadata and redacted activity are not conversation messages. Local prompt and tool assembly is skipped for the admitted external route.

#### Token effect

Bounded public-history bootstrap consumes context tokens when a private thread is created. The App Server reports actual turn usage; mapping and diagnostic metadata add none.

#### KV Cache effect

This package keeps no model KV cache; the selected provider owns cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- An unresolved remote outcome blocks replay until authoritative thread/turn reconciliation succeeds.
- Real inference requires an already authenticated dedicated Codex home; source fixtures never inspect or copy credentials.
- Native packaged discovery, persistence restart and installed lifecycle remain M3 evidence obligations.
- No runtime invariant companion is published; canonical Session validation and transaction-owner tests check the lifecycle without a second mutable observer.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Source tests use isolated runtime owners and explicit Remote operations. The migration ledger records real-smoke limits separately from fixture evidence.

</details>
