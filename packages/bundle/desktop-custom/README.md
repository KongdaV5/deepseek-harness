---
description: "Compose the Custom configuration, runtime and persistence plugins over the RC.2 base and Web bundles, with an explicit Local Huihui default and the official Schedule bundle enabled. Keep hosted defaults and Computer Use out of the Custom composition."
kind: package-bundle
---

# @deepseek-ai/dsh-desktop-custom

English | [中文](README.zh.md)

## Summary

Compose Custom configuration, runtime and persistence plugins over the RC.2 base and Web bundles. New Sessions start with Local Huihui. The Custom Desktop profile includes official Schedule for persistent reminders in their original Session; hosted defaults and Computer Use stay out of the composition.

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

The Custom Desktop profile includes `@deepseek-ai/dsh-experimental-schedule-bundle`. The standard Web profile remains opt-in: enable the bundle from Plugins or list it in `dsh.profile.bundles`. Schedule stores tasks in the Host data root and delivers each due occurrence to its bound Session. The Host must be running; quitting stops timers until the next start, which then checks missed occurrences. Computer Use remains disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The layer mounts Local/Codex runtime owners, task/checkpoint and compaction policy, diagnostic transport, Models controls and Run Details. Its Custom composition adds the official Schedule bundle, while disabling DeepSeek account/controller/UI onboarding, hosted DeepSeek/search, the unrelated timer bundle, HMR and model-generated titles; native credential onboarding is disabled through its existing Config seam. Bootstrap sets provider configuration and Local Huihui as the default in the official profile patch; an uninitialized composition keeps an unregistered sentinel and fails closed. Schedule uses Host-owned task storage, the Session Controller and the official Schedule runtime. Computer Use is not included.

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

- Schedule tools are available to the DSH root Agent, including Local-selected Sessions. Codex external turns do not receive DSH tools through the current official integration seam, so Codex cannot create or manage Schedule tasks itself.
- Schedule persists and enqueues reminders; it does not promise exactly-once model execution or external side effects. The Host must be running for an occurrence to execute, and restart delivers the latest missed occurrence under the official Schedule rules.
- Final release qualification remains a separate step. Computer Use is intentionally disabled.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence, Schedule delivery/recovery and disposal through the owning isolated tests.
