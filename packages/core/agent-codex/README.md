---
description: "Read and edit the saved Codex runtime preference without connecting an account or starting an App Server. Restore thread mappings from canonical plugin-qualified Session events. Pending dispatch and synchronization facts remain reconciliation obligations."
kind: package-reference
---

# @deepseek-ai/dsh-agent-codex

English | [中文](README.zh.md)

## Summary

Read and edit the saved Codex runtime preference without connecting an account or starting an App Server. Restore thread mappings from canonical plugin-qualified Session events. Pending dispatch and synchronization facts remain reconciliation obligations.

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

Config owns preference, authGeneration and authTransition as live references. Preference edits use ConfigEditor and preserve the authentication fields exactly. The projection validates whole mapping snapshots; codexMappingRecovery only classifies obligations and never permits dispatch. No runtime, auth-state epoch, CODEX_HOME, transaction or account binding is initialized by this package.

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

The `plugin:codex/subscription-state` metadata never enters conversation history. The execution owner decides how to synchronize public messages.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect; this layer executes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- App Server execution, auth lifecycle, external turns and catalog discovery belong to M2. Hidden non-secret auth Config fields remain writable only for the future transaction owner by convention; preference consumers call savePreference.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence and disposal through the owning isolated tests.
