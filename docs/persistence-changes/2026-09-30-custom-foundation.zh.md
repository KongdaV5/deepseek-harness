---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-custom-foundation

[English](2026-09-30-custom-foundation.md) | 中文

## 概述

Custom RC.2 基础注册三个带插件限定的 V4 元数据事件，并增加带代次限定的历史任务压缩捕获。入站 V3 转换验证领域载荷，并通过官方插入映射转换 checkpoint 的事件引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

原生 Session 格式仍为 V4。三个新元数据根对未安装 Custom 插件的读取器可选，已安装消费者则验证完整状态。入站 V3 标识只在历史边上接受，并保留原有必需或可选标记。Codex 消息 ID、轮次序号、外部线程 ID 和非机密认证代次保持稳定。Checkpoint 工具结果引用转为 canonical V4 位置。可选字段 plugin:task-compaction-audit 以 sessionFormatVersion: 3 保存审计；未改变的源代次仍是捕获序号与哈希的权限来源。此捕获不能授权原生 V4 继续执行。

<a id="verification"></a>
## 验证

隔离的 custom-migration.spec.ts fixture 证明六种未决 Codex 状态在不可变 successor 发布和重启后仍要求 reconciliation，并保留认证代次和线程映射。它们证明成功工具结果提升与 checkpoint 引用恢复、带代次限定的压缩捕获、结果标识保留、无效引用拒绝、验证失败不产生 successor，以及重复发布的幂等性。任务 producer、schema、guarded-resume 和 continuity 测试验证当前权限及过期准入的处置。配置导入和产品边界测试仅使用临时根目录。本轮不进行真实用户迁移、认证转换或运行时 dispatch。

<a id="dev-note"></a>
## 开发备注

无。
