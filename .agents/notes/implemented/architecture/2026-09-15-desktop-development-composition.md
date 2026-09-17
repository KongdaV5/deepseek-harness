# Agent Note: Desktop development composition for local-runtime capabilities

Status: implemented

English | [中文](2026-09-15-desktop-development-composition.zh.md)

## Problem

The released Desktop must remain upgradeable and cannot load the local Phase 2–6 capability packages from a dirty source checkout. The local IQ3_S validation path still needs the same Desktop Host composition, an independently addressable provider, and reproducible presets without changing the user's normal model route or sessions.

## Decision

The source Desktop launcher accepts only `DSH_DESKTOP_DEV_COMPOSITION=phase2-6`. That value links the private `@deepseek-ai/dsh-desktop-dev-composition` package into its disposable npm project and creates settings, preset fixtures, and metadata below `apps/desktop/.desktop-build/development`. The settings define `local-qwen-dev` for the IQ3_S GGUF model at `http://127.0.0.1:8081/v1`, a 65,536-token context window, and a 24,576-token output limit.

The bundle composes existing agent-run-state, agent-run-policy, task-checkpoint, MLX observer, reasoning-policy, compaction-basic, and agent-run-state command packages. It adds only deployment values: IQ3_S capability normalization, an xhigh benchmark lock, conservative health thresholds, and disabled automatic compaction. The package does not reimplement Run State, retry, recovery, reasoning, checkpoint, compaction, provider, or UI behavior.

The Dev fixture has a visible `lite-general` preset and a hidden, explicitly resolvable `benchmark` preset. The companion metadata records the source revision, dirty state, runtime version, provider, model, and endpoint. The released Desktop app, `$HOME/.dsh`, the official launcher, its 8080 endpoint, and official sessions remain outside this path.

## Alternatives considered

- **Patch the released Desktop application.** Rejected because an app-bundle mutation creates a long-lived compatibility fork and invalidates the released artifact as an upgrade reference.
- **Place development settings in the normal Harness home.** Rejected because a provider or preset test could change a user's daily model route or add test data to normal sessions.
- **Make the bundle a generic profile plugin.** Rejected because the workspace-linked path is only safe in the trusted development launcher; a published profile needs an independent packaging and compatibility decision.

## Verification

The launcher rejects every composition value except the exact allowlisted identifier. Its focused test proves the generated project links only the fixed bundle. The fixture test proves that provider settings, preset visibility, and metadata write only below the supplied Dev home. A Host boot against the disposable project loads the same profile rules with linked packages allowed only for the development call.

## Phase 7A integration validation

The Electron startup shell is an intentional waiting and error surface. The main process leaves `dsh-app://shell/startup.html` only after `backend.start()` completes and a live `backend.host` exists, then navigates to `dsh-app://app/index.html`. A baseline Dev launch reached that application route. The Phase 2–6 launch initially remained on the startup error surface because the generated project linked the composition bundle but not its direct workspace loader dependencies. The development-project preparation now links only those declared direct dependencies into the disposable project; after rebuilding the affected Host artifacts, the same Phase 2–6 launch reached the real frontend. No production Electron startup behavior changed.

`agent-run-policy` owns cancellation probes through its Cordis fiber. Its teardown now detaches listeners, aborts its fiber-owned observation signal, and waits for in-flight probe continuations before the dependency provider can disappear. The regression test holds a cancellation probe across disposal. A real isolated IQ3_S request entered llama.cpp prompt processing and was then stopped by Dev Host disposal without an inactive `agentRunState` access.

The same Dev composition exposed the read-only `/agent_run_state` transport for a live IQ3_S request: it reported stable session/run/attempt identity and xhigh requested, resolved, and wire reasoning. Because no GGUF observer was composed, backend health, backend activity, and prefill remained explicit unknown/null values. A separate disposable replay profile fed the recorded MLX Metal-resource-limit fixture and a following BrokenPipe record into the MLX observer while the HTTP process probe remained healthy. The resulting diagnostics were `processHealth: healthy`, `generationHealth: fatal`, overall `fatal`, primary `RESOURCE_LIMIT`, secondary `STREAM_DISCONNECTED`, and retry count zero.

The full Desktop composition also wrote a revision-3 TaskCheckpoint with completed step 1 and pending step 2, classified it `SAFE_TO_RESUME` without running it, and classified an injected `TOOL_OUTCOME_UNKNOWN` as `BLOCKED_UNKNOWN_SIDE_EFFECT`. Its compaction waterfall used `low` on attempt 1, `medium` on attempt 2, and requested a retry when a candidate omitted authoritative task facts; it decorates only `purpose: compaction`, leaving main xhigh work separate. The actual roster hid `benchmark`, allowed explicit resolution, and produced `benchmark-lock` xhigh diagnostics for an explicit benchmark Session.

The repository's updater design is present and release-oriented: electron-builder emits a generic-provider feed selected by `DSH_DESKTOP_AUTO_UPDATE_ENV`, with macOS ZIP metadata and blockmap verified before a separate COS upload. The inspected installed `0.2.6` app contains a GitHub `latest-arm64` `app-update.yml`, but is ad-hoc signed with no TeamIdentifier; it is not evidence of a release-qualified signed artifact. This validation did not query, install, publish, or modify updater state. A full source build remains blocked in this environment because Codex Node `v24.19.0` has no `include/node/node_api.h`, which `native/system/scripts/build.ts` requires for the `flock` Node-API addon. The safe future remedy is a pinned build Node distribution with matching development headers in the packaged-build environment, not copied headers or a system-Node patch.

## Phase 7B diagnostics surface

The same development-only composition now selects `desktop-run-diagnostics`, a
tiny `desktop-run-diagnostics-remote` browser bridge, and `ui-run-details`. The
Host service is a versioned, read-only Typert projection adapter: it composes
the existing Agent Run State, Reasoning Policy, and TaskCheckpoint diagnostics
but owns no lifecycle or policy. The adapter sends only `AgentRunState | null`,
not raw observer diagnostics, because raw unattributed backend evidence may
contain an arbitrary error object. Classified primary/secondary errors and
three-layer health remain available while the raw evidence stays on the Host.

The bridge mounts that generated Remote namespace on the existing Desktop Host
connection before the UI entry starts; this makes it an explicit client-loader
dependency rather than a first-render race. The UI contributes a compact control
beside the existing composer and opens the shipped modal primitive for details.
It has no Electron IPC, port, file-system, Session JSONL, log, or settings
access. It maps existing `RunPhase` values, leaves unknown facts unknown, never
estimates a prefill percent, and routes explicit Resume through the existing
TaskCheckpoint Host executor for fresh validation. This keeps the released
Desktop and its generic Remote assembly unchanged.

In an isolated Dev Home, the actual Desktop UI rendered the compact control and
the single details modal for a real IQ3_S request. Its status moved from
Preparing to `Reasoning · xhigh` to Completed; the details cut showed the exact
Dev route, stable session/run/attempt identities, confirmed xhigh requested,
selected, resolved, and wire values, normal context pressure, and retry count
zero. Because the GGUF deployment has no structured backend observer, prefill,
attribution, and process/model/generation health remained explicitly Unknown.

## Consequences

Local-runtime capability work can be tested against a Desktop Host without modifying the user's released Desktop or daily configuration. The isolated provider makes an active backend distinguishable from the official route. The temporary backend remains separately owned and must be started and stopped by the test procedure. A released Desktop integration requires a later artifact-build decision rather than a hidden fallback to this source layer.
