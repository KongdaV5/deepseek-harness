---
kind: upgrade-guide
description: "RC.2 基础上的 Custom settings 与 Session identity 转换。"
---

# Custom settings 与 Session V4

[English](guide.md) | 中文

## 变更

Custom 使用官方插件 Config 和 profile patch。旧 SettingsScope consumer 被移除。原生 Custom Session event 使用插件限定身份和 V4 事件引用；旧身份只保留在输入 V3 转换中。

## 迁移

1. 使用隔离 migration candidate 的 desktop-custom profile。Bootstrap 在 Loader 加载 Settings 前翻译已知旧 section，保留 settings 归档并记录 import digest。保留归档，以便处理未知 section 与中断恢复。
2. 使用官方 immutable generation migration 打开复制的 Session fixture。在已验证的 V4 successor 旁保留所有已提交 V3 generation。M1 阶段不得对真实用户数据执行此机制。
3. 验证集中 fixture，并查阅[迁移 ledger](../../../custom-foundation.zh.md)。未解决的 Codex 状态要求 reconciliation；迁移不授权 dispatch 或改变认证生命周期。Runtime 与 Desktop 集成留给 M2。
