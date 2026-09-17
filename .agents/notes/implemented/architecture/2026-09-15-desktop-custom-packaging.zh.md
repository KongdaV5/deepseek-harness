---
summary: "独立标识的本地 DSH Desktop Custom artifact 组合已批准的 Phase 2–7 bundle，但不修改正式 Desktop。"
kind: "architecture"
---

# Desktop Custom Packaging

[English](2026-09-15-desktop-custom-packaging.md) | 中文

## Decision

保持正式 DSH Desktop release path 不变。`custom` Desktop build flavor 会封装匹配的 runtime 与 `@deepseek-ai/dsh-desktop-custom-composition`，使用 bundle identifier `dev.dsh.desktop.custom`，并生成 ad-hoc-signed、本地 artifact `DSH Desktop Custom.app`。

## Composition and state boundaries

Custom 内置 bundle 只负责已经批准的 Phase 2–7 package 的部署组合。`DesktopProjectManager` 接受 build-specific 的 built-in bundle prefix，因此 composition 从不可变的 packaged runtime 链接，而不是被误归类为 profile 安装的第三方插件。常规 Desktop prefix 保持不变。

Custom 使用隔离的 Electron user-data profile 与 `~/.dsh/profiles/desktop-custom`；同时继续使用正常共享的 DSH settings 和 session。因此，正式与 Custom Desktop 可以共存，但不能同时编辑同一个 session。

## Packaging constraints

`package-custom.ts` 提供 Custom bundle closure，并在 `Contents/Resources/custom-build.json` 写入本地 provenance。该 flavor 使用 ad-hoc signing、禁用 updater/notarization configuration，且绝不读取、patch、签名或覆盖 `/Applications/DSH Desktop.app`。它是本地 development artifact，不是可分发的签名 release。

## Known boundary

IQ3_S GGUF 在这个 package 中没有结构化 backend-progress integration。backend prefill 与 attribution 保持 Unknown，不会被推测填充。该 packaging layer 不添加 backend restart、dynamic recovery、automatic resume 或 policy change。
