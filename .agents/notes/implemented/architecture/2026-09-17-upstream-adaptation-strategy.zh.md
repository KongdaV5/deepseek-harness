# Agent Note：Phase 8C.1 锁定 latest-upstream 语义移植策略

状态：已实施

[English](2026-09-17-upstream-adaptation-strategy.md) | 中文

## 问题

Phase 8C.1 是侦察与策略锁定，不是实现或发布。Adaptation target 是已 fetch 的 `origin/master` commit `ddefc45fbc7f8e46dd73185e68295696d1297887`（`0.1.6-alpha.2`）。审计在 `/tmp/ds-harness-upstream-adaptation-ddefc45f` 的 `adapt/ds-harness-upstream-ddefc45f` 分支中进行，该分支直接从此 commit 创建。源产品 baseline 仍是 `ds-harness-product-baseline-2026-09-17`，指向 `bfba98b9bd9390735242ad57840050850a3c11b5`；技术恢复 baseline 仍是 `dsh-custom-baseline-2026-09-17`，指向 `9d9762e7d2567248050559f2ac1b04e9f2a766f2`。Merge base 是 `c291e7961a515f6d7af9304e7fd1d257929aef26`，baseline-only 为 12 个 commit，target-only 为 1,548 个 commit。

没有安装或启动 candidate。两个已安装 App、主工作树、两个 baseline tag、monitor cursor/state、scheduler state，以及真实 settings、sessions、profiles、Application Support 数据都没有被修改或使用。所有源码工作与测试只发生在隔离 worktree 或测试创建的临时目录中。

机器可读契约是 [`2026-09-17-upstream-adaptation-strategy.manifest.json`](2026-09-17-upstream-adaptation-strategy.manifest.json)。其中的能力行、seam 记录、移植阶段、证据路径和 status/action 枚举是本文摘要的精确权威来源。

## 纯 upstream 健康度

在 macOS arm64、Node 24.21.0 环境，`pnpm install --frozen-lockfile` 与完整 `pnpm run build` 均通过。仓库声明 pnpm 11.7.0，本次实际可用 CLI 为 11.19.0。构建完成 darwin-arm64 native system module、Host/client libraries、web renderer 和 248 个 client artifacts。

未修改 target 的完整测试结束结果为：1,511 个 test files 通过、4 个失败、14 个跳过；test level 为 25,845 通过、260 失败、1 个 expected failure、176 跳过。260 个失败有两个 upstream/环境原因：

- 245 个 Python PTC 失败使用源码默认 `python3`，本机解析为 `/usr/bin/python3` 3.9.6，低于 upstream 的 Python 3.10 最低要求。upstream 打包的 primary runtime 自身锁定 Python 3.12.14。
- 15 个 `apps/desktop/tests/main-startup.spec.ts` 失败由一个 upstream fixture 不匹配和随后的 14 个超时组成。Fixture 把 `process.platform` 伪装成 Windows，却保留宿主机 arm64 架构；新的 installed-client policy 正确拒绝不可能的 `desktop-win + arm64` identity。

这些是已记录的 upstream known failures，不是 Custom regression。Clean build 已通过，两个失败类也都有直接、可复现原因，因此不阻塞架构侦察；但发布资格验证前必须用 Python 3.10+ 并修正 upstream test fixture 后重新运行。

## 实质性架构变化

### Desktop 与产品身份

Desktop 新增 mandatory-update identity/policy、update qualification、改变后的 startup shell 和简单 single-instance lock。`DSH_DESKTOP_APP_ID` 提供 bundle identifier，但 `productName` 仍硬编码，Desktop 和 Host 仍选择 `desktop` profile。旧 Custom 的 `startup-renderer.ts` seam 已不存在。因此产品身份需要符合当前架构的显式 flavor seam；直接重放旧 main/paths/renderer patch 不安全。

### Packaging 与构建

Release pipeline 现在 staging 一个签名 primary runtime，其中锁定 Node 24.21.0、Python 3.12.14、pnpm 11.7.0、Python wheels、payload digests、updater inputs 与 qualification stages。旧 package/install scripts 无法代表这套 closure。应保留 upstream 对当前 builder factory 与 runtime lock 的所有权，DS Harness 只添加经过审查的 product-flavor inputs 和 candidate verification。

### Profile、数据与 Session

Profile resolution、isolated module fallback、cleanup 行为和 runtime installation 都有变化，但默认 Desktop identity 仍是 `desktop`。Session persistence 已是 format v3，包含显式 v0-to-v1、v1-to-v2、v2-to-v3 migration、generation/lease 检查、corruption/future-version refusal 和 known-event catalog。未知 extension events 会被拒绝，除非注册或安全标记为 ignorable。Automatic migration 使 profile/data isolation 成为首个产品 stop gate；只能在临时 root 中使用 copied fixtures 测试。

