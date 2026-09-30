# Custom foundation migration ledger

English | [中文](custom-foundation.zh.md)

## Foundation and validation scope

P-UPSTREAM-0.2-M1 starts from the exact official `dsh-v0.2.0-rc.2` tag on `migration/upstream-0.2-rc2`. The trusted `feature/codex-subscription` branch remains unchanged. The original Custom ancestor is `dsh-v0.1.6-alpha.2`. The official target stays fixed throughout this package.

The candidate adopts the official Config, ConfigEditor, profile composition, agent-preset architecture, Session V4 codecs and immutable generation publisher. Custom state is limited to product identity, Local inventory, non-secret Codex configuration and mapping, and task authority. The legacy Settings store, settings-file package and full Custom runtime are absent from this foundation.

## Continuous ownership ledger

| Area | Upstream implementation reused | Old Custom code | Custom addition and reason | State / persistence / lifecycle owner | Compatibility | Custom implementation |
|---|---|---|---|---|---|---|
| Build/package | RC.2 topology, project references, tsdown and generators | REPLACED | Six necessary Custom packages; source-derived lockfile and catalogs | Package manifests / pnpm lock / official build | none | reduced |
| Config | Config, volatile references, ConfigEditor and Settings forms | REPLACED | No SettingsScope or installSection adapter | Plugin Config / profile patch / Loader | none | reduced |
| Codex config | Profile edit and live Config | ADAPT | Preference reader and exact non-secret auth facts | agent-codex / profile patch / ConfigEditor; M2 owns auth transactions | none | reduced |
| Local config | llm-pi-ai and agent-default-model Config | ADAPT | Local inventory and selected profile; no runtime observations persisted | custom-foundation; provider and selection stay with official owners / profile patch / Loader | none | reduced |
| Product/profile | Official profile bootstrap and data helpers | ADAPT | Product flavor, bundle identity source, explicit Custom root and rehearsal isolation | Desktop identity / desktop-custom profile / shell bootstrap | none | same |
| Legacy import | Official file lock and atomic write | REPLACED | Translate Custom namespaces before Settings mounts; digest recovers interrupted publication | custom-foundation / canonical profile patch plus unchanged source archive / initialization | temporary; remove after supported legacy Custom settings retire | reduced |
| Session V4 | Official adjacent edge, child catalog facts and immutable successor publication | REPLACED | Explicit pure incoming extension callback; no new transaction | Official Session / JSONL generations / official prepare-publish | one-way historical conversion, retained while V3 is supported | reduced |
| Codex events | Build-static format catalog and projection registry | ADAPT | Canonical plugin-qualified identity and strict mapping validation | agent-codex projection / Session V4 / registry | historical conversion only | reduced |
| Task events | Session single writer and native tool-role results | ADAPT | Canonical plugin-qualified identities and event-sequence conversion | task-checkpoint / Session V4 / registry and continuity service | historical conversion only | same |
| Continuity | turnBoundary projection and durable turn identity | KEEP + ADAPT | Stale-admission and disposal invalidation; no restored in-memory admission | task-checkpoint and pure run/lifecycle readers / Session / explicit admission | none | reduced |
| Compaction references | Official reference conversion and preserved V3 generation | ADAPT | Historical audit explicitly qualifies its V3 capture; digest and supplemental messages remain exact | captured audit / retained V3; V4 checkpoint evidence uses V4 positions / reader | permanent generation qualification | reduced |
| Runtime behavior | RC.2 AgentLoop and provider interfaces | DEFER | Local driver, Codex external turns, settlement and catalog are M2 | Future explicit runtime owner | no fake executor or success shim | deferred |
| Desktop/UI | RC.2 Host and shell architecture | DEFER | Identity and bootstrap only; ModelSelect and Run Details remain M2 | Desktop Host and client owners | none | deferred |

## Persisted Custom event inventory

The actual Custom Session producers persist three extension identities. Run authority is derived from native turn/step events; run-state and lifecycle-facts add no persisted extension event. Task-aware compaction attaches an audit to `compaction/summary` rather than creating another extension event.

