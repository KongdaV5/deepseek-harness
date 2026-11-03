---
description: "Initialize a Custom profile with Huihui Qwen 27B as its default. Translate legacy Custom settings into plugin-owned profile patches on an explicitly supplied data root. Read Local inventory without inspecting model files or starting a driver."
kind: package-reference
---

# @deepseek-ai/dsh-custom-foundation

English | [中文](README.zh.md)

## Summary

Initialize a Custom profile with Huihui Qwen 27B as its default. Translate legacy Custom settings into plugin-owned profile patches on an explicitly supplied data root. Read Local inventory without inspecting model files or starting a driver.

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

Desktop captures the OS account home before isolating Harness data and passes it to Host as `DSH_DESKTOP_MACHINE_RESOURCE_HOME`. Host supplies that machine resource home to the existing default-model registration and Local runtime Config; the LaunchAgent driver requires it explicitly and never derives it from `HOME`. The launcher refreshes this owned field on startup while preserving user model paths and runtime preferences. Rehearsal isolates Harness configuration, Sessions, caches and Electron state while referencing the actual machine manager, LaunchAgent and model files. Correcting a previously generated rehearsal catalog uses `customLocalPatches` on that isolated profile only.

Generated Huihui metadata declares a 65,536-token total context; the Local adapter admits each serialized text request against both that declaration and the running server capacity. Profile initialization upgrades only the unchanged generated 32k Huihui entry, preserving explicit user capacities. Exact-target Local policies use the existing compaction engine with 4,096 tokens of headroom and an 8,192-token summary cap. The profile remains the sole configuration owner; no tools are removed to fit requests.

New Custom profiles seed only text models; image model inventories are explicitly registered in Settings.

The local image adapter advertises image profiles from CustomFoundation in the same Session model catalog as chat models. It sends text prompts and an optional single reference image to the loopback OpenAI Images `generations` endpoint, verifies the exact image profile is running, commits returned PNG bytes through the attachment store, and emits the durable image block through the normal assistant stream. It never sends an image model to the Chat Completions endpoint.

Image requests use native loopback HTTP with a configurable total `timeoutMs` (default 3,600,000 ms), covering generation and response reading without the five-minute fetch header deadline. Session cancellation still aborts the request; returned images use the existing attachment and Session owners. The prompt and reference come from the latest human-authored message (`source.kind = user`); harness context can also have the user role and must never replace that input.

The exact generated legacy `local-huihui-qwen` route is upgraded to the same Local deployment headers and capacities and hidden from new selections. New defaults move to `dsh-local-huihui`; the old route ID remains resolvable for stored Session selections. The runtime checks both the canonical route and the hidden generated alias against the exact served model before each step. User-edited visible routes are preserved. Retire this alias only when supported persisted selections no longer reference it.

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

- Legacy import is a one-way compatibility module, not a second Settings store. Remove it only after supported Custom V3 profiles and settings archives are retired. The Local runtime controller serializes start/stop/switch, persists only exact successfully served profile intent and refuses foreign or stale health. The LaunchAgent driver owns no external service lifetime; the optional owned-process driver releases its handle only after the official subprocess range exits. Settings can register additional installed llama.cpp GGUF text models and MFlux Qwen Image 2.1 model directories; each remains in the shared one-model-at-a-time runtime. Other image families and loader engines still need explicit runtime support.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence and disposal through the owning isolated tests.
