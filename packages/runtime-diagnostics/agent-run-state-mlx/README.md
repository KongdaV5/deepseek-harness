---
description: "Replaceable MLX log and health observer that emits backend-neutral Agent Run State observations without owning classification or recovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-run-state-mlx

English | [中文](README.zh.md)

## Summary

`dsh-agent-run-state-mlx` follows an MLX server log from its current end, optionally probes its HTTP health endpoint, and normalizes recognized facts into the `LocalBackendObserver` contract. MLX text parsing, file following, and request-lifecycle correlation stay inside this provider. `dsh-agent-run-state` remains backend-neutral and continues to own projection, health classification, error classification, and primary/secondary ordering. This package observes only; it never retries, restarts, resumes, cancels, checkpoints, or changes reasoning or compaction policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Observation contract](#observation-contract)
- [Attribution](#attribution)
- [Failure evidence](#failure-evidence)
- [Implementation map](#implementation-map)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the backend-neutral Run State service first, then opt this provider into a deployment whose MLX process and log path are known. The observer starts at the log's current byte end, so historical failures cannot contaminate a newly started DSH process. An absent log may appear later; truncation or rotation to a shorter file resets the follower safely.

```yaml
- name: '@deepseek-ai/dsh-agent-run-state-mlx'
  config:
    observerId: local-mlx
    logPath: /absolute/path/to/local-model.error.log
    logPollIntervalMs: 500
    healthUrl: http://127.0.0.1:8080/health
    healthPollIntervalMs: 5000
    healthTimeoutMs: 1000
    requestAttribution: unknown
    provider: local
    models:
      - /absolute/path/to/model
```

| Field | Required | Meaning |
|---|---:|---|
| `observerId` | yes | Unique observer id within `ctx.agentRunState` |
| `logPath` | yes | Absolute MLX stdout/stderr log path |
| `logPollIntervalMs` | yes | File-stat interval for appended records |
| `healthUrl` | no | HTTP(S) process-health endpoint |
| `healthPollIntervalMs` | yes | Probe interval when `healthUrl` is present |
| `healthTimeoutMs` | yes | Per-probe timeout; failure means degraded process health, never fatal by itself |
| `requestAttribution` | yes | `unknown` or explicitly declared `exclusive-single-flight` lifecycle correlation |
| `provider` | yes | Exact DSH provider eligible for correlation |
| `models` | yes | Exact DSH model ids eligible for correlation |

-----

<a id="observation-contract"></a>
## Observation contract

The parser recognizes MLX request access lines, server/model health access lines, server startup, prompt-processing progress, and strong worker/process/model failure evidence. A progress line such as `Prompt processing progress: 512/15572` produces `prefill.current`, `prefill.total`, and a speed only when two increasing samples with the same total have increasing timestamps. Every log-derived prefill value is labeled `source: "backend-log"` and `confidence: "provisional"`. The provider emits no percentage or ETA.

Progress and recognized failures advance `lastActivityAt`; a health probe does not pretend that generation advanced. `probe()` forces one immediate log-file read so a retry or cancellation policy can refresh already-written evidence before deciding. Prefill marks generation presence active/provisional; a directly completed attributed request or strong fatal termination marks it inactive/confirmed. Process, model, and generation component health remain independent. A successful `/health` response can set process health to healthy but cannot clear generation fatal. Observations remain process-local and never append high-frequency Session events.

-----

<a id="attribution"></a>
## Attribution

`unknown` is the safe default. `exclusive-single-flight` is a deployment capability declaration, not a Run State constraint. Under that mode, the provider uses the existing `llm/stream` lifecycle to collect exact active DSH attempts and binds a log request marker only when exactly one eligible attempt is active. The resulting Attempt attribution is labeled `source: "request-and-backend-lifecycle"` and `confidence: "provisional"`; zero, multiple, wrong-provider, wrong-model, auxiliary-purpose, runless, or absent Session candidates remain `unknown` and enter `unattributedBackendObservations`.

The binding is retained for late request-side log records such as BrokenPipe and is reset by the next request marker or backend startup. A future structured request id can replace this correlation inside the provider without changing `BackendObservation` or Run State.

-----

<a id="failure-evidence"></a>
## Failure evidence

The observer emits structured evidence for a directly observed process exit, worker uncaught exception, generation-thread termination, model-load failure, and backend-origin terminal exceptions such as MLX Metal resource-limit failures. It emits BrokenPipe as an unstructured stream failure. The shared classifier therefore preserves causal ordering: cancellation or resource limit remains primary and a later BrokenPipe becomes `STREAM_DISCONNECTED` secondary.

An HTTP failure degrades process health only. Silence, client/UI disconnect, BrokenPipe, and a healthy process endpoint do not become fatal evidence. `observeProcessExit()` is intentionally separate because only a process owner that observed child settlement may call it.

-----

<a id="implementation-map"></a>
## Implementation map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis provider, MLX parser, lifecycle correlation, component observations, and optional health probe |
| [`src/log-file.ts`](src/log-file.ts) | Append-only UTF-8 follower that starts at current EOF and handles missing/truncated files |
| [`src/types.ts`](src/types.ts) | Deployment configuration and process-owner input types |
| [`tests/fixtures`](tests/fixtures) | Sanitized real-machine MLX long-prefill, Metal resource-limit, and BrokenPipe replay records |

No runtime invariant companion is published. The observer is a source adapter with no independent persisted relation to inspect; unit coverage and a real Loader composition test exercise its provider lifecycle and emitted public contract.

-----

<a id="model-experience"></a>
## Model Experience

None, as the observer reads backend activity and does not change model requests.

#### KV Cache effect

No effect. The package does not mutate prompts, tokens, cache controls, or Session surface events.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- MLX log parsing is experimental. Text-derived progress and lifecycle attribution remain provisional until MLX exposes structured callbacks, events, metrics, or request ids.
- The parser supports the observed `mlx-lm` log families documented here; an upstream text-format change can reduce observations to unknown without breaking Run State.
- Log request markers do not prove causality on shared or concurrent endpoints. Such deployments must keep `requestAttribution: unknown` unless a stronger provider implementation is available.
- HTTP health covers the process endpoint only. Generation-worker health requires independent log or process-owner evidence.
- Client abort does not by itself prove generation stopped. Without a structured or log-derived disappearance signal, cancellation acknowledgement remains unconfirmed.
- File following starts at current EOF and does not reconstruct historical backend state; replay belongs in tests or an explicit diagnostic tool.
- The package classifies no error and performs no recovery. Those responsibilities remain outside this provider.

### Dev Note

<a id="dev-note"></a>

<details>
<summary>Working context for maintainers — click to expand</summary>

The identity, durability, observer, health, and error decisions are recorded in [Agent Run State projection and backend observer seam](../../../.agents/notes/implemented/architecture/2026-09-13-agent-run-state-projection.md).

</details>
