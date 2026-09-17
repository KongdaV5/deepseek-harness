---
summary: "A separately identified, locally packaged DSH Desktop Custom artifact composes the approved Phase 2–7 bundles without modifying the formal Desktop."
kind: "architecture"
---

# Desktop Custom Packaging

English | [中文](2026-09-15-desktop-custom-packaging.zh.md)

## Decision

Keep the formal DSH Desktop release path unchanged. A `custom` Desktop build flavor packages the matching runtime plus `@deepseek-ai/dsh-desktop-custom-composition`, gives the app bundle identifier `dev.dsh.desktop.custom`, and creates an ad-hoc-signed local artifact named `DSH Desktop Custom.app`.

## Composition and state boundaries

The Custom built-in bundle owns only deployment composition for the already approved Phase 2–7 packages. `DesktopProjectManager` accepts a build-specific built-in bundle prefix so the composition is linked from the immutable packaged runtime rather than misclassified as a profile-installed third-party plugin. The regular Desktop prefix remains unchanged.

Custom uses an isolated Electron user-data profile and `~/.dsh/profiles/desktop-custom`; it continues to use normal shared DSH settings and sessions. Consequently, formal and Custom Desktop may coexist, but they must not edit the same session concurrently.

## Packaging constraints

`package-custom.ts` supplies the Custom bundle closure and writes `Contents/Resources/custom-build.json` with local provenance. The flavor is ad-hoc signed, disables updater/notarization configuration, and never reads, patches, signs, or copies over `/Applications/DSH Desktop.app`. It is a local development artifact, not a distributable signed release.

## Known boundary

IQ3_S GGUF has no structured backend-progress integration in this package. Backend prefill and attribution remain Unknown rather than inferred. This packaging layer does not add backend restart, dynamic recovery, automatic resume, or policy changes.
