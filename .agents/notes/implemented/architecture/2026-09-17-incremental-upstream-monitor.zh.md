# Agent Note: 增量 upstream monitor 将产品债务与新增变化分离

Status: implemented

[English](2026-09-17-incremental-upstream-monitor.md) | 中文

## Problem

只读 auditor 能记录显式 upstream range 的 compatibility impact，但若每天都从 Final Product baseline 审计，就会重复扫描同一段历史 upstream divergence，并让新增 evidence 淹没在重复 report 中。Monitor 必须观察新增 upstream commits，同时不能移动已验证的 DS Harness product baseline，更不能把一次低风险新增变化误解为既有 product-to-upstream blocker 已消失。

Monitor 还需要 scheduler-safe 的 failure semantics。fetch 失败、state 损坏、upstream history 被改写、运行重叠或写入中断，都不能悄悄丢失未审阅 commit range。它必须位于 product runtime 和 user state 之外，且不能使用 LLM 或替产品作适配决定。

## Decision

Phase 8B.2 新增 `pnpm upstream:monitor`，由 [`scripts/upstream-monitor.ts`](../../../../scripts/upstream-monitor.ts) 实现，并围绕 Phase 8B.1 的 [`scripts/upstream-audit.ts`](../../../../scripts/upstream-audit.ts) deterministic core 运行。只有 monitor 层可以执行 `origin --prune` fetch；auditor 继续保持 no-fetch classifier。

Monitor 将独立 lifecycle state 写入 `.artifacts/upstream-monitor/state.json`。固定 initial cursor 为 B8.1 已观察的 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`；初始化会验证 B8.1 `last-audit.json` identity 和本地可解析 commit，而不会再次从 Final Product baseline 审计。Final Product tag 仍为 `ds-harness-product-baseline-2026-09-17`，SHA 为 `bfba98b9bd9390735242ad57840050850a3c11b5`。

State 保存三个彼此独立的事实：

| 事实 | 含义 | Phase 8B.2 权限 |
| --- | --- | --- |
| Product baseline | 已验证的 DS Harness source product | 固定；monitor 永不推进 |
| Monitoring cursor | 最近一次成功观察到的 upstream commit | 仅在 fetch、ref validation、audit、report、atomic state persistence 全部完成后推进 |
| Existing compatibility debt | B8.1 的 product-to-upstream finding | `CRITICAL` / `BLOCKING_CHANGE` / `MANUAL_ADAPTATION_REQUIRED` / `UNRESOLVED`；本阶段永不降低 |

State schema 记录版本、product tag/SHA、remote/branch、last observed upstream SHA、successful/fetch/new-change timestamps、不可变的 unresolved debt、last incremental result、report locations 与 failure state。Atomic replacement 使用现有 [`@deepseek-ai/dsh-atomic-write`](../../../../packages/util/atomic-write/src/index.ts) helper。`monitor.lock` 负责串行化 writer；超过 30 分钟的 lock 会被回收，fresh lock 则返回 `LOCKED`，不会 fetch 或改变 state。

正常算法为：acquire lock；snapshot checkout identity；fetch；验证 HEAD、index、worktree status 与两个受保护 baseline tags 均未改变；解析 `origin/master`；与 cursor 比较；验证 ancestry；只审计 `cursor..target`；写 report；最后 atomic persist 已推进的 cursor。target 等于 cursor 时记录 `NO_NEW_UPSTREAM_CHANGES`，不生成新 report。target 不再以 cursor 为 ancestor 时返回 `UPSTREAM_HISTORY_DIVERGENCE`，生成保留的 failure report，并保持 cursor，等待人工 review。

`--remote`、`--branch`、`--dry-run`、`--no-fetch`、`--output-dir` 与 `--state` 使 CLI 可被未来 scheduler 调用。`--dry-run` 不写 lock、report 或 state；本阶段不安装 scheduler、notification、launchd job 或后台服务。完成观察（包括 HIGH/CRITICAL incremental finding）返回 exit code 0；lock contention 使用 3；state、fetch、audit、ref、ancestry 或 persistence failure 使用 2。

## Reports and safety boundary

Machine-readable state 和每个 report 同时表示 incremental finding 与 unresolved historical debt。Monitor 不会将它们压缩为误导性的 “safe” flag。NONE/LOW change 会覆盖有界的 `latest-compact` Markdown/JSON pair。MEDIUM、HIGH、CRITICAL、failure 与 divergence report 会在 `.artifacts/upstream-monitor/reports/` 下保存按 range 区分的文件；monitor 不会自动删除重要 evidence。No-change check 不生成 report。

Monitor 只 fetch remote-tracking refs。它绝不 pull、checkout、merge、rebase、reset、cherry-pick、push、build、package、install、launch，也不修改任一 installed application。它不读取 `~/.dsh`、profiles、settings、Sessions、Application Support 或 model configuration。除 B8.1 提供的 deterministic seam classification 外，它不会作 compatibility、migration 或 update judgment。

## Verification

[`scripts/upstream-monitor.spec.ts`](../../../../scripts/upstream-monitor.spec.ts) 只使用临时 local bare remote。它验证 initialization、no-change behavior、incremental documentation change、critical seam change、idempotent rerun、fetch/audit/state-write failure、cursor preservation、fresh/stale lock、force-push divergence、corrupt state preservation 与 dry-run/no-fetch behavior；也验证正常 monitor fetch 时 product HEAD 和 index 不变。B8.1 auditor test suite 继续作为 classification regression suite。

首次真实 invocation 只使用 `origin/master` 和 B8.1 anchor。它可观察 no new commit，或只审计 anchor 之后的 delta；不会把此前 666-commit historical range 当作 monitor work 再次扫描。

## Alternatives considered

- **每次都从 product baseline 运行 B8.1 audit。** 放弃，因为这会反复生成同一份大型 historical finding，并掩盖真正需要操作的 incremental range。
- **用 cursor 推进 product baseline。** 放弃，因为 observation 不是 adaptation、build、validation 或 approval。移动 baseline 会抹去已验证 product reference 的含义。
- **将 NONE/LOW increment 视为 compatibility resolution。** 放弃，因为 B8.1 product-to-upstream blocker 是独立 evidence；只有后续 adaptation process 明确建立新 product baseline 后，才可能解除。
- **将 fetch 放进 auditor。** 放弃，因为 deterministic classification 必须可离线复用，而 network/ref refresh 有独立的 failure 与 authority boundary。
- **立即使用 scheduled daemon 或 notification。** 放弃，因为 cadence、recipient 与 material-change policy 需要单独授权。本阶段只提供 scheduler-ready command。

## Consequences

- 日常 monitor 的成本受新增 upstream work 限制，而不是历史 divergence；高风险 evidence 会被保留。
- Failure 不会悄悄跳过 commits：persisted cursor 只在完整 observation transaction 成功后推进。
- Product baseline、upstream observation 和 unresolved compatibility debt 可被人和未来 scheduler 清晰区分。
- Monitor 保持 deterministic 并与 runtime/user data 隔离，但无法证明 runtime compatibility、safe replay、migration 成功、package closure 或 test success。这些均不属于 Phase 8B.2，需要未来显式工作。
