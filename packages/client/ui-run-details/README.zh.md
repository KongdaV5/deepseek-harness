---
description: "开发态紧凑 Run 状态条与可展开的终端安全 Run Details 对话框"
kind: "client-ui-plugin"
---

# @deepseek-ai/dsh-client-ui-run-details

[English](README.md) | 中文

此开发态浏览器插件在 `conversation.input.dock` 中加入紧凑的当前 Run 状态。
点击后使用既有 Modal primitive 打开 Run Details，显示 identity、route、
requested/resolved/wire reasoning、Context facts、独立的 process/model/generation
health、retry、stopping、compaction、checkpoint eligibility，以及先 primary 后
secondary 的错误。

插件只读取版本化 `desktopRunDiagnostics` Remote snapshot；不会读取本地文件、
Session JSONL、日志、settings 或 backend port。未知字段保持未知。Prefill 仅以
已观察到的事实显示，不估算百分比。只有 Session projection 明确标示时才显示
Benchmark，且不会添加 reasoning selector。

“继续任务”只在 `SAFE_TO_RESUME` 时出现。它调用既有 Host endpoint 并显示 Host
重新验证后的结果。若工具结果未知导致 blocked，则只显示原因，不显示按钮。

## Model Experience

### 只读 diagnostics surface

#### What the model sees

UI 不会创建 model request 或 model-visible prompt content；它只在 Host 完成自身 projection 后读取 versioned `DesktopRunDiagnosticsSnapshot`。

#### Token effect

dock 与默认折叠的 dialog 不向 model request 添加 token；其 Remote stream 只把 terminal-safe diagnostics 传给 browser。

#### KV Cache effect

UI 不检查、清除、保留或推断 prompt-cache state；只有 Host projection 已确认的 cache counter 才会 render。

## Known Limitations and Deferred Work

- UI 是 status 与 diagnostics surface，不是第二套 Agent state machine。
- 它映射既有 `RunPhase`，可与 development composition 一同移除。
- 在 backend-neutral structured observer 出现前，GGUF backend progress 保持 Unknown。
