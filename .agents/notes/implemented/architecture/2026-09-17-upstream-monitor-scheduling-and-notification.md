# Agent Note: User-level upstream monitoring notifies only on new material evidence

Status: implemented

English | [中文](2026-09-17-upstream-monitor-scheduling-and-notification.zh.md)

## Problem

The incremental monitor records upstream evidence correctly, but a daily manual command is unreliable and a daily success message would be noise. The established B8.1 product-to-upstream compatibility debt is already `CRITICAL` and `UNRESOLVED`; repeating it through Notification Center would not convey new information. A scheduler must run in the user domain, survive a non-interactive launchd environment, distinguish new material evidence from historical debt, and preserve monitor correctness when notification delivery fails.

## Decision

Phase 8B.3 adds [`scripts/upstream-schedule.ts`](../../../../scripts/upstream-schedule.ts) and five explicit commands:

```sh
pnpm upstream:schedule:install
pnpm upstream:schedule:status
pnpm upstream:schedule:run
pnpm upstream:schedule:uninstall
pnpm upstream:schedule:test-notification
```

Installation creates the owned user LaunchAgent `dev.dsh.upstream-monitor` at `~/Library/LaunchAgents/dev.dsh.upstream-monitor.plist`. It uses `StartCalendarInterval` at 09:00 in macOS local time, has no `RunAtLoad`, no keep-awake behavior, and no root, daemon, cron, or third-party scheduler. The plist records label, project identity, repository path, entrypoint, installed-at timestamp, schedule, and notification threshold for provenance. Install refuses a loaded same-label service without the owned plist; update/uninstall first verify the owned label, project marker, and repository path.

The plist invokes the install-time resolved maintenance Node executable and the repository `tsx/cli` entrypoint directly. It does not depend on shell PATH, `pnpm`, Corepack, Homebrew shell startup files, or `/Applications/DS Harness.app`. Installation probes this exact Node + tsx + scheduler combination before bootstrap and validates the plist with `plutil`. `status` reads ownership, loaded state, local schedule, repository availability, logs, and scheduler state. `run` uses `launchctl kickstart` and waits for the wrapper's completed state record, so verification follows the actual LaunchAgent path rather than a bypass.

The wrapper imports the existing monitor and never reimplements its Git/audit business logic. It writes atomic scheduler state at `.artifacts/upstream-monitor/scheduler-state.json` and bounded JSON-lines logs at `.artifacts/upstream-monitor/logs/scheduler.log` and `scheduler.err.log`. Each log is rotated at 256 KiB and retains only its current file plus one `.1` predecessor.

## Notification policy

The default material threshold is `MEDIUM`, configurable only through the scheduler CLI/plist argument; no product UI preference is added. Notification Center is invoked with built-in `/usr/bin/osascript`, without a third-party notification dependency.

| Monitor result | Notification behavior |
| --- | --- |
| `NO_NEW_UPSTREAM_CHANGES`, `NONE`, `LOW`, `LOCKED` | Silent |
| New `MEDIUM`, `HIGH`, `CRITICAL` incremental range | Notify |
| Existing historical debt alone | Silent |
| `UPSTREAM_HISTORY_DIVERGENCE`, `STATE_INVALID`, `CHECKOUT_MUTATED`, missing remote/ref | Notify immediately |
| First `FETCH_FAILED` | Record only |
| Second consecutive `FETCH_FAILED` | Notify once; later repetitions stay quiet until recovery |

Material event identity is `targetSha + incremental risk + impact`; the notification state keeps a bounded history of notified keys. A reclassification of the same target from MEDIUM to HIGH has a distinct key and may notify once. Existing B8.1 debt may appear as short secondary context for a new material notification, but cannot trigger one.

Notification delivery happens only after monitor completion and scheduler state persistence. A delivery failure leaves the monitor cursor untouched, stores the event as pending, writes `lastNotificationError`, returns scheduler exit code `4`, and retries delivery on a later scheduled run without re-auditing the old range. Monitor/integrity failures return `2`; normal no-change/new-change outcomes return `0`; an active monitor lock returns `3` without notification.

`test-notification` sends the explicit body “Notification test successful.” without running the monitor or writing monitor/scheduler state. It is intentionally distinct from a material-change notification.

## Safety boundary

The scheduler belongs to the repository maintenance plane. It fetches and invokes the existing read-only monitor but never merges, rebases, cherry-picks, resets, pushes, adapts upstream, builds or packages DS Harness, installs/replaces an app, changes either baseline tag, reads `~/.dsh`, profiles, settings, Sessions, Application Support, or invokes any cloud/local model. Uninstall removes only a verified owned LaunchAgent plist; it never deletes monitor state, reports, compatibility debt, source, tags, or product data.

The completed B8.2 monitor remains the authority for cursor movement. The scheduler cannot advance the cursor outside that transaction. Its own state is separate from the product baseline and compatibility debt.

## Verification

[`scripts/upstream-schedule.spec.ts`](../../../../scripts/upstream-schedule.spec.ts) uses injected monitor/notifier/launchctl dependencies and temporary output homes. It covers silence for no-change/NONE/LOW/lock/debt, MEDIUM/HIGH/CRITICAL delivery, same-target escalation, deduplication, fetch-failure debounce/reset, immediate integrity notification, pending delivery failure with cursor preservation, plist rendering, idempotent install, and ownership-guarded uninstall.

The real user LaunchAgent is installed, `plutil`-validated, bootstrapped, and verified with `launchctl kickstart`. The real scheduled path completed twice with `NO_NEW_UPSTREAM_CHANGES`, exited 0, updated only scheduler metadata/logs, and sent no material notification. A separate built-in Notification Center test delivered successfully without modifying monitor or scheduler state.

## Alternatives considered

- **Put a large shell pipeline directly in the plist.** Rejected because launchd PATH and shell behavior are unstable and policy would duplicate monitor logic. The TypeScript wrapper has a validated, inspectable contract.
- **Use the installed DS Harness runtime.** Rejected because product runtime and repository-maintenance runtime need independent lifecycle and upgrade boundaries.
- **Notify every successful check or repeat existing debt.** Rejected because routine no-change checks and known debt are not material events; they would train the user to ignore notifications.
- **Notify every fetch failure.** Rejected because transient network failures are common. The second consecutive failure is the first actionable signal; recovery resets the count silently.
- **Roll back monitor state on notification failure.** Rejected because notification is downstream presentation. Reverting a successful observation would cause redundant auditing and could misrepresent the cursor.
- **Install a system daemon or cloud/webhook service.** Rejected because this task requires local, user-authorized, private macOS maintenance only.

## Consequences

- The Mac checks upstream daily at 09:00 local time while it is running and the user is logged in; normal checks remain silent.
- New material upstream evidence is concise, deduplicated, and linked to retained local report/state evidence rather than a repeated historical blocker.
- The scheduler is removable without affecting DS Harness product/runtime data, but a moved or unavailable repository requires explicit reinstall rather than automatic path discovery.
- Notification Center delivery confirms only presentation command success; neither notification nor monitor automation proves upstream runtime compatibility. Existing `BLOCKING_CHANGE` debt remains unresolved, and Phase 8C isolated adaptation/build/test is still separate work.