### Agent、Run lifecycle 与 retry

`AgentStatus` 仍只有 `idle | running`，但 lifecycle evidence 丰富很多：durable turn/step boundary、`LlmAttemptId`、带 committed settlement 的 compact transient assistant stream、retry events、结构化 terminal reasons，以及 interrupted-turn closure。Upstream 仍没有 DS Harness `RunId`、backend health 或 truthful Run State projection。Upstream retry 提供 durable same-turn backoff，但 normal mode 默认 5 次 retry，也不包含 DS Harness backend fatal evidence。可采用其 mechanism；已批准的 `retry <= 2`、cancel acknowledgement、fatal-no-retry 必须只集成一次，不能形成第二套 retry engine。

### LLM 与 reasoning

`LlmFailure` 现在携带 provider-neutral code、status、retry-after、request ID 等事实。Streaming 暴露 reasoning、tool deltas，以及分离的 input/cache/output/reasoning usage。`llm-pi-ai` 支持 request-level `reasoningEffort`、model-advertised levels、严格 unsupported-value error，以及 request override 覆盖 profile default。这些是 upstream-native foundation。已审计的 IQ3_S 行为——`none`、`low`、`medium`、`xhigh`；`high -> xhigh`；`off -> none`；xhigh-first task policy 与稳定 segment——仍属于 backend-specific DS Harness mapping。

### Compaction 与 token surface

`compaction-basic` 现在拥有 token-meter thresholds、automatic/manual/context-overflow triggers、bracketed atomic summary、replacement generations、shrink validation、prompt-cache prefix reuse、tool-result pruning 和 image offload。不得重放旧的修改版 executor。DS Harness 仍需要薄 task-aware layer，负责 eligibility、TaskCheckpoint fact preservation、deterministic validation、low-to-medium-only 辅助 reasoning、fail-closed apply，以及恢复主任务 xhigh scope。

### Client 与 diagnostics

Client composition 已迁移到 generated catalogs、module packages、scoped/factory slots 和 `ui-dockkit`。旧 `RunStatusDock.tsx` 插入模型没有稳定的一对一对应点。Upstream runtime invariants 可验证很多 contract，但不提供 Run State、backend process/model/generation health、prefill observation、primary/secondary error precedence 或 read-only Run Details 体验。Transport 与 UI 必须在 Run projection 稳定后重建，并继续保证 idle 时 `run = null` 且不占 composer 空间。

### Native runtime

Electron 仍为 44.0.0；Node 从 Custom baseline 的 24.17.0 升到 24.21.0。`node-pty` 1.2.0-beta.15、`koffi` 3.1.1、`sharp` 0.35.3 不变。当前 primary runtime 新增 Python 与 signed payload closure。锁机制已转移到 upstream `native/system` stable N-API；`fs-ext` 仅剩 legacy policy surface，不是当前 runtime lock dependency。Adapted product 必须验证整个 packaged closure，不能复制旧 binary assumptions。

## 能力适配矩阵

| Capability | 旧 DS Harness implementation | 当前 upstream equivalent | Status | Required action | Risk | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| 产品身份/共存 | Custom app ID/name、userData/profile、branding、single instance | 部分 appId input；固定 product/profile 与新 startup/update identity | REWRITE_REQUIRED | REIMPLEMENT 最小 product flavor | CRITICAL | Identity、paths、branding、双 App 共存 |
| Packaging/daily install | Custom staging、Node Host、signing、native smoke | Signed primary runtime 与 release qualification | REWRITE_REQUIRED | 扩展当前 pipeline | HIGH | Runtime manifest、codesign、ABI、candidate rehearsal |
| Run State/identity | session/run/attempt projection | Turn/step 与 LlmAttemptId，无 RunId | PORT_WITH_ADAPTATION | 面向新 events 移植 | HIGH | Lifecycle fixtures、retry same run、terminal immutability |
| Backend observation/health | MLX/GGUF observers 与三层 health | 未找到 equivalent | PORT_WITH_ADAPTATION | 在 observer contract 后移植 | HIGH | Long prefill、worker fatal、attribution Unknown |
| Error classification | 强证据 fatal 和 primary/secondary precedence | 只有结构化 LlmFailure facts | PORT_WITH_ADAPTATION | 复用 facts、移植 precedence | HIGH | Resource limit、cancel/BrokenPipe、弱证据 |
| Run/retry policy | bounded、fatal-aware、cancel-safe | Durable provider retry 默认 5 次 | REWRITE_REQUIRED | 在 native mechanism 上集成一次 | CRITICAL | Retry 至多 2 次；fatal 不 retry |
| Task checkpoint/result manifest | Domain task facts 与 pending-only resume | Generic checkpoint/repair/resume foundation | REWRITE_REQUIRED | 重做 v3 domain events/projection | CRITICAL | Crash、pending-only、outcome-unknown block |
| Generic crash durability | Custom flush/repair hooks | Native checkpoint policy、lease、repair、interrupted closure | UPSTREAM_NATIVE | KEEP_UPSTREAM | MEDIUM | Native E2E 与 persistence tests |
| IQ3_S reasoning | xhigh-first 与 backend aliases | Request effort 与 capability plumbing | PORT_WITH_ADAPTATION | 只移植 backend policy | HIGH | 审计 matrix 与 scope stability |
| Task-aware compaction | Pressure、validation、low/medium、atomic apply | 强 native executor/pruner/offload | PORT_WITH_ADAPTATION | 薄 adapter；保留 native engine | HIGH | Facts、fail closed、scope isolation |
| Large tool results | Custom summary/key lines/references | Native pruner 与 offload | UPSTREAM_NATIVE | KEEP_UPSTREAM | MEDIUM | Root cause 与 artifact retention |
| Run Details | Remote 与旧 dock | 新 module/catalog/dockkit client | REWRITE_REQUIRED | 重建当前 transport/UI | HIGH | Reconnect、read-only、idle closure |
| Data boundary | Shared settings/sessions；隔离 Electron/profile | 新 resolution 与 v3 automatic migration | REWRITE_REQUIRED | 显式 boundary 与 fixture qualification | CRITICAL | Temp roots、migration、sentinels |
| Phase 8B maintenance | Auditor/monitor/scheduler/notification | 与产品独立的 repository plane | UNCHANGED_PORTABLE | 后期移植；只适配 wiring | MEDIUM | B8 regression 与 state hash 不变 |

