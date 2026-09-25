---
description: "Run Details surface for the Web GUI: a read-only composer-context strip showing the current Run's identity, phase, health, steps, retries, reasoning, compaction audit, and task continuity; for users and maintainers of the run diagnostics experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-run-details

English | [中文](README.zh.md)

## Summary

The Web GUI Run Details surface shows the current Run's identity, phase, health, step and retry counts, the main run's reasoning, the last durable compaction audit, and durable task continuity — all read-only. It renders nothing when there is no Run, so an idle session shows no "Run: None" placeholder, and an unobserved backend reads `Unknown` rather than being upgraded to reachable, idle, or healthy. The strip carries no control of any kind.

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

Mount this plugin alongside `ui-conversation` and the Run Details transport package; the strip then appears in the composer-context stack whenever the session has a Run. It ships in the custom desktop flavor only — the official client is unchanged.

### What it shows

- **Run** — the derived Run id (Session and turn), with phase and health badges.
- **Steps / Retries** — the durable counts, plus which step is still open.
- **Backend** — reachability and activity as one `Unknown` reading, because no observer is registered on this path.
- **Run reasoning** — the effort the durable request header proves, marked when the adapter materialized it.
- **Compaction** — the last committed policy audit, with its auxiliary reasoning in a row of its own so it is never mistaken for the main run's.
- **Live compaction** — the status a running compaction publishes right now, read from the transient transport; a transport failure shows its classified code and reason instead of the last value it managed to deliver.
- **Task** — the durable task checkpoint's identity and status, plus any crash-repair hazards.

### What it never does

It offers no retry, resume, cancel, or compact action. Every value arrives from a host-computed projection, so the strip cannot disagree with the fold and cannot write back to the Run it describes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Run cut arrives through `useProjection('runDetails')`, task continuity through `useProjection('taskCheckpoint')`, and the in-flight compaction status through `useResource` on the address derived from the Session. The two projections are whole values the host computes and the resource is a stream the host owns, so this package performs no domain folding. The entry contributes no injected face at all, which is what makes the surface structurally read-only: there is no verb to call and no handler to click.

The component is a pure function of those reads. It returns `null` when the projection has not served yet or when the cut reports `hasRun: false`, so the dock row occupies no space and no placeholder text is produced. Copy comes from the `runDetails` locale namespace; every label and value is a dictionary lookup with no client-side formatting of domain values beyond shortening the Run id for display.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the strip is not enough. They move from the browser strip to the transport and the slots it fills.

- [dsh-run-details](../../runtime-diagnostics/run-details/README.md) — the host transport projection that computes the cut this strip renders.
- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.input.dock` slot and owns the composer.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the strip is a browser-side read-only projection of already-computed run diagnostics; it registers no prompt, schema, tool, or result text.

#### KV Cache effect

None; it never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current Run Details surface. They are current package constraints, not a run-domain comparison or a task backlog.

- **Backend always reads `Unknown`** — the transport installs no observer, so reachability and activity cannot be inferred from this surface.
- **Live compaction is only as fresh as its transport** — the row renders what the generic diagnostics transport currently publishes; with no provider mounted the row is absent, and a restarted host reads as unknown until the owner republishes rather than showing a stale status.
- **A finished Run stays visible as history** — the strip describes the active Run, or the last closed one while none is open, so a session that has finished work still shows how its last Run ended.
- **Custom flavor only** — the official client does not mount this package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. There is a single Run Details dock registration whose disposal rides the plugin fiber — every durable value arrives through a projection seat, and the entry holds no subscription of its own.
