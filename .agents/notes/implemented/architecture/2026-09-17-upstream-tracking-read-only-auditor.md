# Agent Note: Deterministic read-only upstream compatibility auditing

Status: implemented

English | [中文](2026-09-17-upstream-tracking-read-only-auditor.zh.md)

## Problem

The DS Harness source product is stable while the official repository keeps moving across Desktop packaging, profile and persistence boundaries, client composition, Agent/LLM/Session contracts, compaction, and native runtime dependencies. A raw file diff cannot tell a Custom-only file from an upstream deletion, a large documentation change from a small data-safety contract change, or direct modification overlap from an interface Custom code merely consumes. File counts and keyword rules would create daily noise without a safe maintenance boundary.

Upstream observation therefore needs a source-level answer to whether a selected Git range touches a known DS Harness compatibility seam. That answer must be deterministic, auditable, usable without a model or network during tests, explicit when evidence is unknown, and incapable of changing refs, product state, installed applications, or user data. It must never claim that static analysis proves an update safe to merge.

## Decision

The maintenance plane ships a deterministic source-level auditor plus one machine-readable Custom change surface and compatibility seam registry. The auditor compares a required target with an explicit or default product baseline, explains every classified impact, writes Markdown and JSON evidence, and records only deletable local tracker state.

The auditor does not fetch, schedule work, notify, call a model, merge, rebase, cherry-pick, build, package, install, launch, migrate data, or claim a change is safe to merge. Fetch and ref refresh stay in the separate monitor, so deterministic classification remains usable offline.

The auditor is intentionally outside the DS Harness product runtime. Its reports and last-audit state live under the already ignored `.artifacts/upstream-audit/` directory; they are deletable and rebuildable, and never enter a product baseline, a user profile, `~/.dsh`, Application Support, or an installed app.

## Repository topology and baseline role

`master` tracks `origin/master`, the only configured remote, which resolves to the official upstream source. No separate upstream remote is required or added.

The immutable product reference remains the tag only:

```text
ds-harness-product-baseline-2026-09-17
```

The technical recovery reference remains the tag only:

```text
dsh-custom-baseline-2026-09-17
```

No commit identifier is embedded in the maintenance source. The monitor resolves the product baseline through its tag and reads the audited cursor from the auditor's own evidence file, so a baseline move can never be smuggled in by editing a literal.

The auditor analyzes `merge-base → target`, not a two-tree `baseline → target` diff. Custom-only files therefore cannot be misreported as upstream deletions, while the baseline still supplies ancestry and divergence identity.

## Custom change surface

The tracked registry groups the Custom delta into nine maintenance domains: Desktop product identity, Desktop packaging, Desktop Custom composition, the Stage 6–11 capabilities, the profile/runtime boundary, UI integration, tests, documentation, and the workspace build graph.

The inventory is domain-oriented rather than a dump of hundreds of files. Exact patterns and explanations live in the tracked registry next to the auditor so the auditor, the monitor, and future isolated-update tooling consume one authority.

## Compatibility seam registry

Each seam records its upstream surface, Custom dependent surface, interface, importance, failure mode, detection method, fixed base risk, and mapped product tests.

| Seam | Contract | Base risk |
| --- | --- | --- |
| `desktop-product-identity-isolation` | product flavor, app id, startup document, `userData`, single instance | CRITICAL |
| `desktop-packaging-runtime-tree` | staging, primary-runtime lock and digests, builder target | HIGH |
| `package-set-custom-composition` | Cordis tail patch and base/web bundle loading | HIGH |
| `client-package-export-loader` | client/remote exports, generated catalogs, dockkit slots | HIGH |
| `profile-settings-session-boundary` | profile, settings, Session, migration and data paths | CRITICAL |
| `agent-run-event-contract` | Run/Attempt correlation, agent lifecycle, tool and cancel events | HIGH |
| `llm-provider-stream-contract` | reasoning, request, chunks, durable retry, usage and cache | HIGH |
| `session-projection-persistence-contract` | v3 envelope, JSONL, projection replay, ignorable extension events | CRITICAL |
| `compaction-token-surface-contract` | pressure, executor, candidate policy, atomic surface apply | HIGH |
| `diagnostics-remote-ui-contract` | read-only diagnostics transport and the Run Details source | HIGH |
| `native-runtime-abi-closure` | Electron/Node/Python ABI and packaged native module closure | HIGH |

