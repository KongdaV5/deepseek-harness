---
description: "Development-only, versioned Remote transport for terminal-safe Agent Run diagnostics and explicit Task resume"
kind: "package-library"
---

# @deepseek-ai/dsh-desktop-run-diagnostics

English | [中文](README.zh.md)

This package is the small Host-to-Desktop boundary for the development-only
Run Details surface. `DesktopRunDiagnosticsService` reads the existing Agent
Run State, Reasoning Policy, and TaskCheckpoint diagnostics and publishes one
versioned, read-only snapshot stream. It neither owns run lifecycle nor changes
retry, backend recovery, reasoning, compaction, or session persistence.

The Remote projection deliberately carries `AgentRunState | null`, not the
whole raw observer diagnostics object: raw unattributed backend evidence may
contain an arbitrary error value. Classifications, health, identities,
prefill facts, checkpoint diagnostics, and compaction diagnostics remain
available without allowing an unsafe object over the Desktop boundary.

`resume()` is the sole write endpoint. It is invoked only from an explicit UI
action and delegates to the existing TaskCheckpoint executor, which rechecks
resume eligibility at execution time.

## Development use

The package is mounted only by
[`@deepseek-ai/dsh-desktop-dev-composition`](../../bundle/desktop-dev-composition).
The paired browser package mounts its generated `./remote` descriptor on the
existing Typert connection; no Electron IPC channel, renderer file access, or
new network port is created.

## Model Experience

### Terminal-safe projection

#### What the model sees

No direct model request or prompt content is created; `DesktopRunDiagnosticsService` reads existing Run, policy, checkpoint, and compaction facts after their owners have produced them.

#### Token effect

The versioned Remote snapshot is browser-facing only, so snapshot coalescing and elapsed-health refreshes add no model-visible tokens or durable Session events.

#### KV Cache effect

The transport neither changes nor estimates prompt-cache state; it forwards only cache facts that its upstream Run projection has already confirmed.

## Known Limitations and Deferred Work

- This is an upstream-style projection adapter, not a released Desktop integration.
- A future official Desktop can adopt `DesktopRunDiagnosticsSnapshot` without taking on the development composition or UI package.
- Raw unattributed backend evidence remains Host-only by design.
