# Agent Note: Phase 8C latest-upstream strategy and Stage 3 data boundary

Status: implemented

English | [中文](2026-09-17-upstream-adaptation-strategy.zh.md)

## Problem

Phase 8C.1 locked the strategy; Phase 8C.2 now implements it one stop-gated stage at a time. The adaptation target is the fetched `origin/master` commit `ddefc45fbc7f8e46dd73185e68295696d1297887` (`0.1.6-alpha.2`). It is evaluated in `/tmp/ds-harness-upstream-adaptation-ddefc45f` on `adapt/ds-harness-upstream-ddefc45f`, created directly from that commit. The source product baseline remains `ds-harness-product-baseline-2026-09-17` at `bfba98b9bd9390735242ad57840050850a3c11b5`; the technical recovery baseline remains `dsh-custom-baseline-2026-09-17` at `9d9762e7d2567248050559f2ac1b04e9f2a766f2`. The merge base is `c291e7961a515f6d7af9304e7fd1d257929aef26`, with 12 baseline-only and 1,548 target-only commits. Stages 1–3 are complete; packaging and all later capability ports remain pending.

No candidate was installed or launched. Neither installed application, the main worktree, the two baseline tags, monitor cursor/state, scheduler state, nor real settings, sessions, profiles, or Application Support data was modified or used. All source work and tests stayed in the isolated worktree or test-created temporary directories.

The machine-readable contract is [`2026-09-17-upstream-adaptation-strategy.manifest.json`](2026-09-17-upstream-adaptation-strategy.manifest.json). It is authoritative for the exact capability rows, seam records, port stages, evidence paths, and status/action enum values summarized here.

## Pure upstream health

`pnpm install --frozen-lockfile` and the complete `pnpm run build` pass on macOS arm64 with Node 24.21.0. Phase 8C.2 pins and executes the repository-declared pnpm 11.7.0 through Corepack. The build compiles the native darwin-arm64 system module, Host/client libraries, the web renderer, and 248 client artifacts.

The unmodified target test suite completes with 1,511 passed, 4 failed, and 14 skipped files; at test level it reports 25,845 passed, 260 failed, 1 expected failure, and 176 skipped. The 260 failures have two upstream/environment causes:

- 245 Python PTC failures use the source default `python3`, which resolves to `/usr/bin/python3` 3.9.6 on this host, below upstream's Python 3.10 minimum. The packaged upstream primary runtime itself pins Python 3.12.14.
- 15 `apps/desktop/tests/main-startup.spec.ts` failures are one upstream fixture mismatch plus 14 dependent timeouts. The fixture stubs `process.platform` to Windows but retains the arm64 host architecture; the new installed-client policy correctly refuses the impossible `desktop-win + arm64` identity.

These are recorded known upstream failures, not Custom regressions. They do not prevent architectural reconnaissance because the clean build passes and both failure classes have direct, reproducible causes. They must be rechecked with Python 3.10+ and a corrected upstream test fixture before a release qualification can pass.

## Material architecture changes

### Desktop and product identity

Desktop now includes mandatory-update identity and policy, update qualification, a changed startup shell, and a simple single-instance lock. `DSH_DESKTOP_APP_ID` supplies the bundle identifier, but `productName` remains hard-coded and Desktop and Host still select the `desktop` profile. The old Custom `startup-renderer.ts` seam is absent. Product identity therefore requires an explicit current-architecture flavor seam; replaying the old main/paths/renderer patches would be unsafe.

### Packaging and build

The release pipeline now stages a signed primary runtime with locked Node 24.21.0, Python 3.12.14, pnpm 11.7.0, Python wheels, payload digests, updater inputs, and qualification stages. Old package/install scripts do not represent this closure. The current builder factory and runtime lock must remain upstream-owned while DS Harness adds only reviewed product-flavor inputs and candidate verification.

### Profile, data, and Session

The Stage 3 implementation makes data authority explicit without changing Official Desktop defaults. Official continues to use profile `desktop`, its upstream Electron state, and the shared global settings and Session authorities. DS Harness uses profile `desktop-custom` and flavor-isolated Electron state while retaining the approved shared-global settings and Session design. The candidate cannot yet use those live shared stores: it starts only when `DSH_DESKTOP_DATA_MODE=candidate-rehearsal` names an absolute `DSH_DESKTOP_REHEARSAL_ROOT`, and then all DSH and Electron paths are contained below that temporary root. Missing, invalid, or escaping rehearsal inputs fail closed before Host startup.

