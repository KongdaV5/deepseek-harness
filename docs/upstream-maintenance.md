# Upstream maintenance reference

English | [中文](upstream-maintenance.zh.md)

## Summary

<a id="summary"></a>

This reference describes how Custom DSH detects official releases, inspects semantic impact, and selects affected validation. Inspection keeps the qualified Custom product and installed App unchanged. The canonical declaration is [the seam registry](../scripts/upstream-tracking-seams.json); [maintenance policy](../scripts/upstream-maintenance.json) records the actual integrated official ancestor.

## Table of Contents

<a id="table-of-contents"></a>

- [Commands](#commands)
- [Ownership and contracts](#ownership-and-contracts)
- [Impact and evidence](#impact-and-evidence)
- [Identity, ancestry and statistics](#identity-ancestry-and-statistics)
- [Observation, integration and qualification](#observation-integration-and-qualification)
- [Current RC example](#current-rc-example)
- [Further exploration](#further-exploration)

## Commands

<a id="commands"></a>

Run these commands from the repository root with the existing Node.js, pnpm, Git, GitHub CLI and installed development dependencies. Online commands read the official repository's published releases and refs; unavailable metadata fails explicitly. They do not install dependencies.

```sh
pnpm upstream:check
pnpm upstream:inspect --tag dsh-v0.2.0-rc.2
pnpm upstream:inspect --tag dsh-v0.2.0-rc.2 --json --output .artifacts/upstream-maintenance/rc2.json
pnpm upstream:test --report .artifacts/upstream-maintenance/rc2.json
```

`check` reports Custom HEAD, published RC/stable channels, the last synced tag/SHA, master, local object availability, merge base and a cheap package/overlap summary. A missing stable release is `null`. Missing objects produce `OBJECTS_MISSING`, unknown counts and a recommended explicit refresh command.

`inspect` resolves an official tag to its exact SHA, identifies release status, and compares merge-base → Custom, last-synced → target, and merge-base → target. `--master` opts into developer inspection of the moving development branch. An unpublished tag is labeled unpublished and cannot be mistaken for a published watch-channel release.

`test` defaults to **DRY RUN**. It lists exact specs, changed contracts, consumers, evidence states and qualification gaps. `--run` executes only the reviewed keyless unit allowlist from the recomputed plan. Other selected specs remain explicit qualification requirements; selection does not claim that the current product's tests qualify the target's new format. No report can supply executable commands.

All commands support `--json`. `check` and `inspect` write only when `--output` names an ignored file inside `.artifacts/`. Output refuses tracked files, symlinks and paths outside that directory. An explicit inspect output also records local `last-inspected.json`; it does not change the integration policy.

`--refresh` on `check` or `inspect` fetches official objects without moving branch/tag refs or writing `FETCH_HEAD`; it caches the official catalog under ignored `.artifacts/upstream-maintenance/`. Default commands never fetch. `--offline` uses that cache and labels sourceVerification `CACHED_UNVERIFIED`; stale offline metadata cannot authorize `--run`. Offline operation with no valid cache fails explicitly.

## Ownership and contracts

<a id="ownership-and-contracts"></a>

The registry defaults to `UPSTREAM`. Explicit rules declare `CUSTOM` semantic ownership or `MIXED` shared seams, their reasons, invariants, consumed contracts, affected specs and minimum impact. Later rules override broader ones; technical tags such as `GENERATED`, `DERIVED` and `LOCKFILE` complement ownership. Rule patterns describe modules rather than a second ownership inventory. Incoming contracts may name packages absent from Custom, but ownership patterns must match current files.

Contract changes propagate from providers to dependent contracts and Custom consumers, even without a directly overlapping path. For example, replacing Settings affects Codex and Local settings consumers while the Codex adapter source remains unchanged. Registry validation rejects missing tests, stale ownership patterns or declared symbols, missing dependencies and cycles. Unregistered Custom changes produce `REVIEW_REQUIRED`, never an automatic safe result.

Critical invariants include the qualified Huihui Qwen Local-first route, official-only Codex subscription transport, canonical DSH conversation identity, no replay, account-generation isolation, independent Codex Runtime Maintenance, Custom profile boundaries, no silent model substitution and serialized Local runtime ownership. Inspection reports which invariants need revalidation; it does not requalify them.

## Impact and evidence

<a id="impact-and-evidence"></a>

Classification uses functional source changes and dependency causality. File counts, release versions and direct overlap are descriptive statistics, not sufficient risk evidence. Version-only package manifest changes are metadata. Documentation, locale and style changes do not invalidate authentication proof.

| Level | Meaning | Required review |
|---|---|---|
| U0 | Documentation, locale, format or style metadata | Review the nonfunctional change |
| U1 | Official leaf change without a Custom consumer | Review an explicit sync candidate |
| U2 | Localized Custom/Mixed leaf | Select affected leaf validation |
| U3 | Agent, Session, host, provider, runtime or Desktop contract | Revalidate dependent integrations |
| U4 | Persistence, security or core configuration architecture | Stage semantic migration before qualification |

Evidence has only `UNCHANGED`, `AFFECTED` and `INVALIDATED` states. Changed dependencies make consumers `AFFECTED`; directly changed persistence/security/lifecycle proof boundaries make their relevant evidence `INVALIDATED`. A model-selector change leaves Codex Q1 authentication evidence unchanged. Settings affects settings/auth integration; it does not automatically invalidate the authentication-generation contract. Session changes do not trigger full Codex runtime compatibility unless the App Server adapter/process contract actually changes.

The planner includes Session/persistence, Codex projections and settings, Local runtime/default model, external turns, Desktop profiles/lifecycle, model catalog/admission, Run Details transport, task continuity and compaction when their contracts change. Incoming migration, Schedule and Computer Use tests remain explicit gaps until those features are integrated. ABI/payload work belongs to release qualification. The execution allowlist excludes Native builds, packaging, GUI launches, Local inference, real credentials, profile mutation, migrations, full Codex compatibility and whole-repository tests.

## Identity, ancestry and statistics

<a id="identity-ancestry-and-statistics"></a>

A report binds Custom HEAD, target tag/SHA, real unique merge base, ownership/contract revisions, tool/schema version, timestamp and a digest of policy, registry and tool source. The planner rejects stale HEAD/revisions/source, changed official tags, incomplete history and dirty product source. It recomputes the plan from current official immutable objects rather than trusting report-selected specs. Git replace, grafts, shallow history, ambiguous ancestry and in-progress merge/rebase/cherry-pick operations fail explicitly.

The primary statistics use 50% rename similarity, unlimited rename detection and copy detection OFF. A rename counts as one logical change; both source and destination participate in overlap and ownership checks. A copied source is not automatically a conflict. Copy diagnostics, if performed separately with Git, are not the primary report statistic. Missing objects never mean zero commits behind.

Targets must resolve from `deepseek-ai/deepseek-harness`. Fork/mirror remote identities and arbitrary input SHAs fail. Published release metadata distinguishes RC, stable, draft and unpublished tags. Recorded official tag movement or removal fails review; the last-synced tag/SHA must remain an actual ancestor of Custom. Reports contain repository-relative source paths and source facts, with no home paths, tokens, conversations or profile data.

## Observation, integration and qualification

<a id="observation-integration-and-qualification"></a>

The watch channel includes published RC and stable releases. The sync channel requires a future explicit approval of an immutable official tag plus exact SHA. Master remains explicit developer inspection. `lastSynced` is the committed integration pin, currently `dsh-v0.1.6-alpha.2`. Ignored `lastInspected`, catalog and fetch state are observations. A monitor's watch cursor records what was observed/notified; advancing it never erases compatibility debt or advances the integration pin. The existing branch monitor and scheduler remain developer tooling; these commands do not install or change any external schedule.

Source sync and release qualification are separate. This tooling implements neither `upstream:sync` nor `release:qualify`. A future sync must consume a fresh inspected identity and preserve Custom invariants; qualification must independently cover migration, payload, runtime and installed-product requirements. Observed, integrated and qualified versions can therefore differ.

## Current RC example

<a id="current-rc-example"></a>

Inspecting `dsh-v0.2.0-rc.2` against the qualified Custom branch yields **U4 / STAGED_SEMANTIC_MIGRATION**. Tagged source changes Session format 3 → 4, adds migration that prefixes unknown ignorable events with `plugin:`, and replaces Settings-file persistence with volatile Config/profile patch editing and legacy import. Exact Custom `codex/subscription-state`, `task/checkpoint` and `task/result-manifest` projections need explicit migration design. Desktop lifecycle changes require focused validation. These are reported blockers; the target is not integrated or qualified.

Schedule and Computer Use are reported **AVAILABLE**, with explicit product activation required. Schedule delivery/recovery, Computer Use provider permissions/teardown and their shared lifecycle interactions remain future qualification work. Inspection never enables them. The next migration entry point is build/config/plugin foundations followed by separate persistence and provider stages.

## Further exploration

<a id="further-exploration"></a>

See [development](development.md), [testing](testing.md), [the read-only audit implementation](../scripts/upstream-audit.ts), and [the shared maintenance implementation](../scripts/upstream-maintenance.ts) for their owning contracts.

## Dev Note

<a id="dev-note"></a>

None.
