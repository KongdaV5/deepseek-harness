# Agent Note: Checkpoint long tasks across compaction

Status: implemented

English | [中文](2026-10-08-long-task-compaction-checkpoints.zh.md)

## Problem

Long coding turns can compact conversation history many times before a turn reaches its output limit. The existing task-progress guidance covers completed phases and output-limited continuations, but it does not explicitly require a checkpoint before context compaction, record inspected source ranges, or direct the model to resume after a compacted summary without repeating unchanged discovery.

## Decision

When bounded task continuation is enabled, the system prompt asks the model to create or reuse a concise workspace checkpoint before broad codebase exploration. At each discovery phase boundary, it records important paths and exact line ranges inspected and distinguishes read-only inspection from edits. It updates the checkpoint before likely context compaction or an output limit. After a compacted summary or automatic continuation, it reads and verifies the checkpoint, resumes the first unfinished phase, and avoids rereading unchanged ranges unless the source changed or required evidence is missing.

## Alternatives considered

**Block repeated file reads in the host.** Rejected because a read may be necessary after the file changes or when prior output omitted required evidence; a path-and-range match alone cannot establish that a later read is redundant.

**Disable or delay context compaction.** Rejected because this checkpoint change does not alter the model context capacity or the compaction policy that keeps long sessions within that capacity.

## Consequences

The checkpoint gives a later compacted turn a durable place to recover the task phase and completed inspection. This is model guidance rather than host-enforced read deduplication, so it cannot guarantee that a model writes the checkpoint or never repeats a read. It does not reduce the latency or token cost of a compaction request.

## Verification

The focused automatic-continuation suite passes all three tests, and the `automatic-continuation` recorded-session snapshot passes. The task-checkpoint README pair and `git diff --check` pass.
