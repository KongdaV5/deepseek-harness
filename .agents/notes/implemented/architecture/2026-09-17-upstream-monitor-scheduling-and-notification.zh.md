# Agent Note: 用户级 upstream monitoring 只通知新的 material evidence

Status: implemented

[English](2026-09-17-upstream-monitor-scheduling-and-notification.md) | 中文

## Problem

增量 monitor 能正确记录 upstream evidence，但每天手动运行并不可靠，每日成功提示又会成为噪音。已确认的 B8.1 product-to-upstream compatibility debt 是 `CRITICAL` 且 `UNRESOLVED`；反复用 Notification Center 提醒它不会产生新信息。Scheduler 必须在 user domain 中运行、适应 non-interactive launchd environment、区分新增 material evidence 与历史 debt，并且在 notification delivery failure 时保持 monitor correctness。

## Decision

Phase 8B.3 新增 [`scripts/upstream-schedule.ts`](../../../../scripts/upstream-schedule.ts) 和五个明确命令：

```sh
pnpm upstream:schedule:install
pnpm upstream:schedule:status
pnpm upstream:schedule:run
pnpm upstream:schedule:uninstall
pnpm upstream:schedule:test-notification
```

安装会在 `~/Library/LaunchAgents/dev.dsh.upstream-monitor.plist` 创建所属的 user LaunchAgent `dev.dsh.upstream-monitor`。它通过 `StartCalendarInterval` 在 macOS local time 的 09:00 执行，没有 `RunAtLoad`、没有 keep-awake 行为，也不使用 root、daemon、cron 或第三方 scheduler。plist 保存 label、project identity、repository path、entrypoint、installed-at timestamp、schedule 与 notification threshold，作为 provenance。Install 会拒绝“同 label 已 loaded 但没有 owned plist”的情况；update/uninstall 先验证 owned label、project marker 与 repository path。

plist 直接调用 install-time resolved maintenance Node executable 和 repository 的 `tsx/cli` entrypoint，不依赖 shell PATH、`pnpm`、Corepack、Homebrew shell startup files 或 `/Applications/DS Harness.app`。Install 会先 probe 这组精确的 Node + tsx + scheduler，再 bootstrap，并用 `plutil` 验证 plist。`status` 展示 ownership、loaded state、local schedule、repository availability、logs 与 scheduler state。`run` 使用 `launchctl kickstart` 并等待 wrapper 的 completed state record，因此验证走的是真实 LaunchAgent path，而非绕过路径。

Wrapper import 现有 monitor，不重复实现 Git/audit business logic。它在 `.artifacts/upstream-monitor/scheduler-state.json` 原子写入 scheduler state，并在 `.artifacts/upstream-monitor/logs/scheduler.log` 与 `scheduler.err.log` 写入有界 JSON-lines logs。每个 log 到 256 KiB 会 rotate，只保留 current 与一个 `.1` predecessor。

## Notification policy

默认 material threshold 是 `MEDIUM`，只可通过 scheduler CLI/plist argument 调整；不会增加 product UI preference。Notification Center 使用内建 `/usr/bin/osascript` 调用，不增加第三方 notification dependency。

| Monitor result | Notification behavior |
| --- | --- |
| `NO_NEW_UPSTREAM_CHANGES`、`NONE`、`LOW`、`LOCKED` | 静默 |
| New `MEDIUM`、`HIGH`、`CRITICAL` incremental range | 通知 |
| Existing historical debt alone | 静默 |
| `UPSTREAM_HISTORY_DIVERGENCE`、`STATE_INVALID`、`CHECKOUT_MUTATED`、missing remote/ref | 立即通知 |
| 第一次 `FETCH_FAILED` | 仅记录 |
| 连续第二次 `FETCH_FAILED` | 通知一次；之后继续失败保持安静，直到恢复 |

Material event identity 为 `targetSha + incremental risk + impact`；notification state 保存有界的 notified key history。同一 target 从 MEDIUM 重新分类成 HIGH 具有不同 key，可再次通知一次。既有 B8.1 debt 可以作为 new material notification 的简短 secondary context，但不能触发通知。

