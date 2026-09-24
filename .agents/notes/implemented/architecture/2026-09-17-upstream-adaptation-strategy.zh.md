# Agent Note：Phase 8C latest-upstream 策略与 Stage 3 数据边界

状态：已实施

[English](2026-09-17-upstream-adaptation-strategy.md) | 中文

## 问题

Phase 8C.1 已锁定策略；Phase 8C.2 正按 stop gate 逐阶段实现。Adaptation target 是已 fetch 的 `origin/master` commit `ddefc45fbc7f8e46dd73185e68295696d1297887`（`0.1.6-alpha.2`）。审计在 `/tmp/ds-harness-upstream-adaptation-ddefc45f` 的 `adapt/ds-harness-upstream-ddefc45f` 分支中进行，该分支直接从此 commit 创建。源产品 baseline 仍是 `ds-harness-product-baseline-2026-09-17`，指向 `bfba98b9bd9390735242ad57840050850a3c11b5`；技术恢复 baseline 仍是 `dsh-custom-baseline-2026-09-17`，指向 `9d9762e7d2567248050559f2ac1b04e9f2a766f2`。Merge base 是 `c291e7961a515f6d7af9304e7fd1d257929aef26`，baseline-only 为 12 个 commit，target-only 为 1,548 个 commit。Stage 1–3 已完成；Packaging 与后续所有能力移植仍为 pending。

没有安装或启动 candidate。两个已安装 App、主工作树、两个 baseline tag、monitor cursor/state、scheduler state，以及真实 settings、sessions、profiles、Application Support 数据都没有被修改或使用。所有源码工作与测试只发生在隔离 worktree 或测试创建的临时目录中。

机器可读契约是 [`2026-09-17-upstream-adaptation-strategy.manifest.json`](2026-09-17-upstream-adaptation-strategy.manifest.json)。其中的能力行、seam 记录、移植阶段、证据路径和 status/action 枚举是本文摘要的精确权威来源。

## 纯 upstream 健康度

在 macOS arm64、Node 24.21.0 环境，`pnpm install --frozen-lockfile` 与完整 `pnpm run build` 均通过。Phase 8C.2 通过 Corepack 固定并执行仓库声明的 pnpm 11.7.0。构建完成 darwin-arm64 native system module、Host/client libraries、web renderer 和 248 个 client artifacts。

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

Stage 3 实现已明确数据权威关系，同时不改变 Official Desktop 默认行为。Official 继续使用 `desktop` profile、upstream 默认 Electron state，以及共享的全局 settings 与 Session 权威。DS Harness 使用 `desktop-custom` profile 和按 product flavor 隔离的 Electron state，同时保留已批准的全局 settings/Session 共享设计。Candidate 当前不得使用这些真实共享存储：只有在 `DSH_DESKTOP_DATA_MODE=candidate-rehearsal` 指定绝对路径 `DSH_DESKTOP_REHEARSAL_ROOT` 时才允许启动，且所有 DSH 与 Electron 路径都必须包含在该临时 root 下。缺失、非法或发生路径逃逸的 rehearsal 输入会在 Host 启动前 fail closed。

| 权威 | Official | DS Harness 最终设计 | 当前 Candidate |
| --- | --- | --- | --- |
| Settings | `$DSH_HOME/settings.yaml` | 同一共享权威 | 仅临时 rehearsal 副本 |
| Sessions | `$DSH_HOME/sessions` | 同一共享权威 | 仅 synthetic 或 copied fixture |
| Profile | `$DSH_HOME/profiles/desktop` | `$DSH_HOME/profiles/desktop-custom` | 全新临时 `desktop-custom` |
| Electron state | Upstream 默认 | 按 product flavor 隔离 | `<rehearsal>/electron/<flavor-id>` |

Settings 为双向兼容：baseline 与 target 使用相同的 settings-file implementation blob，读取不会自动回写，继续使用带锁的 atomic replace，且更新时保留未知 section。Profile data 需要 migration：旧 `desktop-custom` manifest 在结构上可读，但其 bundle list 与 `patchReload` 语义无法描述当前 boot composition；全新的临时 Custom profile 兼容。

