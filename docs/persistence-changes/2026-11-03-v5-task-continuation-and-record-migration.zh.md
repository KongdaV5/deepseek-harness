---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-v5-task-continuation-and-record-migration

[English](2026-11-03-v5-task-continuation-and-record-migration.md) | 中文

## 概述

为任务续接来源语义及第一方任务/Codex 事件身份，将 Session 写入器从 V4 提升至 V5。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

V5 header 可避免 V4 读取器将新的 task-auto-continuation 来源误解为普通用户输入。V4 到 V5 边保留所有事件位置与引用，在全部受支持的消息位置保留 task-auto-continuation source 对象，并将本地 V4 的三种 plugin-qualified 任务/Codex 状态事件身份改为 V5 第一方可忽略事件名称，不改变载荷。其他可忽略插件记录继续保持不透明且不变；目标恢复器会拒绝未知的 required 事件。V5 读取器通过此相邻迁移边继续接收历史 V4 载荷变体，包括版本提升前写入的本地变体。

<a id="verification"></a>
## 验证

`pnpm run gen-persistence-catalog` 和 `pnpm run gen-session-format-catalog` 已完成；`pnpm run verify-persistence-formats --write` 已验证 V0 至 V5 的完整快照；`pnpm exec tsc --build packages/session/session-format-v4-to-v5/tsconfig.json --pretty false` 通过；`pnpm exec vitest run packages/session/session-format-v4-to-v5/tests/migration.spec.ts` 通过（4 项测试）。

<a id="dev-note"></a>
## 开发备注

无。