Direction and dependency are separate facts. A changed upstream file can affect an interface Custom code consumes even when Custom never modified that implementation file. Conversely, a generic change in a nearby package is not promoted merely because the repository is a fork.

Seam IDs are stable report and state vocabulary. `package-set-custom-composition` is retained even though the historical package-set implementation is retired: the seam now watches the `@deepseek-ai/dsh-desktop-custom` tail patch that layers the Custom capability composition onto the current base and web bundles, and the registry says so explicitly instead of pointing at removed packages.

## Change taxonomy

A change can carry multiple categories: Documentation, Tests, Dependency/version, Build tooling, Desktop shell, Electron packaging, Runtime, Profile, Cordis/composition, Client UI, Agent loop, Session, LLM/provider, Diagnostics/Run State, Schema/type contract, Native dependency, Security, and Unknown. Unknown is a formal review state, not a safe one.

## Risk model

Risk is contract-aware and never derives from file count alone:

- NONE means documentation or tests only, with no registered seam.
- LOW means a known upstream area changed without touching a registered Custom seam.
- MEDIUM means an adjacent seam implementation, a Security surface, or an unknown path needs review without structural contract evidence.
- HIGH means a registered high-value interface, schema, or build contract changed, or direct overlap, a seam rename, native closure, or an accumulated multi-seam range was detected.
- CRITICAL means a product, data, profile, or Session safety boundary changed, or cumulative evidence makes baseline replay likely to require manual adaptation before any isolated attempt.

Impact maps monotonically to `UNAFFECTED`, `RELATED_LOW_RISK`, `REVIEW_REQUIRED`, `LIKELY_CONFLICT`, and `BLOCKING_CHANGE`. Actions map to `NO_ACTION`, `REVIEW`, `TEST_REQUIRED`, and `MANUAL_ADAPTATION_REQUIRED`. An action is advice only; nothing executes it.

Range aggregation is deliberately small: two or more material seams, or three or more material categories, can raise MEDIUM to HIGH; four or more material seams can raise HIGH to CRITICAL. It never lowers a change and never claims merge safety.

## Confidence model

HIGH means exact direct-modification overlap or a registered contract path, or a clearly unrelated or documentation-only rule. MEDIUM means a registered adjacent seam or Security surface without a structural hit. LOW means unclassified path or heuristic evidence only. Confidence is categorical; no percentage probability is invented, and missing evidence yields review, never an invented compatibility fact.

## Audit algorithm

The CLI is:

```sh
pnpm upstream:audit --target <commit-or-ref>
```

It accepts `--base` (defaulting to the product baseline tag), requires an explicit `--target`, and optionally accepts `--output-dir` or an alternate registry for controlled tests. It never guesses the target.

The deterministic core resolves base and target to commits and rejects missing, ambiguous, or non-commit refs; requires one merge base and records baseline/upstream divergence; reads a rename/copy-aware `merge-base → target` diff; assigns non-exclusive categories; matches old and new paths against registered seams; records direct overlap separately from contract dependency; inspects dependency patches only for registered Electron/Node/native signals instead of making every dependency change HIGH; assesses each seam independently, groups path-related commits, and applies bounded range aggregation; then writes human-readable Markdown, machine-readable JSON, and minimal last-audit state atomically.

Every Git subprocess disables optional locks and filesystem-monitor execution. The command uses read operations only.

## Report and state model

Default outputs are:

```text
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.md
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.json
.artifacts/upstream-audit/last-audit.json
```

The Markdown report carries audit identity, summary, grouped evidence, commit samples, affected files, the Custom surface summary, and limitations. JSON retains exact identity, divergence, every classified changed path, group counts and evidence, seams, risk, confidence, impact, and recommended action. State holds only the last audit's ref, commit identity, and result. Deleting the whole directory has no product effect; rerunning reconstructs it from Git and the tracked registry.

## Stage 12 port delta

The auditor is ported from the completed Phase 8B maintenance plane onto the current upstream adaptation. Historical Phase 8B classified the then-current product surface; Stage 12 re-targets the same deterministic engine at the Stage 1–11 implementation.

