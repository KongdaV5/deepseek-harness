---
description: "Progress-aware bounded model-request retry and cancellation acknowledgement over Agent Run State, for local-backend deployments and maintainers composing recovery policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-policy

English | [中文](README.zh.md)

## Summary

`dsh-agent-run-policy` uses the read-only Agent Run State diagnostics to prevent blind model-request retries and to distinguish requesting cancellation from confirming backend termination. It caps transient request recovery at zero through two retries, probes backend observers before every governed retry decision, refuses raw retries for fatal and permanent failures, and publishes transient retry/cancellation facts back through the diagnostics service. It never restarts a backend, resumes a Run, changes reasoning or compaction policy, or writes high-frequency control state to the Session log.

## Table of Contents

- [Use this package](#use-this-package)
- [Retry policy](#retry-policy)
- [Cancellation acknowledgement](#cancellation-acknowledgement)
- [Composition and diagnostics](#composition-and-diagnostics)
- [Implementation map](#implementation-map)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount Agent Run State first, then this policy and the existing retry executor. List only provider routes governed by this local policy. The policy registers its request-error listener as the outermost waterfall guard, so the cap does not depend on Loader ordering and cannot be bypassed by a provider's larger retry budget.

```yaml
- name: '@deepseek-ai/dsh-agent-run-state'
  config:
    slowAfterMs: 300000
    stalledAfterMs: 600000

- name: '@deepseek-ai/dsh-agent-run-policy'
  config:
    observerId: local-run-policy
    providers:
      - local-qwen
    maxRetryCount: 2
    cancellationConfirmationMs: 5000

- name: '@deepseek-ai/dsh-llm-retry'
```

| Field | Required | Meaning |
|---|---:|---|
| `observerId` | yes | Unique identity for the transient run-control observation source |
| `providers` | yes | Exact LLM provider routes governed by this policy |
| `maxRetryCount` | yes | Hard Run-local retry cap from 0 through 2 |
| `cancellationConfirmationMs` | yes | Finite time allowed for confirmed backend generation disappearance |

The package requires `ctx.agentRunState`. A backend observer may implement `probe()` to refresh immediately available log or process evidence before a decision. Probe failure is contained and never fabricated into health or activity.

-----

<a id="retry-policy"></a>
## Retry policy

Every retry remains a new Attempt in the same Run. The policy reads the durable `retryCount`, applies its own `maxRetryCount`, and delegates only `TRANSPORT`, `TIMEOUT`, `SERVER`, `RATE_LIMIT`, or `PROVIDER_UNAVAILABLE` to the existing `dsh-llm-retry` executor. The executor retains ownership of provider policy, durable `llm/retry` and `llm/retry-started` events, backoff, and cancellation-aware waiting.

The policy denies raw retry for `RESOURCE_LIMIT`, `WORKER_CRASH`, `MODEL_LOAD_FAILED`, `INVALID_MODEL_CONFIG`, `INVALID_REASONING_PARAMETER`, `CLIENT_CANCELLED`, `CONTEXT_OVERFLOW`, and `GENERATION_STALLED`. It also denies whenever overall, process, model, or generation health is fatal, even if the immediate provider failure looks like a generic `SERVER` or transport error. A Metal resource limit therefore remains the root cause and cannot trigger another full prefill.

`GENERATION_STALLED` is probed before denial. Agent Run State itself does not abort an active request merely because diagnostics become stalled; if the request is still alive, observation continues. Once a request has already failed, this package has no unsafe “resume the old stream” action and therefore does not turn that condition into a fresh model request.

Errors retain observation order. The first classified failure remains `primaryError`; BrokenPipe, stream disconnect, and later attempt failures remain secondary. Neither retry evaluation nor a later health result overwrites the root cause.

-----

<a id="cancellation-acknowledgement"></a>
## Cancellation acknowledgement

An aborted Agent request first publishes cancellation status `requested`; the AbortSignal proves only that DSH requested transport cancellation. The policy immediately asks backend observers to probe and watches diagnostics for `generationActivity.state = inactive` with `confidence = confirmed`. Only that evidence changes status to `confirmed`.

If no confirmed disappearance arrives inside `cancellationConfirmationMs`, status becomes `unconfirmed` and overall health is at least `degraded`. A later confirmed inactive observation may still replace `unconfirmed` with `confirmed`. Process `/health = 200`, silence, UI disconnect, and a provisional inactive guess do not confirm cancellation.

All acknowledgement data is transient. The durable `turn/end` event still owns the Run's terminal `cancelled` phase and `CLIENT_CANCELLED` primary error; the policy does not invent or rewrite terminal Session events.

-----

<a id="composition-and-diagnostics"></a>
## Composition and diagnostics

`ctx.agentRunState.diagnostics(session)` exposes:

- `lastMeaningfulActivityAt` and `staleThresholdMs` for no-progress classification;
- `retryCount`, policy `maxRetryCount`, and the latest classified retry reason;
- cancellation `requested`, `confirmed`, or `unconfirmed` with timestamps;
- independent process, model, and generation health;
- stable primary and ordered secondary errors.

Attributed advancing backend activity also emits the provider-neutral `llm/request-activity` event. `dsh-llm-pi-ai` uses it only to pulse an outstanding idle watchdog demand for that exact Session. Health polling cannot emit it because an observation must carry a strictly advancing `lastActivityAt` equal to its observation time. The event changes no request payload and writes no Session record.

-----

<a id="implementation-map"></a>
## Implementation map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Outer retry guard, backend probe, cancellation monitor, and diagnostics observation |
| [`src/types.ts`](src/types.ts) | Configuration, pure retry-decision, clock, and test-injection contracts |
| [`src/testing.ts`](src/testing.ts) | Deterministic `FakeClock` for long-window tests without wall-clock waiting |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | Retry matrix, fatal precedence, cancellation acknowledgement, and timer cases |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Real Loader composition proving a provider budget of five is capped at two retries in one Run |

No runtime invariant companion is published. The policy's observable relations are covered directly at the Agent event waterfall, Session projection, backend observer, and real Loader boundaries.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package adds no prompt, tool, model message, or request field and only limits whether an existing failed model request may be attempted again.

#### KV Cache effect

No direct effect: the package does not alter request content or compaction policy, while preventing blind retry can avoid repeating a full prefill.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Cancellation confirmation is only as strong as the backend observer. The current MLX log integration may remain `unconfirmed` after client abort when no structured disappearance signal is available.
- The policy does not restart workers, restart a local-model service, resume a Run, create checkpoints, or mutate terminal state.
- `stalledAfterMs` and an adapter's stream idle timeout are separate deployment settings and should be configured consistently; this package does not silently rewrite either.
- Only named provider routes are governed. Unlisted providers retain their existing recovery chain.
- Run-control overlays are process-local diagnostics. Durable retry attempts continue to come from the existing Session retry events.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The implemented split and minimum core hook are recorded in [Progress-aware Run control](../../../.agents/notes/implemented/architecture/2026-09-14-progress-aware-run-control.md). The underlying projection and observer seam are recorded in [Agent Run State projection and backend observer seam](../../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.md).

</details>
