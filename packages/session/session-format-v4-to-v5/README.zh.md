---
description: "V4 到 V5 Session 事件身份迁移与原生 V5 codec。"
kind: package-library
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 概述

将受支持的 V4 Session 恢复为 V5，同时保留事件位置、继承切点和不透明记录。V5 修改 Session header 的版本判别字段，引入明确的消息来源与第一方事件身份，并沿用已发布的 V4 物理行 framing。

## 目录

- [使用此包](#use-this-package)
- [V4 到 V5 规范](#v4-to-v5-specification)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

构建时的[格式目录](../session-format-catalog/README.zh.md)会在读取 V4 body 时调用此相邻迁移边，并使用 V5 codec 写入当前数据。此包没有运行时插件或 profile mount。直接导入仅供目录和迁移测试使用。

<a id="v4-to-v5-specification"></a>
## V4 到 V5 规范

### Header 与物理 framing

| V4 输入 | V5 结果 | 保留或拒绝规则 |
|---|---|---|
| 逻辑 Session header | `version: 4` 改为 `5` | 其他已准入 header 字段均原样保留。 |
| 物理 JSONL header | V4 标识符改为 V5 | 目标 codec 沿用 V4 物理 framing，只改 header 版本。 |
| 事件序号与引用 | 恒等映射 | 事件顺序、`seq`、message ID、tool ID、SessionSeq 引用和继承切点均不移动。 |

### 事件身份变更

已安装的 DSH V4 构建曾将以下第一方可选记录写入 `plugin:` 命名空间。V5 将它们作为普通第一方 ignorable 事件写入，因此迁移只重命名事件 `type`，保留载荷及 envelope 元数据。

| V4 事件类型 | V5 事件类型 |
|---|---|
| `plugin:codex/subscription-state` | `codex/subscription-state` |
| `plugin:task/checkpoint` | `task/checkpoint` |
| `plugin:task/result-manifest` | `task/result-manifest` |

其他 `plugin:` 记录（包括实验目录中没有声明的记录）保持不透明，并保留原名称与载荷。V5 构建无法识别的 required 事件会被目标恢复器拒绝；标记为 `ignorable: true` 的未知事件仍可跳过。

### 消息来源与交付记录

V5 source map 新增 `task-auto-continuation`，它可能出现在 `user/message`、`developer/message`、`agent/inbox/spliced` 和 `session/title-llm-request` 的 message 位置。迁移将每个 source 对象作为 JSON 原样保留，不推断或改写生产者元数据。V4 codec 准入任意非空的直接 source `kind`，因此已经保留这种本地 V4 表示。

已有的 `session-log-deepseek/delivery-accepted` 记录保留原 `sessionFormatVersion` 和水位。V4 接受记录不表示 V5 后继已成功交付。新的 V5 记录按 V5 Session 身份和序号校验。

### 验证与恢复

V4 codec 负责物理来源解码。此边要求事件序号连续，并校验 seeded 继承标记与来源切点一致；每条来源事件均产生一条目标事件。V5 codec 负责目标 framing。`restoreReleasedV5Artifact` 使用既有 V4 生命周期、surface、compaction、tool、title、catalog 和 V4 交付检查，然后校验当前 V5 交付记录。已安装的当前 Session 校验器负责检查完整的 V5 事件 schema 与载荷。

仅 header 读取只推进 header，不读取事件 body。严格 body 恢复会在持久化发布 V5 后继前拒绝格式错误的来源行或不支持的 required 事件。V4 来源字节与数据代由持久化层管理，此包不会修改它们。

## 模型体验

无；仅在恢复持久化 Session 时由 `dsh-session-format-catalog` 间接调用此包。

### KV Cache effect

此包不组装模型请求，也不修改模型可见消息内容。Session 目录可能在迁移成功后发布新数据代；请求重建随后会使用当前数据代。

## 已知限制与暂缓工作

- **仅支持相邻来源**：此边接受 V4 并输出 V5。更早的数据代必须先经过各自已发布的相邻迁移。
- **不透明插件记录**：实验插件载荷会保留而不解释其所有者专属数据，消费方仍负责验证。

<a id="dev-note"></a>
## 开发备注

无。
