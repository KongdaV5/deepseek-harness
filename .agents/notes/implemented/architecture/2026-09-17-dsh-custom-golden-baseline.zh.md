# DSH Desktop Custom 黄金基线

状态：已实现并已验证

[English](2026-09-17-dsh-custom-golden-baseline.md) | 中文

## 目的与范围

本文冻结已经验证的 Phase 2–7 开发组合，形成可恢复、可在本地打包的 **DSH Desktop Custom** 基线。这是工程基线，不是生产发布，也不会更新正式 DSH Desktop 应用。Phase 8A.1 至此结束；它不启动 Phase 8B，不改变 retry/recovery/reasoning/compaction 策略，也不修改 `/Applications/DSH Desktop.app`。

冻结源码为带注释的 Git tag `dsh-custom-baseline-2026-09-17`，其解析结果是 commit `9d9762e7d2567248050559f2ac1b04e9f2a766f2`。该 tag 有意指向实现 commit；本文是后续仅文档的 commit，因为受 Git 的自引用限制，跟踪的 manifest 无法诚实地包含承载自身的 commit SHA。

## 基线清单

| 字段 | 已验证值 |
| --- | --- |
| 基线名称与日期 | DSH Desktop Custom 黄金基线，2026-09-17（Asia/Shanghai） |
| 冻结源码 | `dsh-custom-baseline-2026-09-17` → `9d9762e7d2567248050559f2ac1b04e9f2a766f2` |
| 源码干净性 | `custom-build.json` 记录冻结 commit 且 `dirty: false` |
| 产品 / bundle identifier | `DSH Desktop Custom` / `dev.dsh.desktop.custom` |
| DSH runtime / desktop 版本 | `0.1.5-rc.2` |
| 目标 | macOS `darwin-arm64` |
| 内置 Node / pnpm | Node `24.17.0`；pnpm `11.7.0` |
| Capability composition | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-desktop-custom-composition`（Phase 2–7） |
| Profile 与 user-data 隔离 | Host profile：`~/.dsh/profiles/desktop-custom`；Electron user data：`~/Library/Application Support/@deepseek-ai/dsh-desktop-custom` |
| 常规 provider / endpoint / model | `local-qwen`；`http://127.0.0.1:8080/v1`；`/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf` |
| Settings 与 sessions | Settings 仍为 `~/.dsh/settings.yaml`；sessions 按设计与普通 profile 共享。不要同时在正式 Desktop 与 Custom Desktop 中打开同一会话。 |
| 签名 | ad-hoc 签名（`codesign --verify --deep --strict` 已通过）；TeamIdentifier 未设置 |
| Notarization / updater | 无 notarization；无 updater；这是本地开发包 |

## 产物身份与可复现性

构建从干净、精确的基线 tag 进行：

```sh
corepack pnpm --filter @deepseek-ai/dsh-desktop run package:custom:mac:arm64:dir
```

打包应用按设计被 Git 忽略，位置为：

```text
apps/desktop/.desktop-build/targets/mac-arm64/custom-artifacts/mac-arm64/DSH Desktop Custom.app
```

本次验证的规范产物身份是从该 app 制作的 `ditto` archive 的 SHA-256：

```sh
ditto -c -k --sequesterRsrc --keepParent \
  'DSH Desktop Custom.app' \
  DSH-Desktop-Custom-0.1.5-rc.2-mac-arm64.zip
shasum -a 256 DSH-Desktop-Custom-0.1.5-rc.2-mac-arm64.zip
```

| Archive | 大小 | SHA-256 |
| --- | ---: | --- |
| `DSH-Desktop-Custom-0.1.5-rc.2-mac-arm64.zip` | 220,546,135 bytes | `4fd7b46c1baf05cf024162a81241e3b4c8bbfb55392176008cca43c57c86a9de` |

这个 hash 标识本次已验证的 build archive；它不承诺跨 rebuild 的字节完全一致。即使 source tag 与功能结果相同，build timestamp、Electron/macOS packaging metadata 和 ad-hoc signing 也会改变 app 与 archive 的 bytes。这里的可复现性指使用本文记录的 target 与 toolchain，对同一冻结源码重新构建并验证。

## 验证证据

- 干净 tag 的 package build 已完成，`custom-build.json` 记录 source commit `9d9762e…`、`dirty: false`、`darwin/arm64`、Node `24.17.0`、pnpm `11.7.0` 与 Phase 2–7 Custom composition。
- 使用 packaged Node 与 packaged DSH runtime 重跑 native payload smoke；在 Node `24.17.0` / macOS arm64 上，`fs-ext`、`koffi`、`sharp`、HTML conversion 与 `node-pty` 均通过。
- 指定的 Phase 2–7 regression command 通过：**55 个测试文件；593 通过；1 个既有跳过**。
- 实际 Custom `.app` 的 `codesign --verify --deep --strict` 通过，identifier 为 `dev.dsh.desktop.custom`。
- 两次实际启动 Custom App 均进入 `dsh-app://app/index.html`，且只有一个标准窗口。Host process 使用 packaged runtime 和 `~/.dsh/profiles/desktop-custom`；模型选择器显示 `Qwen3.8-27B IQ3_S (llama.cpp)`，空闲 run-details projection 按设计显示 `Unknown`。
- 第一次启动后进程已干净退出，才开始第二次启动；第二次也已干净退出。没有输入或发送任何 prompt，因此本验证没有模型 inference request。
- Packaged runtime 含 `@deepseek-ai/dsh-desktop-custom-composition`，且不含 `local-qwen-dev` 或端口 `8081`。

冒烟时 UI 显示的 `benchmark` 标签来自既有的共享 conversation state。Custom build 没有创建或改变 benchmark lock、preset 或 settings value；Benchmark 仍不在本基线范围内。

## 回滚与运行边界

要精确恢复已验证源码，checkout `dsh-custom-baseline-2026-09-17`，再执行上述 build 命令。正式 `/Applications/DSH Desktop.app` 既不是这个流程的输入也不是输出。Custom profile/user-data 隔离使 Custom Host 和 Electron process 不与正式 app 共享这些路径；共享 settings 与 sessions 是已经记录的例外。

已知限制保持明确：

- 仅本地开发：无 Developer ID signing、notarization、updater 或 distribution channel；
- packaging smoke test 不使用 inference；
- 空闲 GGUF backend observation 正确为 `Unknown`，不会伪造状态；
- sessions 为共享状态，因此不可同时用正式 Desktop 与 Custom Desktop 操作同一会话；
- 因上文 metadata/signing 原因，重新构建的 archive 可以具有不同 SHA-256。

## 升级兼容性

本基线保持 plugin-first：Custom package 通过 `@deepseek-ai/dsh-desktop-custom-composition` 携带其 Phase 2–7 capability set；匹配的 `0.1.5-rc.2` source 仅保留此前已接受的、满足 capability contracts 的窄 seam。未来升级官方 runtime 时，应从此 tag 开始，先重新审计这些 seam 与 runtime package-set contract，之后才可 rebuild；不能仅因 Custom application 能启动就假定二进制兼容。