| Authority | Official | DS Harness final design | Current candidate |
| --- | --- | --- | --- |
| Settings | `$DSH_HOME/settings.yaml` | Same shared authority | Temporary rehearsal copy only |
| Sessions | `$DSH_HOME/sessions` | Same shared authority | Synthetic or copied fixture only |
| Profile | `$DSH_HOME/profiles/desktop` | `$DSH_HOME/profiles/desktop-custom` | Fresh temporary `desktop-custom` |
| Electron state | Upstream default | Product-flavor isolated | `<rehearsal>/electron/<flavor-id>` |

Settings are bidirectionally compatible: baseline and target use the same settings-file implementation blob, reads do not write back, locked atomic replacement is retained, and unknown sections survive updates. Profile data requires migration: the old `desktop-custom` manifest is structurally readable, but its bundle list and `patchReload` semantics do not describe the current boot composition; a fresh temporary Custom profile is compatible.

Both baselines use Session format v3 and the JSONL persistence implementation is unchanged. A read-open prepares historical migration in memory without mutation; only write-open publishes a verified immutable successor generation, retaining the predecessor. Physical format compatibility does not make event catalogs bidirectional: target-only required `image/offload` and `workspace/changes` events are unknown to the Final Product, while old required Custom `task/checkpoint` and `task/result-manifest` events are unknown to the target and were not marked ignorable. Their classification is `CUSTOM_EVENT_MIGRATION_BLOCKED`, to be resolved by the Stage 6 schema adapter. Source rollback is therefore independent of data rollback and is safe only after restoring a pre-candidate snapshot when a candidate could have written Sessions.

### Agent, run lifecycle, and retry

`AgentStatus` remains `idle | running`, but lifecycle evidence is substantially richer: durable turn/step boundaries, `LlmAttemptId`, compact transient assistant streams with committed settlement, retry events, structured terminal reasons, and interrupted-turn closure. There is still no DS Harness `RunId`, backend health, or truthful Run State projection. Upstream retry provides durable same-turn backoff, but normal mode defaults to five retries and lacks DS Harness fatal-backend evidence. The mechanism can be adopted; the approved `retry <= 2`, cancellation acknowledgement, and fatal-no-retry policy must be integrated once, without a second retry engine.

### LLM and reasoning

`LlmFailure` now carries provider-neutral code, status, retry-after, request ID, and related facts. Streaming exposes reasoning, tool deltas, and disjoint input/cache/output/reasoning usage. `llm-pi-ai` supports request-level `reasoningEffort`, model-advertised levels, strict unsupported-value errors, and request override over profile defaults. Those are upstream-native foundations. The audited IQ3_S behavior—`none`, `low`, `medium`, `xhigh`; `high -> xhigh`; `off -> none`; xhigh-first task policy and stable segments—remains a backend-specific DS Harness mapping.

### Compaction and token surface

`compaction-basic` now owns token-meter thresholds, automatic/manual/context-overflow triggers, bracketed atomic summaries, replacement generations, shrink validation, prompt-cache prefix reuse, tool-result pruning, and image offload. The old modified executor must not be replayed. DS Harness still needs a thin task-aware layer for eligibility, TaskCheckpoint fact preservation, deterministic validation, low-to-medium-only auxiliary reasoning, fail-closed application, and restoration of the main xhigh scope.

### Client and diagnostics

Client composition moved to generated catalogs, module packages, scoped/factory slots, and `ui-dockkit`. The old `RunStatusDock.tsx` insertion model has no stable one-to-one counterpart. Upstream runtime invariants validate many contracts but do not supply Run State, backend process/model/generation health, prefill observation, primary/secondary error precedence, or the read-only Run Details experience. Transport and UI must be rebuilt after the Run projection stabilizes, retaining `run = null` with no idle composer gap.

### Native runtime

Electron remains 44.0.0; Node moves from the Custom baseline's 24.17.0 to 24.21.0. `node-pty` 1.2.0-beta.15, `koffi` 3.1.1, and `sharp` 0.35.3 remain. The current primary runtime adds Python and signed payload closure. Locking has moved to upstream `native/system` stable N-API; `fs-ext` is legacy policy surface rather than the current runtime lock dependency. The adapted product must validate the entire packaged closure, not copy old binary assumptions.

