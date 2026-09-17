# DS Harness final product baseline

Status: implemented and verified

English | [中文](2026-09-17-ds-harness-final-product-baseline.zh.md)

## Purpose and scope

This note freezes the verified daily local product as **DS Harness**. It accepts the Phase 8A.2c evidence that the apparent stale renderer was an old in-memory Electron process, not a stale source, tarball, staging, or packaged renderer artifact. It records a final product recovery point after DS Harness branding, daily `/Applications` installation, startup branding, and idle Run Details presentation were all verified.

This is a local product baseline, not a public release. It does not modify `/Applications/DSH Desktop.app`, alter Phase 2–7 runtime policy, begin Phase 8B, publish a release, push a branch or tag, or add an updater.

The annotated final product tag is intentionally on the verified implementation commit. This attestation is a later documentation-only commit because a tracked manifest cannot truthfully contain the SHA of the commit that contains it.

## Baseline manifest

| Field | Verified value |
| --- | --- |
| Final product baseline | `ds-harness-product-baseline-2026-09-17` → `bfba98b9bd9390735242ad57840050850a3c11b5` |
| Parent implementation commit | `0e222bb4c25cef338457e0856ddf95bab125681e` |
| Technical recovery baseline retained | `dsh-custom-baseline-2026-09-17` → `9d9762e7d2567248050559f2ac1b04e9f2a766f2` |
| Product / installed path | `DS Harness` / `/Applications/DS Harness.app` |
| Bundle identifier / version | `dev.dsh.desktop.custom` / `0.1.5-rc.2` |
| Target | macOS `darwin-arm64` |
| Build environment | Node `24.17.0`; pnpm `11.7.0` |
| Capability composition | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-desktop-custom-composition` (Phase 2–7) |
| Source state | detached clean worktree at the exact final product tag; packaged `custom-build.json` records `bfba98…` and `dirty: false` |
| Profile / Electron user data | `~/.dsh/profiles/desktop-custom` / `~/Library/Application Support/@deepseek-ai/dsh-desktop-custom` |
| Normal route | `local-qwen` → `http://127.0.0.1:8080/v1` → `Qwen3.8-27B IQ3_S (llama.cpp)` |
| Shared state boundary | `~/.dsh/settings.yaml` and `~/.dsh/sessions` are intentionally shared; do not operate one conversation from formal and Custom Desktop concurrently |

## Clean rebuild and artifact identity

The final application was rebuilt from a detached, clean worktree of `ds-harness-product-baseline-2026-09-17` and installed with the canonical Custom pipeline:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64
```

The generated application path before installation was:

```text
/tmp/ds-harness-product-baseline-20260917/apps/desktop/.desktop-build/targets/mac-arm64/custom-artifacts/mac-arm64/DS Harness.app
```

The installed application was then verified at:

```text
/Applications/DS Harness.app
```

| Archive | Size | SHA-256 |
| --- | ---: | --- |
| `DS-Harness-product-baseline-2026-09-17.zip` | 220,018,914 bytes | `cbcca4c60cf8b4c963f0292d3daed6312e1774d5d3f5f55a3861952334ae2df9` |

The archive was made with `ditto -c -k --sequesterRsrc --keepParent`, hashed, and deleted after verification. Its hash identifies this verified build only. Rebuilds are functionally and structurally reproducible from the tag, but are not promised to be byte-for-byte identical because build-root-derived CSS module names, build timestamps, Electron/macOS packaging metadata, and ad-hoc signing can change bytes.

The source `RunStatusDock.tsx` hash remained `570b8d700d4cf45c51243143d1348ee439062671bdb034b11081bef3e63b3505`. The final clean build's `@deepseek-ai/dsh-client-ui-run-details/lib/client.js` hash was `d19c70051887cf739727f255f24241cb884f2dcf120334768f3aa8239f3c0760` in the workspace, tarball, Desktop staging, and installed App. It includes the `snapshot?.run === null` guard. The earlier `4e58…` generated hash differed only because its CSS module hash embedded a different build-root path; source and behavioral implementation were unchanged.

## Verification evidence

- The complete scoped Phase 2–7/desktop/custom-composition regression passed from the final-tag worktree: **55 test files; 598 passed; 1 skipped; 0 failed**.
- Packaged runtime smoke ran against the newly installed app's Node and `Resources/dsh`: `fs-ext`, `koffi`, `sharp`, HTML/runtime, and `node-pty` all passed on Node `24.17.0` / macOS arm64.
- `codesign --verify --deep --strict '/Applications/DS Harness.app'` passed. The installed app reports identifier `dev.dsh.desktop.custom`, signature `adhoc`, and `TeamIdentifier=not set`.
- Two independent launches from `/Applications/DS Harness.app` first displayed `正在启动 DS Harness…` at `dsh-app://shell/startup.html`, then reached `dsh-app://app/index.html`. Neither startup showed `DeepSeek Harness`; window title and application menu were `DS Harness`.
- In both idle launches, `run = null` yielded no standalone Run Details dock, no `查看运行详情`, no `未知`/`Unknown` row, and no reserved layout gap. The normal selector area flowed directly to the prompt composer.
- Existing tests retain the separate active-Run rule: an active Run with unavailable backend observation remains `Unknown`; no diagnostic fact was renamed to Idle, Ready, Healthy, or Normal.
- Each launch used the packaged Node Host under `/Applications/DS Harness.app/Contents/Resources/`, the Custom profile, `local-qwen`, and port `8080`. Neither `local-qwen-dev` nor port `8081` was observed.
- Each exit was followed by an explicit residual-process check covering the main process, Renderer, GPU/Network Helpers, packaged Desktop Host, and `desktop-custom`; both checks returned none. No prompt was sent and no model inference was performed.

