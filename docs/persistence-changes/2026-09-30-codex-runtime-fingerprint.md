---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-codex-runtime-fingerprint

English | [中文](2026-09-30-codex-runtime-fingerprint.zh.md)

## Summary

Same-version. Session format version 3 and Codex projection state version 3 remain unchanged. The optional runtime fingerprint binds private thread ownership to the producing binary and adapter contract. Legacy settled mappings without a fingerprint retire locally and bootstrap from public history; unresolved dispatch remains blocked without replay. The wire declaration also records the already-supported optional authentication generation: projection readers continue normalizing a missing epoch to null, and existing authentication transaction/ownership logic is unchanged. Neither cache metadata nor the mapping contains authentication credentials.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-codex-runtime-fingerprint
baseline: false
changes:
  - root: "event:codex/subscription-state"
    previous: "2026-09-28-codex-subscription-session-mapping"
    after: "24ad1b1b38e1ed47c3576a00b6943abb5eb6adb8c52d44e29453c71b6a9a4a43"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same-version. Session format version 3 and Codex projection state version 3 remain unchanged. The optional runtime fingerprint binds thread ownership to the producing binary and adapter contract. Legacy settled mappings retire and bootstrap from public history; unresolved dispatch remains blocked without replay. The optional wire authentication generation matches the existing reader normalization to null. Authentication transaction and ownership behavior is unchanged; neither mapping nor cache contains credentials.

<a id="verification"></a>
## Verification

Focused Codex runtime, schema/cache, Host model directory, and client selector tests passed (9 files, 140 tests), including the existing authentication lifecycle regressions and unknown-runtime-pair dispatch/recovery barriers. System and Bundled Light probes passed against their real binaries. System Full passed short-turn, transcript injection, correlated history, resume, and observed-active interruption checks; its own temporary thread was deleted. The generated persistence catalog and this schema acknowledgement are checked by the existing persistence verification commands.

<a id="dev-note"></a>
## Dev Note

None.
