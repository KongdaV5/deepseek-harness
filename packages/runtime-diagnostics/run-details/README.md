---
description: "Read-only Run Details transport: one client-visible Session projection combining durable Stage 6 lifecycle, Stage 7 run state, Stage 9 reasoning and Stage 10 compaction facts, inventing none of them."
kind: "package-reference"
---

# @deepseek-ai/dsh-run-details

English | [中文](README.zh.md)

## Summary

Serve the current client one read-only Run cut through the session-projection seam, so a Run Details panel can render live run state without becoming a second authority. The fold accumulates Stage 6 lifecycle facts one committed event at a time, captures the durable `request/header` and the `compaction/summary` policy audit, and derives the cut with Stage 7's projection, health classifier, and run identity. Where no source proves a value, the field is absent rather than defaulted: an unobserved backend stays `unknown`, and a session with no Run reports no Run at all instead of a placeholder.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **Cordis plugin whose whole body is one projection registration**: it holds no subscription, owns no state outside the fold, emits no Session event, and carries no control verb. Registering it adds the `runDetails` key to the projection table; delivery is the seam's.

```ts
import { Context } from '@deepseek-ai/cordis'
import { runDetailsProjectionDefinition } from '@deepseek-ai/dsh-run-details'
// Pulls the `sessionProjections` service merge into `Context`.
import type {} from '@deepseek-ai/dsh-session-projection'

declare const ctx: Context

// In a host plugin with `inject = ['sessionProjections']`:
ctx.sessionProjections.register(runDetailsProjectionDefinition)
```

On the client, the value arrives through the standard projection seat. The cut is a discriminated union, so an idle session has no run fields to render at all:

```ts
import type { RunDetailsView } from '@deepseek-ai/dsh-run-details/client'

// Supplied by the Session client's projection seat.
declare function useProjection(key: 'runDetails'): RunDetailsView | undefined

export function readRunDetails(): RunDetailsView | null {
  const details = useProjection('runDetails')
  if (details === undefined || !details.hasRun) return null   // hide, never placeholder
  // details.runId, details.phase, details.health, details.reasoning, details.compaction
  return details
}
```

### Every field comes from somewhere else

The package computes no domain fact of its own. Run identity is Stage 7's `runIdFor(sessionId, turn)`; phase, steps, retry summary, and errors come from Stage 7's projection of Stage 6 facts; health is Stage 7's classifier applied to a standing `unknown` observation; reasoning is Stage 9's header read; compaction is the Stage 10 audit a `compaction/summary` committed. A reader can therefore trace any displayed value back to a committed event.

### Idle is an absence, not a null Run

`hasRun: false` is returned while no durable turn has ever opened. A Run that has finished is still a Run, so the last closed one is served as history with `active: false` — history is not mistaken for current work, and neither case produces a synthesized Run object.

### Main-run reasoning and auxiliary reasoning stay apart

The main run's reasoning comes from the durable `request/header`. A compaction's auxiliary summarization request carries its own effort, and it lands under `compaction`, never under `reasoning`: showing them in one field would let a reader believe the value describes the user's run.

<a id="api"></a>
## API

| Export | Role |
|---|---|
| `runDetailsProjectionDefinition` | The `runDetails` unit with the default health thresholds; register it on `ctx.sessionProjections`. |
| `createRunDetailsProjection(thresholds?)` | Build the unit with deployment-owned `slowAfterMs` / `stalledAfterMs`. |
| `emptyRunDetailsState(sessionId)` | Empty fold state for tests and diagnostics. |
| `runDetailsViewSchema` | Validates the wire cut before it leaves the host. |
| `runDetailsStateSchema` | Validates persisted fold state before it seeds a fold. |
| `RUN_DETAILS_HEALTH_THRESHOLDS` | The default thresholds (30s slow, 120s stalled). |
| `RunDetailsView` | `RunDetailsIdleView` (`hasRun: false`) or `RunDetailsRunView`. |
| `RunDetailsRunView` | `runId`, `turn`, `active`, `phase`, `health`, times, `stepCount`, `openStep`, retry summary, `primaryError`, `secondaryErrors`, `backend`, `reasoning`, `compaction`. |
| `RunReasoningFacts` | Main-run `requested` / `resolved` plus `adapterMaterialized` and the source event's seq and time. |
| `RunCompactionFacts` | The durable audit: policy identity, trigger, attempts, protected cut, and the auxiliary reasoning. |

The `/types` and `/client` outlets carry the contracts with no host-side runtime import.

<a id="model-experience"></a>
## Model Experience

None, as the unit folds already-committed Session events into a client-facing read model and registers no prompt, schema, tool, or result text.

#### KV Cache effect

None; it never builds or sends a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Backend observation is always the `unknown` standing fact** — this read-only path registers no observer, so reachability and activity stay `unknown` instead of being inferred from a port, a process, or a missing progress metric. A deployment that installs a real observer needs a live read path this package deliberately does not add.
- **In-progress compaction diagnostics are not transported** — they live in a process-local store by design, and this wire value is persisted fold state, so a status that was never durable is structurally absent rather than snapshotted and later shown as if it were.
- **Health is elapsed-time derived from the folded event's own timestamp** — the cut is recomputed on every event, so a Run that goes quiet is reclassified on the next event rather than on a timer; without a new event, the last verdict stands.
- **The terminal Run is retained as history** — the cut describes the active Run, or the last closed one when none is open, so a session that has finished work still serves one Run rather than nothing.
- **No new Session event type is introduced** — everything here is derived from events other stages already own.
- **No runtime invariant companion is published because the unit is a pure fold over durable facts** — its contracts are proven by the package spec.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fold is reference-preserving in the way the projection drive depends on: an event that changes nothing the panel reports returns the same state, and the stored cut keeps its identity, so the change feed stays quiet between real changes.

Persisted fold state is a shortcut, never authority. A `stateVersion` bump or a schema rejection makes the registry discard the row and replay the log, so strict schemas here can only cost a re-fold.

</details>
