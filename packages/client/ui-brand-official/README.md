---
description: "Registers the DeepSeek Harness sidebar wordmark alongside its motion-synced assistant mascot."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

An `official` client build shows the existing DeepSeek Harness wordmark beside the shared assistant mascot; the wordmark keeps its original artwork and lightly echoes the mascot's motion. The mascot breathes and blinks at rest, makes varied short idle gestures, follows the pointer over its mark, and reacts to composer and navigation actions. It respects reduced-motion preferences and does not affect model requests. Other build profiles keep the shell's mascot fallback and local-build label. Choose it for deployments branded as DeepSeek Harness; deployments with another identity should provide a replacement brand package.

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

Mount this plugin in the browser roster of a deployment whose identity is DeepSeek's own, then build the client with the `official` profile so the sidebar occupants register.

### Choosing the profile

`DSH_CLIENT_BUILD_PROFILE=official` registers the DeepSeek wordmark and the shared animated assistant mascot in the sidebar. The wordmark artwork is unchanged while its wrapper follows the mascot's idle breathing and short action gestures. The conversation hero shows that same shared mark from its own declaring package regardless of profile, because that fallback is already the official mark. Any other value leaves the shell fallback — the mascot and the local-build label — in place. The plugin still loads and validates in both cases; only the sidebar registration is profile-gated.

### Replacing the brand

An additional product identity should compose its own package that occupies the sidebar slots. Slot registration is the only composition route; there is no user-configurable brand setting here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state, and its three slot occupants install and leave through one transactional effect.
