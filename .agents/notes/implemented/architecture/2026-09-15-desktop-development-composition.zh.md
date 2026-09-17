# Agent Note: Desktop development composition for local-runtime capabilities

Status: implemented

[English](2026-09-15-desktop-development-composition.md) | 中文

## Problem

已发布 Desktop 必须可升级，不能从 dirty source checkout 加载本地 Phase 2–6 capability package。本地 IQ3_S 验证路径仍需要相同的 Desktop Host composition、可独立寻址的 provider 与可重复的 preset，同时不能改变用户的日常 model route 或 session。

## Decision

源码 Desktop launcher 仅接受 `DSH_DESKTOP_DEV_COMPOSITION=phase2-6`。该值会把 private `@deepseek-ai/dsh-desktop-dev-composition` package link 到其 disposable npm project，并在 `apps/desktop/.desktop-build/development` 下创建 settings、preset fixture 与 metadata。settings 为 IQ3_S GGUF model 在 `http://127.0.0.1:8081/v1` 定义 `local-qwen-dev`，context window 为 65,536 token，output limit 为 24,576 token。

该 bundle 组装既有 agent-run-state、agent-run-policy、task-checkpoint、MLX observer、reasoning-policy、compaction-basic 和 agent-run-state command package。它只添加 deployment value：IQ3_S capability normalization、xhigh benchmark lock、保守 health threshold 与 disabled automatic compaction。该包不重新实现 Run State、retry、recovery、reasoning、checkpoint、compaction、provider 或 UI 行为。

Dev fixture 具有可见 `lite-general` preset 与隐藏但可显式解析的 `benchmark` preset。metadata 记录 source revision、dirty state、runtime version、provider、model 与 endpoint。已发布 Desktop app、`$HOME/.dsh`、正式 launcher、其 8080 endpoint 与正式 session 都不在此路径内。

## Alternatives considered

- **Patch the released Desktop application.** 被拒绝，因为 app-bundle mutation 会形成长期 compatibility fork，并使 released artifact 失去 upgrade reference 价值。
- **Place development settings in the normal Harness home.** 被拒绝，因为 provider 或 preset test 可能改变用户的 daily model route 或把 test data 写入 normal session。
- **Make the bundle a generic profile plugin.** 被拒绝，因为 workspace-linked path 只在 trusted development launcher 中安全；published profile 需要独立的 packaging 与 compatibility decision。

## Verification

launcher 会拒绝除精确 allowlisted identifier 外的所有 composition value。其 focused test 证明 generated project 只 link 固定 bundle。fixture test 证明 provider settings、preset visibility 和 metadata 只写入 supplied Dev home。针对 disposable project 的 Host boot 会在仅 development call 允许 linked package 的条件下加载相同 profile rule。

## Phase 7A integration validation

Electron startup shell 是刻意保留的等待与错误 surface。只有当 main process 的 `backend.start()` 完成且仍存在 live `backend.host` 时，main process 才会离开 `dsh-app://shell/startup.html` 并导航到 `dsh-app://app/index.html`。baseline Dev launch 已到达该 application route。Phase 2–6 launch 最初停留在 startup error surface，是因为 generated project 虽然 link 了 composition bundle，却没有 link 它的 direct workspace loader dependency。development-project preparation 现仅将这些已声明的 direct dependency link 到 disposable project；重建受影响 Host artifact 后，同一 Phase 2–6 launch 已进入 real frontend。production Electron startup behavior 未改变。

`agent-run-policy` 通过其 Cordis fiber 管理 cancellation probe。其 teardown 现在会 detach listener、abort fiber-owned observation signal，并在 dependency provider 消失前等待 in-flight probe continuation。regression test 会在 disposal 期间保持 cancellation probe。一次真实 isolated IQ3_S request 已进入 llama.cpp prompt processing，随后由 Dev Host disposal 停止，且没有出现 inactive `agentRunState` access。

