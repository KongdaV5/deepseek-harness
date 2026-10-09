---
description: "Persist task checkpoints and result manifests through the canonical Session writer. Restore guarded-continuation authority after restart. Refuse stale revisions, missing completion evidence and unresolved tool outcomes before a continuation can be admitted."
kind: package-reference
---

# @deepseek-ai/dsh-task-checkpoint

English | [中文](README.zh.md)

## Summary

Persist task checkpoints and result manifests through the canonical Session writer. Restore guarded-continuation authority after restart. Refuse stale revisions, missing completion evidence and unresolved tool outcomes before a continuation can be admitted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use through the Custom profile bundle composition; this package owns no additional application launcher.

For bounded in-process continuation after an output-limit end, set `maxAutoContinuations` on the plugin from `0` to `5`. It defaults to `0`; the Custom desktop profile sets it to `5`. Only `max-tokens` turn endings trigger a follow-up, and pending user input takes precedence. Each follow-up is a separately recorded user message whose chain and attempt number are validated by a Session projection.

When enabled, the system prompt asks the model to create or reuse a concise Markdown checkpoint before broad codebase exploration, update it after each completed phase and before likely context compaction or an output limit, and read and verify it after a compacted summary or automatic continuation. For coding work, the checkpoint records exact paths and line ranges already inspected and distinguishes read-only inspection from edits, so the next phase can resume without repeating unchanged discovery. The prompt reuses an existing progress file when possible; otherwise it selects `.tmp/dsh-task-progress.md` only if `.tmp/` already exists, or `.dsh-task-progress.md` at the workspace root. This is model guidance backed by bounded turns; it does not guarantee that a model will successfully write the file.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Native events use plugin:task/checkpoint and plugin:task/result-manifest; payload kind and version retain their domain identity. Tool-result evidence uses V4 SessionSeq coordinates and native tool-role isError. Task and output revisions, Session identity and turn-derived Run identity are preserved. The registered projections own state; the Session owns persistence. A process-local admission is never restored or replayed, and a changed checkpoint revision or disposed service invalidates deferred adoption.

No runtime invariant companion is published because persistence writes use the existing Session or ConfigEditor validation and this package owns no independently diverging state copy.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Custom foundation ledger](../../../docs/custom-foundation.md)

-----

<a id="model-experience"></a>
## Model Experience

### Persistence foundation

#### What the model sees

The `buildResumeContext` builder renders bounded task facts for the execution owner. It makes no model request; the caller accounts for rendered context within the admitted token budget.

#### Token effect

No model request; rendered continuation context consumes the caller-owned bounded budget.

#### KV Cache effect

No direct effect; this layer executes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Transport, UI and task-aware compaction execution belong to M2. Captured legacy compaction audit references remain explicitly qualified to the retained V3 generation; they cannot authorize a V4 continuation.

-----

<a id="dev-note"></a>
### Dev Note

Maintainers validate Config, persistence and disposal through the owning isolated tests.