Notification delivery 只会在 monitor 完成且 scheduler state persist 后发生。Delivery failure 不会改动 monitor cursor，会将 event 保存为 pending、写入 `lastNotificationError`、返回 scheduler exit code `4`，并在以后 scheduled run retry delivery，而不会重新审计旧 range。Monitor/integrity failure 返回 `2`；正常 no-change/new-change 返回 `0`；active monitor lock 返回 `3` 且不通知。

`test-notification` 发送明确的 “Notification test successful.”，不运行 monitor，也不写 monitor/scheduler state；它与 material-change notification 有意区分。

## Safety boundary

Scheduler 属于 repository maintenance plane。它 fetch 并调用现有 read-only monitor，但绝不 merge、rebase、cherry-pick、reset、push、adapt upstream、build/package DS Harness、install/replace App、改变 baseline tag、读取 `~/.dsh`、profiles、settings、Sessions、Application Support 或调用任何 cloud/local model。Uninstall 只删除经验证的 owned LaunchAgent plist；不会删除 monitor state、reports、compatibility debt、source、tags 或 product data。

已完成的 B8.2 monitor 仍是 cursor movement 的唯一 authority。Scheduler 不能在该 transaction 外推进 cursor；其自身 state 与 product baseline 和 compatibility debt 分离。

## Verification

[`scripts/upstream-schedule.spec.ts`](../../../../scripts/upstream-schedule.spec.ts) 使用 injected monitor/notifier/launchctl dependencies 与 temporary output home。它覆盖 no-change/NONE/LOW/lock/debt 的静默、MEDIUM/HIGH/CRITICAL delivery、same-target escalation、deduplication、fetch-failure debounce/reset、immediate integrity notification、pending delivery failure 与 cursor preservation、plist rendering、idempotent install 和 ownership-guarded uninstall。

真实 user LaunchAgent 已安装、`plutil`-validated、bootstrapped，并通过 `launchctl kickstart` 验证。真实 scheduled path 连续两次返回 `NO_NEW_UPSTREAM_CHANGES`、exit 0，只更新 scheduler metadata/logs，没有发送 material notification。独立的 built-in Notification Center test 已成功 delivery，且不修改 monitor 或 scheduler state。

## Alternatives considered

- **直接把大型 shell pipeline 写入 plist。** 放弃，因为 launchd PATH 与 shell behavior 不稳定，policy 还会重复 monitor logic。TypeScript wrapper 提供可验证、可检查的 contract。
- **使用 installed DS Harness runtime。** 放弃，因为 product runtime 与 repository-maintenance runtime 应拥有独立 lifecycle 和 upgrade boundary。
- **通知每次成功检查或重复 existing debt。** 放弃，因为 routine no-change check 和 known debt 不是 material event；这样会让用户忽略通知。
- **通知每次 fetch failure。** 放弃，因为 transient network failure 很常见。第二次连续失败才是首个 actionable signal；恢复时静默 reset count。
- **notification failure 时 rollback monitor state。** 放弃，因为 notification 是 downstream presentation。回滚成功 observation 会导致重复 audit，并可能错误表示 cursor。
- **安装 system daemon 或 cloud/webhook service。** 放弃，因为本任务要求 local、user-authorized、private macOS maintenance。

## Consequences

- Mac 在运行且用户登录时会每天本地 09:00 检查 upstream；normal check 保持安静。
- 新 material upstream evidence 会简短、deduplicated，并关联 retained local report/state，而不是重复历史 blocker。
- Scheduler 可被移除而不影响 DS Harness product/runtime data；但 repository 被移动或不可用时需要明确 reinstall，不做 automatic path discovery。
- Notification Center delivery 只确认 presentation command 成功；notification 与 monitor automation 都不能证明 upstream runtime compatibility。既有 `BLOCKING_CHANGE` debt 仍 unresolved，Phase 8C 的 isolated adaptation/build/test 仍是独立工作。
