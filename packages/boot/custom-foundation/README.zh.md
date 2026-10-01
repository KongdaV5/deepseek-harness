---
description: "初始化以 Local Huihui Qwen 为默认模型的 Custom profile。在显式数据目录中，把旧 Custom settings 翻译到插件拥有的 profile patch。读取 Local inventory 时不检查模型文件或启动 driver。"
kind: package-reference
---

# @deepseek-ai/dsh-custom-foundation

[English](README.md) | 中文

## 概述

初始化以 Local Huihui Qwen 为默认模型的 Custom profile。在显式数据目录中，把旧 Custom settings 翻译到插件拥有的 profile patch。读取 Local inventory 时不检查模型文件或启动 driver。

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

CustomFoundation 拥有 Local manager inventory 和能力偏好；agent-default-model 拥有默认选择，llm-pi-ai 拥有 provider profiles。旧配置翻译在官方 profile lock 内，验证所有已知 section 后进行一次原子写入。源文件归档和导入 digest 恢复旧 partial import 及发布后归档前的中断。已有 profile 值优先；冲突的认证 authority 被拒绝。未知 section 保留在归档中并返回给调用方。

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

不产生提示词字节；`agent-default-model` 和 `llm-pi-ai` 使用持久化的 Local 意图选择提供者。

#### Token 效应

零直接 token。

#### KV Cache 影响

无直接影响；此层不执行模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 旧配置导入是单向兼容模块，不是第二套 Settings store。仅在受支持的 Custom V3 profiles 与 settings 归档退役后移除。Local runtime controller 串行处理 start/stop/switch，只持久化实际成功服务的精确 profile 意图，并拒绝外来或过时的健康状态。LaunchAgent driver 不拥有外部服务生命周期；可选 owned-process driver 仅在官方 subprocess 范围退出后释放句柄。

-----

<a id="dev-note"></a>
### 开发备注

维护者通过所属隔离测试验证 Config、持久化和释放行为。
