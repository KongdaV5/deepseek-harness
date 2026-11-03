---
description: "Opt in to foreground Computer Use through the existing profile bundle list."
kind: "package-bundle"
---

# @deepseek-ai/dsh-computer-use-bundle

English | [中文](README.zh.md)

## Summary

Add this optional bundle using the existing Plugins interface. It is available but absent from the default Custom profile bundle list. Enabling it composes the official registry and MCP provider, Custom safety and minimal client controls. Disabling it stops and drains owned work; it does not erase uncertain outcomes.

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

Add this optional bundle using the existing Plugins interface. It is available but absent from the default Custom profile bundle list. Enabling it composes the official registry and MCP provider, Custom safety and minimal client controls. Disabling it stops and drains owned work; it does not erase uncertain outcomes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider launches `cua-driver mcp` only on explicit bundle activation. The child environment sets `CUA_DRIVER_RS_PERMISSIONS_GATE=0` to suppress automatic permission onboarding; it does not bypass macOS grants or runtime approval. failOnStartupError:false reuses the official MCP reconnect policy, so a missing executable does not block Desktop startup. Profile bundle presence is the only enablement owner; there is no second boolean setting. The bundle adds no persistence framework.

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

The optional composition adds `computer-use:custom-safety` foreground admission, approval and user-takeover guidance through safety; the official provider supplies tool schemas and results.

#### Token effect

Enabling the composition adds safety guidance and driver tool schemas; observation results use upstream content and image admission.

#### KV Cache effect

This package manages no model KV cache; the selected provider owns cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Computer Use V1 supports foreground Local turns only. Schedule and Codex remain unsupported, with no model substitution or bridge. macOS grants belong to CuaDriver in the default proxy mode; user-triggered permission controls report explicit grants. Native qualification and formal promotion are separate from source tests.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
