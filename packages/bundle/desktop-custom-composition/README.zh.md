---
description: "供本地封装 DSH Desktop Custom 使用的私有能力组合层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-custom-composition

[English](README.md) | 中文

## Summary

这个私有、内置 bundle 为 **DSH Desktop Custom** 组合已通过审查的 Phase 2–7 本地运行时能力。只有 `custom` packaging flavor 会选择它；它不会修改已发布 DSH Desktop、其 launcher 或日常 `~/.dsh/settings.yaml`。

Custom 应用使用独立的 Electron 数据目录及 Desktop profile（`~/.dsh/profiles/desktop-custom`），同时刻意沿用用户正常的本地 provider 配置。日常路径是 `local-qwen` 与已配置的 IQ3_S GGUF backend；不会选择 8081 的开发 fixture。

## Capability boundary

`cordis.patch.yml` 组合已有的 Run State、diagnostics transport 与 dock、reasoning policy、task checkpoint、compaction policy 与 backend observation contract。GGUF 路径目前没有结构化 backend-progress 数据源，因此 prefill 与 worker attribution 仍是 **Unknown**，不会被推测填充。该 bundle 不会重启 backend，也不会添加超出已批准能力包范围的 retry、resume、profile、benchmark 或 reasoning-budget policy。

Custom composition 是一个**内置 runtime bundle**，不是可安装的第三方插件。Desktop 从不可变的已封装 runtime 链接它，并将其排除在 profile 的用户插件清单之外。

## Safety and coexistence

- 不会读取、patch、签名或替换正式 `/Applications/DSH Desktop.app`。
- Custom 与正式 Desktop 使用独立的 Electron user data 及 Desktop 插件 profile。
- DSH session 与正常 settings 有意保持共享。不要在两个应用中同时编辑同一个 conversation。
- 本包没有 updater 或 notarization 路径；正式 release 仍使用官方 packaging configuration。

## Further exploration

- [`cordis.patch.yml`](cordis.patch.yml) — Custom capability composition 与正常 provider 声明。
- [`../../../apps/desktop/scripts/package-custom.ts`](../../../apps/desktop/scripts/package-custom.ts) — 本地 artifact build 与 provenance metadata。
- [`../../../apps/desktop/src/project-manager.ts`](../../../apps/desktop/src/project-manager.ts) — 内置 bundle/profile 分离。
- [`../../../apps/desktop/README.zh.md`](../../../apps/desktop/README.zh.md) — Desktop packaging 背景。

## Maintainer note

该包刻意保持为窄小 packaging seam。不要把状态机、解析规则、recovery action 或正式视觉重构放入其中。升级兼容性应通过替换本 composition 或各个 capability package 保持，而不是把正式 Desktop 变成长期 fork。
