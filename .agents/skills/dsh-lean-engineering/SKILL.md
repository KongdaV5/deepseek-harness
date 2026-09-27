---
name: dsh-lean-engineering
description: >
  Lean software-engineering discipline for coding, debugging, refactoring,
  migrations, repository maintenance, and long-running project work.
  Minimize unnecessary context, scans, code, tests, tool output, waiting,
  and repeated verification without weakening correctness or safety.
asset_id: skill.engineering.dsh-lean-engineering
version: 1.1.0
status: active
---

# Lean Engineering

Use the smallest reliable engineering path.

Efficiency means removing redundant work, not guessing, weakening safety,
or skipping evidence required by the current task.

## 1. Scope narrowly

Identify the exact requested outcome and the smallest likely affected surface.

Do not turn a local task into a repository-wide audit.
Do not begin adjacent phases or improvements unless required for correctness.

## 2. Reuse confirmed project state

Treat accepted manifests, architecture decisions, baselines, prior verified
results, and current handoff state as evidence.

Do not re-audit confirmed facts unless:

- the current change touches that contract;
- new evidence contradicts it;
- the target/version changed;
- the task explicitly requires re-verification.

Prefer delta analysis over reconstructing project history.

## 3. Read the narrowest useful evidence

Start with:

known file / symbol / error
→ nearby dependency
→ affected package
→ broader repository search only if necessary.

Avoid repeated full-repository scans.

If a broad search is necessary, do it once, retain the useful conclusions,
and continue from that compact state.

Keep tool output bounded. Prefer relevant failures, summaries, and focused
diffs over full logs and large dumps.

## 4. Use the minimum sufficient implementation

Before adding new code, prefer in this order:

existing behavior
→ existing repository helper/pattern
→ standard library or platform-native capability
→ existing dependency
→ small local implementation
→ new abstraction/dependency only when required.

Reuse upstream-native capabilities whenever they already satisfy the needed
invariant.

Do not add speculative abstractions, fallbacks, frameworks, configuration,
or extension points for hypothetical future needs.

## 5. Verify in proportion to impact

Default validation order:

focused static/type/lint checks
→ focused unit/integration tests
→ affected subsystem tests
→ affected build/package
→ full regression only when justified.

Use broad regression for cross-cutting contracts, schemas, persistence,
runtime/ABI, packaging/release, migration, security, or final qualification.

Do not rerun expensive global verification merely to reconfirm unchanged
invariants.

## 6. High-risk work overrides efficiency

For migration, persistence, security, destructive operations, release/install,
runtime/ABI, concurrency, or irreversible changes:

- use stronger evidence;
- make rollback implications explicit;
- use isolated fixtures/copies before live data;
- distinguish source rollback from data rollback;
- fail closed when evidence is insufficient.

Never save tokens by weakening a safety gate.

## 7. Do not spend model time babysitting external work

Downloads, uploads, long compiles, package fetches, network waits, and other
slow external I/O are not reasoning tasks.

Do not repeatedly poll or narrate unchanged progress.

When external work blocks progress:

- establish the real blocker;
- preserve resumable state;
- state the exact continuation point;
- stop or hand execution back to the environment/user as appropriate.

When resumed, continue from the saved point instead of re-investigating the
completed work.

## 8. Keep reasoning and reporting lean

Use the least expensive reasoning level that can reliably complete the task.

Escalate only for genuine architecture ambiguity, migration/safety issues,
cross-subsystem root causes, or final high-risk qualification.

Implementation under a locked design, routine ports, focused tests, and
known-file edits should not automatically use maximum reasoning.

Final reports should be delta-only:

- result;
- material changes;
- verification;
- blocker/risk;
- next gate if relevant.

Do not repeat long project history or unchanged safety facts.

One concise sentence is enough for unchanged protected state.

## 9. Stop at the requested gate

When the requested task or stage is complete, stop.

Do not automatically continue into the next phase.

Also stop and re-scope when:

- repeated searches produce no stronger evidence;
- the same root cause has already been established;
- work is mostly waiting or repeated verification;
- the task has drifted;
- proceeding would cross a safety or authorization boundary.

The goal is not the fewest possible actions.

The goal is the fewest actions required for a reliable result.
