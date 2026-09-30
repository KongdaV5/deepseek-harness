---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-codex-runtime-fingerprint

[English](2026-09-30-codex-runtime-fingerprint.md) | 中文

## 概述

同版本。Session 格式版本 3 和 Codex projection state version 3 保持不变。可选 runtime 指纹将私有线程所有权绑定到产生它的二进制及适配器合同。无指纹的旧版已结算映射在本地退役并从公开历史 bootstrap；未决 dispatch 保持阻断，不重放。wire 声明同时记录原已支持的可选认证 generation：projection reader 仍把缺失 epoch 归一化为 null，既有认证事务及所有权逻辑不变。缓存元数据及映射都不含认证凭据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

同版本。Session 格式版本 3 和 Codex projection state version 3 不变。可选 runtime 指纹将线程所有权绑定到产生它的二进制及适配器合同。旧版已结算映射退役并从公开历史 bootstrap；未决 dispatch 阻断且不重放。可选 wire 认证 generation 与既有 reader 归一化为 null 的行为一致。认证事务及所有权行为不变，映射与缓存都不含凭据。

<a id="verification"></a>
## 验证

Codex runtime、schema/cache、Host 模型目录及客户端 selector 的 focused tests 通过（9 个文件、140 项），包括既有认证生命周期回归及未知 runtime pair 的 dispatch/结果恢复屏障。System 与 Bundled 的真实二进制 Light 探针通过。System Full 的短轮次、历史注入、关联历史、恢复及观测活跃状态后的中断验证通过，并删除了自己创建的临时线程。生成持久化目录及本 schema acknowledgement 使用既有 persistence 验证命令检查。

<a id="dev-note"></a>
## 开发备注

无。
