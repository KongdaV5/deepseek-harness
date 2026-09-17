# Agent Note: Deterministic read-only upstream compatibility auditing

Status: implemented

English | [中文](2026-09-17-upstream-tracking-read-only-auditor.zh.md)

## Problem

The Final Product baseline is stable, while the official repository continues to change across Desktop packaging, profile and persistence boundaries, client composition, Agent/LLM/Session contracts, and native runtime dependencies. A raw file diff cannot distinguish a Custom-only file from an upstream deletion, a large documentation change from a small data-safety contract change, or direct modification overlap from an interface that Custom code consumes indirectly. File count and keyword-only rules would create daily noise without providing a safe maintenance boundary.

Phase 8B needs a source-level answer to whether a selected upstream Git range touches a known DS Harness compatibility seam. That answer must be deterministic, auditable, usable without a model or network during tests, explicit about unknown evidence, and incapable of changing source refs, product state, installed applications, or user data. It must not claim that static analysis proves an update safe to merge.

## Decision

Phase 8B.1 ships a deterministic source-level auditor plus one machine-readable Custom change surface and compatibility seam registry. The auditor compares a required target with an explicit or default Final Product baseline, explains every classified impact, writes Markdown and JSON evidence, and records only deletable local tracker state.

It does not fetch on its own, schedule work, send notifications, call a model, merge, rebase, cherry-pick, build, package, install, launch, migrate data, or claim that a change is safe to merge.

The auditor is intentionally separate from the DS Harness product runtime. Its generated reports and last-audit state live under the already ignored `.artifacts/upstream-audit/` directory. They are deletable and rebuildable, and they never enter the Final Product baseline, a user profile, `~/.dsh`, Application Support, or an installed app.

## Git topology and baseline role

The repository is `/Users/kongda/Developer/Local/deepseek-harness`. `master` tracks `origin/master`; `origin` is the only configured remote and resolves to the official `https://github.com/deepseek-ai/deepseek-harness.git` source. `origin/HEAD` and the remote's declared default branch are `master`. No separate upstream remote is required or added.

The immutable product reference remains:

```text
ds-harness-product-baseline-2026-09-17
→ bfba98b9bd9390735242ad57840050850a3c11b5
```

The technical recovery reference remains:

```text
dsh-custom-baseline-2026-09-17
→ 9d9762e7d2567248050559f2ac1b04e9f2a766f2
```

The first real audit refreshed remote refs with a standalone `git fetch origin --prune`, without merging or rebasing. At that point `origin/master` was `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`, the unique merge base with the Final Product baseline was `c291e7961a515f6d7af9304e7fd1d257929aef26`, and divergence was 12 baseline-only commits versus 666 upstream-only commits.

The auditor analyzes `merge-base → target`, not a direct two-tree `baseline → target` diff. This prevents Custom-only files from being falsely reported as deleted by upstream. The baseline still supplies ancestry/divergence identity, while the registry separately maps upstream changes onto the Custom change surface.

## Custom change surface

The tracked registry groups the Custom delta into these maintenance domains:

| Domain | Custom responsibility | Important upstream dependency |
| --- | --- | --- |
| Desktop product identity | DS Harness name, bundle id, Custom flavor, startup branding, official-product isolation | Electron identity, startup, `userData`, and single-instance contracts |
| Desktop packaging | Custom package/install path, runtime tree, builder inputs, package set | staging layout, packaged Node Host, Electron builder, build/release contracts |
| Custom composition | built-in `desktop-custom-composition` and development composition | Cordis patch schema, base/web bundles, package resolution |
| Phase 2–7 capabilities | Run State, observation, run policy, Task Checkpoint, reasoning, compaction, diagnostics | Agent, LLM, Session, compaction, and token-meter contracts |
| Profile/runtime boundary | `desktop-custom`, isolated Electron data, bundled Host, deliberate settings/Session sharing | profile linking, storage, migration, and runtime descriptors |
| UI integration | Run Details, idle closure, startup shell, title | remote transport, renderer slots/layout, startup URL |
| Tests | contract, composition, packaging, UI, and safety regressions | Vitest, fixtures, build faces |
| Documentation | bilingual decisions, subsystem pages, generated catalogs, attestations | pairing and generated-doc conventions |
| Workspace/build graph | references, lockfile, metadata, exports, release families | workspace discovery, TypeScript faces, package exports and dependencies |

The inventory is domain-oriented rather than a dump of hundreds of files. Exact patterns and explanations live in `scripts/upstream-tracking-seams.json` so the auditor and future isolated-update tooling consume the same authority.

## Compatibility seam registry

Each seam records its upstream surface, Custom dependent surface, interface, importance, failure mode, detection method, fixed base risk, and mapped tests.

