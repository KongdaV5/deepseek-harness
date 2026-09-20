# Agent Note: Incremental upstream monitoring keeps product debt separate from new changes

Status: implemented

English | [中文](2026-09-17-incremental-upstream-monitor.zh.md)

## Problem

The read-only auditor records the compatibility impact of an explicit upstream range, but repeated daily audits from the product baseline would rescan the same historical upstream divergence and bury new evidence in duplicate reports. A monitor must observe new upstream commits without moving the verified DS Harness product baseline or confusing a low-risk new change with proof that the existing product-to-upstream blocker has disappeared.

The monitor also needs scheduler-safe failure semantics. A failed fetch, malformed state, rewritten upstream history, overlapping run, or interrupted write must not silently discard a range of unreviewed commits. It must stay outside the product runtime and user state, and it cannot use a model or make any adaptation decision.

## Decision

The maintenance plane adds `pnpm upstream:monitor`, implemented by [`scripts/upstream-monitor.ts`](../../../../scripts/upstream-monitor.ts), around the deterministic core in [`scripts/upstream-audit.ts`](../../../../scripts/upstream-audit.ts). The monitor is the only layer that fetches `origin --prune`; the auditor remains a no-fetch classifier.

The monitor persists its independent lifecycle state at `.artifacts/upstream-monitor/state.json`. Its initial cursor is not written as a literal: initialization resolves the product baseline through its tag and reads the previously audited cursor and debt from the auditor evidence file `.artifacts/upstream-audit/last-audit.json`, requiring that the recorded base matches the baseline tag and that the recorded result is `BLOCKING_CHANGE`. If that evidence is missing or inconsistent the monitor fails closed instead of inventing a cursor.

State holds three independent facts:

| Fact | Meaning | Authority |
| --- | --- | --- |
| Product baseline | The verified DS Harness source product | Fixed; never advanced by the monitor |
| Monitoring cursor | The latest upstream commit successfully observed | Advances only after fetch, ref validation, audit, report, and atomic state persistence |
| Existing compatibility debt | Product-to-upstream finding | `CRITICAL` / `BLOCKING_CHANGE` / `MANUAL_ADAPTATION_REQUIRED` / `UNRESOLVED`; never reduced here |

The state schema records its version, product tag and commit identity, remote and branch, last observed upstream commit, successful, fetch, and new-change timestamps, immutable unresolved debt, last incremental result, report locations, and failure state. Atomic replacement uses the existing [`@deepseek-ai/dsh-atomic-write`](../../../../packages/util/atomic-write/src/index.ts) helper. A `monitor.lock` file serializes writers; a lock older than thirty minutes is reclaimed, while a fresh lock returns `LOCKED` without fetching or changing state.

The normal algorithm is: acquire lock; snapshot checkout identity; fetch; verify HEAD, index, worktree status, and both protected baseline tags stayed unchanged; resolve the remote branch; compare it with the cursor; verify ancestry; audit only the cursor-to-target range; write a report; and atomically persist the advanced cursor. A target equal to the cursor records `NO_NEW_UPSTREAM_CHANGES` without a new report. A non-ancestor target returns `UPSTREAM_HISTORY_DIVERGENCE`, emits a retained failure report, and preserves the cursor for manual review.

`--remote`, `--branch`, `--dry-run`, `--no-fetch`, `--output-dir`, `--state`, `--baseline-tag`, and `--bootstrap-evidence` make the CLI usable by a future scheduler. `--dry-run` writes neither lock, report, nor state; no scheduler, notification, launchd job, or background service is installed by this command. Completed observations, including HIGH or CRITICAL incremental findings, return exit code 0. Lock contention uses 3; state, fetch, audit, ref, ancestry, or persistence failures use 2.

## Reports and safety boundary

The machine-readable state and every report state both incremental findings and the unresolved historical debt. The monitor does not collapse them into a misleading "safe" flag. NONE and LOW changes replace a bounded `latest-compact` Markdown and JSON pair. MEDIUM, HIGH, CRITICAL, failure, and divergence reports receive immutable per-range files under `.artifacts/upstream-monitor/reports/`; the monitor never automatically deletes important evidence. No-change checks generate no report.

The monitor fetches remote-tracking refs only. It never pulls, checks out, merges, rebases, resets, cherry-picks, pushes, builds, packages, installs, launches, or modifies either installed application. It does not read `~/.dsh`, profiles, settings, Sessions, Application Support, or model configuration. It makes no compatibility, migration, or update judgment beyond the deterministic seam classification supplied by the auditor.

## Stage 12 port delta

The monitor is ported from the completed maintenance plane onto the current upstream adaptation. The historical version embedded a fixed initial cursor as a literal and initialized from an audit that had been run against the then-current product surface.

The port removes every embedded commit identifier. Bootstrap now derives the initial cursor and debt from the product baseline tag plus the auditor evidence file, and it refuses to start when that evidence is missing or does not match the baseline. The state contract is otherwise preserved exactly, so an existing monitor state file remains readable without a migration and the monitor never reports a migration requirement. The cursor transaction, the three independent facts, and the exit-code contract are unchanged.

## Verification

[`scripts/upstream-monitor.spec.ts`](../../../../scripts/upstream-monitor.spec.ts) uses only temporary local bare remotes and temporary state homes. It verifies initialization with no new change, bootstrap from the baseline tag plus evidence, fail-closed behaviour on missing or inconsistent evidence, reading a pre-existing historical state file without migration, idempotent reruns, compact report generation, a full-range audit, a CRITICAL change producing a full report while debt stays unchanged, fetch, audit, and state-write failures that keep the cursor, force-push divergence that preserves the cursor, checkout mutation detection, invalid state with dry-run and no fetch, dry-run writing nothing, ref reuse under `--no-fetch`, temporary-root overrides, and fresh and stale lock handling as well as lock contention. It also checks that product HEAD and index remain unchanged during normal monitor fetches. The auditor suite remains the classification regression suite.

## Alternatives considered

- **Run the audit from the product baseline each time.** Rejected because it repeatedly produces the same large historical finding and masks the operationally relevant incremental range.
- **Advance the product baseline with the cursor.** Rejected because observation is not adaptation, build, validation, or approval. Moving it would erase the meaning of the verified product reference.
- **Treat a NONE or LOW increment as compatibility resolution.** Rejected because the product-to-upstream blocker is independent evidence and remains unresolved until a later adaptation process explicitly establishes a new product baseline.
- **Put fetch inside the auditor.** Rejected because deterministic classification must remain reusable offline, while network and ref refresh have separate failure and authority boundaries.
- **Keep the historical initial cursor as a literal in source.** Rejected because an embedded commit identifier is unverifiable maintenance debt and can disagree with the baseline tag; the tag plus audited evidence is the single authority.

## Consequences

- Daily monitoring is bounded by new upstream work instead of historical divergence, while retainable reports preserve higher-risk evidence.
- A failure cannot silently skip commits: the persisted cursor advances only after the entire successful observation transaction.
- Product baseline, upstream observation, and unresolved compatibility debt remain legible to a human and a future scheduler.
- The monitor remains deterministic and isolated from runtime and user data, but it cannot prove runtime compatibility, safe replay, successful migration, package closure, or test success. Those remain outside this stage and require later explicit work.
