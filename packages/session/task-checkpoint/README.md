---
description: "The durable Task authority for a Session: read compatibility for the Final Product v1 task events, their strict schemas and pure projections, the checkpoint and result-manifest producers, and the guarded resume that adopts a Run already committed."
kind: "package-reference"
---

# @deepseek-ai/dsh-task-checkpoint

English | [中文](README.zh.md)

## Summary

Own the durable task authority for a Session. The package restores the two Final Product task events to the Session v3 vocabulary so a legacy log loads again, folds them with strict schemas and pure projections, and writes new revisions through the ignorable append seam. It also decides whether an unfinished task may continue and adopts the Run of the turn that actually started, so no resume ever predicts a turn. Task state stays independent of the Stage 7 run state.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service when a Session should record task progress, publish a result manifest, and continue an unfinished task after a crash. Import the projections when a client should only *read* that state.

The Final Product recorded durable task progress as two Session events. When the run-state subsystem that produced them was removed upstream, their `SessionEventMap` declarations went with it, so the durable read path stopped recognising them and a legacy Session carrying a checkpoint could not be read at all — the log was intact, but the reader refused it as an unknown required event. This package first restored that vocabulary, then added the writer the restored contract was waiting for: one producer API, a resume policy, and the seam that attributes a continued task to a real Run.

**Importing the package is what restores readability.** The two events are declared by module merge into `@deepseek-ai/dsh-session/types`, so the catalog generator picks them up and the read path admits them. A legacy log written by the Final Product loads as it always did, and because reading never rewrites bytes, a pre-seam revision stays exactly as it was stored.

### What this package owns

| Owned | Not owned |
|---|---|
| The two `SessionEventMap` members and their payload types | The run-state subsystem that allocates run identity |
| Strict zod schemas that accept a legacy payload unchanged | The Run itself — a Run is one committed turn, owned by the run-state package |
| Pure fold functions and registerable projection definitions | The Session log, its envelope, or its v3 format version |
| The checkpoint and result-manifest producers, the only writer of these events | Backend health, model selection, and compaction |
| The guarded resume decision and the pending-only resume plan | Whether a resume actually runs — the caller acts on the decision |

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

### Writing a revision

Every new revision goes through the service, which is the single writer of these events and the only thing that sets the ignorable marker:

```ts
import { Context } from '@deepseek-ai/cordis'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import TaskCheckpoint from '@deepseek-ai/dsh-task-checkpoint'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TaskId, TaskResumeContext, TaskStepId } from '@deepseek-ai/dsh-task-checkpoint/types'

const ctx = new Context()
await ctx.plugin(SessionProjection)
await ctx.plugin(TaskCheckpoint)

declare const session: Session
declare const taskId: TaskId
declare const step: TaskStepId
declare const resumeContext: TaskResumeContext

const created = ctx.taskCheckpoints.createCheckpoint(session, {
  taskId,
  taskType: 'report',
  originTurn: 4,
  execution: { provider: 'deepseek', model: 'chat' },
  pendingSteps: [{ id: step, title: 'Draft the report' }],
  resumeContext,
})

created.revision   // 1 — the first durable revision of this task
```

`createCheckpoint`, `advanceCheckpoint`, `publishResultManifest`, and `recordAcceptedResume` are the durable verbs. Each one validates against the projected state it read, appends through `Session.appendIgnorable`, and returns the stored revision. `advanceCheckpoint` takes the revision the caller believes is current and fails closed when it is stale, so two competing successors of one revision cannot both become authoritative. `publishResultManifest` mints a monotonic result revision, and a checkpoint that cites it is only accepted once that revision is already durable — there are no forward references.

A task's steps stay a coherent partition: completed, current, and pending are mutually exclusive, and a completed step is never re-planned.

### Continuing a task

`armResume` answers one question: may this unfinished task continue, and if so, from where? It returns a structured decision whose class is `allowed`, `requires_confirmation`, `blocked`, or `not_applicable`, carrying the reason code, the checkpoint revision, the run it read, the step ids, and the hazard evidence. A task that is completed, cancelled, blocked, or fatally failed is never allowed; an evidence-unknown tool outcome always requires confirmation; a task whose recorded run no longer matches the Session's durable run fails closed rather than reinterpreting the log.

Arming writes nothing. The decision becomes durable only after the caller starts a new turn: the service observes the committed `turn/start`, derives the Run from that turn, and records the accepted resume with the RunId that turn actually has. `buildResumeContext` assembles the bounded context the plan carries, naming every section it left out instead of trimming silently.

### Legacy correlation identities

