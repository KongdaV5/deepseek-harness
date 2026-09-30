---
description: "Fold committed Session lifecycle facts into durable turn and step observations. Retain interrupted and unknown outcomes rather than inferring success from a restarted process. Consume these facts from continuity and run readers."
kind: package-library
---

# @deepseek-ai/dsh-agent-lifecycle-facts

English | [中文](README.zh.md)

## Summary

Fold committed Session lifecycle facts into durable turn and step observations. Retain interrupted and unknown outcomes rather than inferring success from a restarted process. Consume these facts from continuity and run readers.

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

The pure fold derives lifecycle facts from native turn, step, message and retry records. It has no storage, timer, subscription or execution authority of its own.

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

The `lifecycleFactsFrom` facts are diagnostics; they add no prompt bytes or model requests.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect; this layer executes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Runtime execution and Desktop rendering remain deferred to M2.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence and disposal through the owning isolated tests.
