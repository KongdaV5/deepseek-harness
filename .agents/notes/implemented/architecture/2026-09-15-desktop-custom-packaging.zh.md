---
summary: "独立标识的本地 DS Harness 产品组合已批准的 Phase 2–7 bundle，但不修改正式 Desktop。"
kind: "architecture"
---

# Desktop Custom Packaging

[English](2026-09-15-desktop-custom-packaging.md) | 中文

## Decision

保持正式 DSH Desktop release path 不变。内部 `custom` Desktop flavor 会封装匹配的 runtime 与 `@deepseek-ai/dsh-desktop-custom-composition`，继续使用 bundle identifier `dev.dsh.desktop.custom`，并生成 ad-hoc-signed、本地 app **DS Harness.app**。`desktop-custom` 及其 composition package 仍是内部技术 identity；**DS Harness** 是用户可见的产品 identity。

## Composition and state boundaries

Custom 内置 bundle 只负责已经批准的 Phase 2–7 package 的部署组合。`DesktopProjectManager` 接受 build-specific 的 built-in bundle prefix，因此 composition 从不可变的 packaged runtime 链接，而不是被误归类为 profile 安装的第三方插件。常规 Desktop prefix 保持不变。

Custom 使用隔离的 Electron user-data profile 与 `~/.dsh/profiles/desktop-custom`；同时继续使用正常共享的 DSH settings 和 session。因此，正式与 Custom Desktop 可以共存，但不能同时编辑同一个 session。

## Packaging constraints

`package-custom.ts` 提供 Custom bundle closure，并在 `Contents/Resources/custom-build.json` 写入本地 provenance，其中包含 `productName: "DS Harness"`。该 flavor 使用 ad-hoc signing、禁用 updater/notarization configuration，且绝不读取、patch、签名或覆盖 `/Applications/DSH Desktop.app`。它是本地 development artifact，不是可分发的签名 release。

Custom package 使用与正式 Desktop 相同的 official client capability profile，但通过 `--title "DS Harness"` 传入 narrow build title override。其本地 `release:pack` 调用以同一个显式值 `--client-title "DS Harness"` 重复传递，因此 package-set verifier 只接受带有目标 title 的 artifacts。通用 client-build helper 只改变公开的 `DSH_CLIENT_TITLE`；正式 packaging 不传这两个选项，并继续要求 `DeepSeek Harness`。

单独构建的 startup shell 通过 Desktop 自己的 `localeGet` IPC 接收本地化 messages。Custom 会在此处获得与原生菜单和 dialog 相同的窄范围 product-token 替换，因此 loading 与 recovery 的可见文案显示 **DS Harness**；正式 Desktop 继续接收未修改的 upstream locale。这是 build/configuration seam，不是 renderer DOM rewrite。

可选 Run Details dock 使用条件挂载。没有 active Run 时，它不会只为显示诊断值 `Unknown` 或历史 checkpoint state 而在 idle composer 中保留一行。该 suppression 不表示 backend 已被判定为 idle、ready 或 healthy：active Run 但 observation 不可得时仍会显示 `Unknown`。

日常本地使用可执行 `pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64`，先 package 再安装 `/Applications/DS Harness.app`。install step 会通过 Bundle ID、可见名称、provenance 与 ad-hoc signature 验证 source app 以及任何已存在 target，之后才替换 target。它绝不写入正式 Desktop application、`desktop-custom` profile、Electron user-data identity、settings 或 sessions。

历史 `dsh-custom-baseline-2026-09-17` tag 仍是不可变的 rename 前技术恢复锚点。它有意保留原始 `DSH Desktop Custom` build provenance；不会因为 DS Harness 产品 rename 而移动。

## Known boundary

IQ3_S GGUF 在这个 package 中没有结构化 backend-progress integration。backend prefill 与 attribution 保持 Unknown，不会被推测填充。该 packaging layer 不添加 backend restart、dynamic recovery、automatic resume 或 policy change。
