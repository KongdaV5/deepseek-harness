---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-28-codex-subscription-session-mapping

English | [中文](2026-09-28-codex-subscription-session-mapping.zh.md)

## Summary

Adds an ignorable Session event that persists the non-secret mapping between a DSH Session and its official Codex App Server thread, including bounded dispatch and transcript-sync recovery facts.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-28-codex-subscription-session-mapping
baseline: false
changes:
  - root: "event:codex/subscription-state"
    previous: null
    after: "4227b5b5c9417f7eb8ba0bcb6963f50297f361fb2456513c8017facd868c5684"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same-version. Session format version 3, the existing event envelope, and all existing event payloads remain unchanged. Older records omit this optional event and initialize the Codex mapping as empty; readers that do not implement the feature can ignore the event. The payload stores correlation IDs, selected model and effort, workspace paths/identity, and content hashes needed to reconcile a turn; it stores no authentication token, credential, or login URL.

<a id="verification"></a>
## Verification

The focused Codex runtime, external-turn loop, Settings controller, and Models UI tests passed (4 files, 130 tests). The generated persistence catalog and schema inventory are checked with verify-persistence-catalog; persistence-changes --check verifies this acknowledgement and its schema snapshot.

<a id="dev-note"></a>
## Dev Note

None.