## Capability adaptation matrix

| Capability | Old DS Harness implementation | Current upstream equivalent | Status | Required action | Risk | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| Product identity/coexistence | Custom app ID/name, userData/profile, branding, single instance | Partial appId input; fixed product/profile plus new startup/update identity | REWRITE_REQUIRED | REIMPLEMENT minimal product flavor | CRITICAL | Identity, paths, branding, dual-app coexistence |
| Packaging/daily install | Custom staging, Node Host, signing, native smoke | Signed primary runtime and release qualification | REWRITE_REQUIRED | Extend current pipeline | HIGH | Runtime manifest, codesign, ABI, candidate rehearsal |
| Run State/identity | Session/run/attempt projection | Turn/step and LlmAttemptId, no RunId | PORT_WITH_ADAPTATION | Port against new events | HIGH | Lifecycle fixtures, retry same run, terminal immutability |
| Backend observation/health | MLX/GGUF observers and three-layer health | None found | PORT_WITH_ADAPTATION | Port behind observer contract | HIGH | Long prefill, worker fatal, attribution Unknown |
| Error classification | Strong-evidence fatal and primary/secondary precedence | Structured LlmFailure facts only | PORT_WITH_ADAPTATION | Reuse facts, port precedence | HIGH | Resource limit, cancel/BrokenPipe, weak evidence |
| Run/retry policy | Bounded, fatal-aware, cancellation-safe | Durable provider retry defaults to five | REWRITE_REQUIRED | One policy integration on native mechanism | CRITICAL | Retry at most two; fatal no retry |
| Task checkpoint/result manifest | Domain task facts and pending-only resume | Generic checkpoint/repair/resume foundation | REWRITE_REQUIRED | Reimplement v3 domain events/projection | CRITICAL | Crash, pending-only, outcome-unknown block |
| Generic crash durability | Custom flush/repair hooks | Native checkpoint policy, lease, repair, interrupted closure | UPSTREAM_NATIVE | KEEP_UPSTREAM | MEDIUM | Native E2E and persistence tests |
| IQ3_S reasoning | xhigh-first and backend aliases | Request effort and capability plumbing | PORT_WITH_ADAPTATION | Port backend policy only | HIGH | Audited matrix and scope stability |
| Task-aware compaction | Pressure, validation, low/medium, atomic apply | Strong native executor/pruner/offload | PORT_WITH_ADAPTATION | Thin adapter; keep native engine | HIGH | Facts, fail closed, scope isolation |
| Large tool results | Custom summaries/key lines/references | Native pruner and offload | UPSTREAM_NATIVE | KEEP_UPSTREAM | MEDIUM | Root cause and artifact retention |
| Run Details | Remote plus old dock | New module/catalog/dockkit client | REWRITE_REQUIRED | Rebuild current transport/UI | HIGH | Reconnect, read-only, idle closure |
| Data boundary | Shared settings/sessions; isolated Electron/profile | New resolution and v3 automatic migration | REWRITE_REQUIRED | Stage 3 boundary implemented; live cutover remains gated | CRITICAL | Temp roots, migrations, sentinels |
| Phase 8B maintenance | Auditor/monitor/scheduler/notification | Product-independent repository plane | UNCHANGED_PORTABLE | Port late; adapt wiring only | MEDIUM | B8 regression and unchanged state hashes |

## Upstream-native reduction and required Custom surface

The new branch must adopt upstream checkpoint flush, generic resume and interrupted-turn closure, TOOL_NOT_STARTED/TOOL_OUTCOME_UNKNOWN repair facts, request-level reasoning plumbing, `LlmFailure`, same-turn retry events/backoff, token meter, atomic compaction, tool-result pruning/image offload, runtime invariants, and session migration/generation/lease/projection foundations. Duplicating these would enlarge risk without preserving a distinct user invariant.

The old baseline changes 256 tracked files (19,967 insertions, 163 deletions); 136 files fall within the primary capability paths. Phase 8C.1 does not invent a misleading future file count. The required new Custom surface is instead bounded to ten semantic domains: product flavor, data boundary, minimal composition, run observability, safety policy, task continuity, IQ3_S reasoning, task-aware compaction, client diagnostics, and the repository-only maintenance plane. Every domain must remain smaller than a replacement upstream subsystem and must justify each hook.

## Eleven compatibility seams

