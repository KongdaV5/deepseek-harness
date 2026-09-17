---
name: "Desktop Run diagnostics Remote bridge"
description: "仅供开发版使用的浏览器桥接层：在只读 UI 加载前挂载 versioned Desktop Run diagnostics namespace。"
---

# Desktop Run diagnostics Remote bridge

[English](README.md) | 中文

`@deepseek-ai/dsh-client-desktop-run-diagnostics-remote` 是仅供开发版
Desktop capability layer 使用的小型浏览器组合桥接层。它在后续 UI entry
依赖该 namespace 前，通过现有 Desktop Host connection 挂载生成的
`desktopRunDiagnostics` Remote contribution。

它不包含 model、retry、recovery、health、policy 或 UI-state logic。
capability 所属的 Host service 仍是 diagnostics 的唯一来源；UI 仍只负责
render versioned snapshot，并调用已经存在的显式 Resume operation。

## 范围

该 package 只由 `@deepseek-ai/dsh-desktop-dev-composition` 列出。它不是
released Desktop feature、日常 profile plugin 或第二条 transport。移除
development composition 后，bridge 与其 browser namespace 会一同离开组合。

## 边界

保留既有 `remote.$mount()` extension point。把这一步从 status UI 分离后，
`remote.desktopRunDiagnostics` 成为显式 loader dependency，因此
session-scoped dock entry 不会在首次 render 时与 asynchronous namespace mount
发生竞争。

## 文件

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | package loader 所需的 no-op Host face。 |
| `src/client/index.ts` | 仅浏览器使用的 generated-Remote mount。 |

## 保证

- 本 package 不会把 polling、log、settings 或 raw JSONL 传给浏览器。
- 不会在这里创建 Run、自动 Resume、retry、restart 或重新分类。
- bridge 不拥有 durable state，也不选择 provider、benchmark 或 reasoning。

## Model Experience

### Browser namespace mount

#### What the model sees

bridge 不创建 model request 或 model-visible prompt；它只在 Host capability 已完成 composition 后挂载生成的 `desktopRunDiagnostics` namespace。

#### Token effect

挂载 browser Remote namespace 不添加 request content；只有 Host 完成自身 coalescing 后才传递 diagnostics。

#### KV Cache effect

bridge 不读取、修改、保留或推断 cache state。

## Known Limitations and Deferred Work

- bridge 仅用于 development composition，不是 released Desktop compatibility layer。
- 它不提供 UI、health classification、recovery 或额外 transport behavior。
