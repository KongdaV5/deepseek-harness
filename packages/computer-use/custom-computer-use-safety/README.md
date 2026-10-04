---
description: "Enable foreground Local Computer Use with one desktop owner, approval and Host Stop."
kind: "package-reference"
---

# @deepseek-ai/dsh-custom-computer-use-safety

English | [中文](README.zh.md)

## Summary

Use this package beside the official registry and MCP provider in the optional Computer Use bundle. Observation uses an exact reviewed read-only catalog; unknown tools are actions. Every mutation is reviewed through canonical approval because input names cannot establish high-risk intent. Schedule and Codex routes are refused.

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

Use this package beside the official registry and MCP provider in the optional Computer Use bundle. Observation uses an exact reviewed read-only catalog; unknown tools are actions. Every mutation is reviewed through canonical approval because input names cannot establish high-risk intent. Schedule and Codex routes are refused.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One Host-root memory lease survives bundle reloads. Root Session and turn identify its owner; verified child agents share that owner. Stop rejects new calls, aborts in-flight work, and drains before release. A timed-out drain or failed/cancelled dispatched action poisons the lease; resume cannot clear poison. Old work must be shut down and the desktop checked before restarting the Host and driver. No lease, pending physical action, permission or screenshot is persisted by this package.


V1 presentation is owned by [presentation.ts](src/presentation.ts), using the official per-Agent ToolRuntime restriction seam. CuaDriver 0.22.0 discovers 56 tools globally; the model receives eight: `get_accessibility_tree`, `list_windows`, `get_window_state`, `click`, `type_text`, `press_key`, `scroll`, and `bring_to_front`. Structured window state uses `include_screenshot:false` and element tokens for the text-only Local route. Advanced browser/visual/session controls and sensitive clipboard/recording/configuration/install/replay operations remain outside V1. Future unknown tools default to not presented. Host permission controls retain the complete registry; non-CU schemas and every ACT safety gate are unchanged. The five reviewed catalog groups are in the same policy source, rather than a second catalog or UI allowlist.

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

The frozen request keeps the same transcript and non-CU tools. Selecting eight CU definitions reduces CU schema tokens from 24,018 to 6,664 and total input from 34,157 to 16,803 (50.8%). Counts use the deployed server template/tokenizer; cache-read tokens are a subset of input. Observation results still use upstream content and image admission.

#### KV Cache effect

This package manages no model KV cache; the selected provider owns cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Host controller exposes redacted status, explicit permission queries/requests, Stop and idle-only resume. Permission grants require boolean fields in the canonical MCP result's structuredContent; readable text cannot authorize access. Prompt authority is tied to a single user-request call ID, never a session flag. No startup permission query occurs. Permission failures remain denied; unavailable catalog reports driver-unavailable. Credentials require user takeover. Clipboard, recording, configuration, installation and trajectory replay calls are excluded.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