| Seam | Contract | Base risk | Representative mapped tests |
| --- | --- | --- | --- |
| `desktop-product-identity-isolation` | product/app id, startup, `userData`, single instance | CRITICAL | Desktop main/startup/project-manager tests |
| `desktop-packaging-runtime-tree` | staging, package set, runtime descriptor, builder target | HIGH | signature/runtime-closure fixtures |
| `package-set-custom-composition` | Cordis patch and built-in package loading | HIGH | capability loader-composition suites |
| `client-package-export-loader` | client/remote exports, loader, slots, renderer registry | HIGH | Run Details and client-package tests |
| `profile-settings-session-boundary` | profile, settings, Session, migration and data paths | CRITICAL | profile/project and checkpoint schema tests |
| `agent-run-event-contract` | Run/Attempt, agent/tool/retry/cancel events | HIGH | Run projection, policy, and checkpoint guards |
| `llm-provider-stream-contract` | reasoning, request, chunks, retry/error, usage/cache | HIGH | adapter, reasoning-policy, Run State service tests |
| `session-projection-persistence-contract` | durable event, JSONL, projection replay, persistence | CRITICAL | Run projection and Task resume suites |
| `compaction-token-surface-contract` | pressure, compaction, validation, atomic surface apply | HIGH | compaction-policy/basic and resume tests |
| `diagnostics-remote-ui-contract` | read-only diagnostics remote and Run Details source | HIGH | diagnostics transport and Run Details tests |
| `native-runtime-abi-closure` | Electron/Node/native ABI and packaged module closure | HIGH | runtime closure, runtime fixture, signature tests |

Direct modification overlap and contract dependency are separate facts. A changed upstream file can affect an interface consumed by Custom code even when Custom never modified that upstream implementation file. Conversely, a generic change in a nearby package is not promoted merely because the repository is a fork.

## Change taxonomy

A change can carry multiple categories:

- **Documentation** — Markdown, bilingual records, and documentation trees.
- **Tests** — test sources and fixtures.
- **Dependency/version** — manifests, lockfiles, workspace definitions, and runtime version files.
- **Build tooling** — scripts, project references, bundler/test/CI configuration.
- **Desktop shell** — Electron main-process and Desktop shell source.
- **Electron packaging** — builder configuration and package/install/prepare entry points.
- **Runtime** — Host, packaged runtime, native system, and SDK runtime.
- **Profile** — profile, configuration, path, and Desktop project selection.
- **Cordis/composition** — bundles, Cordis patches, loader, and composition.
- **Client UI** — client packages, web app, layout, and renderer integration.
- **Agent loop** — agent and core-agent source.
- **Session** — Session format, controller, persistence, and core Session source.
- **LLM/provider** — LLM, provider, adapters, and streaming source.
- **Diagnostics/Run State** — diagnostics and governed Run policy packages.
- **Schema/type contract** — explicit type, schema, protocol, and contract surfaces.
- **Native dependency** — native system or named native-module surfaces.
- **Security** — security, permission, sandbox, and security-workflow surfaces.
- **Unknown** — no registered taxonomy evidence; this is a formal review state, not Safe.

## Risk model

Risk is contract-aware and never derives from file count alone:

- **NONE** — documentation/tests only, with no registered seam.
- **LOW** — a known upstream area changed without touching a registered Custom seam.
- **MEDIUM** — an adjacent seam implementation, Security surface, or unknown/unclassified path requires review, but no structural contract evidence is established.
- **HIGH** — a registered high-value interface/schema/build contract, direct overlap, seam rename, native closure, or accumulated multi-seam range changed.
- **CRITICAL** — product/data/profile/Session safety boundaries changed, or cumulative evidence makes baseline replay likely to require manual adaptation before any isolated attempt.

Impact maps monotonically to `UNAFFECTED`, `RELATED_LOW_RISK`, `REVIEW_REQUIRED`, `LIKELY_CONFLICT`, and `BLOCKING_CHANGE`. Actions map to `NO_ACTION`, `REVIEW`, `TEST_REQUIRED`, and `MANUAL_ADAPTATION_REQUIRED`. An action is advice only; Phase 8B.1 never executes it.

Range aggregation is deliberately small: two or more material seams, or three or more material categories, can raise MEDIUM to HIGH; four or more material seams can raise HIGH to CRITICAL. It does not lower any change and does not claim merge safety.

## Confidence model

- **HIGH** — exact direct-modification overlap or registered contract path; or a clearly unrelated/document-only rule.
- **MEDIUM** — registered adjacent seam or Security surface without a structural hit.
- **LOW** — unclassified path/heuristic evidence only.

Confidence is categorical. The auditor does not emit fabricated percentage probabilities. Missing evidence causes `Unknown`/review, never an invented compatibility fact.

## Audit algorithm

The CLI is:

```sh
pnpm upstream:audit --target <commit-or-ref>
```

It accepts `--base` (defaulting to the Final Product tag), requires an explicit `--target`, and optionally accepts `--output-dir` or an alternate registry for controlled tests. It never guesses the target.

The deterministic core:

1. resolves base and target to commits and rejects missing, ambiguous, or non-commit refs;
2. requires one merge base and records baseline/upstream divergence;
3. reads a rename/copy-aware `merge-base → target` Git diff;
4. assigns non-exclusive taxonomy categories;
5. matches old and new paths against registered seams;
6. records direct overlap separately from contract dependency;
7. inspects dependency patches only for registered Electron/Node/native signals instead of making every dependency change HIGH;
8. assesses each seam independently, groups path-related commits, and applies bounded range aggregation;
9. writes human-readable Markdown, machine-readable JSON, and minimal last-audit state atomically.

