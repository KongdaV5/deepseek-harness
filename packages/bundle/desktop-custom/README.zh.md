---
description: "web 表层之上的 DS Harness Desktop 能力层：持久 Task 权威、有界运行策略与任务感知压缩策略，供用户组合或定制 DS Harness Desktop profile。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-custom

[English](README.md) | 中文

## 概述

DS Harness Desktop profile 依次组合 `dsh-base`、`dsh-web-app` 与本层（本层置于最后），因此该表层获得了 DS Harness 产品所依赖的持久 Task 权威、有界运行策略与任务感知压缩策略。本层挂载三个 host 平面服务，并在继承来的压缩执行器上声明一项部署取值。它不添加任何客户端行、不替换任何执行器、不新增任何 Session 事件，因此不含本层的 profile 就是一个普通的 web 表层。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

DS Harness Desktop profile 把本组合包列在 web 表层之后，因此本层是该 profile 的最后一个组合包：

```yaml
- bundles:
    - '@deepseek-ai/dsh-base'
    - '@deepseek-ai/dsh-web-app'
    - '@deepseek-ai/dsh-desktop-custom'
```

随发行版交付的组合包从 dsh 安装目录解析；`dsh plugin --profile <name> add @deepseek-ai/dsh-desktop-custom` 会把本层追加到你自己的 profile 上。缺少 `dsh.bundle.patch` 字段的包根本不是组合包，组合器会把它当作普通插件处理。

### 你会得到什么

三行 host 平面行与一项重述的部署取值：

| 行 | 该表层获得的能力 |
|---|---|
| `task-checkpoint` | 持久 Task 权威：`taskCheckpoint` 与 `taskResults` 两个投影，以及受保护的续跑接缝。 |
| `agent-run-policy` | 一个最外层 `agent/request-error` 监听器，在上游重试执行器之上约束自动重试。 |
| `compaction-task-aware-policy` | 现有压缩执行器通过 `ctx.get` 解析的可选 `compactionCandidatePolicy` 服务。 |
| `compaction-basic` | 继承来的执行器，在 host 平面上重新启用，并带上本部署的 `maxSummaryValidationRetries` 预算。 |

每一行的行为、不变量与配置都归其所属包所有；本层只负责放置这些行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本层是一份静态 patch 文档，在 `dsh-web-app` 之后应用。它自身不挂载任何服务、不发任何事件、不持有可变状态。

### 为何重述压缩执行器

`dsh-web-app` 禁用了 base 的 `compaction-basic` 行，因为在 Web 表层上由挂载的 agent 预设拥有压缩后端。DS Harness 产品改为在 host 平面上拥有该后端，因此任务感知策略管辖的是一个已知的执行器实例，而不是每个已挂载预设各一个实例。patch 会整体替换目标行的 `config`，因此这条重述行同时声明了 `disabled` 标志与校验预算。

`maxSummaryValidationRetries` 表示校验型策略还可再要求多少个摘要候选。上游默认值为 `0`——一个候选、不做语义重试——未挂载校验型策略的部署保持该值。本层设为 `1`：任务感知策略对候选做确定性校验，因此它正好获得一次用于修复被拒摘要的额外候选机会。重试阶梯由该策略自身限定，绝不由这个数字单独决定。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 组合包实质：三行 insert 行与一行重述的执行器行，逐行理由以行内注释给出 |
| [`src/index.ts`](src/index.ts) | 包入口；不承载任何运行时 API |
| — | 不发布不变量伴随包，因为本包是一个静态 patch 列表载体（一份由其他包拥有的 loader 行的 YAML 文档）；它不挂载服务、不发事件、不持有需要检查的可变关系。每个被插入行的不变量由其自身所属包承载。 |
| [`tests/desktop-custom.spec.ts`](tests/desktop-custom.spec.ts) | 清单声明、插入行集合与重述执行器的检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [app-boot profile 章节](../../boot/app-boot/README.zh.md)——profile 如何解析、分层与定制。
- [组合包列表](../README.zh.md)——构建于共享核心之上的各个表层。
- [生成的组合图](../../../apps/cli/composition.md)——每个随发行版交付的 profile 实际使用的插件集合。
- [`@deepseek-ai/dsh-compaction-task-aware-policy`](../../compaction/compaction-task-aware-policy/README.zh.md)——本层挂载的策略。
- [`@deepseek-ai/dsh-task-checkpoint`](../../session/task-checkpoint/README.zh.md)——该策略所保护的持久权威。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由每个被插入行所属的包，由它们承载该行的模型可见行为。

#### KV Cache effect

本层自身不添加任何请求前缀；缓存影响由被插入行所属的包承载。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束，而非通用对比或任务清单。

- **patch 会整体替换配置块**——在此重述 `compaction-basic` 会替换其全部配置，因此后续层若要改一个键，必须重述它保留的每个键。
- **本层依赖 web 表层**——它重述的是一行被 `dsh-web-app` 禁用的行，且插入的行会读取 web 表层的会话投影；它不是独立组合包。
- **本层不含客户端行**——Run Details 与诊断传输属于后续阶段，因此期望它们的客户端会渲染自己的空状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