## Upstream-native 缩面与必要 Custom surface

新分支必须采用 upstream checkpoint flush、generic resume 和 interrupted-turn closure、TOOL_NOT_STARTED/TOOL_OUTCOME_UNKNOWN repair facts、request-level reasoning plumbing、`LlmFailure`、same-turn retry events/backoff、token meter、atomic compaction、tool-result pruning/image offload、runtime invariants，以及 session migration/generation/lease/projection foundation。重复这些能力会增加风险，却不保护任何独特用户 invariant。

旧 baseline 改变 256 个 tracked files（19,967 insertions、163 deletions），其中 136 个文件位于主要 capability paths。Phase 8C.1 不虚构容易误导的未来文件数。必要的新 Custom surface 改按十个 semantic domains 约束：product flavor、data boundary、minimal composition、run observability、safety policy、task continuity、IQ3_S reasoning、task-aware compaction、client diagnostics、repository-only maintenance plane。每个 domain 都必须小于替换整个 upstream subsystem，并为每个 hook 提供必要性证据。

## 十一个 compatibility seams

| Seam | 旧 contract -> 新 contract 与 breakage | Required migration | Risk | Mapped validation |
| --- | --- | --- | --- | --- |
| desktop-product-identity-isolation | 旧 main/paths/renderer flavor -> environment appId 加固定 product/profile 与新 update identity；无法一对一 patch | 启动前审查当前 product-flavor seam | CRITICAL | Identity、isolation、coexistence、branding |
| desktop-packaging-runtime-tree | Custom Node staging -> signed Node/Python/pnpm primary runtime；旧 scripts 绕过 closure | 扩展当前 runtime/builder inputs | HIGH | Locks、digests、codesign、native smoke |
| package-set-custom-composition | 旧 Cordis patch -> 改变的 package/module catalogs；entries 可能已移除或 native | 重建 minimal composition | HIGH | Resolution、isolated Host startup、inventory equality |
| client-package-export-loader | 旧 exports/slots -> generated catalogs 与 scoped/factory slots | 当前 exports/catalog integration | HIGH | Catalog generation、module 与 renderer build |
| profile-settings-session-boundary | desktop-custom 加 shared stores -> 默认 desktop 加新 resolution/migrations；有碰撞/迁移风险 | 显式 paths 与 copied-fixture qualification | CRITICAL | Temp-home audit 与 sentinel hashes |
| agent-run-event-contract | 旧 events -> turn/step/LlmAttemptId/compact streams/terminal reasons；旧 projection 不完整 | 新 event 到 RunId adapter | HIGH | Event matrix、same-run retry、terminal stability |
| llm-provider-stream-contract | 旧 hooks -> LlmFailure/reasoning/usage/provider retry；旧 adapters 会重复行为 | Native facts 上唯一 DS Harness policy | CRITICAL | Provider contracts、IQ3_S、retry/fatal |
| session-projection-persistence-contract | 旧 custom envelopes -> v3 catalog/migrations/leases；旧 events 可能被拒绝 | v3 event 与 projection 设计 | CRITICAL | Schema、round trip、migration、refusal behavior |
| compaction-token-surface-contract | 修改版旧 executor -> 成熟 native transaction/pruner/offload；重放会产生双引擎 | 薄 eligibility/reasoning/validation adapter | HIGH | Atomic failure、facts、fallback、main scope |
| diagnostics-remote-ui-contract | 旧 remote/dock -> session transport/module/dockkit；插入点改变 | Projection 后重建 | HIGH | Reconnect、read-only、idle run=null |
| native-runtime-abi-closure | Node 24.17 与旧 smoke -> Node 24.21/Python/native-system/signed payload；旧 assumptions 不完整 | 使用 runtime lock 并验证 packaged flavor | HIGH | Architecture、modules、Python、codesign |

