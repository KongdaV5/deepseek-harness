# Agent Note：Profile 边界与隐藏 Benchmark 条件

状态：已实现

[English](2026-09-14-profile-benchmark-visibility.md) | 中文

## 问题

日常 agent preset 与可复现 Benchmark 原先共用同一交互名单。若把 preset 名称当成 reasoning 档位，就会在 Profile 组装里复制 task policy，使日常会话不可预测地降档；误选 Benchmark 也会改变被测条件。preset 服务没有 session-overlay primitive，因此只靠 overlay 的 Benchmark 会要求新增 Host capability。

## 决策

`dsh-agent-presets` 接受可选 `visibility: hidden` metadata。隐藏 preset 在内部仍可发现并按精确 id 解析，但 `remoteExportList()` 会把它排除在交互名单外。因此它只能经显式的空会话入口选择。这只是展示和运维安全边界，不是 authorization，也绝不改变 preset 的 composition。

本地 `benchmark` preset 标记为 hidden。它既有的受限 tool exposure 仍是其 capability condition 的来源。deployment 挂载外置 `dsh-reasoning-policy` 时提供显式 `benchmarkPresets` 声明。匹配的 composed preset id 会锁定声明的 provider、model、reasoning 值与 raw-context preservation。route mismatch 和不支持的 benchmark reasoning 都会在 provider I/O 前 fail closed。该 lock 优先于普通 user reasoning override，使 Benchmark condition 不会漂移。只有在该精确声明要求保留原始 model-visible context 时，automatic compaction 才会拒绝。

日常 preset 仍是 composition choice，而非 reasoning policy。`lite-general` 是带通用 skill scope 的日常 default candidate；`lite-amazon` 为 Amazon 工作收窄 skill discovery；真实存在的 `code` preset 可暴露面向代码的 capability。它们的名称都不意味着 medium、low 或 xhigh。既有 xhigh-first classifier 会把复杂、未知、Coding 和 Amazon 工作保留在 xhigh，把明确机械操作用 low，只把明确简单的辅助分析用 medium。

## 考虑过的替代方案

- **新的 session overlay system。** 本阶段不采用，因为当前 preset selection 与 composition 在 blank-session creation 时固定，新增 overlay lifecycle 会扩大 core surface area。
- **永久可见的 Benchmark Profile。** 不采用，因为日常选择会静默改变 benchmark condition。
- **从字符串 `benchmark` 推断 lock。** 不采用，因为名称既不是 capability contract，也不是固定 provider/model route。
- **把每个 Profile 映射为 reasoning effort。** 不采用，因为 tool scope 与 task difficulty 独立；这会损害 xhigh-first work 和 prompt-cache stability。

## 验证

Metadata test 证明 `hidden` 可 round-trip，未知值保持 visible。Remote-roster test 证明 hidden preset 不出现在 interactive export 中，而 exact resolution 仍可用。Policy test 证明显式 hidden Benchmark 覆盖普通 user request、在 adapter I/O 前拒绝 fixed-route mismatch，并保持 `lite-general`、`lite-amazon` 与 `code` task-driven：复杂工作为 xhigh，明确机械工作为 low。

## 后果

实现没有修改 Agent Loop、LLM、Session、Desktop、launcher、retry、recovery、reasoning-budget 或 Profile-composition core。旧 runtime 会忽略 hidden metadata，因而仍安全，但在使用匹配 runtime build 或兼容 plugin backport 前仍会显示该 preset。既有 Phase 2–5 capability 继续是共享的外置 package，不复制到每个 Profile。官方 Desktop 要呈现这些 source change，仍需由匹配 runtime 挂载 source/test composition。
