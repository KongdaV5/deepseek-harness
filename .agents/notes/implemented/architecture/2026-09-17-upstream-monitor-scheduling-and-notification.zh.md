# Agent Note: User-level upstream monitoring notifies only on new material evidence

Status: implemented

[English](2026-09-17-upstream-monitor-scheduling-and-notification.md) | 中文

## Problem

Incremental monitor 能正确记录 upstream evidence，但每日手工命令不可靠，而每日一条成功消息只会成为噪音。既有的 product-to-upstream compatibility debt 已经是 `CRITICAL` 与 `UNRESOLVED`；通过 Notification Center 重复它并不能传达新信息。Scheduler 必须在 user domain 运行、在非交互的 launchd 环境中存活、区分新的 material evidence 与 historical debt，并在 notification delivery 失败时保持 monitor 正确性。

## Decision

Maintenance plane 新增 [`scripts/upstream-schedule.ts`](../../../../scripts/upstream-schedule.ts) 与五个显式命令：

```sh
pnpm upstream:schedule:install
pnpm upstream:schedule:status
pnpm upstream:schedule:run
pnpm upstream:schedule:uninstall
pnpm upstream:schedule:test-notification
```

Installation 在 `~/Library/LaunchAgents/dev.dsh.upstream-monitor.plist` 创建其拥有的 user LaunchAgent `dev.dsh.upstream-monitor`。它使用 macOS 本地时间 09:00 的 `StartCalendarInterval`，没有 `RunAtLoad`，没有 keep-awake 行为，也没有 root、daemon、cron 或第三方 scheduler。Plist 为识别用途记录其 label、project identity、repository path、entrypoint、installed-at 时间戳、schedule 与 notification threshold。Install 会拒绝一个已加载但没有 owned plist 的同 label service；update 与 uninstall 先校验 owned label、project marker 与 repository path。

Plist 直接调用 install 时解析出的 maintenance Node executable 与 repository 的 `tsx/cli` entrypoint。它不依赖 shell PATH、`pnpm`、Corepack、Homebrew shell startup file 或 `/Applications/DS Harness.app`。Installation 在 bootstrap 前探测这一确切的 Node 加 tsx 加 scheduler 组合，并用 `plutil` 校验 plist。`status` 读取 ownership、loaded state、local schedule、repository availability、logs 与 scheduler state。`run` 使用 `launchctl kickstart` 并等待 wrapper 的 completed state record，因此验证走的是真实 LaunchAgent 路径，而非旁路。

Wrapper 复用既有 monitor，绝不重新实现其 Git 或 audit business logic。它在 `.artifacts/upstream-monitor/scheduler-state.json` 写入 atomic scheduler state，并在 `.artifacts/upstream-monitor/logs/scheduler.log` 与 `scheduler.err.log` 写入有界的 JSON-lines log。每个 log 在 256 KiB 时轮转，只保留当前文件与一个 `.1` 前身。

## Notification policy

默认 material threshold 是 `MEDIUM`，只能通过 scheduler CLI 或 plist 参数配置；不新增 product UI preference。Notification Center 通过内建 `/usr/bin/osascript` 调用，不依赖任何第三方 notification dependency。

| Monitor result | Notification behaviour |
| --- | --- |
| `NO_NEW_UPSTREAM_CHANGES`、`NONE`、`LOW`、`LOCKED` | Silent |
| 新的 `MEDIUM`、`HIGH`、`CRITICAL` incremental range | Notify |
| 仅既有 historical debt | Silent |
| `UPSTREAM_HISTORY_DIVERGENCE`、`STATE_INVALID`、`CHECKOUT_MUTATED`、missing remote 或 ref | 立即 Notify |
| 首次 `FETCH_FAILED` | 仅记录 |
| 连续第二次 `FETCH_FAILED` | Notify 一次；之后的重复保持安静直到恢复 |

Material event identity 为 `targetSha + incremental risk + impact`；notification state 保存有界的 notified keys 历史。同一 target 从 MEDIUM 重分类为 HIGH 会得到不同的 key，因此可能通知一次。既有 product-to-upstream debt 可以作为新 material notification 的简短 secondary context 出现，但不能触发通知。

Notification delivery 只在 monitor 完成与 scheduler state 持久化之后发生。Delivery 失败会保持 monitor cursor 不变、把 event 记为 pending、写入 `lastNotificationError`、返回 scheduler exit code `4`，并在之后的计划运行中重试 delivery，而不会重新 audit 旧 range。Monitor 与 integrity 失败返回 `2`；正常的 no-change 与 new-change 结果返回 `0`；活跃的 monitor lock 返回 `3` 且不通知。