| Seam | Old contract -> new contract and breakage | Required migration | Risk | Mapped validation |
| --- | --- | --- | --- | --- |
| desktop-product-identity-isolation | Old main/paths/renderer flavor -> environment appId plus fixed product/profile and new update identity; no one-to-one patch | Reviewed current product-flavor seam before launch | CRITICAL | Identity, isolation, coexistence, branding |
| desktop-packaging-runtime-tree | Custom Node staging -> signed Node/Python/pnpm primary runtime; old scripts bypass closure | Extend current runtime/builder inputs | HIGH | Locks, digests, codesign, native smoke |
| package-set-custom-composition | Old Cordis patch -> changed package/module catalogs; entries may be gone or native | Rebuild minimal composition | HIGH | Resolution, isolated Host startup, inventory equality |
| client-package-export-loader | Old exports/slots -> generated catalogs and scoped/factory slots | Current exports/catalog integration | HIGH | Catalog generation, module and renderer build |
| profile-settings-session-boundary | desktop-custom plus shared stores -> default desktop plus new resolution/migrations; collision/migration risk | Explicit paths and copied-fixture qualification | CRITICAL | Temp-home audit and sentinel hashes |
| agent-run-event-contract | Older events -> turn/step/LlmAttemptId/compact streams/terminal reasons; old projection is incomplete | New-event-to-RunId adapter | HIGH | Event matrix, same-run retry, terminal stability |
| llm-provider-stream-contract | Older hooks -> LlmFailure/reasoning/usage/provider retry; old adapters duplicate behavior | One DS Harness policy over native facts | CRITICAL | Provider contracts, IQ3_S, retry/fatal |
| session-projection-persistence-contract | Older custom envelopes -> v3 catalog/migrations/leases; old events may be refused | v3 event and projection design | CRITICAL | Schema, round trip, migration, refusal behavior |
| compaction-token-surface-contract | Modified old executor -> mature native transaction/pruner/offload; replay creates two engines | Thin eligibility/reasoning/validation adapter | HIGH | Atomic failure, facts, fallback, main scope |
| diagnostics-remote-ui-contract | Old remote/dock -> session transport/module/dockkit; insertion point changed | Rebuild after projection | HIGH | Reconnect, read-only, idle run=null |
| native-runtime-abi-closure | Node 24.17 and old smoke -> Node 24.21/Python/native-system/signed payload; old assumptions incomplete | Use runtime lock and qualify packaged flavor | HIGH | Architecture, modules, Python, codesign |

## Decision

The single selected strategy is **B: fresh latest-upstream branch plus semantic capability port**. The adaptation branch already starts at the exact locked target. Each Custom capability will be reintroduced only after comparing its invariant with the current upstream owner. Existing source may be reused as tested domain logic, but historical patches are not integration units.

## Alternatives considered

- **Rebase the existing Custom branch.** Rejected because all 11 seams changed and conflict resolution would not establish semantic safety.
- **Full or broad cherry-pick.** Rejected because it would replay old file and ownership assumptions, including duplicated native capabilities.
- **Hybrid as the primary strategy.** Rejected because it creates ambiguous architecture and provenance. Selective code reuse inside strategy B does not change the latest-upstream-first branch model.

## Phase 8C.2 port order and stop gates

1. Reconfirm target/toolchain health. Stop on unexplained target or health drift.
2. Add product identity/process isolation. Stop on any collision with official Desktop or Stable DS Harness.
3. **Complete:** establish profile/settings/session/userData boundaries with temporary copied fixtures. Live data remains blocked until the Stage 13 cutover gate.
4. Restore packaging and primary-runtime closure. Stop on payload, signing, or native failure.
5. Build the minimal current Cordis/package-set composition. Stop on duplicate native services or isolated startup failure.
6. Adapt Session v3 and Agent lifecycle contracts. Stop if Run identity or durable event semantics are ambiguous.
7. Port Run State, observers, health, and error precedence. Stop if Unknown is guessed or terminal state can regress.
8. Reimplement TaskCheckpoint, Result Manifest, and guarded pending-only resume. Stop if authoritative task facts can be lost or duplicated.
9. Integrate IQ3_S reasoning and bounded fatal-aware policy once. Stop on double retry or unproven wire reasoning.
10. Add task-aware compaction around the native engine. Stop if it can mutate task authority, delete evidence, or lower main reasoning.
11. Rebuild Run Details on current client contracts. Stop if it is mutating or reintroduces idle layout cost.
12. Port the Phase 8B repository maintenance plane. Stop if it joins runtime composition or changes monitor state/debt.
13. Run full isolated regression and packaged candidate qualification. Any failed invariant prevents install, tag, or new baseline.

