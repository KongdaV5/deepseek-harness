---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-custom-foundation

English | [中文](2026-09-30-custom-foundation.zh.md)

## Summary

The Custom RC.2 foundation registers three plugin-qualified V4 metadata events and adds a generation-qualified historical task-compaction capture. Incoming V3 conversion validates the domain payloads and remaps checkpoint event references with the official insertion map.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-custom-foundation
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "57642d49abd6ad289a01ec31be22d07082e99b527df4b3956cd659da98023391"
    decision: same-version
  - root: "event:plugin:codex/subscription-state"
    previous: null
    after: "49929f90c9abbd2863ff31c3a7239787785526a12b2e124379fb460d3c70af85"
    decision: same-version
  - root: "event:plugin:task/checkpoint"
    previous: null
    after: "6badc6b9d384a1710c62c31555aba18021b26cdd1d68ff46e6d45e80ee1684f3"
    decision: same-version
  - root: "event:plugin:task/result-manifest"
    previous: null
    after: "135ec978cb5fe4be9e932d0723701422d408e7759fa9ba2c26d271954262c433"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The native Session format remains V4. The three new metadata roots are optional to readers without Custom plugins, while installed consumers validate their complete state. Incoming V3 identities are accepted only on the historical edge and retain their required/optional marker. Codex message IDs, turn ordinals, external thread IDs and non-secret authentication generation remain stable. Checkpoint tool-result references move to canonical V4 positions. The optional plugin:task-compaction-audit field retains its audit under sessionFormatVersion: 3; the unchanged source generation remains the authority for its captured sequence and hash. That capture cannot authorize native V4 continuation.

<a id="verification"></a>
## Verification

Isolated custom-migration.spec.ts fixtures prove six unresolved Codex states remain reconciliation-required after immutable successor publication and restart, preserving auth generation and thread mapping. They prove successful tool-result lifting and checkpoint reference restoration, generation-qualified compaction capture, result identity preservation, malformed reference refusal, no successor on validation failure and idempotent publication. Task producer, schema, guarded-resume and continuity tests validate current authority and stale-admission disposal. Config import and product-boundary tests use temporary roots only. No live user migration, authentication transition or runtime dispatch occurs.

<a id="dev-note"></a>
## Dev Note

None.
