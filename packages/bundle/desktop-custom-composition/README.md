---
description: "Private composition for the locally packaged DSH Desktop Custom application."
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-custom-composition

English | [中文](README.zh.md)

## Summary

This private, built-in bundle composes the approved Phase 2–7 local-runtime capabilities for **DSH Desktop Custom**. It is selected only by the `custom` packaging flavor. It does not modify the released DSH Desktop, its launcher, or normal `~/.dsh/settings.yaml`.

The Custom application uses its own Electron data directory and its own Desktop profile (`~/.dsh/profiles/desktop-custom`), while deliberately retaining the user's normal local provider configuration. Its daily route is `local-qwen` and the configured IQ3_S GGUF backend; it does not select the 8081 development fixture.

## Capability boundary

`cordis.patch.yml` composes the existing Run State, diagnostics transport and dock, reasoning policy, task checkpoint, compaction policy, and backend observation contracts. The GGUF route has no structured backend-progress source, so prefill and worker attribution remain **Unknown** rather than inferred. The bundle neither restarts a backend nor adds retry, resume, profile, benchmark, or reasoning-budget policy beyond the approved capability packages.

The custom composition is a **built-in runtime bundle**, not an installable third-party plugin. Desktop links it from the immutable packaged runtime and excludes it from the profile's user-plugin inventory.

## Safety and coexistence

- Formal `/Applications/DSH Desktop.app` is not read, patched, signed, or replaced.
- Custom and formal Desktop have separate Electron user data and Desktop plugin profiles.
- DSH sessions and normal settings remain shared intentionally. Do not edit the same conversation simultaneously in both applications.
- The package has no updater or notarization path; release builds use the official packaging configuration instead.

## Further exploration

- [`cordis.patch.yml`](cordis.patch.yml) — Custom capability composition and normal-provider declarations.
- [`../../../apps/desktop/scripts/package-custom.ts`](../../../apps/desktop/scripts/package-custom.ts) — local artifact build and provenance metadata.
- [`../../../apps/desktop/src/project-manager.ts`](../../../apps/desktop/src/project-manager.ts) — built-in bundle/profile separation.
- [`../../../apps/desktop/README.md`](../../../apps/desktop/README.md) — Desktop packaging background.

## Maintainer note

The package is intentionally a narrow packaging seam. Do not put state machines, parsing rules, recovery actions, or visual redesigns here. Upgrade compatibility is maintained by replacing this composition or its individual capability packages, not by making the formal Desktop a long-lived fork.
