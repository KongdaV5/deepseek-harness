# Agent Note: Profile boundaries and hidden Benchmark conditions

Status: implemented

English | [中文](2026-09-14-profile-benchmark-visibility.zh.md)

## Problem

Daily agent presets and a reproducible Benchmark had shared the same interactive roster. Treating a preset name as a reasoning tier would duplicate task policy in Profile composition, make routine sessions downgrade unpredictably, and permit an accidental Benchmark selection to alter the conditions being measured. The preset service had no session-overlay primitive, so an overlay-only Benchmark would require a new host capability.

## Decision

`dsh-agent-presets` accepts optional `visibility: hidden` metadata. Hidden presets remain discoverable internally and resolvable by exact id, but `remoteExportList()` excludes them from the interactive roster. They can therefore be selected only through an explicit empty-session entry point. This is a display and operational-safety boundary only; it is not authorization, and it never changes a preset's composition.

The local `benchmark` preset is marked hidden. Its existing restricted tool exposure remains the source of its capability condition. The external `dsh-reasoning-policy` receives an explicit `benchmarkPresets` declaration when a deployment mounts it. A matching composed preset id locks the declared provider, model, reasoning value, and raw-context preservation. Route mismatch and unsupported benchmark reasoning fail before provider I/O. The lock outranks a regular user reasoning override so a Benchmark condition cannot drift. Automatic compaction is refused only when that exact declaration requires original model-visible context.

Routine presets remain composition choices, not reasoning policies. `lite-general` is the daily default candidate with its general skill scope; `lite-amazon` narrows skill discovery for Amazon work; a real `code` preset can expose code-oriented capabilities. None means medium, low, or xhigh by its name. The existing xhigh-first classifier keeps complex, unknown, coding, and Amazon work at xhigh, uses low for clear mechanical operations, and uses medium only for clearly simple supporting analysis.

## Alternatives considered

- **A new session overlay system.** Rejected for this phase because current preset selection and composition are fixed at blank-session creation, and a new overlay lifecycle would broaden core surface area.
- **A permanent visible Benchmark Profile.** Rejected because normal daily selection can silently change benchmark conditions.
- **Infer a lock from the string `benchmark`.** Rejected because names are neither a capability contract nor a fixed provider/model route.
- **Map every Profile to a reasoning effort.** Rejected because tool scope and task difficulty are independent; it would undermine xhigh-first work and prompt-cache stability.

## Verification

Metadata tests prove that `hidden` round-trips and unknown values remain visible. Remote-roster tests prove hidden presets are absent from the interactive export while exact resolution remains available. Policy tests prove an explicit hidden Benchmark overrides an ordinary user request, rejects a fixed-route mismatch before adapter I/O, and keeps `lite-general`, `lite-amazon`, and `code` task-driven: complex work is xhigh and clear mechanical work is low.

## Consequences

The implementation adds no Agent Loop, LLM, Session, Desktop, launcher, retry, recovery, reasoning-budget, or Profile-composition core change. The hidden metadata field is ignored by an older runtime, which remains safe but continues to show the preset until a matching runtime build or compatible plugin backport is used. Existing Phase 2–5 capabilities remain shared external packages; they are not copied into each Profile. A source/test composition must still be mounted by a matching runtime before the official Desktop can expose these source changes.
