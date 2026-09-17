---
name: "Desktop Run diagnostics Remote bridge"
description: "Development-only browser bridge that mounts the versioned Desktop Run diagnostics namespace before its read-only UI loads."
---

# Desktop Run diagnostics Remote bridge

English | [中文](README.zh.md)

`@deepseek-ai/dsh-client-desktop-run-diagnostics-remote` is a tiny browser
composition bridge for the development-only Desktop capability layer. It mounts
the generated `desktopRunDiagnostics` Remote contribution with the existing
Desktop Host connection before a later UI entry requires that namespace.

It has no model, retry, recovery, health, policy, or UI-state logic. The
capability-owned Host service remains the only source of diagnostics, and the
UI remains responsible only for rendering its versioned snapshots and invoking
the existing explicit Resume operation.

## Scope

The package is listed only by `@deepseek-ai/dsh-desktop-dev-composition`. It is
not a released Desktop feature, a daily profile plugin, or a second transport.
Removing the development composition removes the bridge and its namespace from
the browser composition.

## Boundary

The existing `remote.$mount()` extension point is retained. Separating this
mount from the status UI makes `remote.desktopRunDiagnostics` an explicit
loader dependency, so session-scoped dock entries do not race an asynchronous
namespace mount during their first render.

## Files

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | No-op Host face required by the package loader. |
| `src/client/index.ts` | Browser-only generated-Remote mount. |

## Guarantees

- No polling, logs, settings, or raw JSONL reaches the browser through this package.
- No Run is created, resumed automatically, retried, restarted, or reclassified here.
- The bridge owns no durable state and makes no provider, benchmark, or reasoning choice.

## Model Experience

### Browser namespace mount

#### What the model sees

No model request or model-visible prompt is created; the bridge mounts the generated `desktopRunDiagnostics` namespace only after the Host capability is already composed.

#### Token effect

Mounting the browser Remote namespace adds no request content and transfers diagnostics only after the Host coalesces its own projection.

#### KV Cache effect

The bridge does not read, modify, preserve, or infer cache state.

## Known Limitations and Deferred Work

- The bridge is development-composition-only and is not a released Desktop compatibility layer.
- It provides no UI, health classification, recovery, or additional transport behavior.
