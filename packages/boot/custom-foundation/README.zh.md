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

Desktop 在隔离 Harness 数据之前取得 OS 账户 home，通过 `DSH_DESKTOP_MACHINE_RESOURCE_HOME` 传给 Host。Host 将这一个机器资源 home 交给既有默认模型登记和 Local runtime Config；LaunchAgent driver 要求显式提供它，不再从 `HOME` 推断。启动器刷新自己拥有的字段，保留用户模型路径和运行时偏好。Rehearsal 隔离 Harness 配置、Session、缓存及 Electron 状态，同时引用真实机器的 manager、LaunchAgent 和模型文件。修正此前生成的 rehearsal 模型目录时，仅对隔离 profile 使用 `customLocalPatches`。

生成的 Huihui 元数据声明 65,536 token 总上下文；Local 适配器按该声明和运行中服务容量共同准入每个序列化文本请求。profile 初始化只升级未修改的生成式 32k Huihui 条目，保留用户显式容量。Local 精确目标 policy 复用现有 compaction 引擎，预留 4,096 token 余量并限制摘要为 8,192 token。profile 仍是唯一配置 owner；不会为了容纳请求移除工具。

未发布 runtime invariant companion，因为所有持久写入经过既有 Session 或 ConfigEditor 校验，且本包没有可独立分歧的状态副本。

完全匹配旧版生成值的 `local-huihui-qwen` 路由会升级为同一 Local 部署 headers 和容量。新默认选择转向 `dsh-local-huihui`；旧路由 ID 保留供已持久化的 Session 选择解析。用户修改过的路由保持不变。只有受支持的持久化选择不再引用它时，才能移除该别名。

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