### Stage 13 static hygiene qualification decision

Stage 13 uses baseline-relative qualification only for `verify-client-domain-graph` and `duplication`. The locked comparison baseline is the original Stage 13 candidate tree `656c3bcfede57e3cba2fa19c8c8d9026fa3bf9fd` (the tree of `chore(architecture): close Stage 12 decision record`); the compared product candidate tree is `9bd3d99a894cd4c2e51fb927fefadda919cc7c56` (the tree of `fix(desktop): wait for flushed asar archives`). These immutable Git tree identities identify the exact source snapshots without using commit references. An unchanged finding requires the same identity and rule/category, no candidate change to the relevant source, and no material change in count, import relationship, or clone scope. Keep the raw gate result as `FAIL`, classify such findings as `PRE_EXISTING_UNCHANGED_DEBT`, and record zero candidate regressions. Any new finding, changed rule/category, expanded relationship or clone scope, or candidate-caused violation blocks qualification. Recheck both gates and their finding identities at the governance-commit HEAD before continuing Stage 13.

The approved, explicitly named client-domain architecture exception is `FAIL — 38 PRE_EXISTING_UNCHANGED_DEBT; candidate regressions: 0`: all 38 rule/source/import identities matched the original candidate, with zero new or changed findings and no candidate change to their source files. These violations of the client-domain layering rule remain unresolved. The duplication result is `FAIL — 7 PRE_EXISTING_UNCHANGED_DEBT; candidate regressions: 0`: all seven file-pair/range clone groups matched, with 69 duplicated lines and 567 duplicated tokens on both commits, zero new or changed groups, and no candidate change to their source files. This maintainability debt remains unresolved. Neither raw gate is recorded as passing.

This decision does not apply to signing, runtime or package integrity, native runtime, startup/restart, crash/process health, Official/Custom or profile/data isolation, live-data safety, Session/Task/Run correctness, rollback, destructive operations, or security/safety sentinels; any failure there still blocks qualification, even if historically present. Stage 13 was `PENDING` when this policy was adopted; its later qualification result is recorded below. The two hygiene debts remain unresolved and require a separate explicit decision at a new Final Product baseline or cutover review, or closure in an independent hygiene remediation phase.

### Stage 13 static documentation debt qualification decision

Separately from the static hygiene decision, Stage 13 uses baseline-relative qualification only for `verify-repository-references` and `verify-concrete-terms`. The comparison baseline is the original Stage 13 candidate tree `656c3bcfede57e3cba2fa19c8c8d9026fa3bf9fd` identified above. At each qualification HEAD, a finding may be classified as `PRE_EXISTING_UNCHANGED_DOCUMENTATION_DEBT` only when its identity and rule match that baseline, its source location and semantic target have not materially changed, and the candidate has introduced or expanded no finding. Keep the raw gate result as `FAIL` and record candidate regressions as zero. Any new or changed finding, expanded scope, or candidate-caused violation blocks qualification; this decision cannot be inherited automatically by a later candidate.

The explicitly approved repository-reference record is `FAIL — 15 PRE_EXISTING_UNCHANGED_DOCUMENTATION_DEBT; candidate regressions: 0`: all 15 file/location/rule identities match the original candidate, with new 0 and changed 0. The separately approved concrete-term record is `FAIL — 3 PRE_EXISTING_UNCHANGED_DOCUMENTATION_DEBT; candidate regressions: 0`: the strategy English and Chinese findings and the runtime-diagnostics type finding have the same identities and meanings as in the original candidate, with new 0 and changed 0. Both raw gates remain failing, and all 18 findings remain unresolved. Rerun both gates and compare finding identities at the documentation-governance commit HEAD before continuing Stage 13.

This documentation-debt decision excludes generated-document freshness, including `verify-config-catalog`, which passed after its separate candidate regression repair. It also excludes runtime and package integrity, signing, startup/restart, process health, Official/Custom and data/profile isolation, Session/Task/Run and Agent Runtime correctness, rollback safety, and security/safety sentinels; any failure in those gates still blocks qualification. Stage 13 was `PENDING` when this policy was adopted; its later qualification result is recorded below. Reconsider the unresolved documentation debts explicitly at a new Final Product baseline or cutover review, or close them in independent remediation.

