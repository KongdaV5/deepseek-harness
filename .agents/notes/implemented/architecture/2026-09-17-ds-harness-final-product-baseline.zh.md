# DS Harness 最终产品基线

状态：已实现并已验证

[English](2026-09-17-ds-harness-final-product-baseline.md) | 中文

## 目的与范围

本文冻结已经验证的日用本地产品 **DS Harness**。它正式接受 Phase 8A.2c 的真实证据：此前看似陈旧的 renderer 来自没有退出的旧 Electron 内存进程，而不是陈旧 source、tarball、staging 或 packaged renderer artifact。本文记录在 DS Harness branding、日用 `/Applications` 安装、startup branding 与空闲 Run Details 展示全部验证完成后的最终产品恢复点。

这是本地产品基线，不是公开发布。它不会修改 `/Applications/DSH Desktop.app`，不会改变 Phase 2–7 runtime policy，不会开始 Phase 8B，不会发布 release、push branch/tag，也不会加入 updater。

带注释的最终产品 tag 有意指向已经验证的实现 commit。本文是随后仅文档的 attestation commit，因为被跟踪的 manifest 无法诚实地记录承载自身的 commit SHA。

## 基线清单

| 字段 | 已验证值 |
| --- | --- |
| 最终产品基线 | `ds-harness-product-baseline-2026-09-17` → `bfba98b9bd9390735242ad57840050850a3c11b5` |
| 父实现 commit | `0e222bb4c25cef338457e0856ddf95bab125681e` |
| 保留的技术恢复基线 | `dsh-custom-baseline-2026-09-17` → `9d9762e7d2567248050559f2ac1b04e9f2a766f2` |
| 产品 / 安装路径 | `DS Harness` / `/Applications/DS Harness.app` |
| Bundle identifier / 版本 | `dev.dsh.desktop.custom` / `0.1.5-rc.2` |
| 目标 | macOS `darwin-arm64` |
| 构建环境 | Node `24.17.0`；pnpm `11.7.0` |
| Capability composition | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-desktop-custom-composition`（Phase 2–7） |
| Source state | detached、干净的最终产品 tag worktree；包内 `custom-build.json` 记录 `bfba98…` 和 `dirty: false` |
| Profile / Electron user data | `~/.dsh/profiles/desktop-custom` / `~/Library/Application Support/@deepseek-ai/dsh-desktop-custom` |
| 常规路由 | `local-qwen` → `http://127.0.0.1:8080/v1` → `Qwen3.8-27B IQ3_S (llama.cpp)` |
| 共享状态边界 | `~/.dsh/settings.yaml` 与 `~/.dsh/sessions` 按设计共享；不可同时在正式 Desktop 与 Custom Desktop 中操作同一会话 |

## Clean rebuild 与产物身份

最终 App 从 `ds-harness-product-baseline-2026-09-17` 的 detached、干净 worktree 重新构建，并使用 canonical Custom pipeline 安装：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64
```

安装前生成 App 的路径：

```text
/tmp/ds-harness-product-baseline-20260917/apps/desktop/.desktop-build/targets/mac-arm64/custom-artifacts/mac-arm64/DS Harness.app
```

最终安装与验证路径：

```text
/Applications/DS Harness.app
```

| Archive | 大小 | SHA-256 |
| --- | ---: | --- |
| `DS-Harness-product-baseline-2026-09-17.zip` | 220,018,914 bytes | `cbcca4c60cf8b4c963f0292d3daed6312e1774d5d3f5f55a3861952334ae2df9` |

archive 使用 `ditto -c -k --sequesterRsrc --keepParent` 创建、计算 hash 后删除。该 hash 只标识这一次已验证 build。tag 的重建在功能和结构上可复现，但不承诺 byte-for-byte 一致：build-root 参与 CSS module class hash、build timestamp、Electron/macOS packaging metadata 和 ad-hoc signing 都可能改变 bytes。

`RunStatusDock.tsx` source hash 保持为 `570b8d700d4cf45c51243143d1348ee439062671bdb034b11081bef3e63b3505`。最终 clean build 的 `@deepseek-ai/dsh-client-ui-run-details/lib/client.js` 在 workspace、tarball、Desktop staging 与 installed App 中均为 `d19c70051887cf739727f255f24241cb884f2dcf120334768f3aa8239f3c0760`，并包含 `snapshot?.run === null` guard。上一轮 `4e58…` generated hash 的不同仅来自另一 build root 产生的 CSS module hash；source 和行为实现没有变化。

## 验证证据

- 从 final-tag worktree 运行完整 scoped Phase 2–7/desktop/custom-composition regression：**55 个测试文件；598 passed；1 skipped；0 failed**。
- 使用新安装 App 的 packaged Node 与 `Resources/dsh` 执行 runtime smoke：Node `24.17.0` / macOS arm64 上的 `fs-ext`、`koffi`、`sharp`、HTML/runtime 与 `node-pty` 全部通过。
- `codesign --verify --deep --strict '/Applications/DS Harness.app'` 通过；installed App 为 identifier `dev.dsh.desktop.custom`、signature `adhoc`、`TeamIdentifier=not set`。
- 两轮从 `/Applications/DS Harness.app` 独立启动均先在 `dsh-app://shell/startup.html` 显示 `正在启动 DS Harness…`，随后进入 `dsh-app://app/index.html`。两轮均未显示 `DeepSeek Harness`；window title 与 application menu 均为 `DS Harness`。
- 两轮空闲启动中，`run = null` 都没有 standalone Run Details dock、`查看运行详情`、`未知`/`Unknown` row 或预留 layout gap；正常 selector 区域自然衔接 prompt composer。
- 现有测试保留单独的 active-Run 规则：active Run 在 backend observation unavailable 时仍为 `Unknown`；没有任何诊断事实被改写成 Idle、Ready、Healthy 或 Normal。
- 每轮均使用 `/Applications/DS Harness.app/Contents/Resources/` 内的 packaged Node Host、Custom profile、`local-qwen` 与端口 `8080`；未观察到 `local-qwen-dev` 或端口 `8081`。
- 每次退出后均明确检查 main process、Renderer、GPU/Network Helper、packaged Desktop Host 与 `desktop-custom`；两轮均为 none。没有发送 prompt，因此没有进行模型 inference。

