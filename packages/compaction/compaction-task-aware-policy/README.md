---
description: "Task-aware compaction policy for DS Harness: an optional candidate policy layered over the unchanged BasicCompactionEngine that protects durable task authority across compaction, gates publication on a synchronous authority re-check, and spends at most one further candidate on a deterministic validation failure."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-task-aware-policy

English | [中文](README.zh.md)

## Summary

Protect durable task authority across compaction without owning it. The executor is already owned: `dsh-compaction-basic` decides when to compact, selects the range, prices it, calls the model, validates stability, and publishes the replacement. This package replaces none of that. It mounts one optional candidate policy the executor may consult, and its contribution is threefold: the latest checkpoint's authority is captured as a canonically hashed protection root and republished verbatim in a code-rendered block, publication is gated on a synchronous authority re-check, and a candidate failing deterministic validation is asked for once more before the compaction is refused.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **plugin**, and it owns no execution. Mounting it is a deployment decision: the official profile mounts nothing, so its compaction behaves exactly as the current upstream does.

```ts
import { Context } from '@deepseek-ai/cordis'
import TaskAwareCompactionPolicy from '@deepseek-ai/dsh-compaction-task-aware-policy'

declare const ctx: Context

// Installs the optional policy that `dsh-compaction-basic` resolves.
ctx.plugin(TaskAwareCompactionPolicy)
```

Once mounted, the executor resolves `ctx.compactionCandidatePolicy` and consults it at two points: `assess` before any destructive model-context operation, and `begin` after its own durable compaction bracket exists. When the executor finds no policy, nothing here runs and no suspension point is added; when it finds one, the executor still owns selection, pricing, summarization, stability validation, and publication.

### Fail-open when the Session tracks no Task

A Session that tracks no Task has no authority to protect, so the policy admits every entry, opens an inert transaction that decorates nothing and accepts whatever the executor produced, and reports an audit without a protection digest. The published replacement is then exactly what the executor would have published with no policy at all, and the audit records that fact instead of implying protection that never happened.

### Authority is captured, hashed, and republished verbatim

`protectTaskAuthority` reads one consistent authority cut and captures the task identity, revision, status, run identities, executions, step partition, resume context, failure and resume records, every evidence identity, every exact referenced result revision, and every repair hazard. That root is canonically serialized with sorted keys and hashed. Because the published replacement must carry exactly that value, validation re-parses the replacement, re-canonicalizes the payload, and compares digest and canonical form — so a reordered list, a duplicated block, or an edited fact fails rather than passes.

The block is **code-rendered**, never model-authored. `decorateRequest` returns it as `replacementContent`, and the executor appends it verbatim after the model's narrative inside the same replacement message. The model is shown the same facts as background through `supplementalMessages`, but the block it would have to forge is not in the model's output path at all.

### Publication is gated on live authority, synchronously

`assertPublishable` is synchronous by contract. It re-reads the projections, rebuilds the protection root, and compares digests in the same uninterrupted block that commits the replacement, so no `await` separates the proof from the write it authorizes. A checkpoint revision, a referenced result revision, an evidence identity, a hazard set, or the main Run's reasoning facts that moved during summarization stops the publication instead of being papered over by prose.

### The auxiliary ladder is bounded and truthful

The auxiliary summarization request asks for `low` reasoning on its first candidate and `medium` on a further one, and never for the main Run's effort. The ladder is a product invariant with exactly two rungs. Before any auxiliary model call, `begin` proves that the executor's declared route can actually honor the first rung; a route that cannot is refused rather than sent an unsupported wire value. A `decorateRequest` for a route other than the one the transaction priced fails closed.

### Nothing here becomes authority

The policy appends no Session event, writes no projection, creates no lock, retries nothing, and deletes nothing. The protected block is derived from the append-only log, which keeps every original event including the checkpoint and result manifests it was derived from. Its audit is recorded on the executor's existing `compaction/summary` event as an optional field, which is what keeps the event backward-compatible for a reader that predates this package.

-----

<a id="api"></a>
## API