## 决策

唯一主策略是 **B：fresh latest-upstream branch + semantic capability port**。Adaptation branch 已从精确锁定的 target 起步。每项 Custom capability 只有在其 invariant 与当前 upstream owner 比较后才重新引入。既有源码可作为已测试 domain logic 复用，但 historical patches 不是 integration units。

## 考虑过的替代方案

- **Rebase 现有 Custom branch。** 拒绝，因为 11/11 seams 均改变，解决冲突并不能证明语义安全。
- **Full 或 broad cherry-pick。** 拒绝，因为它会重放旧文件/ownership assumptions，包括重复 upstream-native capability。
- **Hybrid 作为主策略。** 拒绝，因为它会造成架构与 provenance 模糊；在策略 B 内选择性复用代码并不会改变 latest-upstream-first branch model。

## Phase 8C.2 移植顺序与 stop gates

1. 重新确认 target/toolchain health。Target 或 health 无解释漂移即停止。
2. 加入 product identity/process isolation。任何与 official Desktop 或 Stable DS Harness 碰撞即停止。
3. 用临时 copied fixtures 建立 profile/settings/session/userData boundary。任何真实数据访问或未解决 migration 即停止。
4. 恢复 packaging 与 primary-runtime closure。Payload、signing、native 任一失败即停止。
5. 构建最小当前 Cordis/package-set composition。重复 native service 或隔离启动失败即停止。
6. 适配 Session v3 与 Agent lifecycle contracts。Run identity 或 durable event 语义有歧义即停止。
7. 移植 Run State、observers、health 和 error precedence。猜测 Unknown 或 terminal state 可倒退即停止。
8. 重做 TaskCheckpoint、Result Manifest 与 guarded pending-only resume。权威 task facts 可能丢失或重复即停止。
9. 只集成一次 IQ3_S reasoning 和 bounded fatal-aware policy。出现 double retry 或无法证明 wire reasoning 即停止。
10. 在 native engine 外加入 task-aware compaction。它可能修改 task authority、删除 evidence 或降低主任务 reasoning 即停止。
11. 在当前 client contracts 上重建 Run Details。可写或重新引入 idle layout 占用即停止。
12. 移植 Phase 8B repository maintenance plane。进入 runtime composition 或改变 monitor state/debt 即停止。
13. 运行完整隔离 regression 和 packaged candidate qualification。任何 invariant 失败都禁止 install、tag 或建立新 baseline。

## 后果

### 安全、native、maintenance 与未决 contract

所有 data/migration 测试必须设置临时 `DSH_HOME`、profile、userData 与 Application Support 等价目录，并只使用 synthetic 或 copied released fixtures。Phase 8C.2 中真实用户数据仍然不在范围，除非以后单独授权 migration rehearsal。Settings 与 sessions 只有在 path contract 和 migration behavior 通过 sentinel tests 后才可按设计共享；`desktop-custom` 与 Electron state 必须继续隔离。

Native qualification 采用 upstream runtime lock，并验证 architecture、payload hashes、deep codesign、Node/Python execution、`native/system`、`node-pty`、`koffi`、`sharp`、Host startup 与 renderer loading。它只能发生在 candidate path，绝不使用已安装 stable Apps。

Phase 8B auditor、monitor、scheduler、notification 与 maintenance runtime 保持 repository-only plane。产品 composition 稳定后再移植，只适配 package scripts 和 documentation paths，同时保持 cursor、state、每日 schedule、material-change-only notification，以及 stable Homebrew Node/repository tsx entrypoints。

五项 contract 有意留给对应的 Phase 8C.2 gate：准确的 upstream-style product flavor API；Custom durable events 在 v3 中选择注册还是 ignorable；本地 IQ3_S 到当前 pi-ai catalog 的最终映射；当前 dockkit/scoped-slot Run Details 插入 contract；以及 packaged DS Harness primary-runtime/ABI 行为。解决这些问题都不需要访问真实用户数据或修改 stable App。

Compatibility debt 仍是 **CRITICAL / BLOCKING_CHANGE / UNRESOLVED**。策略锁定只证明如何移植，不证明移植、packaged candidate、data migration 或新 product baseline 已完成。
