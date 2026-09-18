---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-restore-task-checkpoint-events

[English](2026-09-18-restore-task-checkpoint-events.md) | 中文

## 概述

把 Final Product v1 的两个任务事件 `task/checkpoint` 与 `task/result-manifest` 恢复为 Session v3 的第一方已知事件。此前移除 run-state 子系统时一并删除了这两个 `SessionEventMap` 声明，导致持久化读取路径不再识别它们，任何携带它们的旧版 Session 都无法读取。`packages/session/task-checkpoint` 通过声明合并重新登记这两个成员，以及它们承载的整值 checkpoint 与 result-manifest 载荷类型。该修复刻意窄于恢复子系统：本包不新增任何生产者、不持有 Cordis 服务，也不引入新的身份权威。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

同版本（same-version）。不改变任何既有事件、逻辑头、物理头或信封字段；读取路径只是新增了两个此前不认识的成员，`SESSION_FORMAT_VERSION` 仍为 3。旧版日志可原样读入，不转换为其他信封，也不重写字节；由于当前构建不再写入这两个事件，本构建产生的日志不受影响。载荷内的旧版 `RunId` 与 `AttemptId` 仅作为带品牌标记的字符串保留，不授予任何当前 run 权威，因此读取旧日志不会复活已删除的 run-state 模型。

<a id="verification"></a>
## 验证

`pnpm run gen-persistence-catalog` 重新生成了中英文目录、`known-event-types.ts` 与机器 schema 清单，两个 root 均已出现；`verify-persistence-catalog --check` 报告无漂移。`pnpm run persistence-changes --check` 在本记录之前把两个 root 判定为 `root added (same-version allowed)`，本记录即为确认。包内测试通过严格 schema 与纯投影对旧版 checkpoint 与 result manifest 做了往返验证；Stage 3 迁移测试读取了携带这两个事件的旧版载荷，并断言其后磁盘字节完全一致。

<a id="dev-note"></a>
## 开发备注

无。
