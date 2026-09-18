---
name: dsh-lean-engineering
description: >
  Apply DS Harness's required lean engineering discipline to coding, debugging,
  refactoring, migrations, repository work, and project maintenance. Use it to
  minimize unnecessary context, scans, code, tests, tool output, and repeated
  verification without weakening correctness, safety, or explicit stage gates.
metadata:
  ai_brain:
    asset_id: skill.engineering.dsh-lean-engineering
    version: "1.0.0"
    status: active
    authoritative: true
---

# DS Harness Lean Engineering

Complete the requested engineering task correctly with the least unnecessary
context, code, tool activity, verification, and narration.

This is a long-term DeepSeek Harness project constraint. It applies to software
implementation, diagnosis, refactoring, migrations, repository maintenance,
and release qualification. It supplements project safety, Session, release,
and user instructions; it never relaxes them.

Efficiency comes from removing redundant work, not from guessing, skipping
required safety checks, or weakening the requested result.

## Establish the exact task

Before broad exploration, identify the requested outcome, artifact or behavior
that must change, smallest likely code surface, known constraints and confirmed
facts, and the next fact that must be established. Do not turn a narrow task
into a whole-project audit or expand into adjacent improvements unless required
for correctness or explicitly requested.

## Preserve confirmed knowledge

Treat verified project facts, manifests, architecture decisions, baselines,
handoffs, and accepted test results as working evidence. Re-open a conclusion
only when the change touches its dependency or contract, new evidence
contradicts it, the evidence is stale for the current target, or the task
explicitly requests re-verification. Prefer delta analysis over reconstructing
history.

## Read the narrowest useful evidence

Use this order:

1. Known relevant file or failing location.
2. Exact symbol, error, route, package, or configuration.
3. Nearby dependency or caller/callee.
4. Build/package metadata needed to explain behavior.
5. Broader repository search only if narrower evidence is insufficient.

Prefer targeted searches and bounded output. If a broad scan is necessary, do it
once, preserve a compact fact summary, and continue from that summary.

## Control tool output

Prefer focused paths, exact search patterns, failing test names, diff statistics
before full diffs, filtered errors/warnings, and short log windows. Do not dump
full successful build logs, unrelated successful test output, full Git history,
or generated files unless their contents are necessary. Keep only the facts
needed for the next action after a large output.

## Use the minimum implementation ladder

Stop at the first option that correctly solves the task:

1. No change is needed.
2. Reuse an existing repository helper, abstraction, pattern, capability, or platform integration.
3. Use the language standard library.
4. Use an operating-system, browser, database, framework, or platform feature.
5. Use an installed dependency.
6. Add a small local implementation.
7. Add an abstraction or dependency only when simpler options fail the actual requirement.

Do not add speculative configuration, factories, adapters, fallbacks, wrappers,
or extension points. Reuse upstream-native behavior when it satisfies the
required invariant.

## Prefer semantic changes over patch replay

When upstream architecture changed, preserve required behavior and invariants:
identify upstream-native capability first, retain it when sufficient, and port
only missing behavior. A clean Git merge is not proof of semantic compatibility.
Avoid duplicate subsystems.

## Match verification to the change

Use proportional verification in this order:

1. Related static/type/lint checks.
2. Focused unit or integration tests.
3. Affected package/subsystem tests.
4. Build of the affected artifact.
5. Broader regression only when justified.

Run broader regression when the change is cross-cutting; changes shared
contract/schema/runtime, packaging/release behavior, or data migration;
reaches a milestone/final gate; or cannot be established safely with focused
evidence. Do not repeat expensive unchanged checks merely for reassurance.

## High-risk work overrides savings

Use stronger analysis and validation for data/schema migration, persistence,
security, permissions, destructive operations, release/update/install logic,
runtime/ABI changes, concurrency, difficult cross-subsystem bugs, and
irreversible changes.

Make rollback implications explicit, distinguish source rollback from data
rollback, use isolated fixtures or copies before live data, and fail closed when
evidence is insufficient. Never save tokens by weakening a safety gate.

## Keep project and task state separate

Long-term project rules belong in project instructions, manifests, and
architecture records. This Skill supplies engineering discipline. Each task
prompt should carry only its goal, current-state deltas, task-specific
constraints, deliverables, and stop gate; do not repeat project history.

Maintain a compact working state: goal, confirmed facts, target/version, locked
decisions, relevant files, changes, verification, blockers, and exact next
action. Resume from it rather than rescanning. Create a new handoff only when a
task changes materially, stale exploration dominates, or a major boundary is
crossed.

## Use reasoning effort proportionally

Use higher reasoning for architecture, migrations, security, cross-subsystem
design, unclear root causes, and high-risk final qualification. Use ordinary
reasoning for implementation under a locked design, mechanical ports, localized
refactors, routine tests, formatting, documentation, and known-file edits.
Escalate only when the cheaper reliable path is insufficient.

## Avoid redundant review loops

Verify what changed, what it can affect, relevant invariants, and the current
stage gate. Defer global qualification to explicit milestone gates. Adjacent
stages may share evidence only when that does not blur migration approval,
destructive action, release/install authority, security boundaries, or rollback
gates.

## Report deltas, not history

Default reports contain result, changed behavior, why, important files,
verification, remaining risk, and the next gate. State protected unchanged
resources once. Provide a full audit only when the user requests it or a
release/migration gate requires durable evidence.

## Stop when complete

Stop and summarize when the requested deliverable is complete and the current
gate passes. Do not enter the next phase automatically. Re-scope or stop when
searches expand without stronger evidence, repeated attempts share a cause,
output becomes noise, scope drifts, a fact cannot be safely established, or
proceeding crosses an authorization or safety boundary.
