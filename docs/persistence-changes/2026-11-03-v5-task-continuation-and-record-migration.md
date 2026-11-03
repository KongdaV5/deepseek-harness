---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-v5-task-continuation-and-record-migration

English | [中文](2026-11-03-v5-task-continuation-and-record-migration.zh.md)

## Summary

Advances the Session writer from V4 to V5 for task-continuation source semantics and first-party task/Codex event identities.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-v5-task-continuation-and-record-migration
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "0894e31e4a65721908e05ee78394265d3873534ef9920a39f79dcdebc396275a"
    decision: version-bump
  - root: "event:codex/subscription-state"
    previous: null
    after: "24ad1b1b38e1ed47c3576a00b6943abb5eb6adb8c52d44e29453c71b6a9a4a43"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "ae16ee463a45f10d232a3c03103c56d6bb140290f0505f207d30584632821b85"
    decision: version-bump
  - root: "event:plugin:codex/subscription-state"
    previous: "2026-09-30-custom-foundation"
    after: null
    decision: version-bump
  - root: "event:plugin:task/checkpoint"
    previous: "2026-09-30-custom-foundation"
    after: null
    decision: version-bump
  - root: "event:plugin:task/result-manifest"
    previous: "2026-09-30-custom-foundation"
    after: null
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "70d47aca1d3baf0f27da2ecde5edf7fc0abef0b393b49e5deb2af1163f02fdb9"
    decision: version-bump
  - root: "event:task/checkpoint"
    previous: null
    after: "ed6611b5093d78f0a1b567a57f91b14eabcc6826c23ea6e25b250807784cb8c2"
    decision: version-bump
  - root: "event:task/result-manifest"
    previous: null
    after: "f2778fce9c7288863fa02ae1370152b2435c4c135f8b8215acf90b37cf20c8ab"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "3302a83561b88940611ac6bc47f0a9b3adbf2e6e80cd3a1b723b3eedb3dc76a5"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

The V5 header prevents V4 readers from interpreting logs with the new task-auto-continuation source as ordinary user input. The V4-to-V5 edge preserves every event position and reference, retains task-auto-continuation source objects in all supported message slots, and renames the three local V4 plugin-qualified task/Codex state event identities to V5 first-party ignorable event names without changing their payloads. Other ignorable plugin records remain opaque and unchanged; an unknown required event is refused by the target restorer. V5 readers continue to accept historical V4 payload variants through this adjacent edge, including the local variants written before the bump.

<a id="verification"></a>
## Verification

`pnpm run gen-persistence-catalog` and `pnpm run gen-session-format-catalog` completed; `pnpm run verify-persistence-formats --write` verified complete snapshots from V0 through V5; `pnpm exec tsc --build packages/session/session-format-v4-to-v5/tsconfig.json --pretty false` passed; `pnpm exec vitest run packages/session/session-format-v4-to-v5/tests/migration.spec.ts` passed (4 tests).

<a id="dev-note"></a>
## Dev Note

None.
