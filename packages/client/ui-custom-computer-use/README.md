---
description: "Read Computer Use status and stop desktop work through Host-owned controls."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-custom-computer-use

English | [中文](README.zh.md)

## Summary

The optional bundle mounts a Computer Use tab in Plugins settings and a Global Stop row above every visible conversation composer. These controls use canonical Remote operations. Enablement stays with the standard Plugins bundle list. No renderer lease or runtime manager exists.

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

The optional bundle mounts a Computer Use tab in Plugins settings and a Global Stop row above every visible conversation composer. These controls use canonical Remote operations. Enablement stays with the standard Plugins bundle list. No renderer lease or runtime manager exists.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The optional UI mounts its generated Computer Use Remote contribution through the Gateway before injecting the namespace into its controls. Removing the UI releases both the namespace and controls. A disposable observation polls redacted Host status while controls are mounted. Permission checks and prompts occur only on explicit button presses. Global Stop remains available during other asynchronous operations. Stale responses cannot overwrite a newer Stop result; unavailable Host facts remove stale healthy status.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Custom foundation ledger](../../../docs/custom-foundation.md) records product ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Runtime integration

#### What the model sees

The `computerUse.status` controls register no prompt, tool schema or conversation content; safety and the official provider own model-visible content.

#### Token effect

This UI adds no direct prompt tokens.

#### KV Cache effect

This package manages no model KV cache; the selected provider owns cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Existing approval UI owns action confirmation; sensitive inputs require manual takeover. Resume is disabled while draining or poisoned. The UI does not infer permission grants, read credentials, capture screenshots or decide execution authority. Optional bundle removal retires polling and pending publications.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