The taxonomy and the change-surface domains were rewritten for the current workspace layout. The seam IDs were preserved, but every evidence path now names the current implementation: the Desktop flavor and data-boundary modules under `apps/desktop/src`, the primary-runtime scripts under `apps/desktop/scripts`, `packages/bundle/desktop-custom`, the Stage 6–11 capability packages, `packages/api/runtime-diagnostics-controller`, `packages/api/gateway`, `packages/api/remotes`, `packages/typert`, `packages/session/session-checkpoint-policy`, `packages/compaction/compaction-task-aware-policy`, and `packages/client/ui-run-details`. Retired roots that the current workspace no longer contains are gone from the registry instead of being carried along.

The Stage 11 transient diagnostics transport did not create a new seam. The existing diagnostics seam owns that compatibility contract, so its evidence grew to cover the Typert Remote stream face, the Gateway stream transport, the Resource Registry and connection seats, and the Run Details dock, and the seam count stayed at eleven.

## Verification

The auditor suite uses local temporary Git repositories only and needs no network. It covers no upstream changes, documentation-only changes, unrelated package changes, a known product/data seam with direct overlap, rename and move attribution across closed and open paths, an Electron/native dependency signal that does not promote unrelated manifests, unknown-path review behaviour, cumulative multi-seam escalation, missing, ambiguous, and non-commit refs, and Markdown, JSON, and state generation while Git refs, HEAD, and index stay unchanged. It additionally proves that a current agent-loop contract path maps to the agent event seam, that the Gateway and Resource Registry paths map to the diagnostics seam, that token-meter and compaction paths map to the compaction seam, and that a base bundle patch change maps to the composition seam.

The registry suite proves the eleven stable seam IDs, complete seam evidence, the documented retirement of the historical package-set implementation, the Stage 11 and Stage 10 evidence extensions, the absence of every retired package root, and the absence of embedded commit identifiers.

## Safety boundaries

No baseline tag is moved, recreated, retagged, or deleted. The auditor performs no merge, rebase, cherry-pick, reset, push, build, package, install, launch, or user-data read. The installed DS Harness applications stay outside its access path. The product baseline is a comparison and recovery identity, not tracker state, and generated state is never committed into it.

## Known limitations and deferred work

Static analysis cannot prove runtime compatibility, clean replay, native loadability, UI correctness, migration safety, or test success. A semantic break can escape path rules until its seam is registered. Commit grouping is path-based and the Markdown display caps samples even though stored counts and changed paths are exact. The registry is specific to the verified DS Harness product and must evolve when Custom dependencies evolve. Unknown or unclassified paths remain reviewable and must never be silently reclassified as safe.

## Alternatives considered

- **Diff the product baseline tree directly against the upstream target.** Rejected because every Custom-only file would appear to be an upstream deletion. The selected range is merge-base to target, with the Custom surface mapped separately.
- **Use changed-file count or broad keywords as the risk score.** Rejected because volume does not express contract risk and global keywords make unrelated package changes noisy.
- **Ask a model whether upstream is safe.** Rejected because the safety gate must be deterministic, testable offline, reproducible, and explicit when evidence is unknown.
- **Let the auditor fetch, merge, rebase, test, or adapt automatically.** Rejected because observation and mutation need separate authority and failure boundaries.
- **Store tracker state in a product profile or the product baseline.** Rejected because maintenance state is neither user data nor product runtime state; ignored `.artifacts` state is disposable and reconstructible.
- **Add a new seam for the Stage 11 diagnostics packages.** Rejected because the existing diagnostics seam already owns that compatibility contract; extra seams would inflate alerts without adding evidence.

## Consequences

- Maintainers get one evidence-backed inventory of Custom domains, upstream seams, risk, confidence, recommended action, and targeted product tests.
- Large upstream ranges produce a conservative stop signal without treating every changed file as equally dangerous.
- Custom-only files are not misreported as upstream deletions, and indirect contract dependencies stay visible even without path overlap.
- Unknown paths remain reviewable instead of being called safe, while documentation, tests, and unrelated manifests avoid high-risk noise.
- Reports and state are local generated artifacts; deleting them or never running the auditor has no effect on product runtime or user data.
