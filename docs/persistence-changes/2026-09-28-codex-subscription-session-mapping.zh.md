---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-28-codex-subscription-session-mapping

[English](2026-09-28-codex-subscription-session-mapping.md) | 中文

## 概述

新增一个可忽略的 Session 事件，用于持久化 DSH Session 与官方 Codex App Server 线程之间的非机密映射，以及有界的派发和 transcript 同步恢复事实。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

同版本兼容。Session 格式版本 3、现有事件封套和所有既有事件载荷均不变。旧记录不包含此可选事件，Codex 映射会初始化为空；未实现此功能的读取方可以忽略该事件。载荷仅保存协调 ID、所选模型与 effort、工作区路径/身份以及恢复 turn 所需的内容哈希；不保存认证令牌、凭据或登录 URL。

<a id="verification"></a>
## 验证

Codex runtime、external-turn loop、Settings controller 和 Models UI 的定向测试通过（4 个文件、130 项测试）。生成的 persistence catalog 与 schema inventory 使用 verify-persistence-catalog 校验；persistence-changes --check 用于确认此兼容性记录及其 schema snapshot。

<a id="dev-note"></a>
## 开发备注

无。
