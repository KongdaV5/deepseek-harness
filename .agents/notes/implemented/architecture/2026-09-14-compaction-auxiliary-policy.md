# Agent Note: Compaction auxiliary request policy

Status: implemented

English | [中文](2026-09-14-compaction-auxiliary-policy.zh.md)

## Problem

`dsh-compaction-basic` sends its summary through direct `ctx.llm.stream()` rather than the normal `agent/request` waterfall. It therefore cannot claim that an omitted reasoning field inherits a main Run's xhigh selection. Duplicating its replay-aware summarizer in an external policy would fork its cache, token, lock, and atomic replacement behavior.

## Decision

`dsh-compaction-basic` exposes two optional, backend-neutral waterfalls. `compaction/request-policy` receives the complete auxiliary request and may set an adapter-supported reasoning value or insert runtime facts immediately before the fixed final instruction. It rejects any change to provider, model, cap, tools, replayed messages, Session, purpose, or cancellation. `compaction/summary-validation` receives a text-only candidate after token-shrink validation and before durable apply. It accepts or requests another candidate, bounded by `maxSummaryValidationRetries`, which defaults to zero and retains the original single-call behavior.

`dsh-reasoning-policy` is the external IQ3_S consumer. Its xhigh-first main policy normalizes unsupported `high` to `xhigh`. Its opt-in compaction policy normalizes the first candidate to `low`, injects compact TaskCheckpoint and Result Manifest facts, and validates objective, constraints, current/pending work, outputs, references, and blockers. One validation failure requests `medium`; a later failure closes the compaction bracket without replacing the surface. It never requests xhigh for compaction, modifies a TaskCheckpoint or Result Manifest, changes a user override, or changes the main request segment.

The optional auto trigger reads existing Context Pressure facts. It delegates `compact` and `critical` to the existing executor only when Basic's own automatic trigger is disabled. Fatal/cancelled/tool-wait Runs, benchmark-original-context locks, blocked Tasks, and `TOOL_OUTCOME_UNKNOWN` refuse compaction. Critical pressure fails closed unless a successful compaction is followed by a reprice below critical. The external diagnostics API stores only transient request, validation, eligibility, and fact-injection data.

## Alternatives considered

- **Copy BasicCompactionEngine into the policy plugin.** Rejected because it would duplicate summarization and eventually diverge from the token meter, pruner, durable brackets, and atomic apply implementation.
- **Route compaction through `agent/request`.** Rejected because it would conflate an auxiliary request with a normal Run request and expose its facts to unrelated request policies.
- **Use launcher xhigh as compaction policy.** Rejected because server defaults are not request-level evidence and vary by backend.
- **Escalate every failed candidate to xhigh.** Rejected because compaction is auxiliary work and a validation failure must preserve context rather than initiate an unbounded expensive request.

## Verification

Focused tests prove that no policy leaves the request field omitted, the Loader-composed IQ3_S policy sends low to the adapter, and a main request remains xhigh. Task fixtures prove low-to-medium semantic retry, final fail-closed surface preservation, and `TOOL_OUTCOME_UNKNOWN` refusal. Existing compaction tests retain token-shrink, durable transaction, cancellation, pruner, and overflow coverage.

## Consequences

The Basic seam is reusable for another backend or policy without naming IQ3_S, GGUF, or llama.cpp. Deployments that enable semantic retry configure `maxSummaryValidationRetries` explicitly and disable Basic auto triggering when the external auto trigger owns pressure admission. The new compaction facts remain external and provisional to the current process; durable task truth continues to live in Session projections.
