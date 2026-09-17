# Agent Note: Progress-aware Run control remains an outer policy over observation and retry execution

Status: implemented

English | [中文](2026-09-14-progress-aware-run-control.zh.md)

## Problem

Agent Run State made MLX prefill, backend activity, component health, and fatal errors visible, but the existing request recovery path still made two decisions from narrower evidence. The pi-ai adapter's idle watchdog could see only provider response-stream demand, so ten minutes of advancing backend prefill with no assistant token could still look idle. The `dsh-llm-retry` executor correctly persisted and scheduled provider-configured retries, but a local route could inherit a retry budget larger than the safe limit and retry a generic `SERVER` result even after backend observation had established Metal resource exhaustion or worker failure.

Cancellation had a related evidence gap. An aborted Agent request proves that DSH asked the transport to stop; it does not prove that MLX generation released its worker. Treating AbortSignal settlement as backend acknowledgement made diagnostics optimistic precisely when a local worker could still be consuming resources.

The response-stream waterfall cannot solve the prefill gap by rewriting the request: `llm.prepareCall()` deliberately freezes an immutable call snapshot, and backend logs are neither model output nor request configuration. The request-error waterfall can host retry governance, but ordinary listener registration order is not a stable safety boundary: real Loader composition demonstrated that the existing retry executor could wrap the new policy and consume all five provider retries before the policy ran.

## Decision

Run control is an independent Cordis plugin, `@deepseek-ai/dsh-agent-run-policy`, layered over `ctx.agentRunState` and the existing retry executor. The Agent loop, Session controller, client runtime, Desktop, retry event formats, reasoning policy, and compaction policy remain unchanged.

### One provider-neutral activity hook

`dsh-llm` declares the additive `llm/request-activity` event. It carries only a Session identity, observation time, source, and confidence. Agent Run State emits it when an attributed backend observation carries a strictly advancing `lastActivityAt` equal to that observation's own timestamp. A health-only poll therefore cannot pulse request activity, while MLX prefill progress can.

`dsh-llm-pi-ai` optionally subscribes one in-flight request by Session identity and calls the existing `idleWatchdog.pulse()` for matching activity. The hook changes no request, stream chunk, retry action, or Session record. It is provider-neutral and usable by future backend observers without exposing MLX log syntax. This is the minimum core hook because no prior event reached an adapter while its provider iterator had an outstanding demand.

### A bounded outer retry guard

The policy registers a prepended `agent/request-error` listener, making its safety decision the outermost waterfall layer independently of Loader order. For named provider routes it probes all backend observers, reads the current Run diagnostics, and delegates to `dsh-llm-retry` only for transient transport/provider failures while `retryCount < maxRetryCount`. Configuration restricts the local cap to zero through two. `dsh-llm-retry` remains the sole executor and continues to own provider policy, durable `llm/retry` and `llm/retry-started` events, delay, jitter, and cancellation-aware waiting.

Fatal overall or component health blocks delegation even when the immediate failure is generic. `RESOURCE_LIMIT`, `WORKER_CRASH`, `MODEL_LOAD_FAILED`, `INVALID_MODEL_CONFIG`, `INVALID_REASONING_PARAMETER`, `CLIENT_CANCELLED`, `CONTEXT_OVERFLOW`, and `GENERATION_STALLED` also deny raw retry. Retry therefore advances Attempt identity only through the existing durable event path and never creates a Run.

`GENERATION_STALLED` is probed before denial. Run State does not proactively abort a live request when elapsed diagnostics become stalled, so an active request continues to be observed. If a request has already failed, the policy has no “continue the same transport” action and refuses to convert stalled evidence into a fresh full request.

### Transient cancellation acknowledgement

Agent Run State accepts a replaceable `LocalRunControlObserver` alongside backend observers. Its overlay carries the policy's retry budget/reason and cancellation acknowledgement without writing high-frequency or process-local facts to Session JSONL. The `/agent_run_state` view reports `lastMeaningfulActivityAt`, `staleThresholdMs`, current/max/reason retry data, and requested/confirmed/unconfirmed cancellation timestamps.

On request abort the policy publishes `requested`, probes observers, and starts a finite confirmation window. Only `generationActivity = { state: 'inactive', confidence: 'confirmed' }` confirms backend disappearance. Expiry produces `unconfirmed` and degrades overall health unless fatal evidence already dominates. A later confirmed inactive observation may still acknowledge the cancellation. Durable `turn/end` remains the owner of terminal cancellation and `CLIENT_CANCELLED`; the overlay does not rewrite terminal state.

## Alternatives considered

**Increase the adapter timeout again.** Rejected because total elapsed time is not inactivity and a larger constant only moves the false-stall boundary. The watchdog now rearms on real attributed progress.

**Put MLX log parsing or retry decisions in the adapter.** Rejected because it would couple request policy to one provisional log format and prevent llama.cpp or a structured future MLX observer from using the same contracts.

**Replace `dsh-llm-retry`.** Rejected because the existing executor already owns durable retry identity, persistence, backoff, cancellation, and provider policy correctly. The missing concern was an evidence-informed outer cap, not another executor.

**Rely on plugin load order for the cap.** Rejected by a real Loader test: ordinary ordering allowed a five-retry provider policy to run before the guard. Prepending the guard makes the safety boundary explicit in the event contract.

**Treat abort as confirmed cancellation.** Rejected because transport acknowledgement and backend generation disappearance are different facts. Unknown remains explicit.

**Restart or resume after fatal failure.** Rejected for this boundary. Restart, checkpoint, and resume require later recovery ownership and cannot safely replay a full request from observation alone.

## Consequences

- Stalled classification uses `now - lastMeaningfulActivityAt`; Run age only distinguishes continuing work as slow. Assistant reasoning/text, tool events, and attributed backend progress update meaningful activity. UI reads and health polls do not.
- A long MLX prefill can keep both diagnostics and pi-ai's outstanding provider demand alive without generating assistant tokens or Session events.
- Metal resource exhaustion can coexist with process health `healthy`; fatal generation evidence still prevents retry, preserving the first fatal error as primary and later stream failures as secondary.
- Retry diagnostics show the durable current count and the policy's process-local maximum/reason. The real Loader fixture proves a provider maximum of five becomes two retries, three total attempts, and one Run.
- Cancellation may honestly remain unconfirmed on current MLX deployments when neither logs nor a structured endpoint proves generation disappearance. HTTP health success is insufficient.
- The upstream compatibility surface is small but non-zero: one additive LLM event, one optional pi-ai adapter subscription, optional backend `probe()`, and a replaceable Run-control observation contract. Upstream changes to LLM events, pi-ai watchdog ownership, Agent request-error waterfall semantics, or Session retry event shapes require review. No Desktop bundle or signed application is modified.

## Verification

Deterministic fixtures cover advancing prefill over a simulated long interval, no-progress stall, recovery from stall, fatal Metal evidence, bounded transient retry, invalid reasoning, caller cancellation, confirmed and unconfirmed cancellation, and healthy-process/fatal-generation precedence. The MLX replay fixtures retain provisional backend-log progress and root-cause ordering. A real Cordis Loader composition exercises Agent loop plus retry executor and proves the policy cap. Per-file coverage for the new policy and the changed Run State/MLX paths is 100% across statements, branches, functions, and lines.

This decision extends [Agent Run State projection and backend observer seam](2026-09-13-agent-run-state-projection.md) and [Bounded LLM request recovery](2026-06-21-bounded-llm-request-recovery.md); it does not supersede either decision.