## Verification procedure learned in Phase 8A.2c

When replacing a local Electron development app, the process exit check is part of artifact verification:

1. quit DS Harness;
2. verify no remaining Custom main process, Renderer, GPU/Network Helper, Desktop Host, or `desktop-custom` process;
3. install or replace the verified artifact;
4. launch the app from `/Applications`;
5. validate the newly loaded UI and runtime.

This is a verification procedure, not a product-runtime fix. The prior apparent renderer discrepancy was caused by verifying an old live Renderer that had not exited. It was not caused by stale `lib`, tarball, staging, Electron package, or a build-order defect. No packaging pipeline change is warranted.

## Baseline roles and rollback

### Technical Recovery Baseline

`dsh-custom-baseline-2026-09-17` remains fixed at `9d9762e7d2567248050559f2ac1b04e9f2a766f2`. It is the Phase 2–7 plus early Custom packaging technical recovery point. Do not move, delete, retag, or force-update it.

### Final Product Baseline

`ds-harness-product-baseline-2026-09-17` resolves to `bfba98b9bd9390735242ad57840050850a3c11b5`. It is the daily DS Harness recovery point after product identity, `/Applications` installation, startup branding, idle diagnostics closure, and final product verification.

To restore the final daily product:

```sh
git checkout ds-harness-product-baseline-2026-09-17
pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64
```

To restore the earlier technical baseline:

```sh
git checkout dsh-custom-baseline-2026-09-17
pnpm --filter @deepseek-ai/dsh-desktop run package-and-install:custom:mac:arm64
```

Neither rollback moves either tag. Both procedures require first quitting DS Harness and confirming that no Custom processes remain.

## Data and Official Desktop boundaries

The Custom state directories exist and remain stable:

- `~/Library/Application Support/@deepseek-ai/dsh-desktop-custom`;
- `~/.dsh/profiles/desktop-custom`;
- `~/.dsh/settings.yaml`;
- `~/.dsh/sessions` (intentionally shared).

No unexpected `~/Library/Application Support/DS Harness` or `~/.dsh/profiles/ds-harness` directory was created. The formal application remains `/Applications/DSH Desktop.app`, display name `DSH Desktop`, bundle identifier `dev.dsh.desktop`; it and `~/.dsh/profiles/desktop` were not used, rebuilt, resigned, renamed, replaced, or modified by this verification.

## Known limitations and future boundary

- signing remains ad-hoc; there is no Developer ID signing, notarization, updater, release upload, or distribution channel;
- settings and sessions are intentionally shared, so formal and Custom Desktop must not operate the same conversation concurrently;
- the daily GGUF route lacks structured backend progress attribution, so active-run observation can legitimately remain `Unknown` rather than fabricated;
- no inference request was made as part of baseline packaging verification.

Phase 8A.3 stops after this local baseline freeze. Phase 8B upstream tracking, watcher work, compatibility analysis, automatic fetch, rebase, and update behavior remain explicitly out of scope.
