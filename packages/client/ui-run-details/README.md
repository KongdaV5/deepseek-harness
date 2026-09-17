---
description: "Development-only compact Run status dock and expandable terminal-safe Run Details dialog"
kind: "client-ui-plugin"
---

# @deepseek-ai/dsh-client-ui-run-details

English | [中文](README.zh.md)

This development-only browser plugin contributes a compact current-Run status
control to `conversation.input.dock`. Selecting it opens the existing modal
primitive with Run Details: identity, route, requested/resolved/wire reasoning,
Context facts, independent process/model/generation health, retry,
cancellation, compaction, checkpoint eligibility, and primary before secondary
errors.

The plugin reads only the versioned `desktopRunDiagnostics` Remote snapshot;
it never reads local files, Session JSONL, logs, settings, or backend ports.
Unknown fields remain unknown. Prefill is rendered only as confirmed observed
facts, never as an estimated percentage. Benchmark can be displayed when the
session projection explicitly names it, but it never adds a reasoning selector.

The Continue task control appears only for `SAFE_TO_RESUME`. It calls the
existing Host endpoint and displays the Host's revalidated result. A blocked
unknown tool outcome exposes its reason and cannot offer a button.

## Model Experience

### Read-only diagnostics surface

#### What the model sees

No model request or model-visible prompt content is created by this UI; it reads a versioned `DesktopRunDiagnosticsSnapshot` after the Host has completed its own projection.

#### Token effect

The dock and collapsed dialog add no tokens to a model request, and its Remote stream transfers only terminal-safe diagnostics to the browser.

#### KV Cache effect

The UI does not inspect, clear, preserve, or infer prompt-cache state; any cache counters are rendered only when the Host projection confirms them.

## Known Limitations and Deferred Work

- The UI is deliberately a status and diagnostics surface, not a second Agent state machine.
- It maps existing `RunPhase` values and remains removable with the development composition.
- GGUF backend progress remains Unknown until a backend-neutral structured observer supplies it.