## Phase 8A.2c 学到的验证流程

替换本地 Electron development app 时，进程退出检查是 artifact verification 的一部分：

1. quit DS Harness；
2. 确认没有残留 Custom main process、Renderer、GPU/Network Helper、Desktop Host 或 `desktop-custom` process；
3. install/replace 已验证 artifact；
4. 从 `/Applications` 启动；
5. 验证新加载的 UI 与 runtime。

这是一项 verification procedure，不是 product-runtime fix。此前看似 renderer 不一致，是因为验证了未退出的旧 live Renderer，而不是 stale `lib`、tarball、staging、Electron package 或 build-order defect。因此不需要修改 packaging pipeline。

## 两类基线与回滚

### Technical Recovery Baseline

`dsh-custom-baseline-2026-09-17` 继续固定在 `9d9762e7d2567248050559f2ac1b04e9f2a766f2`。它是 Phase 2–7 加早期 Custom packaging 的技术恢复点。不得移动、删除、retag 或 force-update。

### Final Product Baseline

`ds-harness-product-baseline-2026-09-17` 解析到 `bfba98b9bd9390735242ad57840050850a3c11b5`。它是完成产品 identity、`/Applications` 安装、startup branding、idle diagnostics closure 与最终产品验证后的日用 DS Harness 恢复点。

恢复最终日用产品：

```sh
git checkout ds-harness-product-baseline-2026-09-17
pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64
```

恢复旧技术基线：

```sh
git checkout dsh-custom-baseline-2026-09-17
pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64
```

两种回滚都不会移动任何 tag，并且都必须先退出 DS Harness、确认没有 Custom 残留进程。

## 数据与正式 Desktop 边界

Custom 状态目录存在且保持稳定：

- `~/Library/Application Support/@deepseek-ai/dsh-desktop-custom`；
- `~/.dsh/profiles/desktop-custom`；
- `~/.dsh/settings.yaml`；
- `~/.dsh/sessions`（按设计共享）。

没有创建意外的 `~/Library/Application Support/DS Harness` 或 `~/.dsh/profiles/ds-harness`。正式 App 仍是 `/Applications/DSH Desktop.app`、display name `DSH Desktop`、bundle identifier `dev.dsh.desktop`；本次验证没有使用、重建、重签名、改名、替换或修改它及其 `~/.dsh/profiles/desktop`。

## 已知限制与后续边界

- 仍为 ad-hoc signing；没有 Developer ID signing、notarization、updater、release upload 或 distribution channel；
- settings/sessions 按设计共享，因此正式与 Custom Desktop 不可并发操作同一会话；
- 日用 GGUF 路径没有结构化 backend progress attribution，active Run observation 可以合法地保持 `Unknown`，不会伪造；
- baseline packaging verification 不发送 inference request。

Phase 8A.3 在本地 baseline freeze 后停止。Phase 8B 的 upstream tracking、watcher、compatibility analysis、automatic fetch、rebase 与 update 行为继续明确不在范围内。