```ts
import TaskAwareCompactionPolicy, {
  AUXILIARY_REASONING_LADDER,
  TASK_AWARE_POLICY_ID,
  TASK_AWARE_POLICY_VERSION,
  TaskAwarePolicyError,
  admitTaskAware,
  canonicalJson,
  parseTaskProtectionBlocks,
  protectTaskAuthority,
  protectionDigest,
  renderTaskProtectionBlock,
  resolveAuxiliaryReasoning,
  taskProtectionContent,
  taskProtectionSupplement,
  taskRepairHazards,
  textOfContent,
  unknownOutcomeHazard,
  usableInputTokens,
  validateTaskAwareCandidate,
} from '@deepseek-ai/dsh-compaction-task-aware-policy'

import type {
  TaskAwareCompactionDiagnostics,
  TaskProtection,
  TaskProtectionSnapshot,
  TaskCandidateValidationContext,
} from '@deepseek-ai/dsh-compaction-task-aware-policy'
```

| Export | Role |
|---|---|
| `apply(ctx, config)` (default export) | Register the `compactionCandidatePolicy` service the executor resolves. |
| `name` / `inject` / `Config` | Plugin identity, the `sessionProjections`/`taskCheckpoints`/`llm`/`tokenMeter` injections, and the empty config schema. |
| `TASK_AWARE_POLICY_ID` / `TASK_AWARE_POLICY_VERSION` | The stable policy identity and contract version recorded in every audit. |
| `protectTaskAuthority(snapshot)` | Build the canonical protection root and its digest from one authority cut; throws `TaskAwarePolicyError` when the cut has no Task or a protected fact cannot be resolved. |
| `protectionDigest(protection)` / `canonicalJson(value)` | The deterministic digest over the protected value, and the order-independent canonical serializer it uses. |
| `renderTaskProtectionBlock(protection)` | Render the delimited, code-authored block the executor publishes verbatim. |
| `parseTaskProtectionBlocks(content)` | Re-parse a published replacement into its blocks, which is what validation compares against. |
| `taskProtectionContent` / `taskProtectionSupplement` | The published replacement block and the background message shown to the auxiliary model. |
| `validateTaskAwareCandidate(candidate, context)` | The deterministic verdict: `accept`, one permitted `retry`, or a `reject` carrying its exact rule code. |
| `admitTaskAware(input)` | The pure admission decision: obstacle order, the manual exemption, and the task-less fail-open. |
| `resolveAuxiliaryReasoning(provider, model, capability, attempt)` | Resolve one ladder rung against the exact route's published capability. |
| `AUXILIARY_REASONING_LADDER` | The `['low', 'medium']` product invariant. |
| `taskRepairHazards(snapshot, taskId)` / `unknownOutcomeHazard(hazards)` | The addressed Task's hazards, and the unknown-outcome obstacle among them. |
| `usableInputTokens(contextWindow, maxTokens)` | The capacity arithmetic, floored at zero. |
| `textOfContent(content)` | The text projection used by validation and pricing. |
| `TaskAwarePolicyError` | The structured refusal, carrying a `TaskAwareBlockCode`. |
| `TaskAwareCompactionDiagnostics` | The transient per-Session observation, read through the service's `diagnostics(sessionId)`. |
| `TASK_AWARE_COMPACTION_DIAGNOSTICS_TOPIC` / `TASK_AWARE_COMPACTION_DIAGNOSTICS_SCHEMA` ([`./diagnostics-transport`](../../../packages/compaction/compaction-task-aware-policy/src/diagnostics-transport.ts)) | The topic this policy publishes and the schema identity every frame on it must repeat. |
| `createTaskAwareCompactionDiagnosticsProvider(source)` / `isTaskAwareDiagnosticsSource(value)` ([`./diagnostics-transport`](../../../packages/compaction/compaction-task-aware-policy/src/diagnostics-transport.ts)) | The transport adapter: the read/subscribe face the generic runtime-diagnostics controller registers, and the structural check that decides whether the mounted policy can serve that face at all. |

<a id="model-experience"></a>
## Model Experience

### Auxiliary compaction request

#### What the model sees

