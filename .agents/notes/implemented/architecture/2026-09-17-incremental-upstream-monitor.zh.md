# Agent Note: Incremental upstream monitoring keeps product debt separate from new changes

Status: implemented

[English](2026-09-17-incremental-upstream-monitor.md) | 中文

## Problem

只读 auditor 会记录某个显式 upstream range 的 compatibility impact，但从 product baseline 出发反复进行每日 audit 会重扫同一段历史 upstream divergence，并把新 evidence 淹没在重复报告中。Monitor 必须观察新的 upstream commit，同时既不移动已验证的 DS Harness product baseline，也不把低风险的新变化误认为既有 product-to-upstream blocker 已经消失。

Monitor 还需要 scheduler-safe 的 failure semantics。一次失败的 fetch、损坏的 state、被重写的 upstream history、重叠运行或中断写入，都不能静默丢弃一段未 review 的 commit。它必须位于 product runtime 与 user state 之外，且不能使用模型，也不能做出任何 adaptation 决定。

## Decision

Maintenance plane 新增 `pnpm upstream:monitor`，由 [`scripts/upstream-monitor.ts`](../../../../scripts/upstream-monitor.ts) 实现，围绕 [`scripts/upstream-audit.ts`](../../../../scripts/upstream-audit.ts) 中的 deterministic core。Monitor 是唯一执行 `origin --prune` fetch 的层；auditor 保持为 no-fetch 的 classifier。

Monitor 将独立的 lifecycle state 持久化到 `.artifacts/upstream-monitor/state.json`。它的初始 cursor 不以 literal 形式写入：初始化通过 tag 解析 product baseline，并从 auditor evidence file `.artifacts/upstream-audit/last-audit.json` 读取此前 audited cursor 与 debt，要求记录的 base 与 baseline tag 一致，且记录的 result 为 `BLOCKING_CHANGE`。若该 evidence 缺失或不一致，monitor 会 fail closed，而不是凭空编造 cursor。

State 保存三个独立事实：

| Fact | Meaning | Authority |
| --- | --- | --- |
| Product baseline | 已验证的 DS Harness source product | 固定；绝不被 monitor 推进 |
| Monitoring cursor | 最近一次成功观察到的 upstream commit | 只有在 fetch、ref 校验、audit、report 与 atomic state 持久化全部成功后才会前进 |
| Existing compatibility debt | product-to-upstream finding | `CRITICAL` / `BLOCKING_CHANGE` / `MANUAL_ADAPTATION_REQUIRED` / `UNRESOLVED`；绝不在此降低 |

State schema 记录其版本、product tag 与 commit identity、remote 与 branch、最近观察到的 upstream commit、successful、fetch 与 new-change 时间戳、不可变的 unresolved debt、最近一次 incremental result、report 位置与 failure state。Atomic replacement 使用既有的 [`@deepseek-ai/dsh-atomic-write`](../../../../packages/util/atomic-write/src/index.ts) helper。`monitor.lock` 文件串行化 writer；超过三十分钟的 lock 会被回收，而新鲜的 lock 会返回 `LOCKED`，且不 fetch、不改变 state。

正常算法为：获取 lock；快照 checkout identity；fetch；验证 HEAD、index、worktree status 与两个 protected baseline tag 均未改变；解析 remote branch；与 cursor 比较；验证 ancestry；只 audit cursor-to-target range；写 report；并原子持久化前进后的 cursor。target 与 cursor 相等时记录 `NO_NEW_UPSTREAM_CHANGES`，不生成新 report。non-ancestor target 返回 `UPSTREAM_HISTORY_DIVERGENCE`，生成 retained failure report，并保留 cursor 供人工 review。

`--remote`、`--branch`、`--dry-run`、`--no-fetch`、`--output-dir`、`--state`、`--baseline-tag` 与 `--bootstrap-evidence` 使 CLI 可被未来的 scheduler 使用。`--dry-run` 不写 lock、report 或 state；该命令不安装任何 scheduler、notification、launchd job 或 background service。已完成的观察结果，包括 HIGH 或 CRITICAL 的 incremental finding，返回 exit code 0。Lock contention 使用 3；state、fetch、audit、ref、ancestry 或 persistence 失败使用 2。