| V3 identity | Official generic conversion | Canonical Custom V4 identity | References and consumer | Conversion and evidence |
|---|---|---|---|---|
| codex/subscription-state | plugin:codex/subscription-state when ignorable; required unknown events refused | plugin:codex/subscription-state | Stable DSH message IDs and turn/step ordinals; external thread/turn/correlation IDs; Codex projection | Validate payload, retain auth binding and every unresolved fact; isolated physical publication fixtures |
| task/checkpoint | plugin:task/checkpoint when ignorable; required unknown events refused | plugin:task/checkpoint | completedSteps tool-result SessionSeq; stable task/Run/output/revision/resume IDs; task projection and guarded resume | Map prior event positions through the official insertion map; retain payload kind/version and turn-derived identities; checkpoint, producer and continuity tests |
| task/result-manifest | plugin:task/result-manifest when ignorable; required unknown events refused | plugin:task/result-manifest | Stable output/task/run identity and manifest revision; result projection | Validate whole manifest and preserve independent revision authority; migration and producer tests |
| compaction/summary.policyAudit | Generic conversion retains unqualified Custom payload | compaction/summary.plugin:task-compaction-audit | Generation-qualified authorityAsOfSeq, protection digest and captured messages | Keep the complete historical audit under sessionFormatVersion 3; it is historical evidence and cannot become V4 continuation authority |

Native V4 producers and projections accept only the canonical plugin-qualified identities. Legacy names occur only in the incoming conversion. The mapping conversion never changes authGeneration, rotates CODEX_HOME, dispatches, resumes, settles or clears an operation. The authStateEpoch and auth transaction remain runtime responsibilities deferred to M2; no configuration initialization invents them.

## Failure and no-replay obligations

Config translation validates known sections before publication. Unknown sections stay in the archive. A profile digest detects publication-before-archive interruption, and existing profile values protect partial imports from overwriting later edits. Conflicting non-secret auth authority refuses publication.

The official generation publisher retains V3 bytes, validates V4 before exclusive publication and reuses an already published successor. Custom conversion errors produce no canonical V4 generation. Tests allocate private temporary roots; no fixture reads or migrates the formal Custom profile.

Codex intent, accepted, uncertain, pending synchronization, completed-but-not-delivered and unresolved reconciliation fixtures restore as reconciliation-required. A synchronized user-message cursor does not prove answer delivery; only an assistant settlement matching the reconciled DSH turn and step does. A recovery classification is never a dispatch authorization. Task admissions are process-local, not recovered from stored events; durable checkpoint revisions and completion evidence remain the only task authority.

## Composition and deferred integration

Custom bootstrap installs base, Web and desktop-custom bundles in order and resolves the exact Huihui model path into llm-pi-ai and agent-default-model Config. An uninitialized Custom layer uses an unregistered Local sentinel. The composition disables DeepSeek Account, hosted DeepSeek, hosted search, model-generated titles, timer and HMR. It does not add Schedule, Automation, Computer Use, a CUA driver or permission prompts.

M2 owns Local start/stop/switch and inference; Codex App Server lifecycle, auth transaction and epoch handling, external-turn dispatch/cancel/settlement/reconciliation/resume; dynamic model catalog and provider-aware admission; AgentLoop integration and task-aware compaction execution; Desktop background/quit behavior, ModelSelect, popups and Run Details. M1 does not package, install or qualify real inference.

## Focused qualification

The final M1 check selects Config/plugin and legacy import tests, Custom V3→V4 publication and recovery fixtures, checkpoint/continuity and run authority tests, Local-first and composition exclusion, product/rehearsal isolation, affected Host/Client typecheck and lint, generated catalogs, paired modified documentation, persistence acknowledgement, whitespace and workspace hygiene. No full historical runtime proof, full suite, Native build or GUI launch is part of this check.

The focused check covers 40 selected test files and 1,011 distinct tests. The first run passes 1,004 tests and finds one Chinese README structure failure; the corrected documentation passes all 22 owning tests. After the typed-lint corrections, the three affected test files pass all 73 tests. The final recovery-boundary checks pass all 129 tests in five affected files, including six new lifecycle and assistant-delivery cases. Host and Client typechecks pass after the official Host contract build. The final changed-file lint covers 63 files; generated artifacts, documentation, persistence acknowledgement, whitespace and workspace hygiene pass.

Immutable successor publication is exercised through the official prepare/publish/verify API and actual read-provider restart. The Native write-lock entry is not exercised because this package does not build Native bindings. This boundary does not add a replacement publisher or lock adapter. All persistence and Config fixtures use temporary roots; no formal Custom profile or authentication material is opened.