`test-notification` 发送显式正文 "Notification test successful."，不运行 monitor，也不写 monitor 或 scheduler state。它刻意区别于 material-change notification。

## Safety boundary

Scheduler 属于 repository maintenance plane。它 fetch 并调用既有只读 monitor，但绝不 merge、rebase、cherry-pick、reset、push、adapt upstream、build 或 package DS Harness、install 或 replace app、改变任一 baseline tag、读取 `~/.dsh`、profiles、settings、Sessions、Application Support，也不调用任何 cloud 或 local model。Uninstall 只移除已验证 owned 的 LaunchAgent plist；它绝不删除 monitor state、reports、compatibility debt、source、tags 或 product data。

已完成的 monitor 仍是 cursor 移动的 authority。Scheduler 无法在该 transaction 之外推进 cursor。它自身的 state 独立于 product baseline 与 compatibility debt。

## Stage 12 port delta

Scheduler 从已完成的 maintenance plane 移植到当前 upstream adaptation，其 installation contract 保持不变。Owned LaunchAgent label、09:00 本地 schedule、`MEDIUM` 默认 threshold、256 KiB log rotation、notification matrix、exit-code contract 以及 ownership-guarded 的 install 与 uninstall 行为均被保留。

改变的只是通向移植后 monitor 的 seam 与 runtime resolution。Wrapper 像以前一样调用 Stage 12 monitor，installation 把五个已记录的 `pnpm` 命令指向移植后的脚本。对历史 audit anchor 的引用已移除，因此 scheduler 自身不携带任何 commit identifier；monitor 从 baseline tag 与 audited evidence 推导 bootstrap。

## Verification

[`scripts/upstream-schedule.spec.ts`](../../../../scripts/upstream-schedule.spec.ts) 使用注入的 monitor、notifier 与 launchctl 依赖以及临时 output home。它覆盖：no-change、NONE、LOW、lock 与 debt 的静默，MEDIUM、HIGH 与 CRITICAL 的 delivery，同 target escalation，deduplication，fetch-failure debounce 与 reset，immediate integrity notification，pending delivery failure 且保留 cursor，plist rendering，idempotent install，以及 ownership-guarded uninstall。

Suite 还额外验证渲染出的 plist 命名稳定 maintenance Node 与 tsx 路径以及已记录的 schedule、foreign-label service 被拒绝、uninstall 保留 state、reports 与 tags、runtime entrypoint 在模拟 maintenance upgrade 后依然可用，以及 version-pinned runtime 或非 24 的 Node 被拒绝。真实用户 LaunchAgent 不会在本阶段被安装、bootstrap 或修改。

## Alternatives considered

- **把大型 shell pipeline 直接放进 plist。** 放弃，因为 launchd PATH 与 shell 行为不稳定，且策略会重复 monitor logic。TypeScript wrapper 有经过验证、可检视的 contract。
- **使用已安装的 DS Harness runtime。** 放弃，因为 product runtime 与 repository-maintenance runtime 需要独立的 lifecycle 与 upgrade boundary。
- **每次成功检查都通知，或重复既有 debt。** 放弃，因为常规 no-change 检查与已知 debt 不是 material event；它们会让用户学会忽略通知。
- **每次 fetch 失败都通知。** 放弃，因为瞬时网络失败很常见。连续第二次失败才是首个可行动的 signal；恢复会静默重置计数。
- **在 notification 失败时回滚 monitor state。** 放弃，因为 notification 属于下游 presentation。回退一次成功观察会导致重复 audit，并可能错误表达 cursor。
- **安装 system daemon 或 cloud 或 webhook service。** 放弃，因为本任务只要求本地、用户授权、私密的 macOS maintenance。

## Consequences

- Mac 在运行且用户已登录时，每天本地时间 09:00 检查 upstream；正常检查保持静默。
- 新的 material upstream evidence 简洁、去重，并链接到保留的本地 report 与 state evidence，而不是重复的历史 blocker。
- Scheduler 可以被移除而不影响 DS Harness product 或 runtime data，但 repository 被移动或不可用时需要显式重装，而不是自动路径发现。
- Notification Center delivery 只确认 presentation command 成功；notification 与 monitor automation 都无法证明 upstream runtime compatibility。既有 `BLOCKING_CHANGE` debt 仍未解决，isolated adaptation、build 与 test 仍是独立工作。
