---
description: "Compose the Custom configuration and persistence plugins over RC.2 base and Web bundles. Start a new profile with an explicit Local Huihui default supplied by bootstrap. Keep hosted defaults, Schedule and Computer Use out of the implicit composition."
kind: package-bundle
---

# @deepseek-ai/dsh-desktop-custom

English | [中文](README.zh.md)

## Summary

Compose the Custom configuration and persistence plugins over RC.2 base and Web bundles. Start a new profile with an explicit Local Huihui default supplied by bootstrap. Keep hosted defaults, Schedule and Computer Use out of the implicit composition.

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

The layer adds custom-foundation, agent-codex and task-checkpoint. It disables deepseek-account, llm-deepseek, hosted search, timer, HMR and model-generated titles. Bootstrap sets provider configuration and the default model in the official profile patch; an uninitialized composition keeps an unregistered sentinel and fails closed. Optional Schedule and Computer Use bundles are never installed by this layer.

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

This layer contributes no prompt bytes. The composed `agent-default-model` selects Local Huihui; existing Web and Agent plugins own model context.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect; this layer executes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The M1 profile is a persistence foundation. Codex and Local execution, integrated Desktop behavior and final UI are M2 work.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence and disposal through the owning isolated tests.