两个 baseline 都使用 Session format v3，JSONL persistence 实现未改变。read-open 只在内存中准备历史 migration，不发生写入；只有 write-open 才发布经过验证的不可变 successor generation，并保留 predecessor。物理格式兼容不等于 event catalog 双向兼容：target-only required events `image/offload`、`workspace/changes` 对 Final Product 是未知事件；旧 Custom required events `task/checkpoint`、`task/result-manifest` 对 target 是未知事件，且当初未标记为 ignorable。其分类为 `CUSTOM_EVENT_MIGRATION_BLOCKED`，留待 Stage 6 schema adapter 解决。因此 source rollback 与 data rollback 必须分开处理；如果 Candidate 可能写过 Session，只有恢复 Candidate 启动前的 snapshot 才能安全回滚数据。

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
| Data boundary | Shared settings/sessions；隔离 Electron/profile | 新 resolution 与 v3 automatic migration | REWRITE_REQUIRED | Stage 3 boundary 已实现；live cutover 继续受 gate 保护 | CRITICAL | Temp roots、migration、sentinels |
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
3. **已完成：**使用临时 copied fixtures 建立 profile/settings/session/userData boundary。Live data 继续阻断到 Stage 13 cutover gate。
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

### Stage 13 静态 hygiene 资格验证决策

Stage 13 仅对 `verify-client-domain-graph` 和 `duplication` 采用相对于基线的资格判断。锁定的比较基线是原 Stage 13 candidate 的 Git tree `656c3bcfede57e3cba2fa19c8c8d9026fa3bf9fd`（即 `chore(architecture): close Stage 12 decision record` 提交对应的 tree）；对比的产品 candidate tree 为 `9bd3d99a894cd4c2e51fb927fefadda919cc7c56`（即 `fix(desktop): wait for flushed asar archives` 提交对应的 tree）。这些不可变 Git tree identity 精确标识源码快照，不使用 commit 引用。既存 finding 必须具有相同 identity 和 rule/category，相关源码未被 candidate 修改，且数量、import 关系或 clone 范围没有实质变化。原始 gate 结果仍记录为 `FAIL`，这类 finding 分类为 `PRE_EXISTING_UNCHANGED_DEBT`，candidate regression 记为零。任何新增 finding、rule/category 变化、关系或 clone 范围扩大，或 candidate 修改造成的 violation，都会阻断资格验证。继续 Stage 13 前，须在治理提交后的 HEAD 重新运行两个 gate 并核对 finding identity。

本次明确命名的 client-domain 架构例外记录为 `FAIL — 38 PRE_EXISTING_UNCHANGED_DEBT; candidate regressions: 0`：38 条的 rule/source/import identity 均与原 candidate 一致，没有新增或变化的 finding，candidate 也未修改对应源文件。这些违反 client-domain 分层规则的债务仍未解决。Duplication 结果记录为 `FAIL — 7 PRE_EXISTING_UNCHANGED_DEBT; candidate regressions: 0`：七组 file-pair/range clone 均一致，两次提交的 duplicated lines 为 69、duplicated tokens 为 567，没有新增或变化的组，candidate 也未修改对应源文件。这些可维护性债务仍未解决。两个原始 gate 都不得记为通过。

此决策不适用于 signing、runtime 或 package integrity、native runtime、startup/restart、crash/process health、Official/Custom 或 profile/data isolation、live-data safety、Session/Task/Run correctness、rollback、destructive operations，以及 security/safety sentinels；这些门禁即使历史上已有同类失败，也仍须阻断资格验证。Stage 13 保持 `PENDING`。两项 hygiene 债务须在建立新的 Final Product baseline 或 cutover review 时另行作出明确决定，或在独立 hygiene remediation 阶段关闭。

### Stage 13 静态文档债务资格验证决策

