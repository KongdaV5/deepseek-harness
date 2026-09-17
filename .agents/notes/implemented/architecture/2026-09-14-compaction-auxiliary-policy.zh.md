# Agent Note: Compaction auxiliary request policy

Status: implemented

[English](2026-09-14-compaction-auxiliary-policy.md) | 中文

## 问题

`dsh-compaction-basic` 通过直接 `ctx.llm.stream()` 而不是普通 `agent/request` waterfall 发送摘要。因此，它不能把缺失的 reasoning 字段宣称为继承主 Run 的 xhigh 选择。在外置 policy 中复制其 replay-aware summarizer 会分叉 cache、token、lock 和 atomic replacement 行为。

## 决策

`dsh-compaction-basic` 暴露两个可选、backend-neutral waterfall。`compaction/request-policy` 接收完整 auxiliary request，可设置适配器支持的 reasoning 值，或在固定最终 instruction 前立即插入 runtime facts。它拒绝更改 provider、model、cap、tool、replayed message、Session、purpose 或 cancellation。`compaction/summary-validation` 在 token-shrink validation 后、durable apply 前接收 text-only candidate。它接受或请求另一份 candidate，受默认值为零的 `maxSummaryValidationRetries` 限制，零保持原来的单次调用行为。

`dsh-reasoning-policy` 是外置 IQ3_S consumer。其 xhigh-first 主策略把不支持的 `high` normalization 为 `xhigh`。其 opt-in compaction policy 把第一个 candidate normalization 为 `low`，注入紧凑 TaskCheckpoint 和 Result Manifest facts，并验证 objective、constraint、current/pending work、output、reference 与 blocker。一次 validation failure 请求 `medium`；后续失败关闭 compaction bracket 而不替换 surface。它不为 compaction 请求 xhigh，不修改 TaskCheckpoint 或 Result Manifest，不改变 user override，也不改变主 request segment。

可选 auto trigger 读取现有 Context Pressure facts。只有关闭 Basic 自己的 automatic trigger 后，它才在 `compact` 和 `critical` 时委托现有 executor。Fatal/cancelled/tool-wait Run、benchmark-original-context lock、blocked Task 与 `TOOL_OUTCOME_UNKNOWN` 都拒绝 compaction。只有成功 compaction 后重新定价低于 critical，critical pressure 才继续；否则 fail closed。外置 diagnostics API 只保存 transient request、validation、eligibility 与 fact-injection 数据。

## 考虑过的替代方案

- **在 policy plugin 中复制 BasicCompactionEngine。** 不采用，因为它会复制 summarization，并最终与 token meter、pruner、durable bracket 和 atomic apply 实现分叉。
- **通过 `agent/request` 路由 compaction。** 不采用，因为它会把 auxiliary request 与普通 Run request 混淆，并把其 facts 暴露给无关 request policy。
- **把 launcher xhigh 当作 compaction policy。** 不采用，因为 server default 不是 request-level evidence，且不同 backend 会不同。
- **把每个失败 candidate 升级到 xhigh。** 不采用，因为 compaction 是辅助工作，validation failure 必须保留 context，而不是发起无上界的昂贵请求。

## 验证

Focused test 证明无 policy 时请求字段保持缺失，Loader-composed IQ3_S policy 向 adapter 发送 low，主请求保持 xhigh。Task fixture 证明 low-to-medium semantic retry、最终 fail-closed surface preservation 与 `TOOL_OUTCOME_UNKNOWN` refusal。现有 compaction test 保留 token-shrink、durable transaction、cancellation、pruner 和 overflow coverage。

## 后果

Basic seam 可由另一个 backend 或 policy 复用，不命名 IQ3_S、GGUF 或 llama.cpp。启用 semantic retry 的 deployment 显式配置 `maxSummaryValidationRetries`，并在外置 auto trigger 拥有 pressure admission 时关闭 Basic auto triggering。新的 compaction facts 保持外置且仅限当前进程；durable task truth 继续保存在 Session projection。
