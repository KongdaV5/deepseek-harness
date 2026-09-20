---
description: "The DS Harness Desktop capability layer over the web surface: the durable Task authority, the bounded run policy, the task-aware compaction policy, the transient diagnostics transport, and the read-only Run Details surface, for users composing or customizing the DS Harness Desktop profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-custom

English | [中文](README.zh.md)

## Summary

The DS Harness Desktop profile composes `dsh-base`, `dsh-web-app`, and this layer last, so that surface gains the durable Task authority, the bounded run policy, the task-aware compaction policy, the transient diagnostics transport, and the read-only Run Details surface the DS Harness product is built on. It mounts six host-plane services, one browser surface, and states one deployment value on the inherited compaction executor. It replaces no executor and adds no Session event, so a profile without this layer is an ordinary web surface.

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

### Install into a profile

The DS Harness Desktop profile names this bundle after the web surface, so the layer is the profile's last bundle:

```yaml
- bundles:
    - '@deepseek-ai/dsh-base'
    - '@deepseek-ai/dsh-web-app'
    - '@deepseek-ai/dsh-desktop-custom'
```

In-box bundles resolve from the dsh installation; `dsh plugin --profile <name> add @deepseek-ai/dsh-desktop-custom` appends the layer to a profile of your own. A layer whose `dsh.bundle.patch` field is missing is not a bundle at all, and the composer then treats the package as an ordinary plugin.

### What you get

Six host-plane rows, one browser row, and one restated deployment value:

| Row | What the surface gains |
|---|---|
| `task-checkpoint` | Durable Task authority: the `taskCheckpoint` and `taskResults` projections plus the guarded-continuation seam. |
| `agent-run-policy` | One outermost `agent/request-error` listener that bounds automatic retries over the upstream retry executor. |
| `compaction-task-aware-policy` | The optional `compactionCandidatePolicy` service the existing compaction executor resolves with `ctx.get`. |
| `runtime-diagnostics-controller` | The generic transient-diagnostics transport: one topic-keyed provider registry behind a typed Remote stream per topic and Session, plus the browser resource protocol that reads it. |
| `compaction-task-aware-diagnostics-transport` | The adapter that registers the task-aware compaction topic with that transport, so a running compaction's process-local status is readable without a Session event. |
| `run-details` | The read-only Run Details projection over the lifecycle fold, the run state, the durable request header, and the committed compaction audit. |
| `ui-run-details` | The browser strip docked above the composer: the Run's facts, durable task continuity, and the transient compaction status, with no control a click could reach. |
| `compaction-basic` | The inherited executor, re-enabled on the host plane with the deployment's `maxSummaryValidationRetries` budget. |

Each row's behavior, invariants, and configuration belong to the package that owns it; this layer only places the rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The layer is a static patch document applied after `dsh-web-app`. It mounts no service of its own, emits no events, and holds no mutable state.

### Why the compaction executor is restated

`dsh-web-app` disables the base `compaction-basic` row, because on the Web surface a mounted agent preset owns the compaction backend. The DS Harness product owns that backend on the host plane instead, so the task-aware policy governs one known executor instance rather than one instance per mounted preset. A patch replaces the targeted row's whole `config`, so the restated row names both the `disabled` flag and the validation budget.

`maxSummaryValidationRetries` counts the further summary candidates a validating policy may ask for. The upstream default is `0` — one candidate and no semantic retry — and a deployment with no validating policy keeps it. This layer sets `1`: the task-aware policy validates its candidate deterministically, so it gets exactly one further candidate to repair a rejected summary. The retry ladder is bounded by that policy, never by this number alone.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle substance: the seven insert rows and the restated executor row, with per-row rationale as inline comments |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| — | No invariant companion is published because the package is a static patch-list carrier (a YAML document of loader rows owned by other packages); it mounts no service, emits no events, and owns no mutable relation to check. Each inserted row's own package carries that row's invariants. |
| [`tests/desktop-custom.spec.ts`](tests/desktop-custom.spec.ts) | Manifest declaration, inserted-row set, and restated-executor checks |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [app-boot profile section](../../boot/app-boot/README.md) — how profiles are resolved, layered, and customized.
- [Bundle package map](../README.md) — the surfaces built on the shared core.
- [Generated composition graph](../../../apps/cli/composition.md) — the exact plugin set each shipped profile uses.
- [`@deepseek-ai/dsh-compaction-task-aware-policy`](../../compaction/compaction-task-aware-policy/README.md) — the policy this layer mounts.
- [`@deepseek-ai/dsh-task-checkpoint`](../../session/task-checkpoint/README.md) — the durable authority the policy protects.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package, which owns that row's model-facing behavior.

#### KV Cache effect

The layer itself adds no request prefix; the inserted rows' packages own any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a general comparison or a task backlog.

- **A patch replaces whole settings blocks** — restating `compaction-basic` here replaces its entire configuration, so a later layer that wants to change one key restates every key it keeps.
- **The layer depends on the web surface** — it restates a row `dsh-web-app` disables and inserts rows that read the web surface's session projections; it is not a standalone bundle.
- **The browser row renders only what the host publishes** — the Run Details strip reads one projection and one resource, so a profile that omits this layer renders its own empty state rather than a degraded strip.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
