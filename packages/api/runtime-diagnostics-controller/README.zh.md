---
description: "领域无关的瞬时运行时诊断传输：按 topic 键入的单一 provider 注册表、以同步快照开场并按序投递整体替换的强类型 Remote 流，以及把每次观测发布为实时资源的客户端资源 provider。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-runtime-diagnostics-controller

[English](README.md) | 中文

## 概述

本包用于把一个运行时对某个 Session 的*当前*观测送到 Web 客户端，同时不让传输层成为该状态的第二个权威。owner 通过只读 provider 发布，controller 为每个 topic 与 Session 路由一条流，客户端把它当作实时资源读取。每一帧都是整体替换，缺失本身也是一种取值；流一旦结束或失败即报告为不可用，而不是把旧值继续当作当前值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 在宿主侧发布观测

领域包为每个 topic 注册一个 provider。provider 是只读的：它报告自己的当前观测并订阅替换，不暴露任何写入、触发或阶段语义。`undefined` 与 `{ present: false }` 描述的是同一种缺失。

```ts
import type { RuntimeDiagnosticsProvider } from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/types'

declare const policy: {
  diagnostics(sessionId: string): object | undefined
  subscribeDiagnostics(sessionId: string, listener: (value: object | undefined) => void): () => void
}

const provider: RuntimeDiagnosticsProvider = {
  topic: 'task-aware-compaction',
  schemaId: 'dsh.task-aware-compaction-diagnostics',
  schemaVersion: 1,
  read: sessionId => {
    const value = policy.diagnostics(sessionId)
    return value === undefined ? undefined : { present: true, value }
  },
  subscribe: (sessionId, listener) => policy.subscribeDiagnostics(
    sessionId,
    value => listener(value === undefined ? undefined : { present: true, value }),
  ),
}
```

| 方法 | 返回值 | 用途 |
|---|---|---|
| `registerProvider(provider)` | disposer | 把一个 topic 绑定到一个 provider；同一 topic 的第二个 provider 会抛错，disposer 会以 `runtime-diagnostics/provider-unavailable` 终止该 topic 上已打开的流 |
| `follow({ topic, sessionId }, signal)` | `RuntimeDiagnosticsFrame` 流 | 一次代（generation）：恰好一帧 `snapshot`，随后按提交顺序给出 `change` 帧 |

主动撤销 provider 时，已打开的代会先交付已经提交的帧，再以类型明确的 `runtime-diagnostics/provider-unavailable` 失败终止；没有撤销信号的自然结束仍是 `runtime-diagnostics/unexpected-frame`；非 Remote 的载体异常会报告为 `runtime-diagnostics/transport-failure`，不会误报成帧协议违规。

### 在客户端读取观测

客户端挂载生成产物、声明每个 topic 承载的 schema，并通过资源模型访问传输层 —— `useResource(runtimeDiagnosticsAddress(topic, sessionId))`。没有 domain 声明过的 topic 会失败关闭（fail closed），因为渲染一个无人校验过的观测，比什么都不显示更糟。

```ts
// Type-only: the observation vocabulary this surface decodes. The `./client`
// half also exports `runtimeDiagnosticsAddress`, which builds the address below.
import type { RuntimeDiagnosticsObservation } from '@deepseek-ai/dsh-api-runtime-diagnostics-controller/types'

declare const runtimeDiagnosticsTopics: {
  declare(topic: string, schema: { schemaId: string; schemaVersion: number }): () => void
}
// Supplied by the controller's client mount over the resource model.
declare function useResource(address: string): {
  status: 'none' | 'loading' | 'live' | 'failed'
  value: RuntimeDiagnosticsObservation | undefined
}
declare function runtimeDiagnosticsAddress(topic: string, sessionId: string): string

runtimeDiagnosticsTopics.declare('task-aware-compaction', {
  schemaId: 'dsh.task-aware-compaction-diagnostics',
  schemaVersion: 1,
})

export function readTransientCompaction(sessionId: string): RuntimeDiagnosticsObservation | undefined {
  return useResource(runtimeDiagnosticsAddress('task-aware-compaction', sessionId)).value
}
```

地址语法为 `dsh-resource://runtime-diagnostics/<topic>/<sessionId>`，并严格解析：恰好两个路径段，且每段都必须是其解码结果的标准编码。一个指向两个目标的地址，或以两种写法指向同一目标的地址，都指向空。

### 线上词汇

| 类型 | 含义 |
|---|---|
| `RuntimeDiagnosticsFrame` | `{ type, topic, sessionId, schemaId, schemaVersion, observation }` —— 一次整体替换 |
| `RuntimeDiagnosticsObservation` | `{ present: false }`，或 `{ present: true, value }`，其中 value 为已脱附的 JSON |
| `RuntimeDiagnosticsValue` | 观测值可以是的递归 JSON |
| `RuntimeDiagnosticsFollowRequest` | `{ topic, sessionId }` —— 一条流所服务的那一对 |

