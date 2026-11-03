---
description: "从已提交的 Session turn 派生稳定 Run identity 与 run state。将 backend observation 与持久 authority 分开。重启后重建同一逻辑 Run，不存储进程内 attempt counter。"
kind: package-library
---

# @deepseek-ai/dsh-agent-run-state

[English](README.md) | 中文

## 概述

从已提交的 Session turn 派生稳定 Run identity 与 run state。将 backend observation 与持久 authority 分开。重启后重建同一逻辑 Run，不存储进程内 attempt counter。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 Custom profile 的 bundle 组合使用；本包不拥有另一套应用启动入口。

-----

<a id="understand-the-implementation"></a>
## 理解实现

runIdFor 根据 SessionId 与持久 turn 序号派生唯一身份。本库不发出事件，不分配 run。原生 Session 和 lifecycle projection 提供事实；observation 不创建或结算 authority。

未发布 runtime invariant companion，因为所有持久写入经过既有 Session 或 ConfigEditor 校验，且本包没有可独立分歧的状态副本。

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Custom foundation ledger](../../../docs/custom-foundation.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 持久化基础

#### 模型可见内容

`runIdFor` 标识与 run 投影属于诊断信息；它们不增加提示词字节或模型请求。

#### Token 效应

零直接 token。

#### KV Cache 影响

无直接影响；此层不执行模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 实时 runtime observation 与 Run Details 传输留给 M2。

-----

<a id="dev-note"></a>
### 开发备注

维护者通过所属隔离测试验证 Config、持久化和释放行为。
