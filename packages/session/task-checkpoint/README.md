---
description: "Read compatibility for the Final Product v1 task authority: the two restored durable Session events, their strict schemas, and their pure projections, for maintainers reading legacy sessions and for the consumer that will fold them."
kind: "package-library"
---

# @deepseek-ai/dsh-task-checkpoint

English | [中文](README.zh.md)

## Summary

Read the task progress and result manifests a Final Product session recorded, and fold them into current state. Loading the package restores the two durable task events to the Session v3 vocabulary, so a legacy log that carries them loads again instead of being refused; the strict schemas then validate each revision unchanged. Register the two exported projection definitions when a client should see task state. The package owns no service, ships no producer, and grants no run authority, so nothing in the current build writes these events.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no live state.

The Final Product recorded durable task progress as two Session events. When the run-state subsystem that produced them was removed upstream, their `SessionEventMap` declarations went with it, so the durable read path stopped recognising them and a legacy Session carrying a checkpoint could not be read at all — the log was intact, but the reader refused it as an unknown required event. This package restores that vocabulary and nothing else: no run authority, no producer, no resume policy.

**Importing the package is what restores readability.** The two events are declared by module merge into `@deepseek-ai/dsh-session/types`, so the catalog generator picks them up and the read path admits them; no mount step, config key, or composition change is involved. A log written by the Final Product then loads as it always did, and because this package adds no producer, no current build ever writes one.

### What is and is not restored

| Restored | Not restored |
|---|---|
| The two `SessionEventMap` members and their payload types | The run-state subsystem that allocated `RunId` and `AttemptId` |
| Strict zod schemas that accept a legacy payload unchanged | Any writer: `Session.append('task/checkpoint', …)` has no producer here |
| Pure fold functions and registerable projection definitions | Any resume policy — nothing here authorizes or blocks a resume |
| `TaskId`, `TaskStepId`, and `TaskOutputId` constructors | A logical harness `RunId` (a later architecture decision) |

### Reading a legacy log

Read the log through the normal persistence path; the events arrive typed. Fold them with the exported projections — register `taskCheckpointProjectionDefinition` and `resultManifestProjectionDefinition` through `dsh-session-projection`, which keeps task progress and result manifests as two independent authorities:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-session-projection'
import {
  resultManifestProjectionDefinition,
  taskCheckpointProjectionDefinition,
} from '@deepseek-ai/dsh-task-checkpoint'

declare const ctx: Context

ctx.sessionProjections.register(taskCheckpointProjectionDefinition)
ctx.sessionProjections.register(resultManifestProjectionDefinition)
```

Both folds are strict replay validators. A checkpoint must advance by exactly one revision and may never rewrite its immutable identity (`sessionId`, `taskType`, `originRunId`, `createdAt`, `originalExecution`), its completed steps, or its output references; a manifest must advance by exactly one and may not rewrite its `outputId` identity metadata. The first violation is retained as a `failure` string in the fold state rather than thrown, so a damaged log yields a diagnosable state instead of aborting the read.

Before writing a producer, validate a candidate revision with `assertTaskCheckpointTransition` or `assertResultManifestTransition`: it applies the same rules to a candidate without mutating the fold.

### Legacy correlation identities

`RunId` and `AttemptId` exist only to make legacy payloads validate. They are **opaque values with no current run authority**: nothing in this package allocates, derives, or interprets them, and no constructor for them is exported. They are not the process-local `LlmAttemptId`, and they are not a logical harness run identity.

-----

<a id="api"></a>
## API

```ts
import {
  taskCheckpointSchema,
  taskCheckpointProjectionDefinition,
  applyTaskCheckpointProjection,
  emptyTaskCheckpointProjection,
} from '@deepseek-ai/dsh-task-checkpoint'

import type { TaskCheckpoint, RunId, AttemptId } from '@deepseek-ai/dsh-task-checkpoint/types'
```

### Durable payload schemas

| Export | Role |
|---|---|
| `taskCheckpointSchema` | Strict schema for one whole checkpoint revision, including every cross-field rule the Final Product enforced. |
| `resultManifestSchema` | Strict schema for one whole result-manifest revision. |
| `taskCheckpointEventDataSchema` | Strict `{ kind: 'task/checkpoint', version: 1, checkpoint }` envelope. |
| `resultManifestEventDataSchema` | Strict `{ kind: 'task/result-manifest', version: 1, manifest }` envelope. |

### Projections

| Export | Role |
|---|---|
| `taskCheckpointProjectionDefinition` | The `taskCheckpoint` unit (`stateVersion` 1): task progress plus crash-repair hazards. |
| `resultManifestProjectionDefinition` | The `taskResults` unit (`stateVersion` 1): the manifest collection, kept separate from task progress. |
| `applyTaskCheckpointProjection(state, event)` | Fold one event into task state; returns the same reference for events it does not own. |
| `applyResultManifestProjection(state, event)` | Fold one event into result-manifest state. |
| `assertTaskCheckpointTransition(state, checkpoint)` | Throw when a candidate is not the next legal revision of a known task. |
| `assertResultManifestTransition(state, manifest)` | Throw when a candidate is not the next legal revision of a known output. |
| `emptyTaskCheckpointProjection()` / `emptyResultManifestProjection()` | The immutable empty fold states. |
| `taskCheckpointProjectionSchema` / `taskCheckpointProjectionStateSchema` / `resultManifestProjectionStateSchema` / `resultManifestCollectionSchema` | Wire and cache schemas for the two units. |

### Identities

| Export | Role |
|---|---|
| `taskIdFromString` / `taskStepIdFromString` / `taskOutputIdFromString` | Brand one already-validated normalized external identity. |
| `createTaskId()` / `createTaskOutputId()` | Mint a collision-resistant task or output identity. |

The package's `/types` outlet carries the durable value contracts — `TaskCheckpoint`, `ResultManifest`, `TaskStatus`, `RunErrorCode`, the step-evidence union, and `RunId` / `AttemptId` — with no runtime import, so an aggregate that only needs the shapes does not pull the schemas in.

<a id="model-experience"></a>
## Model Experience

None, as both restored events are log-only and this package registers no prompt, schema, tool, or result text.

#### KV Cache effect

None; nothing here assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Read compatibility only** — the events are restored as known vocabulary and foldable state; no component writes them, and none is planned until the run-state architecture decision lands.
- **`RunId` / `AttemptId` carry no authority** — they validate and round-trip a legacy value, and cannot correlate two revisions, so a consumer needing durable run correlation must derive it from the checkpoint's own `taskId` and revision.
- **The two folds are not registered here** — this package exports definitions; a composition that wants client-visible task state must mount `dsh-session-projection` and register them.
- **No runtime invariant companion is published because the fold holds no mutable runtime state** — it is a pure function over event data, and its contracts are proven by the package spec instead.
- **A legacy payload is not repaired** — a revision that violates a rule is reported as a fold `failure`, never rewritten on disk, so the log stays byte-identical.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package was restored from the Final Product v1 serialized schema, so the schemas, the cross-field rules, and the step-evidence union preserve the original semantics rather than approximating them. The one deliberate departure is the `RunId` / `AttemptId` split: the original imported them from `@deepseek-ai/dsh-agent-run-state`, which no longer exists, so `src/legacy-identity.ts` re-implements only the serialized representation and the brand application.

Adding these events to the known vocabulary is a persistence change acknowledged as `same-version` in `docs/persistence-changes/2026-09-18-restore-task-checkpoint-events.md`: no existing type changed, and `SESSION_FORMAT_VERSION` stays 3.

</details>
