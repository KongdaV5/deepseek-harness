# Agent Note: Incremental upstream monitoring keeps product debt separate from new changes

Status: implemented

English | [中文](2026-09-17-incremental-upstream-monitor.zh.md)

## Problem

The read-only auditor records the compatibility impact of an explicit upstream range, but repeated daily audits from the Final Product baseline would rescan the same historical upstream divergence and bury new evidence in duplicate reports. A monitor must observe new upstream commits without moving the verified DS Harness product baseline or confusing a low-risk new change with proof that the existing product-to-upstream blocker has disappeared.

The monitor also needs scheduler-safe failure semantics. A failed fetch, malformed state, rewritten upstream history, overlapping run, or interrupted write must not silently discard a range of unreviewed commits. It must stay outside the product runtime and user state, and it cannot use an LLM or make any adaptation decision.

## Decision

Phase 8B.2 adds `pnpm upstream:monitor`, implemented by [`scripts/upstream-monitor.ts`](../../../../scripts/upstream-monitor.ts), around the Phase 8B.1 deterministic core in [`scripts/upstream-audit.ts`](../../../../scripts/upstream-audit.ts). The monitor is the only layer that fetches `origin --prune`; the auditor remains a no-fetch classifier.

The monitor persists its independent lifecycle state at `.artifacts/upstream-monitor/state.json`. Its fixed initial cursor is the B8.1-observed `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`; initialization verifies the B8.1 `last-audit.json` identity and locally resolvable commits rather than auditing again from the Final Product baseline. The Final Product tag remains `ds-harness-product-baseline-2026-09-17` at `bfba98b9bd9390735242ad57840050850a3c11b5`.

State holds three independent facts:

| Fact | Meaning | Phase 8B.2 authority |
| --- | --- | --- |
| Product baseline | The verified DS Harness source product | Fixed; never advanced by the monitor |
| Monitoring cursor | The latest upstream commit successfully observed | Advances only after fetch, ref validation, audit, report, and atomic state persistence |
| Existing compatibility debt | B8.1 product-to-upstream finding | `CRITICAL` / `BLOCKING_CHANGE` / `MANUAL_ADAPTATION_REQUIRED` / `UNRESOLVED`; never reduced here |

The state schema records its version, product tag/SHA, remote/branch, last observed upstream SHA, successful/fetch/new-change timestamps, immutable unresolved debt, last incremental result, report locations, and failure state. Atomic replacement uses the existing [`@deepseek-ai/dsh-atomic-write`](../../../../packages/util/atomic-write/src/index.ts) helper. A `monitor.lock` file serializes writers; a lock older than 30 minutes is reclaimed, while a fresh lock returns `LOCKED` without fetching or changing state.

The normal algorithm is: acquire lock; snapshot checkout identity; fetch; verify HEAD, index, worktree status, and both protected baseline tags stayed unchanged; resolve `origin/master`; compare it with the cursor; verify ancestry; audit only `cursor..target`; write a report; and atomically persist the advanced cursor. A target equal to the cursor records `NO_NEW_UPSTREAM_CHANGES` without a new report. A non-ancestor target returns `UPSTREAM_HISTORY_DIVERGENCE`, emits a retained failure report, and preserves the cursor for manual review.

`--remote`, `--branch`, `--dry-run`, `--no-fetch`, `--output-dir`, and `--state` make the CLI usable by a future scheduler. `--dry-run` writes neither lock, report, nor state; no scheduler, notification, launchd job, or background service is installed in this phase. Completed observations, including HIGH or CRITICAL incremental findings, return exit code 0. Lock contention uses 3; state, fetch, audit, ref, ancestry, or persistence failures use 2.

## Reports and safety boundary

The machine-readable state and every report state both incremental findings and the unresolved historical debt. The monitor does not collapse them into a misleading "safe" flag. NONE/LOW changes replace a bounded `latest-compact` Markdown/JSON pair. MEDIUM, HIGH, CRITICAL, failure, and divergence reports receive immutable per-range files under `.artifacts/upstream-monitor/reports/`; the monitor never automatically deletes important evidence. No-change checks generate no report.

The monitor fetches remote-tracking refs only. It never pulls, checks out, merges, rebases, resets, cherry-picks, pushes, builds, packages, installs, launches, or modifies either installed application. It does not read `~/.dsh`, profiles, settings, Sessions, Application Support, or model configuration. It makes no compatibility, migration, or update judgment beyond the deterministic seam classification supplied by B8.1.

## Verification

[`scripts/upstream-monitor.spec.ts`](../../../../scripts/upstream-monitor.spec.ts) uses only temporary local bare remotes. It verifies initialization, no-change behavior, an incremental documentation change, a critical seam change, idempotent rerun, fetch/audit/state-write failures, cursor preservation, fresh and stale locks, force-push divergence, corrupt state preservation, and dry-run/no-fetch behavior. It also checks that product HEAD and index remain unchanged during normal monitor fetches. The B8.1 auditor test suite remains the classification regression suite.

The first real invocation uses only `origin/master` and the B8.1 anchor. It may observe no new commits or audit only the delta after that anchor; it never rescans the prior 666-commit historical range as monitor work.

## Alternatives considered

- **Run the B8.1 audit from the product baseline each time.** Rejected because it repeatedly produces the same large historical finding and masks the operationally relevant incremental range.
- **Advance the product baseline with the cursor.** Rejected because observation is not adaptation, build, validation, or approval. Moving it would erase the meaning of the verified product reference.
- **Treat a NONE/LOW increment as compatibility resolution.** Rejected because B8.1's product-to-upstream blocker is independent evidence and remains unresolved until a later adaptation process explicitly establishes a new product baseline.
- **Put fetch inside the auditor.** Rejected because deterministic classification must remain reusable offline, while network/ref refresh has separate failure and authority boundaries.
- **Use a scheduled daemon or notification immediately.** Rejected because cadence, recipient, and material-change policy need separate authorization. This phase supplies a scheduler-ready command only.

## Consequences

- Daily monitoring is bounded by new upstream work instead of historical divergence, while retainable reports preserve higher-risk evidence.
- A failure cannot silently skip commits: the persisted cursor advances only after the entire successful observation transaction.
- Product baseline, upstream observation, and unresolved compatibility debt remain legible to a human and a future scheduler.
- The monitor remains deterministic and isolated from runtime/user data, but it cannot prove runtime compatibility, safe replay, successful migration, package closure, or test success. Those remain outside Phase 8B.2 and require later explicit work.
