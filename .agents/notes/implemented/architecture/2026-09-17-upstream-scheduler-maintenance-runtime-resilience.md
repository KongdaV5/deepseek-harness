# Agent Note: The upstream scheduler stores stable maintenance runtime entrypoints

Status: implemented

English | [中文](2026-09-17-upstream-scheduler-maintenance-runtime-resilience.zh.md)

## Problem

The user LaunchAgent correctly separates repository maintenance from the installed DS Harness application, but its Node and tsx `ProgramArguments` must not resolve through version-specific implementation paths. A Homebrew cleanup after a normal `node@24` update can remove a referenced Cellar version, and a pnpm dependency refresh can replace a `.pnpm/tsx@version` internal directory. Requiring a manual scheduler reinstall for either ordinary maintenance event defeats the purpose of unattended upstream observation.

Launchd cannot rely on an interactive PATH, Corepack, pnpm, or `/usr/bin/env node`. The replacement must remain explicit, validate the intended Node major and architecture, stay entirely outside the application runtime, and leave monitor, notification, cursor, debt, report, and scheduler state semantics unchanged.

## Decision

[`scripts/upstream-schedule.ts`](../../../../scripts/upstream-schedule.ts) discovers the maintenance Node at install and status time with `brew --prefix node@24`, then stores the lexical stable executable path `<prefix>/bin/node` in the plist. Homebrew owns this `opt` symlink and moves it to the selected Cellar release on formula updates; the scheduler deliberately does not call `realpath()` before rendering the plist, so it never persists a Cellar release directory.

The repo-local tsx entrypoint is likewise stored as `<repository>/node_modules/tsx/dist/cli.mjs`, not `node_modules/.pnpm/tsx@<version>/…`. pnpm currently provides `node_modules/tsx` as its normal package link, making this a stable repository-facing dependency path after a completed `pnpm install`. The scheduler does not copy or shadow tsx.

Installation and status validate the stored invocation without resolving its symlinks: the Node and tsx paths must exist; Node must execute; `node --version` must be major 24; `process.arch` must be `arm64`; and the exact Node plus tsx plus scheduler source must complete the safe runtime probe. A Cellar Node path, a pnpm-internal tsx path, an absent path, a non-24 Node, a non-arm64 process, a failed probe, an unavailable stable Homebrew prefix, or a missing repository entrypoint causes a visible failure rather than a silent fallback.

The loaded LaunchAgent remains `dev.dsh.upstream-monitor`, scheduled daily at local 09:00. Reinstallation only replaces and reloads its owned plist and never deletes `.artifacts/upstream-monitor/state.json`, scheduler notification state, reports, debt, or tags. `status` reports the validated maintenance Node path, tsx path, Node version, architecture, and any runtime validation error.

## Upgrade simulation and verification

The scheduler tests simulate stable `node@24/bin/node` and `node_modules/tsx/dist/cli.mjs` symlinks first targeting Cellar `24.21.0` and pnpm `tsx@4.22.4`, then retargeting to `24.22.0` and `tsx@4.23.0`. The plist text remains unchanged and continues to name the stable links. Tests also reject a version-pinned Cellar path, a pnpm-internal tsx path, a missing stable runtime, and Node 25.

## Stage 12 port delta

The stable-runtime design is preserved unchanged when the scheduler is ported onto the current upstream adaptation: the same `brew --prefix node@24` discovery, the same lexical stable paths, the same Node 24 and arm64 validation, and the same refusal of pnpm-internal or version-pinned paths. The Stage 12 port installs nothing on the real host; the resilience contract is exercised only through simulated runtime links in temporary directories, so no host LaunchAgent, plist, or monitor state is touched.

## Alternatives considered

- **Persist the Cellar executable after `realpath()`.** Rejected because identity validation would turn a stable Homebrew entrypoint into a stale release path. The scheduler verifies the target by execution while retaining the lexical stable path.
- **Use `node` or `/usr/bin/env node` in the plist.** Rejected because launchd does not inherit a dependable interactive PATH.
- **Run `brew --prefix` on every scheduled invocation.** Rejected because runtime execution should be deterministic and independent of a working Homebrew command. Discovery occurs only during install and status.
- **Use the DS Harness bundled Node.** Rejected because the application runtime must remain independent from repository maintenance and can be deleted, rolled back, or replaced.
- **Copy a private Node or tsx runtime into scheduler artifacts.** Rejected because it would introduce an unmanaged shadow runtime. Standard Homebrew and pnpm maintenance already own these dependencies.
- **Accept any future Node major.** Rejected because maintenance compatibility is an explicit Node 24 contract; a Node 25 transition must be reviewed instead of silently adopted.

## Consequences

- Normal Homebrew patch and minor upgrades and normal pnpm tsx dependency upgrades do not require a plist rewrite when stable links remain valid.
- A broken opt link, removed node formula, moved repository, absent tsx dependency, incompatible Node major, or architecture mismatch stops visibly in install or status rather than silently choosing another executable.
- The scheduler still cannot run when the repository itself is unavailable, and it does not discover moved repositories automatically; explicit reinstall remains the safe recovery action.
- This resilience design neither proves upstream compatibility nor changes the observation and notification policy. Existing `BLOCKING_CHANGE` debt remains unresolved, and isolated adaptation, build, and test remain separate work.
