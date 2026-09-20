# Agent Note: The upstream scheduler stores stable maintenance runtime entrypoints

Status: implemented

[English](2026-09-17-upstream-scheduler-maintenance-runtime-resilience.md) | 中文

## Problem

User LaunchAgent 正确地分离了 repository maintenance 与已安装的 DS Harness 应用，但它的 Node 与 tsx `ProgramArguments` 不能通过版本相关的实现路径解析。一次 `node@24` 常规更新后的 Homebrew cleanup 可能移除被引用的 Cellar 版本，而一次 pnpm dependency refresh 可能替换 `.pnpm/tsx@version` 内部目录。为这两类普通维护事件都要求手工重装 scheduler，就违背了无人值守 upstream observation 的初衷。

Launchd 无法依赖交互式 PATH、Corepack、pnpm 或 `/usr/bin/env node`。替代方案必须保持显式、校验预期的 Node major 与 architecture、完全位于 application runtime 之外，并保持 monitor、notification、cursor、debt、report 与 scheduler state 的语义不变。

## Decision

[`scripts/upstream-schedule.ts`](../../../../scripts/upstream-schedule.ts) 在 install 与 status 时通过 `brew --prefix node@24` 发现 maintenance Node，然后把词法上的稳定 executable 路径 `<prefix>/bin/node` 存入 plist。Homebrew 拥有该 `opt` symlink，并在 formula 更新时把它移动到选定的 Cellar release；scheduler 刻意在渲染 plist 前不调用 `realpath()`，因此绝不持久化 Cellar release 目录。

Repo-local tsx entrypoint 同样存储为 `<repository>/node_modules/tsx/dist/cli.mjs`，而不是 `node_modules/.pnpm/tsx@<version>/…`。pnpm 目前把 `node_modules/tsx` 作为其常规 package link 提供，使它在一次完成的 `pnpm install` 后成为稳定的 repository-facing dependency path。Scheduler 不复制也不遮蔽 tsx。

Installation 与 status 在不解析 symlink 的情况下校验存储的 invocation：Node 与 tsx 路径必须存在；Node 必须可执行；`node --version` 必须是 major 24；`process.arch` 必须是 `arm64`；且确切的 Node 加 tsx 加 scheduler source 必须完成 safe runtime probe。Cellar Node 路径、pnpm-internal tsx 路径、缺失路径、非 24 的 Node、非 arm64 的 process、失败的 probe、不可用的稳定 Homebrew prefix 或缺失的 repository entrypoint，都会导致可见失败，而不是静默 fallback。

已加载的 LaunchAgent 仍为 `dev.dsh.upstream-monitor`，每天本地 09:00 调度。重装只替换并 reload 其 owned plist，绝不删除 `.artifacts/upstream-monitor/state.json`、scheduler notification state、reports、debt 或 tags。`status` 报告校验后的 maintenance Node 路径、tsx 路径、Node 版本、architecture 以及任何 runtime validation error。

## Upgrade simulation and verification

Scheduler 测试模拟稳定的 `node@24/bin/node` 与 `node_modules/tsx/dist/cli.mjs` symlink，先指向 Cellar `24.21.0` 与 pnpm `tsx@4.22.4`，再重定向到 `24.22.0` 与 `tsx@4.23.0`。Plist 文本保持不变，并继续命名稳定 link。测试还拒绝 version-pinned Cellar 路径、pnpm-internal tsx 路径、缺失的稳定 runtime 与 Node 25。

## Stage 12 port delta

Scheduler 移植到当前 upstream adaptation 时，稳定 runtime 设计被原样保留：同样的 `brew --prefix node@24` 发现、同样的词法稳定路径、同样的 Node 24 与 arm64 校验、同样的对 pnpm-internal 或 version-pinned 路径的拒绝。Stage 12 移植不在真实主机上安装任何东西；resilience contract 只在临时目录中通过模拟 runtime link 被检验，因此不触碰任何主机 LaunchAgent、plist 或 monitor state。

## Alternatives considered

- **在 `realpath()` 之后持久化 Cellar executable。** 放弃，因为 identity 校验会把稳定的 Homebrew entrypoint 变成过时的 release 路径。Scheduler 通过执行来校验目标，同时保留词法稳定路径。
- **在 plist 中使用 `node` 或 `/usr/bin/env node`。** 放弃，因为 launchd 不会继承可靠的交互式 PATH。
- **每次计划调用都运行 `brew --prefix`。** 放弃，因为 runtime 执行应当 deterministic 且不依赖可用的 Homebrew 命令。发现只在 install 与 status 时发生。
- **使用 DS Harness bundled Node。** 放弃，因为 application runtime 必须与 repository maintenance 保持独立，且可能被删除、回滚或替换。
- **把私有 Node 或 tsx runtime 复制进 scheduler artifacts。** 放弃，因为这会引入不受管理的 shadow runtime。标准 Homebrew 与 pnpm 维护已经拥有这些依赖。
- **接受任意未来的 Node major。** 放弃，因为 maintenance compatibility 是显式的 Node 24 contract；Node 25 迁移必须被 review，而不是静默采纳。

## Consequences

- 当稳定 link 仍然有效时，常规 Homebrew patch 与 minor upgrade 以及常规 pnpm tsx dependency upgrade 都不需要重写 plist。
- 断裂的 opt link、被移除的 node formula、被移动的 repository、缺失的 tsx dependency、不兼容的 Node major 或 architecture mismatch，会在 install 或 status 中可见地停止，而不是静默选择另一个 executable。
- Repository 本身不可用时 scheduler 仍然无法运行，它也不会自动发现被移动的 repository；显式重装仍是安全恢复动作。
- 这一 resilience 设计既不证明 upstream compatibility，也不改变 observation 与 notification policy。既有 `BLOCKING_CHANGE` debt 仍未解决，isolated adaptation、build 与 test 仍是独立工作。
