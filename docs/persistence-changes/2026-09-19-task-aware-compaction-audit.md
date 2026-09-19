---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-19-task-aware-compaction-audit

English | [中文](2026-09-19-task-aware-compaction-audit.zh.md)

## Summary

Adds one optional property, `policyAudit`, to the body of the existing `compaction/summary` event. `packages/compaction/compaction` gained an optional `CompactionCandidatePolicy` seam a compaction backend may consult, and `packages/compaction/compaction-task-aware-policy` is the deployment's implementation of it. That policy appends no Session event and writes no projection of its own; its only durable trace is the structured report it hands back to the executor, which the executor records on the summary event it already writes. The property is therefore an additive field on an existing event rather than a new event type, and the Session format version is unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-19-task-aware-compaction-audit
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-14-image-offload"
    after: "b49be98b21eeb748d80dfaf862ed55e06dc22bd1cdd8e969d1c026ba47347d49"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same-version. The addition is optional, so every record written before this change remains valid and is admitted unchanged: a log whose summary events carry no `policyAudit` is read exactly as before, with no conversion and no byte rewrite. An older reader that predates this change ignores the field, because it reads the event body as an open object and no reader is required to consume it; the protected facts the audit names were already durable in their own events, so skipping it changes neither replay nor any derived state. No logical header, physical header, or envelope field changes, `SESSION_FORMAT_VERSION` stays 3, and a deployment that mounts no candidate policy writes byte-identical summary events to the ones this build wrote before the seam existed.

<a id="verification"></a>
## Verification

`pnpm run gen-persistence-catalog` regenerated the catalog pair, the schema inventory, and the known-event-type roster with `compaction/summary` still the only affected root and no added event type; `verify-persistence-catalog --check` reports no drift. `pnpm run persistence-changes --check` classified this path as `optional property added (same-version allowed)` before this record existed, and this record is the acknowledgement. The `dsh-compaction-basic` specs assert that a compaction with no policy mounted writes a summary event without the field, so the policy-free path stays byte-identical; the task-aware policy and executor specs assert that a policy-gated compaction records its audit on the same event rather than anywhere else.

<a id="dev-note"></a>
## Dev Note

None.
