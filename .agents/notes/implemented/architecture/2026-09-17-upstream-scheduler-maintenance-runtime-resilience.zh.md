# Agent Note: upstream scheduler 保存稳定的 maintenance runtime entrypoint

Status: implemented

[English](2026-09-17-upstream-scheduler-maintenance-runtime-resilience.md) | 中文

## Problem

最初的 user LaunchAgent 已正确分离 repository maintenance 与已安装的 DS Harness application，但它的 Node 与 tsx ProgramArguments 通过 version-specific implementation path 解析。正常 `node@24` update 后 Homebrew cleanup 可能删除被引用的 Cellar version；pnpm dependency refresh 也可能替换 `.pnpm/tsx@version` internal directory。若这两类普通维护事件都要求人工重新安装 scheduler，就违背了 unattended upstream observation 的目标。

Launchd 不能依赖 interactive PATH、Corepack、pnpm 或 `/usr/bin/env node`。替代方案必须保持 explicit、验证目标 Node major 与 architecture、完全位于 application runtime 之外，并且不改变 monitor、notification、cursor、debt、reports 或 scheduler state semantics。

## Decision

[`scripts/upstream-schedule.ts`](../../../../scripts/upstream-schedule.ts) 现在在 install/status 时通过 `brew --prefix node@24` 发现 maintenance Node，并在 plist 中保存 lexical stable executable path `<prefix>/bin/node`。本机上该路径为 `/opt/homebrew/opt/node@24/bin/node`。Homebrew 管理这个 `opt` symlink，并在 formula update 时把它移动到选定的 Cellar release；scheduler 刻意不会在渲染 plist 前调用 `realpath()`，因此不会持久化 Cellar release directory。

repo-local tsx entrypoint 同样保存为 `<repository>/node_modules/tsx/dist/cli.mjs`，而非 `node_modules/.pnpm/tsx@<version>/…`。pnpm 当前以 `node_modules/tsx` 作为正常 package link，因此在完成 `pnpm install` 后它是稳定的 repository-facing dependency path。Scheduler 不复制或 shadow tsx。

Install 与 status 会验证 stored invocation，但不展开 symlink：Node 与 tsx path 必须存在；Node 必须可执行；`node --version` 必须为 major 24；`process.arch` 必须为 `arm64`；精确的 Node + tsx + scheduler source 必须完成 safe runtime probe。Cellar Node path、pnpm-internal tsx path、absent path、non-24 Node、non-arm64 process、failed probe、unavailable stable Homebrew prefix 或 missing repository entrypoint 均会显式失败，不会 silent fallback。

已加载的 LaunchAgent 仍为 `dev.dsh.upstream-monitor`，每天 local 09:00 执行。Reinstallation 只替换/reload 经 provenance 验证的 plist，不会删除 `.artifacts/upstream-monitor/state.json`、scheduler notification state、reports、debt 或 tags。`status` 现在会报告已验证的 maintenance Node path、tsx path、Node version、architecture 与任何 runtime validation error。

## Upgrade simulation and verification

Scheduler test 模拟 stable `node@24/bin/node` 与 `node_modules/tsx/dist/cli.mjs` symlink：先指向 Cellar `24.21.0` 和 pnpm `tsx@4.22.4`，再切换为 `24.22.0` 和 `tsx@4.23.0`。plist text 保持不变，继续只命名 stable link。测试还拒绝 version-pinned Cellar path、pnpm-internal tsx path、missing stable runtime 与 Node 25。

真实机器上，`brew --prefix node@24` 返回 `/opt/homebrew/opt/node@24`；它是 Homebrew `opt` symlink，当前指向 `../Cellar/node@24/24.21.0`。它的 explicit stable executable 运行 `v24.21.0`、架构为 `arm64`。真实 LaunchAgent 已重新安装，并确认只包含 stable Node/tsx path；之后完成真实 `launchctl kickstart`，结果为 `NO_NEW_UPSTREAM_CHANGES`、exit 0、无 notification。

## Alternatives considered

- **在 `realpath()` 后持久化 Cellar executable。** 放弃，因为 identity validation 会把 stable Homebrew entrypoint 变成 stale release path。Scheduler 执行验证 target，同时保留 lexical stable path。
- **在 plist 中使用 `node` 或 `/usr/bin/env node`。** 放弃，因为 launchd 不会继承可靠的 interactive PATH。
- **每次 scheduled invocation 都执行 `brew --prefix`。** 放弃，因为 runtime execution 应是 deterministic，不能依赖可工作的 Homebrew command。Discovery 只发生在 install/status。
- **使用 DS Harness bundled Node。** 放弃，因为 application runtime 必须和 repository maintenance 独立，App 可能被删除、回滚或替换。
- **复制 private Node 或 tsx runtime 到 scheduler artifact。** 放弃，因为这会引入 unmanaged shadow runtime。标准 Homebrew 与 pnpm maintenance 已管理这些 dependency。
- **接受任意未来 Node major。** 放弃，因为 maintenance compatibility 是明确的 Node 24 contract；Node 25 transition 必须 review，而非 silent adopt。

## Consequences

- 在 stable link 保持有效时，正常 Homebrew patch/minor update 与正常 pnpm tsx dependency update 不要求 rewrite plist。
- 损坏 opt link、removed node formula、moved repository、absent tsx dependency、incompatible Node major 或 architecture mismatch 会在 install/status 中显式停止，而非 silent 选择其他 executable。
- Scheduler 仍无法在 repository 本身不可用时执行，也不自动发现 moved repository；explicit reinstall 仍是安全 recovery action。
- 此韧性修复既不证明 upstream compatibility，也不改变 Phase 8B observation/notification policy。existing `BLOCKING_CHANGE` debt 仍 unresolved；Phase 8C 仍独立。
