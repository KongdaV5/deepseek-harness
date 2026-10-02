# Agent Note: Shared DSH mascot motion

Status: implemented

English | [中文](2026-09-27-shared-dsh-mascot-motion.zh.md)

## Problem

The sidebar and empty-session hero used separate marks, so the DSH identity changed between nearby surfaces and could not respond consistently to user actions. Inferring action meaning from button labels would also make the behavior depend on localized copy.

## Decision

`DshMascotMark` in [`ui-primitives`](../../../../packages/client/ui-primitives/README.md) is the shared decorative DSH assistant mark. The official brand package, the sidebar fallback, and the empty-session hero render it at the size requested by their host. It owns transient visual mood and pointer gaze; it does not read or change Session data or model requests.

The mark reacts to composer focus, input, submit, pointer activity, and keyboard or pointer activation of controls. Controls that need a specific reaction carry the stable `data-dsh-mascot-action` value `new-session`, `send`, or `stop`; the mark never infers control meaning from localized text or accessibility labels. Other navigation controls use the curious reaction.

Idle gestures run on a randomized 2.1–4.2 second interval while the page is visible and reduced motion is off. User reactions last 1.5 seconds. Hiding the page or enabling reduced motion stops scheduled reactions; CSS also disables the mark's and linked wordmarks' animations for reduced-motion users.

## Alternatives considered

**Keep the fish mark in the sidebar and a conversation-owned hero illustration.** This preserves separate artwork and behavior across surfaces, so the product identity still changes between the sidebar and a new session, and each surface keeps its own art to maintain.

**Infer actions from visible or accessible labels.** The earlier implementation matched English and Chinese label text. Labels are user-facing and can change with locale or copy edits, so the implementation now uses stable action values on the owning controls.

## Consequences

The shared primitive owns short-lived interaction state and document listeners. Host controls that should produce a distinct mood must expose a stable `data-dsh-mascot-action` value. The existing `data-composer-input` marker continues to identify composer events. Hosts that render the mark keep their own layout: the sidebar scales its wordmark wrapper, and the hero keeps its mark-host box, so the mark itself carries no page geometry. Motion stays decorative and transient, with no Session persistence or model-facing effect.

The component spec covers composer and action reactions, pointer gaze, idle gestures, and reduced motion. Package READMEs describe the shared mark and its behavior.
