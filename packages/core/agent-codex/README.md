---
description: "Run a Codex model through an official ChatGPT subscription in DS Harness Custom. Use this package when you need an isolated App Server session without API-key routing or provider fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

English | [中文](README.zh.md)

## Summary

Run DSH turns through an official ChatGPT subscription. Automatic mode prefers the verified signed Codex runtime inside `/Applications/ChatGPT.app`; bundled `@openai/codex` is selected only for unavailable system identity or confirmed incompatibility, not temporary account, network, or quota failures. Each connection uses one executable and its own `model/list` directory. DSH retains public Session history; Codex owns private execution threads and sign-in. This integration accepts no API key and never falls back to another provider.

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

The DS Harness Custom desktop composition mounts this provider beside the Local model route.

### When to choose it

Choose this route when you want to run an explicitly selected Codex model with an official ChatGPT subscription. Choose a configured Local provider for local-only work; this route never switches providers automatically.

### Minimal configuration

Mount the package as a Cordis row; it accepts no package-specific configuration fields.

```yaml
- id: agent-codex
  name: '@deepseek-ai/dsh-agent-codex'
```

The generated [configuration catalog](../../../docs/config-catalog.md) records the service requirements and confirms that this entry has no config block.

| Field | Default | Meaning |
|---|---|---|
| None | — | This plugin accepts no package-specific configuration. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runtime owns one official App Server process over stdio and keeps its private thread separate from the public DSH Session. The Models settings card persists Automatic, System Codex, or Bundled Codex; switching takes effect only after the current turn ends and a new connection starts. A missing model never triggers an executable switch. The runtime synchronizes bounded public history, persists dispatch intent before a model turn, and rejects workspace or approval requests it cannot validate. It publishes sanitized command, file-change, approval, and terminal activity through a bounded, process-local Session live-follow window, separate from Local tool calls and durable Session events. After a lost `turn/start` response, it reconciles against the remote thread and turn; a confirmed terminal result releases the local dispatch barrier without replay, while an unresolved turn remains fail-closed or retires its mapping. The Session projection tracks the latest committed assistant settlement so a recovered result cannot be delivered twice after restart.

DSH persists a non-secret `authGeneration` in settings and binds each Session's private-thread mapping to it. DSH or App Server restarts, runtime selection, and temporary account-read failures preserve the generation; only successful DSH logout or official login rotates it. A non-secret `authTransition` is persisted before login or logout RPCs and cleared atomically with the new generation; a pending marker prevents startup from restoring an account and blocks account-bound operations until an explicit authentication transaction resolves it. Process-local authentication epochs discard stale account, model-catalog, quota, and login results after their client, settings, or transaction owner changes. A legacy or earlier-generation mapping is retired locally without remote reconciliation or replay, and a later turn bootstraps from the public DSH transcript. While official browser login is pending, account-bound remote operations remain blocked. Login completion is correlated to the active DSH attempt and serialized; the new generation is persisted before the connected state is published. `resumedThreads` is process-local and cleared when its App Server client is replaced or exits, while the persistent Session mapping and `authGeneration` remain unchanged on process exit. `CODEX_HOME` is created only beneath an independently supplied DSH Custom data root or explicit rehearsal root; symlinks, non-directories, and escaping paths fail closed, and the home is revalidated immediately before App Server startup.

| Source | Owns |
|---|---|
| `src/index.ts` | Composition entry and declared service requirements. |
| `src/runtime.ts` | Account status, model discovery, history synchronization, turns, and approvals. |
| `src/app-server.ts` | Signed system-runtime identity verification, bundled executable identity, and JSON-RPC stdio lifecycle. |
| `src/compatibility.ts` | Shared schema-aware connection admission, sanitized machine cache, and explicit maintenance probes. |
| `src/projection.ts` | Ignorable Session state for the private Codex thread mapping. |

### Independent runtime maintenance

Run `corepack pnpm codex:compat --status --json` for fresh distribution identity and matching cached evidence. Add `--system` or `--bundled` to select one runtime. `--light` validates that binary's generated App Server schemas and uses only initialize, account, catalog, and optional quota reads; it does not create threads, run inference, or change authentication. `--full` explicitly creates a named temporary synthetic thread, exercises short-turn, history, resume, and observed-active interruption behavior, then deletes its own thread when the protocol supports deletion. Failed or inactive interruption is not a Full pass.

The shared verifier stores only non-secret runtime metadata, model/effort entries and capability evidence under the Custom root's `cache/codex-runtime-compat.json`, using atomic writes. Binary SHA-256, verified distribution identity, architecture, adapter-contract revision and required-schema fingerprint define an evidence key. Identity and binary bytes are rechecked before every connection and cache reuse. Corrupt, stale, or unwritable cache never proves compatibility; a write failure is separate from direct verification. During a pending authentication transaction only protocol/path validation runs; account/catalog reads and complete Light admission wait until that existing transaction barrier clears.

Catalog-only changes need no DSH build: current `model/list` entries refresh Host/client directories. A disappeared model remains the Session's selection and blocks sending with `MODEL_UNAVAILABLE` until the user chooses another; DSH never substitutes a model or switches executables for it. Runtime replacement occurs only at a safe reconnect, never mid-turn or silently on a healthy idle connection. A settled mapping from an unverified runtime pair is retired and bootstrapped from public history; an unresolved dispatch remains blocked without replay. The optional mapping fingerprint preserves the existing state version and dispatch barrier. This does not rotate authentication state.

Compatibility levels distinguish catalog-only change, compatible runtime, an additive change requiring adapter work, and a breaking required contract. The CLI reports incomplete behavior separately from schema evidence; unknown compatibility is not a pass.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Core subsystem](../../../docs/subsystems/core.md)
- [Agent runtime](../agent/README.md)
- [Desktop Custom bundle](../../bundle/desktop-custom/README.md)
- [Official Codex App Server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server)

-----

<a id="model-experience"></a>
## Model Experience

### Synchronized public transcript

#### What the model sees

The Codex thread receives recent plain-text user messages and final assistant messages from the DSH Session; the current turn's text is sent separately in `turn/start`. History is capped at 80 messages and 48,000 characters, with an omission marker when older content is dropped.

#### Token effect

DSH sends the bounded public transcript and current turn text as request content; it does not add DSH prompt sections or tool schemas to the Codex request. App Server and model-owned context may add other tokens, so this package cannot report an exact total.

#### KV Cache effect

The private Codex thread owns its own provider context and cache. A resumed thread can retain reuse while workspace identity and the acknowledged history cursor remain valid; rebuilding after uncertain synchronization or identity changes resends bounded history and may reduce reuse. This package does not alter a Local provider's cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints define when this route is unavailable or needs user action.

- **Official subscription login is required** — the user completes the ChatGPT sign-in in the official browser flow; API-key authentication is not supported.
- **A registered local workspace is required** — the active Session must resolve to one canonical absolute workspace before a Codex thread can start.
- **Uncertain turn dispatch is not replayed automatically** — the runtime preserves the outcome for reconciliation and fails closed to avoid duplicate side effects.
- **Only text input is forwarded** — image and other non-text content are not passed to the Codex turn by this integration.
- **System Codex is identity- and capability-gated** — only the official signed runtime inside `/Applications/ChatGPT.app` is considered; DSH never executes a `codex` binary found through `PATH`.
- **Runtime choice is connection-scoped** — changing runtime requires an idle turn boundary and reloads the model/effort catalog from the newly selected App Server. The system runtime is rechecked on reconnect; the bundled runtime is pinned to the package version.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