每一帧都重复 `topic`、`sessionId`、`schemaId` 与 `schemaVersion`，因此客户端会对每一帧校验契约（而不是只校验一次），而在传输中丢失身份的帧会被拒绝而不是被渲染。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

controller 只负责路由与投递，别无其他。它不保存当前值映射、不缓存已投递内容、也不向任何 provider 写入，因此重连时是重新读取 owner，而不是回放记忆中的状态。

开场快照关闭了一个特定的竞态。先订阅再读取的读者，必须确信中途没有变更插进来，因此按契约注册是静默的，且读取是同步的：两步之间不会运行任何代码，这使那个空隙在结构上为空，而不只是被缩小。

投递是缓冲，不是权威。一次代持有 owner 已经提交过的观测，按提交顺序排列，并在被读取时逐个丢弃。没有 JSON 表示形式的值 —— 函数、symbol、bigint、非有限数、类实例、环、以及 `undefined` 成员 —— 会让整条流失败关闭，而不是被悄悄截断，因此客户端永远不会渲染只传输了一半的观测。

客户端 provider 会重新校验每一帧，而不是直接转换它。即使生成的 codec 已经解析过，载荷仍是不可信输入，因为这个 provider 也会被外部实现驱动。一条流必须恰好以一帧 `snapshot` 开场；第二个 snapshot、先于 snapshot 的 change、属于其他 topic/Session/schema 的帧、以及意外结束，都是失败帧。资源模型会在后续失败帧中保留最后一次 `ok` 的值，因此 provider 会让一次已结束的代以失败帧收尾，而不是任其静默结束 —— 这正是让断连读作不可用、而不是读作宿主在消失前恰好发布的最后一个阶段的原因。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `RuntimeDiagnosticsController`：topic 注册表、每个 `topic + SessionId` 一次代，以及 `runtimeDiagnostics.follow` Remote 流 |
| [`src/stream.ts`](src/stream.ts) | 每个观测都要经过的严格 JSON 脱附步骤，以及一次代的顺序与通知 |
| [`src/types.ts`](src/types.ts) | 线上词汇、只读 provider 缝（seam）与已声明的失败码 |
| [`src/client/address.ts`](src/client/address.ts) | `dsh-resource://runtime-diagnostics/…` 的解析与拼装 |
| [`src/client/provider.ts`](src/client/provider.ts) | 资源 provider：地址到已校验值流的转换 |
| [`src/client/mount.ts`](src/client/mount.ts) | 客户端 topic 注册表与挂载生命周期 |
| [`src/client/index.ts`](src/client/index.ts) | `./client` 入口，绑定生成的 Host-for-Client 产物 |
| — | 不发布运行时 invariant 伴生件；本控制器是不持有共享运行时状态的无状态路由器，其顺序与生命周期代数由传输测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [API 包地图](../README.zh.md) —— 与本包相邻的宿主/客户端 Remote 包。
- [客户端资源](../../client/resources/README.zh.md) —— 资源模型、`useResource`、pin 与 provider 生命周期。
- [压缩子系统](../../../docs/subsystems/compaction.zh.md) —— 与瞬时观测刻意保持分离的持久审计路径。
- [任务感知压缩策略](../../compaction/compaction-task-aware-policy/README.zh.md) —— 第一个通过本传输层发布的 owner。

-----

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **传输层不持久、也不回放。** 观测只在 owner 持有它期间存在；重连的客户端读到的是 owner 的当前值，而不是它错过的历史。必须跨重启保留的内容属于持久路径。
- **一个 topic 只能有一个 provider。** topic 是扁平命名空间，没有层级、没有作用域、也没有动态优先级：同一 topic 的第二个 provider 是接线错误，而不是覆盖。
- **传输层只校验形状，绝不校验含义。** 它能证明某个值是已脱附的 JSON，也能证明某帧指向它被询问的那个地址；它无法证明这些字段的含义与某个 topic 的 schema 一致，因此客户端渲染时仍需自行解码。
- **订阅是进程本地的。** provider 绑定在挂载它的宿主进程上；既没有跨进程扇出，也没有跨宿主重启的投递保证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

在改动 `src/types.ts` 之前，Remote 边界有一条值得记住的警告：生成的 codec 会拒绝开放的 `unknown` 数据，因此观测值不能是 `Record<string, unknown>`，而是一个具体的递归 JSON 类型；provider 缝之所以保持宽松（`object`），正是为了让 `src/stream.ts` 中那次严格遍历仍然是唯一判定"什么算可传输"的地方。

`./client` 入口是唯一导入生成的 `…/remote` 产物的模块，该产物只在构建后存在。所有带行为的代码都放在 `client/mount.ts`，以便源码通道能够覆盖它；入口也因此被排除在逐文件覆盖率门禁之外。

</details>