与静态 hygiene 决策分开，Stage 13 仅对 `verify-repository-references` 和 `verify-concrete-terms` 采用相对于基线的资格判断。比较基线是上文标识的原 Stage 13 candidate Git tree `656c3bcfede57e3cba2fa19c8c8d9026fa3bf9fd`。在每次资格验证的 HEAD，只有 finding identity 和 rule 与该基线一致、源码位置和语义目标没有实质变化、candidate 也没有新增或扩大 finding 时，才能将其分类为 `PRE_EXISTING_UNCHANGED_DOCUMENTATION_DEBT`。原始 gate 结果仍记录为 `FAIL`，candidate regressions 记为零。任何新增或变化的 finding、范围扩大或 candidate 修改造成的 violation 都阻断资格验证；后续 candidate 不得自动继承本决策。

明确批准的 repository-reference 记录为 `FAIL — 15 PRE_EXISTING_UNCHANGED_DOCUMENTATION_DEBT; candidate regressions: 0`：15 条 file/location/rule identity 均与原 candidate 一致，new 0、changed 0。另行批准的 concrete-term 记录为 `FAIL — 3 PRE_EXISTING_UNCHANGED_DOCUMENTATION_DEBT; candidate regressions: 0`：strategy 英文、中文及 runtime-diagnostics type 中的 finding identity 和含义均与原 candidate 一致，new 0、changed 0。两个原始 gate 仍为失败，全部 18 条 finding 均未解决。继续 Stage 13 前，须在本次文档治理提交的 HEAD 重新运行两个 gate 并核对 finding identity。

本决策不适用于生成文档的新鲜度，包括已单独修复 candidate regression 并恢复通过的 `verify-config-catalog`。它也不适用于 runtime 或 package integrity、signing、startup/restart、process health、Official/Custom 与 data/profile isolation、Session/Task/Run 和 Agent Runtime correctness、rollback safety，以及 security/safety sentinels；这些门禁失败仍须阻断资格验证。Stage 13 保持 `PENDING`。文档债务须在建立新的 Final Product baseline 或 cutover review 时另行作出明确决定，或在独立 remediation 阶段关闭。

## 后果

### 安全、native、maintenance 与未决 contract

所有 data/migration 测试都设置临时 `DSH_HOME`、profile、userData 与 Application Support 等价目录，并只使用 synthetic 或 copied released fixtures。Phase 8C.2 中真实用户数据仍然不在范围，除非以后单独授权 migration rehearsal。未来 cutover 必须先停稳两个产品，snapshot settings、Sessions 与 `desktop-custom`，记录 hash 和 restore manifest，在副本上 migration 并验证，然后取得明确批准才可访问共享存储。只要 Session 双向兼容尚未证明，source rollback 就必须恢复该 snapshot。Electron `sessionData` 始终属于 product-flavor state，不得与 DSH Session JSONL 混淆。

Native qualification 采用 upstream runtime lock，并验证 architecture、payload hashes、deep codesign、Node/Python execution、`native/system`、`node-pty`、`koffi`、`sharp`、Host startup 与 renderer loading。它只能发生在 candidate path，绝不使用已安装 stable Apps。

Phase 8B auditor、monitor、scheduler、notification 与 maintenance runtime 保持 repository-only plane。产品 composition 稳定后再移植，只适配 package scripts 和 documentation paths，同时保持 cursor、state、每日 schedule、material-change-only notification，以及 stable Homebrew Node/repository tsx entrypoints。

剩余 contract 按 stop gate 留给后续阶段：Custom durable events 在 v3 中选择注册还是 ignorable；本地 IQ3_S 到当前 pi-ai catalog 的最终映射；当前 dockkit/scoped-slot Run Details 插入 contract；以及 packaged DS Harness primary-runtime/ABI 行为。解决这些问题都不需要访问真实用户数据或修改 stable App。

Compatibility debt 仍是 **CRITICAL / BLOCKING_CHANGE / UNRESOLVED**。Stage 1–3 只证明 target、product identity 与隔离数据 contract；尚未证明 packaging、Custom durable-event 适配、live data cutover、后续能力移植或新 product baseline。
