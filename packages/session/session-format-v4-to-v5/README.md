---
description: "V4-to-V5 Session event identity migration and native V5 codec."
kind: package-library
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

Restore supported V4 Sessions as V5 while preserving event positions, inherited cuts, and opaque records. V5 changes the Session header discriminator, adopts explicit message-source and first-party event identities, and keeps the released V4 physical row framing.

## Table of Contents

- [Use this package](#use-this-package)
- [V4-to-V5 specification](#v4-to-v5-specification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The build-static [format catalog](../session-format-catalog/README.md) invokes this adjacent edge for V4 body reads and uses the V5 codec for current writes. The package has no runtime plugin or profile mount. Direct imports are for the catalog and migration tests.

<a id="v4-to-v5-specification"></a>
## V4-to-V5 specification

### Header and physical framing

| V4 input | V5 result | Preservation or refusal |
|---|---|---|
| Logical Session header | `version: 4` becomes `5` | Every other admitted header field is retained exactly. |
| Physical JSONL header | V4 discriminator becomes V5 | The target codec reuses V4 physical framing and changes only the header version. |
| Event sequence and references | Identity mapping | Event order, `seq`, message IDs, tool IDs, SessionSeq references, and the inherited cut do not move. |

### Event identity changes

The installed DSH V4 build wrote these first-party optional records in the `plugin:` namespace. V5 writes them as ordinary first-party ignorable events, so the migration renames only the event `type` and retains its payload and envelope metadata.

| V4 event type | V5 event type |
|---|---|
| `plugin:codex/subscription-state` | `codex/subscription-state` |
| `plugin:task/checkpoint` | `task/checkpoint` |
| `plugin:task/result-manifest` | `task/result-manifest` |

Other `plugin:` records, including records without a declaration in the experimental catalog, remain opaque and retain their original name and payload. A required event the V5 build does not recognize is refused by the target restorer; an unknown event marked `ignorable: true` remains skippable.

### Message sources and delivery records

The V5 source map adds `task-auto-continuation`, which can appear in `user/message`, `developer/message`, `agent/inbox/spliced`, and `session/title-llm-request` message positions. The edge retains each source object byte-for-byte as JSON; it does not infer or rewrite producer metadata. The V4 codec admits any nonempty direct source `kind` and already preserves this local V4 representation.

Existing `session-log-deepseek/delivery-accepted` records keep their original `sessionFormatVersion` and watermarks. A V4 acceptance does not certify that a V5 successor was delivered. New V5 records are checked against the V5 Session identity and sequence.

### Validation and recovery

The V4 codec owns physical source decoding. This edge requires dense event sequences and validates a seeded inherited marker against the source cut; it emits one target event for every source event. The V5 codec owns target framing. `restoreReleasedV5Artifact` applies the established V4 lifecycle, surface, compaction, tool, title, catalog, and V4 delivery checks, then validates current V5 delivery markers. The installed current Session validator checks the complete V5 event schemas and payloads.

Header-only reads advance the header without reading event bodies. A strict body restore refuses malformed source rows or unsupported required events before persistence publishes a V5 successor. The V4 source bytes and generation remain the persistence layer's responsibility and are not modified by this package.

## Model Experience

None, as `dsh-session-format-catalog` alone invokes this package while restoring persisted Sessions.

### KV Cache effect

The package does not assemble model requests or alter model-visible message content. The Session catalog may publish a new generation after a successful migration; request reconstruction then uses that current generation.

## Known Limitations and Deferred Work

- **Adjacent source only** — this edge accepts V4 and V5 representations. Earlier generations must pass through their own released adjacent migrations first.
- **Opaque plugin records** — experimental plugin payloads are retained without interpreting their owner-specific data; their consumers remain responsible for validation.

<a id="dev-note"></a>
## Dev Note

None.
