---
description: "Host Remote owner for settings and credential configuration surfaces, including redacted reads, writes, credential references, and native document opening."
kind: "package-reference"
---
# Settings Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-settings-controller` exposes generated `ctx.remote.settings`, `ctx.remote.credentials`, and opt-in `ctx.remote.localModels` namespaces for browser configuration surfaces. It returns redacted settings and credential metadata, supports settings and credential writes without returning secret values, opens provider-owned settings or Agent preset locations on the Host desktop, and can control the verified existing local-model manager. When a provider is absent, the configuration namespace remains registered and returns an actionable error.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Local model runtime](#local-model-runtime)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves browser configuration. The entry registers both namespaces independently of their providers so a missing provider produces a named configuration error at invocation. Its generated descriptors enter the strict Typert registry, while the settings and credential Definitions remain plain Cordis Services with no wire obligations of their own.

`describe(refs)` answers one map keyed by the requested names, so a settings page describing every reference its rows carry settles those rows together. It accepts at most 64 names per call, reports an invalid name or empty write value as `bad-request`, and copies each answer field by field — a provider returning more than `CredentialInfo` declares cannot widen what crosses. Valid `set(ref, value)` and `unset(ref)` calls report a provider refusal as `credential-rejected`, carrying the provider's message with only the reference in its details. Secret values cross in this direction only: no method here returns one.

`settings.describe()` returns deployment facts and every namespace under `redactSecrets: true`. `settings.update`, `settings.replace`, and `settings.mutate` expose the settings service's three write operations and return the namespace's new redacted view; stale writes use `settings-conflict` and other provider refusals use `settings-rejected`.

`settings.openSettingsDocument()` prepares the provider-owned document and opens it with the native text-editor intent. `settings.canOpenAgentPresetDirectory()` reports native-opening availability when the preset page becomes visible. `settings.openAgentPresetDirectory(id)` resolves only a user-authored preset and either opens its directory or returns the path when native opening is unavailable; neither open method accepts a browser-supplied filesystem target.

<a id="local-model-runtime"></a>
### Local model runtime

When `localModelRuntime` is enabled, `localModels.status/start/stop/restart` delegates to the installed `local-model` manager. Status is derived from the matching LaunchAgent, its served model id, and the loopback health endpoint; the controller refuses to stop an unrelated listener or start another profile until the shared port is confirmed free. Starts use the manager's runtime-only `runtime-start` command, so switching a serving profile does not rewrite the legacy DSH default-model setting.

The current manager supports the Huihui text profile, Original Qwen text profile, and Qwen Image profile. The text profiles share one port and are switched sequentially only after the old LaunchAgent and listener have stopped.

The snapshot lifecycle values are `stopped`, `starting`, `running`, `stopping`, and `error`. Each profile reports its id, modality, whether its model files are present, and whether DSH is permitted to control it. A manager-owned profile is started only when port 8080 is free; a listener not owned by the verified manager is never stopped or replaced.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `nativeOpen` | platform-detected | Whether Agent preset directories can be handed to a native desktop opener |
| `localModelRuntime` | `false` | Whether this deployment exposes controls for the verified existing local-model manager |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-settings-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as settings and credential configuration are browser and Host state and register no prompt, tool, or session event.

#### KV Cache effect

No direct effect; reading or writing these configuration values does not alter model requests already in flight.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The batch bound is fixed at 64 references and is not a deployment-configurable field.
- The local-model adapter recognizes the installed macOS manager and its runtime-only profile command; other manager layouts remain outside this controller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The settings and credential seams own storage and update events, while this package only projects their methods onto the wire.
