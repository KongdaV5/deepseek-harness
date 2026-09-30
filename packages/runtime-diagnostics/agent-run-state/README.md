---
description: "Derive stable Run identities and run state from committed Session turns. Keep backend observations separate from durable authority. Reconstruct the same logical Run after restart without storing process-local attempt counters."
kind: package-library
---

# @deepseek-ai/dsh-agent-run-state

English | [中文](README.zh.md)

## Summary

Derive stable Run identities and run state from committed Session turns. Keep backend observations separate from durable authority. Reconstruct the same logical Run after restart without storing process-local attempt counters.

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

Use through the Custom profile bundle composition; this package owns no additional application launcher.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

runIdFor derives an injective identity from SessionId and the durable turn ordinal. The library emits no event and allocates no run. Native Session and lifecycle projections supply the facts; observations never create or settle authority.

No runtime invariant companion is published because persistence writes use the existing Session or ConfigEditor validation and this package owns no independently diverging state copy.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Custom foundation ledger](../../../docs/custom-foundation.md)

-----

<a id="model-experience"></a>
## Model Experience

### Persistence foundation

#### What the model sees

The `runIdFor` identity and run projections are diagnostics; they add no prompt bytes or model requests.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect; this layer executes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Live runtime observation and Run Details transport remain deferred to M2.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence and disposal through the owning isolated tests.
