---
summary: "A separately identified, locally packaged DS Harness product composes the approved Phase 2–7 bundles without modifying the formal Desktop."
kind: "architecture"
---

# Desktop Custom Packaging

English | [中文](2026-09-15-desktop-custom-packaging.zh.md)

## Decision

Keep the formal DSH Desktop release path unchanged. The internal `custom` Desktop flavor packages the matching runtime plus `@deepseek-ai/dsh-desktop-custom-composition`, retains the bundle identifier `dev.dsh.desktop.custom`, and creates an ad-hoc-signed local app named **DS Harness.app**. `desktop-custom` and its composition package remain internal technical identities; **DS Harness** is the user-facing product identity.

## Composition and state boundaries

The Custom built-in bundle owns only deployment composition for the already approved Phase 2–7 packages. `DesktopProjectManager` accepts a build-specific built-in bundle prefix so the composition is linked from the immutable packaged runtime rather than misclassified as a profile-installed third-party plugin. The regular Desktop prefix remains unchanged.

Custom uses an isolated Electron user-data profile and `~/.dsh/profiles/desktop-custom`; it continues to use normal shared DSH settings and sessions. Consequently, formal and Custom Desktop may coexist, but they must not edit the same session concurrently.

## Packaging constraints

`package-custom.ts` supplies the Custom bundle closure and writes `Contents/Resources/custom-build.json` with local provenance, including `productName: "DS Harness"`. The flavor is ad-hoc signed, disables updater/notarization configuration, and never reads, patches, signs, or copies over `/Applications/DSH Desktop.app`. It is a local development artifact, not a distributable signed release.

The Custom package uses the same official client capability profile as the formal Desktop, but passes the build's narrow title override as `--title "DS Harness"`. Its local `release:pack` call repeats the same explicit value as `--client-title "DS Harness"`, so the package-set verifier accepts only artifacts that carry the intended title. The generic client-build helper changes only the public `DSH_CLIENT_TITLE`; formal packaging omits both options and continues to require `DeepSeek Harness`.

The separately built startup shell receives localized messages through the Desktop-owned `localeGet` IPC. For Custom it receives the same narrow product-token substitution as native menus and dialogs, so its visible loading and recovery text says **DS Harness**; the formal Desktop receives the untouched upstream locale. This is a build/configuration seam, not a renderer DOM rewrite.

The optional Run Details dock is conditionally mounted. With no active Run, it does not reserve an idle composer row merely to display the diagnostic value `Unknown` or a historical checkpoint state. That suppression does not assert that the backend is idle, ready, or healthy: an active Run with unavailable observation still renders `Unknown`.

For daily local use, `pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64` packages then installs `/Applications/DS Harness.app`. The install step verifies the source app and any pre-existing target through its Bundle ID, visible name, provenance, and ad-hoc signature before replacing the target. It never writes the formal Desktop application, the `desktop-custom` profile, Electron user-data identity, settings, or sessions.

The historical `dsh-custom-baseline-2026-09-17` tag remains the immutable pre-rename technical recovery anchor. It intentionally retains the original `DSH Desktop Custom` build provenance; it is not moved for the DS Harness product rename.

## Known boundary

IQ3_S GGUF has no structured backend-progress integration in this package. Backend prefill and attribution remain Unknown rather than inferred. This packaging layer does not add backend restart, dynamic recovery, automatic resume, or policy changes.