## Reports and safety boundary

Machine-readable state 与每份 report 都同时陈述 incremental finding 与未解决的 historical debt。Monitor 不会把它们压缩成一个误导性的 "safe" flag。NONE 与 LOW change 会替换一对有界的 `latest-compact` Markdown 与 JSON。MEDIUM、HIGH、CRITICAL、failure 与 divergence report 会在 `.artifacts/upstream-monitor/reports/` 下获得不可变的 per-range 文件；monitor 绝不自动删除重要 evidence。No-change check 不生成 report。

Monitor 只 fetch remote-tracking refs。它绝不 pull、checkout、merge、rebase、reset、cherry-pick、push、build、package、install、launch 或修改任一已安装应用。它不读取 `~/.dsh`、profiles、settings、Sessions、Application Support 或 model configuration。除 auditor 提供的 deterministic seam classification 之外，它不做任何 compatibility、migration 或 update 判断。

## Stage 12 port delta

Monitor 从已完成的 maintenance plane 移植到当前 upstream adaptation。历史版本把固定的初始 cursor 作为 literal 内嵌，并从针对当时产品 surface 运行的 audit 初始化。

本次移植移除了所有内嵌 commit identifier。Bootstrap 现在从 product baseline tag 加 auditor evidence file 推导初始 cursor 与 debt，并在该 evidence 缺失或与 baseline 不一致时拒绝启动。State contract 其余部分被完整保留，因此既有 monitor state file 仍然无需 migration 即可读取，monitor 也绝不会报告 migration 要求。Cursor transaction、三个独立事实与 exit-code contract 均保持不变。

## Verification

[`scripts/upstream-monitor.spec.ts`](../../../../scripts/upstream-monitor.spec.ts) 只使用本地临时 bare remote 与临时 state home。它验证：初始化且无新变化、从 baseline tag 加 evidence 进行 bootstrap、evidence 缺失或不一致时 fail-closed、无需 migration 地读取既有历史 state file、幂等重跑、compact report 生成、full-range audit、CRITICAL change 生成 full report 且 debt 不变、fetch / audit / state-write 失败时保留 cursor、force-push divergence 保留 cursor、checkout mutation 检测、invalid state 配合 dry-run 且不 fetch、dry-run 不写任何内容、`--no-fetch` 下复用 ref、临时 root override，以及 fresh 与 stale lock 处理及 lock contention。它还检查正常 monitor fetch 期间 product HEAD 与 index 保持不变。Auditor suite 仍是 classification regression suite。

## Alternatives considered

- **每次都从 product baseline 运行 audit。** 放弃，因为这会反复产生同一段大型历史 finding，并掩盖真正有运营意义的 incremental range。
- **让 cursor 推进 product baseline。** 放弃，因为 observation 不等于 adaptation、build、validation 或 approval。移动它会抹掉已验证产品引用的意义。
- **把 NONE 或 LOW increment 当作 compatibility resolution。** 放弃，因为 product-to-upstream blocker 是独立 evidence，在后续 adaptation 流程显式建立新 product baseline 之前仍未解决。
- **把 fetch 放进 auditor。** 放弃，因为 deterministic classification 必须保持可离线复用，而 network 与 ref refresh 有独立的 failure 与 authority boundary。
- **把历史初始 cursor 作为 literal 留在源码中。** 放弃，因为内嵌 commit identifier 是无法验证的 maintenance debt，且可能与 baseline tag 不一致；tag 加 audited evidence 才是唯一 authority。

## Consequences

- 每日 monitoring 以新的 upstream 工作为界，而不是历史 divergence，同时可保留的 report 会保全更高风险的 evidence。
- 失败无法静默跳过 commit：持久化的 cursor 只有在整个成功观察事务完成后才会前进。
- Product baseline、upstream observation 与未解决的 compatibility debt 对人和未来 scheduler 都保持可读。
- Monitor 保持 deterministic 并与 runtime 及用户数据隔离，但它无法证明 runtime compatibility、safe replay、成功 migration、package closure 或 test success。这些仍在本阶段之外，需后续显式工作。
