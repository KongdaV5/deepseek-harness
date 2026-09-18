---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-restore-task-checkpoint-events

English | [中文](2026-09-18-restore-task-checkpoint-events.zh.md)

## Summary

Restores the two Final Product v1 task events, `task/checkpoint` and `task/result-manifest`, to the first-party Session v3 vocabulary. Removing the run-state subsystem had also removed both `SessionEventMap` declarations, so the durable read path stopped recognising them and every legacy Session carrying them became unreadable. `packages/session/task-checkpoint` re-declares both members through declaration merge, together with the whole-value checkpoint and result-manifest payload types they carry. The repair is deliberately narrower than restoring the subsystem: this package adds no producer, owns no Cordis service, and introduces no new identity authority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-restore-task-checkpoint-events
baseline: false
changes:
  - root: "event:task/checkpoint"
    previous: null
    after: "ed6611b5093d78f0a1b567a57f91b14eabcc6826c23ea6e25b250807784cb8c2"
    decision: same-version
  - root: "event:task/result-manifest"
    previous: null
    after: "f2778fce9c7288863fa02ae1370152b2435c4c135f8b8215acf90b37cf20c8ab"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same-version. No existing event, logical header, physical header, or envelope field changes; the read path gains two members it previously did not know, and `SESSION_FORMAT_VERSION` stays 3. A legacy log is admitted unchanged, with no conversion to another envelope and no byte rewrite, and because no current build writes either event, a log produced by this build is unaffected. The legacy `RunId` and `AttemptId` values inside the payloads are preserved as opaque branded strings that grant no current run authority, so reading a legacy log cannot revive the removed run-state model.

<a id="verification"></a>
## Verification

`pnpm run gen-persistence-catalog` regenerated the catalog pair, `known-event-types.ts`, and the machine schema inventory with both roots present; `verify-persistence-catalog --check` reports no drift. `pnpm run persistence-changes --check` classifies both roots as `root added (same-version allowed)` before this record, and this record is the acknowledgement. The package spec round-trips a legacy checkpoint and result manifest through the strict schema and the pure projections, and the Stage 3 migration spec reads a legacy payload carrying both events and asserts the on-disk bytes are identical afterwards.

<a id="dev-note"></a>
## Dev Note

None.