All Git subprocesses disable optional locks and filesystem-monitor execution. The command uses only read operations. It does not fetch; a future monitor must update remote refs as a separate, explicit step.

## Report and state model

Default outputs are:

```text
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.md
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.json
.artifacts/upstream-audit/last-audit.json
```

The Markdown report includes audit identity, summary, grouped evidence, commit samples, affected files, Custom surface summary, and limitations. JSON retains exact identity, divergence, all classified changed paths, group counts/evidence, seams, risk, confidence, impact, and recommended action. State holds only the last audit's ref/SHA/result identity. Deleting the whole directory has no product effect; rerunning reconstructs it from Git and the tracked registry.

## Initial real audit

The first audit used the Final Product baseline and the actual refreshed `origin/master`:

| Field | Result |
| --- | --- |
| Base | `bfba98b9bd9390735242ad57840050850a3c11b5` |
| Target | `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` |
| Merge base | `c291e7961a515f6d7af9304e7fd1d257929aef26` |
| Range | 666 upstream commits; 3,188 changed files |
| Affected seams | all 11 registered seams |
| Highest risk | CRITICAL |
| Confidence | MEDIUM |
| Manual review | YES |
| Result | `BLOCKING_CHANGE` |

This is a static stop signal for later isolated work, not a statement that upstream is impossible to adapt. The upstream range materially changes Desktop identity/profile paths, Session/persistence contracts, Agent/LLM/client/composition surfaces, and Electron/native runtime dependencies; it therefore cannot bypass review or go directly to replay.

## Test mapping and verification

`scripts/upstream-audit.spec.ts` uses local temporary Git repositories and needs no network. It verifies:

- no upstream changes;
- documentation only;
- unrelated package changes;
- known product/data seam changes;
- rename/move attribution using both old and new paths;
- Electron/native dependency version signals without promoting unrelated manifests;
- unknown/unclassified review behavior;
- cumulative multi-seam escalation;
- missing, ambiguous, and non-commit refs;
- Markdown/JSON/state generation while Git refs, HEAD, and index remain unchanged.

The registry maps every high-value seam to existing targeted product tests so Phase 8C can select evidence without inventing a second dependency map.

## Safety boundaries

Phase 8B.1 did not modify either baseline tag, perform a merge/rebase/cherry-pick/reset, push, build, package, install, launch an app, or read user settings, profiles, Sessions, or Application Support. `/Applications/DS Harness.app` and `/Applications/DSH Desktop.app` remain outside the auditor's access path.

The Final Product baseline is a comparison and recovery identity, not tracker state. Generated state is not committed into it. Product code and user data do not depend on tracker state.

## Known limitations and future integration

Static analysis cannot prove runtime compatibility, clean replay, native loadability, UI correctness, migration safety, or test success. A semantic break can escape path rules until its seam is registered. Commit grouping is path-based, and the Markdown display caps samples even though stored counts and changed paths are exact. The current registry is specific to the verified DS Harness product and must evolve when Custom dependencies evolve.

Phase 8B.2 may add an explicit monitor around this auditor, but must keep fetch/notification/scheduling separate from deterministic classification. Phase 8C may consume the seam-to-test mapping in an isolated worktree and stop on CRITICAL/data-safety evidence. Neither phase is implemented here.

## Alternatives considered

- **Diff the Final Product baseline tree directly against the upstream target.** Rejected because every Custom-only file would appear to be an upstream deletion. The selected range is merge-base to target, with the Custom surface mapped separately.
- **Use changed-file count or broad keywords as the risk score.** Rejected because volume does not express contract risk and global keywords make unrelated package changes noisy. Registered paths, direct overlap, contract dependencies, rename identity, and bounded dependency signals provide the evidence instead.
- **Ask an LLM whether upstream is safe.** Rejected because the safety gate must be deterministic, testable offline, reproducible, and explicit when evidence is unknown. Human or AI-assisted explanation may be layered on later but cannot replace the static core.
- **Let the auditor fetch, merge, rebase, test, or update automatically.** Rejected because observation and mutation need separate authority and failure boundaries. Phase 8B.1 only classifies already available Git objects and writes ignored reports.
- **Store tracker state in the product profile or Final Product baseline.** Rejected because maintenance state is neither user data nor product runtime state. Ignored `.artifacts` state is disposable and reconstructible.

## Consequences

- Maintainers get one evidence-backed inventory for Custom domains, upstream seams, risk, confidence, recommended action, and future targeted tests.
- Large upstream ranges produce a conservative stop signal without treating every changed file as equally dangerous.
- Custom-only files are not misreported as upstream deletions, and indirect contract dependencies remain visible even without path overlap.
- Unknown paths remain reviewable instead of being called safe, while pure documentation/tests and unrelated manifests avoid unnecessary high-risk noise.
- Reports and state are local generated artifacts; deleting them or never running the auditor has no effect on DS Harness runtime or user data.
- Static analysis still cannot prove replay, runtime, native ABI, UI, migration, or test compatibility. Isolated adaptation and verification remain future work.
