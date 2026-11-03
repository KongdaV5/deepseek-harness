---
description: "Inspect Local model health and Codex subscription status in Models settings. Start or switch an installed Local text profile and stop its owned serving resource. Choose a verified Codex runtime or begin an explicit sign-in action. Unavailable observations replace stale status and never trigger a cloud fallback."
kind: package-reference
---

# @deepseek-ai/dsh-client-ui-custom-runtime

English | [中文](README.zh.md)

## Summary

Inspect Local model health and Codex subscription status in Models settings. Start or switch an installed Local text profile and stop its owned serving resource. Choose a verified Codex runtime or begin an explicit sign-in action. Unavailable observations replace stale status and never trigger a cloud fallback.

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

Use the Custom composition, which mounts this Client contribution in the official Models footer. Choose an available exact text profile; unavailable profiles and unverified System runtime choices stay disabled. Changing a runtime preference does not change account ownership. Authentication controls always require an explicit user action. The Local card identifies the Host-reported active profile and modality. Start/switch, stop and explicit restart invoke the existing Host controller; a profile is restartable only while the Host reports safe stop ownership.

The Local runtime line uses the same Host snapshot to distinguish disabled, unavailable, stopped, starting, ready, stopping and error, and names the active profile when one is running. Computer Use has its own separately labeled lease/Global Stop row; its idle lease never means the Local runtime is stopped. This card adds no polling timer.

The Codex card shows Host-reported runtime and account states, the selected runtime source/version, runtime selection notes and dynamic model count. Both available usage windows include their used percentage, duration and reset time. Missing quota information remains unavailable; it does not affect routing or infer connection health.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The object-layer RuntimeSettingsModel reads both redacted Remote status owners and publishes a complete observation. Generation retirement rejects delayed reads, while a single operation gate serializes user interactions. Renderer-bound observable hooks keep Host Context, runtime state machines and imperative subscriptions outside the component. Local and Codex controllers remain the only mutation owners.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Models settings](../ui-settings-models/README.md)
- [Local runtime owner](../../boot/custom-foundation/README.md)
- [Codex runtime owner](../../core/agent-codex/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### Runtime integration

#### What the model sees

The controls register no prompt, tool schema or conversation text. The `session.selectModel` selection and provider owners determine the model-facing request.

#### Token effect

This package adds no direct prompt tokens; the selected execution and request-assembly owners determine token use.

#### KV Cache effect

This package keeps no model KV cache; the selected provider owns cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Native window layout and installed runtime behavior require M3 qualification.
- The read join has no automatic polling timer; connection reset, adapter invalidation, completed actions and explicit refresh obtain fresh status.
- Original Qwen is a text profile; image inventory is not an inference route here.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Source tests use isolated runtime owners and explicit Remote operations. The migration ledger records real-smoke limits separately from fixture evidence.

</details>
