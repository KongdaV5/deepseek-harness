# DSH Desktop Custom golden baseline

Status: implemented and verified

English | [中文](2026-09-17-dsh-custom-golden-baseline.zh.md)

## Purpose and scope

This note freezes the verified Phase 2–7 development composition as a recoverable, locally packaged **DSH Desktop Custom** baseline. It is an engineering baseline, not a production release and not an update to the formal DSH Desktop application. Phase 8A.1 ends here; it does not begin Phase 8B, change retry/recovery/reasoning/compaction policy, or modify `/Applications/DSH Desktop.app`.

The frozen source is the annotated Git tag `dsh-custom-baseline-2026-09-17`, which resolves to commit `9d9762e7d2567248050559f2ac1b04e9f2a766f2`. The tag is intentionally on the implementation commit. This attestation note is a later documentation-only commit because a tracked manifest cannot truthfully contain the SHA of the commit that contains it.

## Baseline manifest

| Field | Verified value |
| --- | --- |
| Baseline name and date | DSH Desktop Custom golden baseline, 2026-09-17 (Asia/Shanghai) |
| Frozen source | `dsh-custom-baseline-2026-09-17` → `9d9762e7d2567248050559f2ac1b04e9f2a766f2` |
| Source cleanliness | `custom-build.json` records the frozen commit and `dirty: false` |
| Product / bundle identifier | `DSH Desktop Custom` / `dev.dsh.desktop.custom` |
| DSH runtime / desktop version | `0.1.5-rc.2` |
| Target | macOS `darwin-arm64` |
| Bundled Node / pnpm | Node `24.17.0`; pnpm `11.7.0` |
| Capability composition | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-desktop-custom-composition` (Phase 2–7) |
| Profile and user-data isolation | Host profile: `~/.dsh/profiles/desktop-custom`; Electron user data: `~/Library/Application Support/@deepseek-ai/dsh-desktop-custom` |
| Normal provider / endpoint / model | `local-qwen`; `http://127.0.0.1:8080/v1`; `/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf` |
| Settings and sessions | Settings remain `~/.dsh/settings.yaml`; sessions remain intentionally shared with the normal profile. Do not open the same conversation in formal and Custom Desktop concurrently. |
| Signing | ad-hoc signature (`codesign --verify --deep --strict` passed); TeamIdentifier is unset |
| Notarization / updater | no notarization; no updater; this is a local development package |

## Artifact identity and reproducibility

The build was performed from the clean, exact baseline tag using:

```sh
corepack pnpm --filter @deepseek-ai/dsh-desktop run package:custom:mac:arm64:dir
```

The packaged application is deliberately ignored by Git at:

```text
apps/desktop/.desktop-build/targets/mac-arm64/custom-artifacts/mac-arm64/DSH Desktop Custom.app
```

The canonical artifact identity for this verification is the SHA-256 of a `ditto` archive made from that app:

```sh
ditto -c -k --sequesterRsrc --keepParent \
  'DSH Desktop Custom.app' \
  DSH-Desktop-Custom-0.1.5-rc.2-mac-arm64.zip
shasum -a 256 DSH-Desktop-Custom-0.1.5-rc.2-mac-arm64.zip
```

| Archive | Size | SHA-256 |
| --- | ---: | --- |
| `DSH-Desktop-Custom-0.1.5-rc.2-mac-arm64.zip` | 220,546,135 bytes | `4fd7b46c1baf05cf024162a81241e3b4c8bbfb55392176008cca43c57c86a9de` |

This hash identifies this verified build archive; it is not a promise of byte-for-byte reproducibility across rebuilds. Build timestamps, Electron/macOS packaging metadata, and ad-hoc signing can change app and archive bytes even when the source tag and functional result are identical. Reproducibility here means rebuilding and verifying the same frozen source with the documented target and toolchain.

## Verification evidence

- The clean-tag package build completed and its `custom-build.json` records source commit `9d9762e…`, `dirty: false`, `darwin/arm64`, Node `24.17.0`, pnpm `11.7.0`, and the Phase 2–7 Custom composition.
- Native payload smoke was run again with the packaged Node and packaged DSH runtime. It passed `fs-ext`, `koffi`, `sharp`, HTML conversion, and `node-pty` on Node `24.17.0` / macOS arm64.
- The scoped Phase 2–7 regression command passed: **55 test files; 593 passed; 1 existing skipped**.
- `codesign --verify --deep --strict` passed for the actual Custom `.app` and reports identifier `dev.dsh.desktop.custom`.
- Two actual Custom App launches each reached `dsh-app://app/index.html` in one standard window. The Host process used the packaged runtime and `~/.dsh/profiles/desktop-custom`; the model selector showed `Qwen3.8-27B IQ3_S (llama.cpp)` and the idle run-details projection showed `Unknown`, as designed.
- After the first launch the process cleanly exited before the second launch. After the second launch it again cleanly exited. No prompt was entered or sent, so this verification made no model inference request.
- Packaged runtime configuration contains `@deepseek-ai/dsh-desktop-custom-composition` and contains neither `local-qwen-dev` nor port `8081`.

The UI surfaced a pre-existing `benchmark` label from shared conversation state during the smoke test. The Custom build did not create or change a benchmark lock, preset, or settings value; Benchmark remains out of scope for this baseline.

## Rollback and operational boundaries

To recover the verified source exactly, check out `dsh-custom-baseline-2026-09-17` and rebuild with the command above. The formal `/Applications/DSH Desktop.app` is not an input or an output of this procedure. Custom profile/user-data isolation prevents the Custom Host and Electron process from sharing those locations with the formal app; shared settings and sessions remain the documented exception.

Known limitations remain explicit:

- local development only: no Developer ID signing, notarization, updater, or distribution channel;
- no inference was used as a packaging smoke test;
- idle GGUF backend observation is correctly `Unknown` rather than fabricated;
- sessions are shared, so do not operate one conversation from formal and Custom Desktop at the same time;
- a rebuilt archive may have a different SHA-256 for the metadata/signing reasons above.

## Upgrade compatibility

The baseline remains plugin-first: the Custom package carries its Phase 2–7 capability set through `@deepseek-ai/dsh-desktop-custom-composition`, while the matching `0.1.5-rc.2` source retains only the narrow seams previously accepted for the capability contracts. Future official-runtime upgrades should start from this tag and re-evaluate those seams and the runtime package-set contract before rebuilding; they must not be assumed binary-compatible merely because the Custom application launches.