The summarization model receives the executor's replayed conversation prefix unchanged, plus one supplemental user message this policy supplies — a prose restatement of the durable task facts — inserted immediately before the executor's fixed compaction instruction. The conversation model never sees this request, and the checkable `task_compaction_context` block is deliberately absent from it: the model is shown the facts as background, not as the block it would have to reproduce.

#### Token effect

The supplemental message adds one fixed, bounded block to the auxiliary request, and the policy prices it through the executor's own meter before it makes any capacity claim: it reserves that cost out of the usable input budget and refuses an admission whose protected context cannot fit. It never raises the generation cap the executor resolved.

#### KV Cache effect

The replayed prefix is untouched, so the provider's warm prefix cache is still reused up to the inserted supplemental message; that message and the trailing compaction instruction are the only uncached input. A policy that changed the provider, model, tools, or replayed messages could not make that claim, which is why the decoration type has no field for any of them.

### Published replacement

#### What the model sees

The replacement the executor publishes carries the model's narrative, followed by the code-rendered `task_compaction_context` block appended verbatim inside the same message. The block states the protection hash it was rendered for and carries the canonical JSON of the protected value between its `[[dsh-task-authority]]` and `[[/dsh-task-authority]]` sentinels, so a reader that understands the delimiters can reconstruct the protected cut without the policy's process-local state.

#### Token effect

The block is a fixed size for a given authority cut, and the executor refuses any replacement that is not smaller than the span it shadows, so the published candidate always reduces future input history relative to what it replaced. The supplemental message is charged to the auxiliary call only and never to the conversation.

#### KV Cache effect

Replacing rather than appending, exactly as any other compaction checkpoint: reuse is preserved for the unchanged request prefix before the replaced range and invalidated from the first replaced token on. The protected block is the last content in the replacement, so it adds no prefix of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A validation failure is asked for once more and then refused** — the Custom policy admits at most two candidates within the native transaction; there is no third attempt, and exhausting the budget is a refusal rather than a degraded publication.
- **The protection root is only as strong as the projections it reads** — a protected fact that the Task projections do not expose cannot be captured, so the capture fails closed with `TASK_AUTHORITY_UNAVAILABLE` instead of publishing a weaker block.
- **Capacity is consulted only when the route advertises a window** — an unpriced route means the policy makes no capacity claim at all, and the executor's own capacity error stays the owner of that failure mode.
- **The auxiliary ladder has exactly two rungs** — `low` then `medium`; a route that cannot advertise `low` refuses the compaction before any auxiliary call rather than substituting an effort it never priced.
- **The policy protects the Task the Session is currently tracking** — it never addresses a different Task, and it never decides that a Task should be dropped, so a Task-less Session is fail-open rather than a protected empty case.
- **No new Session event type is introduced** — the policy's only durable trace is the optional `plugin:task-compaction-audit` field on the executor's existing `compaction/summary` event.
- **No runtime invariant companion is published because the policy is a reader and a gate over already-folded projection state, it appends no durable fact of its own, and every decision it makes is a pure function of one authority cut plus one candidate** — its contracts are proven by the pure decision matrices and the plugin and executor specs rather than by a runtime observer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The executor consults the policy at two points that are deliberately not symmetric. `assess` runs synchronously enough to avoid adding a suspension point on the policy-free path, and it runs before the model-free tool-result prune so a refusal never leaves the surface already narrowed. `begin` returns a live transaction whose `assertPublishable` is synchronous by type, which is the only way the authority re-check can share an uninterrupted block with the replacement append.

`rebaseAfterOwnedRecovery` exists because the executor's own summary-error recovery mutates the source surface; the policy follows that mutation but re-checks its digest first, so a recovery that also moved authority refuses instead of silently rebasing onto moved facts.

This package adds no durable vocabulary of its own, so it does not participate in the persistence catalog. The pure modules under `src/` (`protection`, `validation`, `eligibility`, `reasoning`, `context`) carry the decision matrices and can be called without mounting anything; `tests/plugin.spec.ts` owns the integration proof over the real projections, and the `dsh-compaction-basic` specs own the executor-level proof that the seam is honored.

</details>