`RunId` and `AttemptId` exist in the durable payload because a legacy checkpoint carries them. `AttemptId` is **opaque with no current authority**: nothing here mints or interprets it. `RunId` is no longer opaque — the producer derives it from the committed turn through the run-state package's own `runIdFor`, and never mints, guesses, or pre-allocates one. A RunId in a payload therefore names a real turn, in the encoding the run-state package owns.

-----

<a id="api"></a>
## API

```ts
import {
  createTaskCheckpoint,
  appendTaskCheckpointUpdate,
  publishResultManifest,
  recordAcceptedResume,
  decideGuardedResume,
  buildResumeContext,
  taskCheckpointProjectionDefinition,
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

### Producers

| Export | Role |
|---|---|
| `createTaskCheckpoint(authority, input)` | Append revision 1 of a new task, attributed to the Run of a turn already committed. |
| `appendTaskCheckpointUpdate(authority, update)` | Append the next revision under a compare-and-set on the expected revision and Run. |
| `publishResultManifest(authority, manifest)` | Append the next result manifest revision; a citing checkpoint must follow it. |
| `recordAcceptedResume(authority, input)` | Record the accepted resume with the RunId of the turn that actually started. |
| `TaskCheckpoint` (default export) | The `ctx.taskCheckpoints` service: the single-writer facade over the four producers. |

### Resume policy

| Export | Role |
|---|---|
| `decideGuardedResume(input)` | Return the structured decision, not a boolean: class, reason code, revision, runs, steps, hazards. |
| `buildResumeContext(checkpoint, results, options)` | Assemble the bounded resume context and name every omitted section. |
| `GuardedResumeReason` | The reason vocabulary a caller branches on, from `PENDING_ONLY` to `SESSION_DIVERGED`. |

### Identities

| Export | Role |
|---|---|
| `taskIdFromString` / `taskStepIdFromString` / `taskOutputIdFromString` | Brand one already-validated normalized external identity. |
| `createTaskId()` / `createTaskOutputId()` | Mint a collision-resistant task or output identity. |

The package's `/types` outlet carries the durable value contracts — `TaskCheckpoint`, `ResultManifest`, `TaskStatus`, `RunErrorCode`, the step-evidence union, and `RunId` / `AttemptId` — with no runtime import, so an aggregate that only needs the shapes does not pull the schemas in.

<a id="model-experience"></a>
## Model Experience

None, as the durable task events stay out of model context and the service registers no prompt, schema, tool, or result text.

#### KV Cache effect

None; nothing here assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The producers write only what policy already allowed** — the checkpoint records progress and the decision to continue; it never starts, steers, or cancels a turn.
- **A resume is armed, not run** — `armResume` is process-local and inert until the caller starts a turn, so a crash between arming and starting leaves no durable trace to clean up.
- **The Run bridge needs a real commit** — the service derives a Run from a committed `turn/start`, so a producer asked for a turn that never committed fails closed instead of inventing one.
- **`AttemptId` carries no authority** — it validates and round-trips a legacy value and cannot correlate two revisions; a consumer needing durable correlation reads the checkpoint's `runId`.
- **The two folds are not registered by the service** — the service reads them, but a client that wants task state must mount `dsh-session-projection` and register both definitions.
- **No runtime invariant companion is published because the fold holds no mutable runtime state** — it is a pure function over event data, and its contracts are proven by the package specs instead.
- **A legacy payload is not repaired** — a revision that violates a rule is reported as a fold `failure`, never rewritten on disk, so the log stays byte-identical.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package was restored from the Final Product v1 serialized schema, so the schemas, the cross-field rules, and the step-evidence union preserve the original semantics rather than approximating them. The one deliberate departure is the `RunId` / `AttemptId` split: the original imported them from what is now the run-state package, so `src/legacy-identity.ts` re-implements only the serialized representation and the brand application.

Stage 8 added the writer. `src/producer.ts` owns the four durable verbs and validates every revision against an explicit authority read from projections — never from the deprecated synchronous readers — so a producer cannot append against a state it did not observe. `src/resume.ts` owns the decision and the bounded context. `src/service.ts` is the Cordis service: it registers the projections, exposes a diagnostics read, and defers adoption of the started Run to a microtask, because a Session observer may not reenter `append` while the publication latch is held.

New revisions travel `Session.appendIgnorable`, the typed ignorable append seam. A pre-seam revision carries no marker and stays required-on-read; only what this package writes is marked optional, so an older reader that does not know the events still refuses nothing it used to accept.

Adding these events to the known vocabulary is a persistence change acknowledged as `same-version` in `docs/persistence-changes/2026-09-18-restore-task-checkpoint-events.md`: no existing type changed, and `SESSION_FORMAT_VERSION` stays 3.

</details>