同一 Dev composition 为 live IQ3_S request 提供只读 `/agent_run_state` transport：它报告了稳定的 session/run/attempt identity，以及 xhigh 的 requested、resolved 和 wire reasoning。由于未组合 GGUF observer，backend health、backend activity 与 prefill 保持明确的 unknown/null 值。另一个 disposable replay profile 在 HTTP process probe 仍为 healthy 时，把已记录的 MLX Metal-resource-limit fixture 及其后的 BrokenPipe record 输入 MLX observer。最终 diagnostics 为 `processHealth: healthy`、`generationHealth: fatal`、overall `fatal`、primary `RESOURCE_LIMIT`、secondary `STREAM_DISCONNECTED`，retry count 为 zero。

完整 Desktop composition 还写入了 revision 3 的 TaskCheckpoint：completed step 为 1，pending step 为 2；它被分类为 `SAFE_TO_RESUME`，但没有执行。注入 `TOOL_OUTCOME_UNKNOWN` 后，分类为 `BLOCKED_UNKNOWN_SIDE_EFFECT`。其 compaction waterfall 在 attempt 1 使用 `low`，在 attempt 2 使用 `medium`，并在 candidate 缺少 authoritative task fact 时请求 retry；它只装饰 `purpose: compaction`，使 main xhigh work 保持隔离。actual roster 隐藏 `benchmark`，允许 explicit resolution，并在 explicit benchmark Session 中产生 `benchmark-lock` xhigh diagnostics。

repository 的 updater design 已存在并面向 release：electron-builder 会根据 `DSH_DESKTOP_AUTO_UPDATE_ENV` 生成 generic-provider feed，并在独立 COS upload 前验证 macOS ZIP metadata 与 blockmap。检查到的已安装 `0.2.6` app 包含 GitHub `latest-arm64` `app-update.yml`，但它是无 TeamIdentifier 的 ad-hoc 签名，不能作为 release-qualified signed artifact 的证据。本验证没有 query、install、publish 或修改 updater state。此环境的完整 source build 仍被阻塞：Codex Node `v24.19.0` 没有 `include/node/node_api.h`，而 `native/system/scripts/build.ts` 的 `flock` Node-API addon 需要该文件。未来的安全处理方式是在 packaged-build environment 使用带有 matching development header 的 pinned build Node distribution，而不是复制 header 或 patch system Node。

## Phase 7B diagnostics surface

同一 development-only composition 现选择 `desktop-run-diagnostics`、小型
`desktop-run-diagnostics-remote` browser bridge 与 `ui-run-details`。Host service
是版本化只读 Typert projection adapter：它组合既有 Agent Run State、Reasoning
Policy 和 TaskCheckpoint diagnostics，但不拥有 lifecycle 或 policy。adapter 只发送
`AgentRunState | null`，不发送 raw observer diagnostics，因为 raw unattributed
backend evidence 可能包含任意错误对象。已分类的 primary/secondary error 与三层
health 仍可使用，而 raw evidence 留在 Host。

bridge 会在 UI entry 启动前通过既有 Desktop Host connection 挂载生成的 Remote
namespace；这使它成为显式 client-loader dependency，而不是 first-render race。UI 在
既有 composer 附近贡献紧凑 control，并用已发布的 modal primitive 展开详情。它没有
Electron IPC、port、file-system、Session JSONL、log 或 settings access。它映射既有
`RunPhase`，Unknown 保持 Unknown，从不估算 prefill 百分比，并将显式 Resume 交给既有
TaskCheckpoint Host executor 做 fresh validation。这样正式 Desktop 与其 generic Remote
assembly 保持不变。

在隔离 Dev Home 中，真实 Desktop UI 已为一次真实 IQ3_S request render 紧凑 control
与唯一 details modal。其 status 从 Preparing 进入 `Reasoning · xhigh`，再到 Completed；
details cut 显示精确 Dev route、稳定 session/run/attempt identity、confirmed xhigh
requested、selected、resolved 与 wire value、normal context pressure，以及 retry count
zero。由于 GGUF deployment 尚无 structured backend observer，prefill、attribution 和
process/model/generation health 仍明确保持 Unknown。

## Consequences

本地运行时 capability work 可以针对 Desktop Host 测试，而不修改用户的 released Desktop 或 daily configuration。isolated provider 使 active backend 可与 official route 区分。temporary backend 仍由独立 test procedure 拥有，必须由它启动和停止。released Desktop integration 需要后续 artifact-build decision，而不是暗中 fallback 到此 source layer。
