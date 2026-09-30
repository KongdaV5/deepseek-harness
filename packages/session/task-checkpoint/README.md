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
