---
description: "Initialize a Custom profile with Local Huihui Qwen as its default. Translate legacy Custom settings into plugin-owned profile patches on an explicitly supplied data root. Read Local inventory without inspecting model files or starting a driver."
kind: package-reference
---

# @deepseek-ai/dsh-custom-foundation

English | [中文](README.zh.md)

## Summary

Initialize a Custom profile with Local Huihui Qwen as its default. Translate legacy Custom settings into plugin-owned profile patches on an explicitly supplied data root. Read Local inventory without inspecting model files or starting a driver.

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

CustomFoundation owns Local manager inventory and capability preferences; agent-default-model owns the default selection and llm-pi-ai owns provider profiles. Legacy translation validates all recognized sections before one atomic write under the official profile lock. The source archive and an import digest recover both old partial imports and publication-before-archive interruption. Existing profile values win; competing authentication authority fails closed. Unknown sections remain in the source archive and are returned to the caller.

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

No prompt bytes; `agent-default-model` and `llm-pi-ai` consume persisted Local intent to select the provider.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect; this layer executes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Legacy import is a one-way compatibility module, not a second Settings store. Remove it only after supported Custom V3 profiles and settings archives are retired. Local runtime execution, inventory probing and UI actions belong to M2.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence and disposal through the owning isolated tests.