### Stage 13 final qualification result — 2026-09-25

Stage 13 is `PASS` for candidate source tree `db94d1276d03250ed11523257e999091a6e220bc`, packaged as `apps/desktop/.desktop-build/qualification/final/DS Harness Qualification.app`. The app reports Product `DS Harness`, version `0.1.6-alpha.2`, Bundle ID `dev.dsh.desktop.custom`, arm64, and `@electron/asar` 4.1.1. The `app.asar` SHA-256 is `aa8a694e33576a92cd103095e94c3ca918153ad99b51d107c19a91ba03374854`; local ad-hoc signing passed `codesign --verify --deep --strict`, with publish disabled. Runtime descriptor and packaged runtime were 13,080 / 13,080 files; missing, extra, byte-size, SHA-256, and executable-mode mismatches were all zero.

The isolated packaged client launched from the sole Stage 13 launcher under a fresh candidate-rehearsal root; no Stable, Official, or live user-data path was used. The fresh packaged client completed a real local Huihui Qwen 27B run against the localhost OpenAI-compatible service and a manual compaction. The UI showed a terminal completed state without `unexpected-frame`; after normal `⌘Q` and relaunch, the synthetic session, Run Details, and compacted result were restored. Candidate processes exited cleanly. Other unaffected Stage 13 Session/Task/Run, guarded-resume, repeated-tool guard, isolation, maintenance, native-runtime, and client-semantic evidence was reused from the already completed qualification runs.

The final source `check:all` run reported 60 gates passed and 7 raw gate failures. The four hygiene/documentation gates remain raw `FAIL` and are classified only under their approved unchanged-debt decisions: 38 client-domain findings, 7 clone groups (69 lines / 567 tokens), 15 repository references, and 3 concrete terms; no relevant source files changed after their identity comparisons. `verify-config-catalog` and translation pairing passed. `test` and `test:snapshot` also reported the known host Python 3.9.6 incompatibility for PTC tests (the targeted Python 3.12 qualification passed previously) and missing Playwright Chromium cache. Two additional aggregate-only test failures—a 5-second plugin-manager timeout and an extra request in the mocked one-shot CLI case—both passed their single-file focused rerun; the source files were unchanged by this candidate. These raw aggregate outcomes are recorded, not relabeled as gate passes. No new product regression or safety-sentinel failure was found.

The Stage 13 qualification commit records this result; installation, baseline tagging, and user-data cutover are separate subsequent actions. The approved static debts remain unresolved and are not represented as repaired.

## Consequences

### Safety, native, maintenance, and unresolved contracts

Every data/migration test sets temporary `DSH_HOME`, profile, userData, and Application Support equivalents and uses synthetic or copied released fixtures. Real user data stays out of scope through Phase 8C.2 until a separately authorized migration rehearsal. The future cutover must quiesce both products, snapshot settings, Sessions, and `desktop-custom`, record hashes and a restore manifest, migrate and validate a copy, and require explicit approval before shared-store access. A source rollback must restore that snapshot whenever bidirectional Session compatibility is not proven. Electron `sessionData` remains product-flavor state and is never confused with DSH Session JSONL.

Native qualification adopts the upstream runtime lock and verifies architecture, payload hashes, deep codesign, Node and Python execution, `native/system`, `node-pty`, `koffi`, `sharp`, Host startup, and renderer loading. It occurs on a candidate path only, never the installed stable applications.

The Phase 8B auditor, monitor, scheduler, notification, and maintenance runtime remain a repository-only plane. They port after product composition stabilizes, adapting package scripts and documentation paths while preserving cursor, state, daily schedule, material-change-only notification, and stable Homebrew Node/repository tsx entrypoints.

The remaining contracts are stop-gated to later stages: v3 registration versus ignorable semantics for Custom durable events; final IQ3_S mapping into the current pi-ai catalog; the current dockkit/scoped-slot Run Details insertion contract; and packaged DS Harness primary-runtime/ABI behavior. None requires real user data or stable-App mutation to resolve.

Compatibility debt remains **CRITICAL / BLOCKING_CHANGE / UNRESOLVED**. Stages 1–3 prove the target, product identity, and isolated data contract; they do not prove packaging, Custom durable-event adaptation, live data cutover, later capability ports, or a new product baseline.
