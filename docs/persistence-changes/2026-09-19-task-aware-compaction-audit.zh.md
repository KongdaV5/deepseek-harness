---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-19-task-aware-compaction-audit

[English](2026-09-19-task-aware-compaction-audit.md) | 中文

## 概述

为既有的 `compaction/summary` 事件体新增一个可选属性 `policyAudit`。`packages/compaction/compaction` 增加了一个压缩后端可查询的可选 `CompactionCandidatePolicy` 接缝，而 `packages/compaction/compaction-task-aware-policy` 是该接缝在本部署中的实现。该策略不追加任何 Session 事件、也不写任何自有投影；它唯一的持久痕迹是交还给执行器的结构化报告，由执行器记录在它本来就会写入的 summary 事件上。因此该属性是既有事件上的一个增量字段，而不是一种新的事件类型，Session 格式版本保持不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

同版本。该新增是可选的，因此本次变更之前写入的每一条记录都仍然有效并原样被读取：summary 事件不带 `policyAudit` 的日志与从前完全一致地被读取，既不转换也不重写字节。早于本次变更的读取方会忽略该字段，因为它把事件体当作开放对象读取，且没有任何读取方被要求消费它；审计所命名的受保护事实本就持久存在于它们自己的事件中，因此跳过它既不会改变重放，也不会改变任何派生状态。逻辑头、物理头与信封字段均无变化，`SESSION_FORMAT_VERSION` 保持 3；未挂载任何候选策略的部署所写入的 summary 事件，与该接缝出现之前的本构建所写入的逐字节相同。

<a id="verification"></a>
## 验证

`pnpm run gen-persistence-catalog` 重新生成了目录对、schema 清单与已知事件类型名册，其中 `compaction/summary` 仍是唯一受影响的根，且没有新增事件类型；`verify-persistence-catalog --check` 报告无漂移。`pnpm run persistence-changes --check` 在本记录存在之前已把该路径归类为 `optional property added (same-version allowed)`，而本记录即为该确认。`dsh-compaction-basic` 的规格断言：未挂载策略的压缩所写入的 summary 事件不含该字段，因此无策略路径保持逐字节相同；任务感知策略与执行器的规格断言：受策略闸门的压缩把它的审计记录在同一条事件上，而不是记录在别处。

<a id="dev-note"></a>
## 开发备注

无。
