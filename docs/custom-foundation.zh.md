# Custom foundation 迁移 ledger

[English](custom-foundation.md) | 中文

## 基础与验证范围

P-UPSTREAM-0.2-M1 在 `migration/upstream-0.2-rc2` 分支上从官方 `dsh-v0.2.0-rc.2` 的精确 tag 开始。可信 `feature/codex-subscription` 分支保持不变。Custom 原始祖先是 `dsh-v0.1.6-alpha.2`。本工作包的官方 target 固定。

Candidate 采用官方 Config、ConfigEditor、profile composition、agent-preset 架构、Session V4 codec 和 immutable generation publisher。Custom 状态限于产品身份、Local inventory、非秘密 Codex 配置与 mapping，以及 task authority。旧 Settings store 和 settings-file 包仍不存在；以下 M1 ledger 记录初始基础，M2 runtime ownership 在后文记录。

## 连续 ownership ledger

| Area | Upstream implementation reused | Old Custom code | Custom addition and reason | State / persistence / lifecycle owner | Compatibility | Custom implementation |
|---|---|---|---|---|---|---|
| Build/package | RC.2 topology, project references, tsdown and generators | REPLACED | Six necessary Custom packages; source-derived lockfile and catalogs | Package manifests / pnpm lock / official build | none | reduced |
| Config | Config, volatile references, ConfigEditor and Settings forms | REPLACED | No SettingsScope or installSection adapter | Plugin Config / profile patch / Loader | none | reduced |
| Codex config | Profile edit and live Config | ADAPT | Preference reader and exact non-secret auth facts | agent-codex / profile patch / ConfigEditor; M2 owns auth transactions | none | reduced |
| Local config | llm-pi-ai and agent-default-model Config | ADAPT | Local inventory and selected profile; no runtime observations persisted | custom-foundation; provider and selection stay with official owners / profile patch / Loader | none | reduced |
| Product/profile | Official profile bootstrap and data helpers | ADAPT | Product flavor, bundle identity source, explicit Custom root and rehearsal isolation | Desktop identity / desktop-custom profile / shell bootstrap | none | same |
| Legacy import | Official file lock and atomic write | REPLACED | Translate Custom namespaces before Settings mounts; digest recovers interrupted publication | custom-foundation / canonical profile patch plus unchanged source archive / initialization | temporary; remove after supported legacy Custom settings retire | reduced |
| Session V4 | Official adjacent edge, child catalog facts and immutable successor publication | REPLACED | Explicit pure incoming extension callback; no new transaction | Official Session / JSONL generations / official prepare-publish | one-way historical conversion, retained while V3 is supported | reduced |
| Codex events | Build-static format catalog and projection registry | ADAPT | Canonical plugin-qualified identity and strict mapping validation | agent-codex projection / Session V4 / registry | historical conversion only | reduced |
| Task events | Session single writer and native tool-role results | ADAPT | Canonical plugin-qualified identities and event-sequence conversion | task-checkpoint / Session V4 / registry and continuity service | historical conversion only | same |
| Continuity | turnBoundary projection and durable turn identity | KEEP + ADAPT | Stale-admission and disposal invalidation; no restored in-memory admission | task-checkpoint and pure run/lifecycle readers / Session / explicit admission | none | reduced |
| Compaction references | Official reference conversion and preserved V3 generation | ADAPT | Historical audit explicitly qualifies its V3 capture; digest and supplemental messages remain exact | captured audit / retained V3; V4 checkpoint evidence uses V4 positions / reader | permanent generation qualification | reduced |
| Runtime behavior | RC.2 AgentLoop and provider interfaces | DEFER | Local driver, Codex external turns, settlement and catalog are M2 | Future explicit runtime owner | no fake executor or success shim | deferred |
| Desktop/UI | RC.2 Host and shell architecture | DEFER | Identity and bootstrap only; ModelSelect and Run Details remain M2 | Desktop Host and client owners | none | deferred |

## Custom 持久事件清单

实际 Custom Session producer 持久化三种 extension identity。Run authority 从原生 turn/step 事件派生；run-state 与 lifecycle-facts 不添加持久 extension event。Task-aware compaction 把 audit 附加到 `compaction/summary`，不创建另一种 extension event。

| V3 identity | Official generic conversion | Canonical Custom V4 identity | References and consumer | Conversion and evidence |
|---|---|---|---|---|
| codex/subscription-state | plugin:codex/subscription-state when ignorable; required unknown events refused | plugin:codex/subscription-state | Stable DSH message IDs and turn/step ordinals; external thread/turn/correlation IDs; Codex projection | Validate payload, retain auth binding and every unresolved fact; isolated physical publication fixtures |
| task/checkpoint | plugin:task/checkpoint when ignorable; required unknown events refused | plugin:task/checkpoint | completedSteps tool-result SessionSeq; stable task/Run/output/revision/resume IDs; task projection and guarded resume | Map prior event positions through the official insertion map; retain payload kind/version and turn-derived identities; checkpoint, producer and continuity tests |
| task/result-manifest | plugin:task/result-manifest when ignorable; required unknown events refused | plugin:task/result-manifest | Stable output/task/run identity and manifest revision; result projection | Validate whole manifest and preserve independent revision authority; migration and producer tests |
| compaction/summary.policyAudit | Generic conversion retains unqualified Custom payload | compaction/summary.plugin:task-compaction-audit | Generation-qualified authorityAsOfSeq, protection digest and captured messages | Keep the complete historical audit under sessionFormatVersion 3; it is historical evidence and cannot become V4 continuation authority |

原生 V4 producer 与 projection 仅接受规范 plugin-qualified identity。旧名称只存在于输入转换。Mapping 转换不会改变 authGeneration、轮换 CODEX_HOME、dispatch、resume、settle 或清除 operation。authStateEpoch 与 auth transaction 仍由延期到 M2 的 runtime 负责；配置初始化不制造这些状态。

## 失败与 no-replay 要求

配置翻译在发布前验证已知 section。未知 section 保留在归档。Profile digest 检测发布后归档前的中断；已有 profile 值避免 partial import 覆盖后续编辑。冲突的非秘密 auth authority 拒绝发布。

官方 generation publisher 保留 V3 字节，在独占发布前验证 V4，并复用已经发布的 successor。Custom 转换错误不会生成规范 V4 generation。测试分配独立临时目录；没有 fixture 读取或迁移正式 Custom profile。

Codex intent、accepted、uncertain、pending synchronization、completed-but-not-delivered 与未决 reconciliation fixture 恢复为 reconciliation-required。已同步的用户消息游标不能证明回答已交付；只有与 reconciliation 的 DSH turn 和 step 匹配的 assistant settlement 才能证明交付。恢复分类不是 dispatch 授权。Task admission 属于进程内状态，不从存储事件恢复；持久 checkpoint revision 和完成证据仍是唯一 task authority。

## 组合与延期集成

Custom bootstrap 按顺序安装 base、Web 与 desktop-custom bundles，并把 Huihui 精确模型路径解析到 llm-pi-ai 和 agent-default-model Config。未初始化的 Custom 层使用未注册 Local sentinel。组合禁用 DeepSeek Account、hosted DeepSeek、hosted search、模型生成标题、timer 与 HMR。不添加 Schedule、Automation、Computer Use、CUA driver 或权限提示。

M2 负责 Local start/stop/switch 与 inference；Codex App Server 生命周期、auth transaction 与 epoch、external-turn dispatch/cancel/settlement/reconciliation/resume；动态 model catalog 与 provider-aware admission；AgentLoop 集成和 task-aware compaction 执行；Desktop background/quit 行为、ModelSelect、popup 与 Run Details。M1 不 package、install 或验证真实 inference。

## 集中验证

最终 M1 检查覆盖 Config/plugin 与 legacy import、Custom V3→V4 发布及恢复 fixture、checkpoint/continuity 与 run authority、Local-first 与组合排除、product/rehearsal 隔离、受影响 Host/Client typecheck 与 lint、generated catalog、修改范围内双语文档、持久类型变更记录、whitespace 与 workspace hygiene。不包含完整历史 runtime proof、全套测试、Native build 或 GUI 启动。

集中检查覆盖 40 个选定测试文件和 1,011 个不同测试。首轮通过 1,004 项，发现一个中文 README 结构问题；修正后的文档通过全部 22 项所属测试。Typed lint 修正后，三个受影响测试文件通过全部 73 项测试。最终恢复边界检查在五个受影响文件中通过全部 129 项测试，包含六个新增生命周期和回答交付用例。官方 Host contract 构建后，Host 与 Client typecheck 通过。最终修改范围 lint 覆盖 63 个文件；生成产物、文档、持久类型变更记录、空白与工作区卫生检查通过。

不可变 successor 发布通过官方 prepare/publish/verify API 和实际读取提供者重启验证。本工作包不构建 Native bindings，因此没有验证 Native 写锁入口。此边界不引入替代发布器或锁适配器。所有持久化与 Config fixture 使用临时根目录；没有打开正式 Custom profile 或认证材料。

## M2 runtime 与 Desktop ownership

M2 扩展 M1 基础，不改变固定官方 base 或 trusted branch。源码 composition 现在挂载真实 runtime owner 和 Client 控件。下表记录旧 Custom 语义、承载语义的 RC.2 seam、最终 ownership 与剩余 qualification 边界。

| Area | Old implementation / decision | RC.2 seam | Final owner and lifecycle | Shim | Source evidence / M3 boundary |
|---|---|---|---|---|---|
| Local runtime | ADAPTED; retain exact profiles and serialization | Official subprocess handle, ConfigEditor and pre-step admission | One Local controller; LaunchAgent remains the qualified external service owner, or one explicitly configured owned child; handle release requires whole process-range exit | none | Real isolated Huihui start, READY inference and stop; managed-range timeout/crash fixtures; M3 proves installed manager/environment |
| Codex auth and runtime | ADAPTED; preserve Q1 and runtime-maintenance state machines | Official subprocess and JSON-RPC transport; plugin Config and ConfigEditor | CodexSubscriptionRuntime owns child, leases, auth epoch/transaction and dedicated CODEX_HOME; Codex Config owns generation/marker; preference edits cannot edit lifecycle fields | none | Focused owner, restart, no-replay and catalog fixtures; System 0.159.2 real handshake/model list; authenticated inference remains unproved |
| External turn | REPLACED old loop interception | Scoped resolver before assembly, native AssistantStreamAttempt and turn/step settlement | AgentLoop owns DSH conversation/cancellation; Codex owns private thread and dispatch reconciliation | none | One Session Local→Codex→Local fixture, external cancellation and Desktop active-task observation; M3 repeats real cross-provider turns |
| Mapping and recovery | KEPT semantics, ADAPTED V4 writes | Canonical Session events/projection and native settlement | Session is persistence authority; stored uncertain/completed-undelivered facts are obligations, never permission to repeat effects | V3 conversion only | Restart and delivery fixtures; M3 proves real persisted restart |
| Catalog and admission | REPLACED old Settings/model-picker plumbing | Native Session catalog and model selection plus optional external provider directory | Local Config owns exact inventory; App Server model/list owns Codex IDs; disappeared model blocks dispatch without substitution | Exact M1 single-model Local catalog upgrade only | Dynamic removal fixture and live discovery of gpt-6.1-sol; M3 checks actual selector with both runtimes |
| Task compaction | ADAPTED policy; REMOVED old executor plumbing | Native BasicCompaction transaction, RequestUserInput supplements and V4 references | Native backend alone publishes/recovers/brackets; policy protects task/checkpoint/manifest authority and rechecks immediately before publish | Historical V3 audit is read-only evidence | Actual backend fixtures prove low→medium auxiliary ladder, stable main reasoning and refusal on authority drift; M3 proves installed compaction/restart |
| Diagnostics and UI | ADAPTED pure projections; REPLACED bespoke selector/popup | Session projection/follow, generic resource transport, Models footer and native selector/positioner | Runtime owners publish redacted observations; Client stores retire stale generations; UI has explicit verbs and no Host Context | none | Render/control and stale-generation tests; bounded external activity remains separate from Local tools; M3 validates Native layout/interactions |
| Desktop Host | REPLACED old Host fork | Official profile bootstrap, launcher environment, task inspector, window/tray/quit owners | Custom flavor owns profile/data root and disables official updater; upstream lifecycle owns close/background/quit | none | Real source Host and Client RPC plus lifecycle fixtures; M3 proves packaged single-instance, close/background/quit and install |
| Build and contracts | ADAPTED graph; REMOVED Host types from Client imports | Official project references, Typert FaceModel emitter, catalogs and normal library build | Mapping state has a leaf face; Custom UI imports pure types; large Typert selections use existing bounded batch analyzer with emitter-equivalence proof | none | Normal Host/Client builds and generated checks; M3 builds fresh payload/signature once |

External turn resolver 在组装 Local prompt 或工具之前冻结选定 route。External failure 不会调用 Local adapter。ToolCallRecovery 仍拥有原生 Local tool outcome；Codex reconciliation 处理远端 thread/turn outcome，其 command 从不被表示为 Local tool call。它们是在同一 DSH turn 生命周期下的不同执行资源，没有竞争性的 recovery owner。

Compaction supplement 使用仅用于请求的 RequestUserInput，没有 Session identity 或新的 MessageSource kind。V4 audit 是既有 native summary event 上的 `plugin:task-compaction-audit`，sessionFormatVersion 为 4。Policy 只在 native compaction/end 报告成功后记录 applied。V3 audit 仍是历史证据，不能授权 continuation。不引入新的持久化格式或平行 task store。

Generic Settings 只暴露 Codex preference；内部根字段 authGeneration 和 authTransition 被排除在 form 与通用 mutation 之外。Canonical Codex transaction owner 通过 ConfigEditor 写入这些字段。Runtime 变化不轮换 generation，pending auth marker 仍 fail closed。集成不读取或复制 auth 文件与凭据。

Custom Desktop 跳过官方 account watch 和首次 account onboarding，同时保留 native locale read 与 window/quit owner。Product flavor startup fixture 证明直接进入工作区和禁用官方 updater；官方 startup suite 仍通过。

## M2 源码集成证据与限制

全部 smoke root 都是可丢弃的私有临时目录。正式 Custom profile 和已安装应用保持不变。Custom composition 的 Schedule、Automation、Computer Use 与 DeepSeek account/hosted fallback 仍禁用。Image inventory 保留为独立且不支持推理的 modality，不能成为 Local text default。

真实 owned Huihui llama-server 在临时 loopback port 返回 HTTP 200 和 READY，随后由官方 subprocess range owner 停止。真实 System Codex 0.159.2 在新隔离 CODEX_HOME 下通过 verified discovery 和初始化；model/list 返回八个模型，包含 gpt-6.1-sol。该 home 未认证。本轮不尝试真实 Codex turn、login/logout、auth generation transition 或凭据复制。

实际源码 profile 启动 Host。原生 Client unary RPC carrier 与生成 Remote codec 连接该 Host，读取仅含 Local 的 catalog/status，启动确切 Local model，并创建默认为 Huihui 的 Session。完整 Session turn 在官方 writer lock 处停止，因为 candidate 缺失 native/system/packages/darwin-arm64/bin/system.node。M2 不构建该 Native 产物。因此直接真实 Local inference 通过，完整持久化源码 turn 与已认证 Codex turn 保留为明确集成 blocker；mock 不为其 qualification。Client library build 与 Models/Run Details render 证据属于源码检查，不是 GUI release qualification。

M2 affected set 使用既有 upstream maintenance contract/evidence planner 的 RC.2 结果，映射到新 package owner，并按实际变化的 seam 扩展。它排除完整 Q1、Full runtime compatibility probe、package 与全项目 suite。最终集中验证中，63 个核心受影响文件的 1,440 项测试全部通过，另有 17 个 Client 消费端与公开边界文件的 582 项测试通过：合计 80 个文件、2,022 项独立测试。官方 generator 的分批等价性证明也通过所选用例。初次验证还尝试了 33 项依赖 Native 的 resume/shutdown 测试；缺失真实 system.node binding 时它们无法通过，这些失败仍未取得资格，不计入源码测试通过数。Host/Client 构建与类型检查、变更文件 lint、生成目录、修改范围双语文档和工作区卫生分别检查。真实持久化源码会话与已认证 Codex 会话仍受上述阻塞影响。

## M2 整合与 M3 交接

保留的 Custom package 为 custom-foundation、agent-codex、task-checkpoint、reasoning-policy、compaction-task-aware-policy、run-details、runtime-diagnostics-controller、ui-custom-runtime、ui-run-details 和 desktop-custom composition。Mixed 变化限于 external turn selection/settlement、Session catalog/activity transport、compaction policy consultation、generic internal Config protection、Desktop updater product exclusion、Client read hook 与官方 bounded contract generation。旧 Settings store、复制的 AgentLoop executor、Custom popup positioner、tool-call impersonation 和平行 thread mapping persistence 均不存在。

相对刻意不含 runtime 的 M1 foundation，Custom surface 增加，因为必要 execution 与 UI owner 现在已存在。相对旧 Custom product，复用了 native turn settlement、compaction publication、selector/popup 和 Desktop lifecycle。每个新增 runtime 或 projection package 拥有独立 capability 或 read boundary。兼容输入只包括单向 legacy Config import、官方 V3 conversion，以及精确 M1 单模型 Local catalog upgrade；在各自支持的历史输入退役后移除。没有永久双 event identity 或 old/new Settings adapter。

后续 P-UPSTREAM-0.2-RUNTIME-READINESS-CLOSEOUT 闭合了上述历史 Native writer 与隔离认证 blocker。上述源码阶段记录保留为历史证据。当前 M2 Desktop Candidate Gate 在 M3 前增加一次隔离 packaged Local/Codex/Local conversation 与 restart 流程。M3 负责最终 release qualification、formal promotion、installed smoke、rollback 和 trusted branch integration decision；尚未启动。

## Desktop candidate ownership

[Local foundation](../packages/boot/custom-foundation/README.zh.md#understand-the-implementation)将 Desktop 拥有的机器资源路径与 Harness 数据分开。Desktop bootstrap 拥有账户 home；既有 profile 登记和显式 LaunchAgent driver 消费它。Candidate 数据隔离保留现有 owner，用户自定义 Local 模型路径仍由配置拥有。

Packaging 与 runtime identity 读取同一个 product definition。Custom candidate 使用官方 package pipeline 和显式本地 ad-hoc signing，不使用公司 signing cache，不 notarize 或 publish。Manifest 要求在 profile 访问前提供 qualification root。已有 rehearsal path owner 隔离 Electron state、logs 与 crashes，并可复用严格位于该 root 内的已认证 fixture DSH home。正式产品数据位于此边界之外。

Session catalog 将 canonical owner 的纯 Custom event schema 作为 build input 内嵌，移除 catalog graph 对 Codex 与 task execution package 的 runtime dependency。Runtime card 通过官方 Models footer 贡献，并声明 Remote carrier 与 Local/Codex namespace。Activation regression 将 Remote 挂载于独立 plugin fiber，避免 root-context fixture 掩盖缺少 service declaration。Host 向 Codex containment 与 maintenance 传递准确的 DSH home，区别于更大的 Electron rehearsal root。官方 selector 在模型与推理等级面板增加可见的返回操作；search、provider grouping、focus restoration 与 portal positioning 保留既有 owner。没有新增 lifecycle manager、runtime authority、persistence store 或 compatibility shim。 Local 设置通过已有 Host Remote 保留当前 profile 标识与显式重启。弹框定位采用上游公共 anchor hook，移除 selector 内重复实现；ResizeObserver 处理菜单高度变化。

隔离 packaged candidate 通过关键产品能力检查：主导航、Local/Codex 分组、可搜索的模型选择、子菜单鼠标与键盘返回、受支持的推理等级选择、Local 控制、Codex 状态/模型数量/用量/重置时间，以及 Run Details。最终受影响 UI 集合的 62 个不同用例通过；复用此前 focused source、目录边界和 runtime 证据。Canonical build、packaged runtime smoke 与严格签名验证通过。

一个 Native conversation 依次完成 Local Huihui、使用 low effort 的 Codex gpt-6.1-sol、一次正常 App/Host 重启，再切回 Local Huihui。重启恢复同一可见 Session、两个历史回答和所选模型。Canonical V4 检查找到顺序正确的三个唯一用户消息、三个唯一助手回答、三个 completed turn，以及一次 Codex dispatch；auth generation 未变，mapping 已绑定，dispatch 与 pendingSync 为空，recovery 为 settled。没有 reconciliation history 的 settled mapping 属于合法状态；validator 不制造 reconciliation，也不将 reasoning/replay 表示误算为额外可见回答。Candidate 及其拥有的 Host/Local 进程正常退出。这些证据完成 M2 candidate gate，不构成最终 release qualification；正式 App 字节和数据未变，Schedule 与 Computer Use 保持关闭。

## P-AUTOMATION-SCHEDULE-I1

本节覆盖此前 M2 阶段记录的“Schedule 已禁用”状态。Custom Desktop profile 现在明确选择官方 `@deepseek-ai/dsh-experimental-schedule-bundle`，没有因此启用全部 experimental bundle。标准 Web profile 仍需显式启用；Computer Use 仍未加入。

| 职责 | Canonical owner | 集成决策 |
|---|---|---|
| 当前时间与时区 | 官方 time-context | 直接复用，不增加 Custom 时钟或时区层 |
| 任务规则与持久记录 | 官方 Schedule domain 与 Host storage | 复用任务创建、列表、更新、删除、重复规则、状态和 delivery history |
| 定时器、到期 occurrence 与恢复 | 官方 Schedule runtime | 使用唯一 Host timer，不增加平行 scheduler 或 daemon |
| Session 绑定与投递 | 官方 SessionController、Agent `followup()` 和 Session flush | receipt 只确认 inbox message 已持久化，不代表模型工作已完成 |
| 模型执行 | canonical Session 当前选择的 Local 或 Codex route | 选择归 Session 所有；不会 fallback 或替换 route |
| 任务界面 | 官方 `ui-schedule` contribution | Custom composition 激活现有任务页、标题栏入口和管理工具 |

Schedule admission projection 是唯一新增的 Custom 恢复逻辑。如果 inbox splice 已持久化，但 Schedule receipt 写入失败，Host 重启后会将任务 occurrence 匹配到 canonical Session message id，flush 已存在的历史，并使用相同 receipt 记录结果，不会再次 followup。若历史冲突或无法明确解释，则 fail closed。该机制保护 occurrence 的 admission identity，不承诺模型执行或外部副作用 exactly-once。

隔离环境中的真实 Local smoke 在 canonical Custom Session 创建一次性任务，在到期前停止 Host，再重启 Host。定时 Local turn 在同一 Session 生成一条 assistant 回答，Schedule history 指向已持久化的 inbox message，任务随后变为 inactive。848 项 Schedule focused tests 覆盖创建、更新、删除、计时与恢复行为，包括 receipt 中断边界；现有 composition 与 Desktop profile tests 覆盖 bundle 激活。只有 Host 运行时才能投递；重启时会检查已逾期 occurrence。

此前隔离 Codex 尝试没有保留失败诊断，因此失败阶段仍无法确定。`P-AUTOMATION-SCHEDULE-CLOSEOUT` 在唯一一次重试前检查了 scheduled followup 路径：Schedule 使用 canonical Session selection 和 Agent external executor，Codex 要求该 Session 明确归属唯一已注册工作区。不需要修改 provider runtime 源码。诊断 runner 先注册隔离工作区、确认 Session 归属，再创建任务；只导出 event identity、receipt 与 mapping metadata、经过脱敏的 lifecycle state，以及 RPC method/result metadata，不导出认证 payload 或原始 Host 输出。

本次唯一 occurrence 复用既有官方隔离登录。System Codex 0.159.2 动态列出支持 `low` effort 的 `gpt-6.1-sol`。证据覆盖 occurrence 到期、inbox admission 与 receipt 持久化、Agent 消费消息、canonical provider/model 解析、Codex mapping 创建、一次获得确认的 `turn/start`、external turn 完成、一条 Session V4 assistant 回答持久化，以及客户端 history 中的一条回答。receipt 与消费记录指向同一个 inbox message。等待执行静止后，dispatch 与 pendingSync 均为空；只读检查一次，mapping authGeneration 与已提交的 runtime owner 一致。没有 replay、provider substitution、DeepSeek fallback、API key、private endpoint、auth rotation 或 production data access。Host 正常退出。该证据关闭 Codex 定时执行 blocker，没有重复 Local smoke、Schedule suite、package 或 GUI qualification。

Local-selected Agent 的 live registry 会收到官方 Schedule 管理工具定义；deterministic 工具注册与执行测试覆盖该 seam。Codex 可以执行定时 Session turn，但目前不能通过 external-turn model tool surface 创建、编辑或删除 Schedule task。未来若实现 DSH tool bridge，需要单独的 bounded architecture task。

最终文档检查只要求修改范围正确；既有历史 persistence-format 与 reasoning-policy README metadata 债务不属于本轮集成。复用此前已通过的 Schedule、composition、Local execution、typecheck、lint 与 generated-catalog 证据。

Schedule service 持有任务定义与 delivery history；admission projection 从 canonical Session V4 inbox event 派生。Desktop lifecycle 决定 Host 是否运行；Schedule runtime 管理唯一 timer；SessionController 和 AgentLoop 管理 canonical message admission；所选 provider 持有 inference。没有添加 Computer Use provider、权限提示或 Schedule 专用 lifecycle manager。Final release qualification 和 Computer Use 仍延期。

## M3 发布验收与回滚

M3 保持固定官方 RC.2 底座，复用此前 Config、Session migration、runtime 与 Schedule 证据。Release 修复在 canonical package path 增加显式可晋升 candidate 选项，通过已有 Cordis scope 隔离各 live Agent 的模型选择，并解包已锁定 Bundled Codex vendor binary。Packaged runtime check 在私有 scratch 中运行该 binary 的版本命令，不启动 App Server 或打开认证文件。不增加 lifecycle manager、配置 store 或 runtime adapter。

最终 arm64 Custom artifact 为 0.2.0-rc.2，bundle identity 为 `dev.dsh.desktop.custom`。严格代码签名完整性与 packaged runtime closure 通过；使用本地 ad-hoc 签名，没有 public distribution notarization。编译失败及 release-blocking package 检查只进行针对性修复和 rebuild，不重复已通过的历史 suites。Focused tests 覆盖 28 个不同用例；新增双 live Session 回归还保证断言失败时清理 owner。

隔离 Native candidate 通过导航、Settings、runtime controls、动态模型与 effort、子菜单鼠标及键盘返回、Run Details 和官方 Schedule UI。一条 canonical conversation 按顺序包含四条可见回答：Local、Codex、scheduled Codex、Local。仅一次 scheduled inbox admission 和两次 Codex dispatch。一次正常 App/Host 重启保留 visible history、task history、mapping 和 authGeneration；settlement 后 dispatch、pendingSync 与 pending inbox 均为空。关闭窗口保留 Host，重新打开仍使用同一实例。Schedule history 仍表示 admission history，不承诺外部副作用 exactly-once。

两次显式 fixture retry 保留在记录中：继承的 64-token Local 限制中止首次建任务 turn；重启后 Local 尚未 ready 时发送被 fail closed。修正 fixture 设置并等待 ready 后，只有一个任务和四条可见回答，失败 turn 仍保留。认证复用官方隔离登录，不读取 auth.json、复制凭证或 rotate generation。Candidate qualification 不访问 production data。

随后 formal promotion 暴露尚未解决的 installed-profile blocker。既有 history 可以加载，但模型选择器持续 loading，Local/Codex 状态持续 unknown；没有提交 installed inference。同一 binary 在隔离 profile 中仍可解析模型和 runtime status。该比较只证明症状随 profile 不同，未定位原因。立即回滚 formal promotion，恢复旧 application bytes。将未变的已归档 legacy settings source 改名恢复，不读取其内容或覆盖文件；保留 canonical patch 与 immutable Session generations。不继续 production validation 或强制 migration。

随后 `P-UPSTREAM-0.2-M3-PROFILE-CLOSEOUT` 以分阶段、隔离优先的诊断闭合该 blocker，而不是通过改代码。第一轮只读的 host 层复现，在正式 home 的 clone（排除凭据、`auth.json` 与 Electron state）上重放启动链，结果各阶段均健康，包括 `localModels/status`、`codexSubscription/status` 与 `session/modelCatalog`。第二轮 UI 层复现，用同一 packaged candidate 针对同一 cloned home 启动真实 Desktop window，观察到 renderer 确实收到这三个 Remote 结果并发布了具体状态：选择器离开 loading 并落在该 Session 投影出的 Local 选择上，Local 渲染出具体 runtime 状态，Codex 渲染为 ready。启动后 clone 的 canonical patch 与正式 patch 逐字节一致，说明旧 profile 的 Config 形态被完整覆盖；只有依赖 `auth.json` 的账户分支无法表示。因为没有证明存在源码缺陷，所以没有改动源码，也没有加入假 timeout、UI 硬编码状态或第二套 catalog store。

随后执行唯一一次授权的 promotion 重试。旧 application bytes 通过重命名以 rollback copy 形式先行保留（不删除），安装已验证的 candidate，并以真实正式 home 在 `custom-default` 模式下启动晋升后的应用。installed smoke 通过：既有 history 加载、选择器离开 loading 并 settle、Local 报告带端点的具体 stopped 状态、Codex 报告 ready 且使用 system runtime，Settings 与 Schedule 界面均存在。canonical patch、`package.json` 与 `authGeneration` 未变，legacy settings source 由正常单向 import 仅归档一次，Session 与 projection-cache 数量未变，没有 generation 被改写。预留的 rollback copy 未被使用。

唯一记录在案的环境差异是 system Codex runtime 版本，从 qualification 时的 0.159.0 变为 0.159.2。晋升后的应用将其解析为 ready 并列出模型；此前缓存的 0.159.0 full-compatibility 条目作为历史证据保留、未重跑，runtime maintenance 仍为独立任务。

因此 M3 已完成。晋升后的 0.2.0-rc.2 Custom 应用保持安装；Schedule 仅在 migration composition 和 candidate 中启用，Computer Use 仍禁用。Codex 可以执行 scheduled turn，但不能通过官方 external-turn tool surface 管理 DSH Schedule task。修改文档通过 focused checks，历史 persistence-format 与 reasoning-policy metadata 债务未变。不启动 Computer Use 或无关增强。

## 启动入口闭合

`P-UPSTREAM-0.2-M3-LAUNCH-CLOSEOUT` 闭合了剩余的启动入口问题。此前的 promotion 重试是直接执行 bundle 内部可执行文件完成的，因为 `open -a` 看起来什么都启动不了；而晋升后的 0.2 应用与 0.1.6 rollback 应用都是 ad-hoc 签名、未做公证，因此 `spctl` 对两者都返回 rejected。Gatekeeper 并非原因：两个 bundle 都没有 quarantine 属性，严格的 code-signature 校验都通过，LaunchServices 中也存在已安装 bundle 的正确注册记录。

真正的原因是环境。`open` 会把调用方的环境变量传给被启动的应用，而 Electron 会把非空的 `ELECTRON_RUN_AS_NODE` 理解为“以纯 Node.js 运行”而不是启动应用。因此从一个导出 `ELECTRON_RUN_AS_NODE=1` 的环境发起 `open`，会让 bundle 的主可执行文件以 Node 方式启动、不产生任何应用输出，并在约 65 ms 内退出。LaunchServices 确实启动了进程，只是它在弹出窗口前就结束了，这也是该次尝试看起来像“启动失败”的原因。launchd 用户会话并未定义该变量，所以它来自调用进程而非系统；0.2 应用与 0.1.6 rollback 在该变量下的退化行为完全一致。

在该变量不存在时，标准入口无需任何产品改动即可工作：`open -a` 可以启动应用，由 Finder 打开 bundle 等效。installed smoke 通过 LaunchServices 重跑并全部通过：窗口已呈现且可见，使用正式 Custom profile 与其 canonical patch，patch 未被改写；此前持久化的 Session 被列出并恢复了一条；模型选择器离开 loading 并 settle；Local 报告带端点的具体 stopped 状态；Codex 报告 ready 及 system runtime 与模型数量。没有改动任何源码，也没有为此入口加入假 timeout、UI 硬编码状态或第二套 catalog store。

由于该变量只影响从已导出它的 shell 发起的启动（例如某 Electron 宿主应用的嵌入式终端），正常的 Finder 启动不受影响。这是启动环境说明，不是产品缺陷。

## 前台电脑操作 V1

电脑操作采用可选 profile bundle，默认关闭。复用官方 MCP、图像准入及审批；[Custom 安全层](../packages/computer-use/custom-computer-use-safety/README.zh.md)负责唯一 Host 租约及停止／排空／污染策略，[客户端控件](../packages/client/ui-custom-computer-use/README.zh.md)观察其状态。Schedule 和 Codex 电脑操作不受支持。凭据、租约及待执行物理动作均不持久化，不确定的物理结果绝不重放。未找到完整 A1 原文，明确的 P-COMPUTER-I1 交接说明作为本轮实施合同。


实现采用一个安全包、一个可选 bundle 和一个客户端 UI 包。官方 provider 注册、MCP 传输、ToolRuntime 取消、审批、图像准入、Typert Remote 和 scoped UI slots 继续拥有各自职责。provider 仅将默认 true 的启动失败策略及默认空的子进程环境转交现有 MCP 客户端。Custom bundle 关闭驱动自动权限引导，但不跳过系统授权或运行时审批。没有兼容层、第二个启用布尔值或新增持久化格式。

聚焦验证覆盖十二个文件的 176 个不同用例，包括真实假 MCP 子进程、审批／Stop 竞态、子 Agent ownership、权限控件及 UI 观察失效。失败文件修正后仅重跑自身；未重复 Local、Codex 或 Schedule 专项资格验收。受影响 Host／Client 类型检查、lint、安全包／bundle／客户端产物构建、ownership 校验、配置／客户端／Cordis 目录、package 列表、模块图、双语配对、仓库引用、空白和工作区卫生通过。快速文档集合初次为 17/21；两项本轮文档失败已修正并通过对应检查。剩余两项未修改的失败是历史 persistence-format freshness 和 reasoning-policy README metadata。服务关系图生成器仍有六个既有 Custom 服务分类缺口；新增公开 Computer Use controller 已登记分类。这些基线失败未被报告为通过。

原生资格验证待完成。已安装 cua-driver 0.22.0 能发现 MCP 工具目录。通过实际 CuaDriver daemon 身份取得的只读状态为辅助功能已授权、屏幕录制未授权。Host 控制器从 canonical MCP structuredContent 读取布尔授权事实，而非解析可读文本投影。其真实 MCP 查询与直接驱动查询一致：辅助功能已授权、屏幕录制未授权。响应读取修正后，八个直接受影响权限用例通过，包括真实 fixture MCP 子进程，以及缺失／非布尔结构化授权事实的拒绝；复用此前聚焦门禁。未进行鼠标、键盘、截图、权限弹窗或正式 profile 访问。临时 daemon 已停止，正式应用字节未变。用户需在系统设置 → 隐私与安全性 → 屏幕录制中授权 CuaDriver（`com.trycua.driver`），随后重启 CuaDriver 并重新检查授权，再执行有界原生资格验证。当前是待收尾的源码交付，不是 COMPLETE。

迁移底座缺失已有 ownership registry，已从可信分支恢复同一路径。非 Computer Use inventory 保留原始基线并明确尚未重新资格验证；新增 Computer Use ownership 和受影响测试指向固定 RC.2 底座。没有建立第二份 ownership map。

## Local 上下文准入封板

由真实 llama.cpp 模板与 tokenizer 重建的冻结首轮请求包含 34,157 个输入 token：system/模板边界 2,061、Session 运行时注入 587、工具 schema 31,451、用户文本 58。其中 56 个 CuaDriver 定义占 24,018 个 schema token。cache-read 30,720 属于输入子集，不额外占一份容量。同一冻结请求关闭 CU 后有 34 个工具、9,799 个输入 token；启用 CU 增加 56 个工具、24,018 个 schema token 和 24,358 个总输入 token。这里采用包含模板边界的顺序增量计数，不把各段独立分词结果简单相加。

生成的 Huihui 声明为 32,768，而实际 server slot 为 65,536。pi-ai 预留 4,096 个 token 后，把请求的 8,192 输出压到一 token 下限，却没有拒绝已超窗输入。现在在现有序列化 payload callback 中，使用 loopback 服务端模板和 tokenizer，在 inference 前执行精确准入。以声明和真实窗口的较小值约束输入、输出与余量；保留用户明确设置的短输出上限，剩余答复空间不足时抛出 canonical context error。未修改的生成 Huihui metadata 更新到 65,536；用户显式容量仍由用户拥有。现有 compaction 使用精确 Local target policy 和 4,096 headroom。没有引入第二套 compaction engine、工具目录、cache accounting 或 finish-reason 模型。

聚焦 adapter/config/profile 测试通过：四文件共 95 个不同用例，包括七个准入回归。无密钥记录式 Session 场景证明固定输入无法压缩时，在 canonical compaction recovery 后保留诊断，不再次 dispatch 主模型请求。真实隔离 standard-preset Local Session 返回 LOCAL-CONTEXT-OK。真实 CU-enabled source Host 请求包含全部 56 个 CU 定义、共 89 个工具，精确输入 33,619，输出仍为 8,192；加上 4,096 余量，总计 45,907，满足 65,536 窗口。然而输入处理阶段仍触发既有 300 秒 stream-idle timeout，尚未生成 token 或 CU call。既有 retry policy 在有界 probe 关闭前开始一次 retry；没有成功 OBSERVE，也没有物理动作。这个历史全目录性能阻塞由下述 V1 presentation policy 闭合。未增加超时、删除工具、package、执行 Native ACT、重新权限验收、正式晋升或访问生产 profile。

## Local V1 电脑操作工具呈现

[上下文准入提交](../packages/llm/llm-pi-ai/src/context-admission.ts)已独立提交并推送。安全包现在在完整官方 MCP discovery 之上，唯一拥有逐 Agent 的已核实工具呈现策略：三项结构化观察和五项经过审批的动作原语。已安装的 56 项目录在同一源码 owner 中分为 OBSERVE_CORE、ACT_CORE、ADVANCED、UNSUPPORTED_V1 和 SENSITIVE_EXCLUDED。未来未知工具不呈现；非 CU 工具和原始 schema 参数保持原样。全局 discovery 仍完整供 Host 权限 controller 使用。没有 fork provider、复制实现工具目录、UI allowlist 或删除 prompt JSON 字段。

同一冻结请求中，八项 CU 定义占 6,664 token，原为 24,018；总输入从 34,157 降到 16,803（减少 50.8%），保留 34 项非 CU 工具。真实隔离 standard-preset Host 请求共 41 项工具，其中 CU 八项，输入 16,349，保留 8,192 输出和 4,096 余量，满足真实 65,536 窗口。真实 Huihui 首 token 在 275.622 秒到达；模型正常 reasoning 并且仅 dispatch 一次成功的 list_windows OBSERVE，之后 probe 显式取消该轮。没有 ACT 或物理动作。Server 报告 prompt evaluation 为 258.083 秒／16,349 token（63.35 token/s）。300 秒边界与选定 Local 模型均不变；冷 prefill 仍是产品性能限制。

六项新增聚焦用例覆盖完整 discovery 与八工具呈现的区分、动态未知工具拒绝／重连、已有 Agent 启用、非 CU schema 保持原样、ACT approval 允许／拒绝，以及结构化 text-only 工作流；与受影响 typecheck、lint、双语配对、引用、catalog 一致性和 workspace hygiene 一起通过。复用此前 95 个 context 和 176 个 safety 用例。Native 证据见下文；源码测试本身不构成完成。

第二个可晋升 candidate 修复真实 model projection 缺口：官方 MCP structuredContent 以可读结构化文本交给模型；若服务端文本已包含相同 JSON，则不重复。raw/PTC 值、image admission、错误与 transport 不变。所属 59 个不同用例通过，包括结构化窗口 identity 和拒绝图片时保留 identity；更新后的 Host 在缓存 prefill 下 33.975 秒 dispatch 一次 OBSERVE。冷 prefill 仍慢：candidate 的一次首轮触及未修改的 300 秒 idle 边界后被显式取消。后续有界 Native 请求到达 OBSERVE；不宣称延迟保证，没有增加 timeout 或替换模型。

隔离 Native matrix 在第二个 candidate 通过。arm64 Custom identity、strict/deep ad-hoc 签名、runtime closure、八工具 presentation、data/machine home 分离均已验证。随后 installed smoke 暴露未改变的生成 legacy Local alias 缺少部署 headers，却仍被选作默认；立即恢复旧正式 App。现有 profile bootstrap 只识别完整生成 alias，补入 Local headers/容量，并仅在 canonical Local route 未改变时迁移新默认选择。用户修改过的路由保留；历史 Session 选择保留可解析 alias，直到受支持的持久化引用退役。四个聚焦 profile 用例和真实隔离 legacy-default Host 回答通过；安全与 Session contract 不变。第 3 次也是最后一次获准 candidate build 纳入这项有界修复。

P-COMPUTER-I1-FINAL 仍为 BLOCKED_WITH_DIAGNOSTIC_EVIDENCE。第 3 个 candidate 的 package closure 和隔离通过；安全层/provider/MCP 字节与 Native-qualified 第 2 个 candidate 相同。安装 smoke 成功准入修复后的 canonical Local 默认，但真实首轮在 300 秒超时，尚无 CU call 或物理动作。实际 header 有 42 个唯一工具，其中 CU 八项。单个 skill-catalog 消息包含 27 个唯一条目、11,066 个模型可见文本字符；持久化 source metadata 不是另一份 prompt。没有发现重复目录注入。既有 retry 开始一次后立即被取消；Global Stop 阻止准入，旧正式 App 已恢复并正常启动，Computer Use 关闭。未增加 timeout、删除用户 Skill、切换云模型或进行第 4 次 build。隔离 Native 证据仍有效，但 installed smoke 失败意味着不能 COMPLETE，也不能最终晋升。

输入区域状态/Stop 横条仍有 UI 呈现问题：空闲标签无需独占整行，但桌面工作期间必须保留立即可达的 Global Stop。本次三次 build 配额已用尽，未夹带布局改动。截图 retention、后台自主 CU、Codex/Schedule CU bridge 继续延期；物理副作用不是 exactly-once，结果未知绝不重放。

## Local 电脑操作冷启动资格验证

精确重建正式安装失败首轮后，输入为 19,322 token，而非此前较小的隔离输入 16,349。顺序增量计数中，system/guidance 为 2,060，34 项非 CU schema 为 7,433，八项 CU schema 为 6,664，Skill 目录为 2,588，Session/runtime metadata 为 416，用户轮为 114；模板边界和顺序差异净计 47。正式与隔离输入相差 2,973 token，其中 Skills 为 2,588，其余组合/消息差异为 385。27 条 Skill 只有名称和受限长度简介，不含完整说明；正文通过既有 skill 工具按需加载。未发现重复 schema 或 Skill 目录。输出仍为 8,192，余量 4,096，总容量 65,536；容量准入成立。

实测部署为 M1 Pro / 32 GiB 上的 Huihui Qwen3.8 27B IQ3，使用 llama.cpp build 10809、单个 65,536-token slot、全部 65 层 offload、Flash Attention、f16 KV，以及实际八条 CPU 线程。机器 manager 使用逻辑 batch 2,048、物理 batch 512，以及 backend 默认 8,192 MiB RAM prompt cache。既有 backend 会复用匹配前缀；此前 33.975 秒的缓存请求不构成冷启动证据。动态 Session 消息位于静态 system/schema 前缀之后，工具组合变化可能缩短前缀复用。未引入第二套缓存、私有 Session 持久缓存或跨 Session 内容投影。

冷启动资格要求两次真实 Host OBSERVE 请求均在 180 秒内产生首个生成内容，且无 ACT、retry 或物理动作。仅 probe 使用 cache_prompt=false，并通过服务器缓存 token 证据区分冷计算与复用。终止错误 frame 不计为首个生成内容。隔离数据/profile root 与既有机器模型资源保持分离；性能 probe 使用现有 Host-owned process driver，不编辑机器模型文件或 LaunchAgent 配置。

临时采用 1,024 和 2,048 物理 batch、将 RAM prompt cache 限定为 1,024 MiB，仍未通过该负载资格。batch 1,024 时，42 工具、16,504 token 的隔离请求在 282.391 秒后成功执行一次 OBSERVE；加入 27 条目录后为 19,092 token，尚无生成内容便在 300 秒超时。batch 2,048 的两次正式形态请求均含 19,096 token、42 项工具、八项 CU 定义；两次均触发未改变的 300 秒超时，零生成内容、零 CU call。Server 日志确认两次均未复用 token。第二次包含约 21.7 秒等待前次取消完成，但其自身冷计算也要 240.71 秒才到 14,336 token，独立超过 180 秒要求。增大 batch 未建立值得采用的改善。保留内存压力观察，不把 swap 单独认定为失败原因。

P-COMPUTER-I1-COLD-START-FINAL 在当前机器/部署和所需 V1 prompt 下为 CURRENT_LOCAL_MODEL_NOT_VIABLE。阻止资格通过的是模型冷输入处理速度，并非容量、提前注入 Skill 正文、重复 payload 或电脑操作安全层。没有采用 runtime 调参；原机器服务已恢复。未进行新 package、promotion 或 installed smoke，旧正式应用保持原样、Computer Use 关闭；I1 不是 COMPLETE。产品裁决是为用户显式选择的更合适 Local 模型进行电脑操作资格验证；本任务不实施模型替换，也不新增专用模型架构。普通 Local 使用与已有 Native 安全证据仍成立。紧凑 idle 电脑操作入口和 active 一键 Global Stop 仅登记为 NEXT UI polish。

### 恢复锚点与发布边界

Computer Use V1 状态为**已实现并通过安全资格验证；暂停在性能资格与正式启用之前**。复用 Native 安全资格、权限路径、DesktopLease、审批、Global Stop、no-replay 边界和已审查的八工具呈现；除非后续改动真实改变这些 contract，否则不要重做。下一项目优先级为 `P-CORE-RELEASE`。它可以在保留 Computer Use 代码和安全行为、且 optional bundle 默认关闭的情况下发布稳定核心客户端，不必等待当前 Local 冷启动 OBSERVE 性能门槛。

恢复 Computer Use 时，第一步重新检查机器当前已安装的 Local 模型目录，然后只继续冷启动性能与模型适用性评估。用户说明当前有两套可用的 27B 量化 Local 配置，但本文没有可靠记录其准确模型名与量化身份。`Qwen3.6-35B-A3B` 已卸载，不可假定仍可用。禁止静默替换模型、自动 fallback 到 Codex 或云端，也不得为通过 benchmark 移除普通 Local 能力。本双语 ledger 已保存可长期恢复所需的资格摘要与恢复点；临时 probe 产物只是补充材料，不是恢复项目状态的必要依赖。

## P-CORE-RELEASE

P-CORE-RELEASE（2026-10-04）**已完成**。仅构建一次隔离 arm64 candidate，源码为 `5d705499a8f565f4ca781bd9136c9524e536d0df`，bundle ID `dev.dsh.desktop.custom`，版本 `0.2.0-rc.2`；本地 ad-hoc 签名严格／深度完整性验证通过，不声称已公开公证。Candidate 的 user data、profile 和 DSH home 均隔离；Local 机器资源仍从真实 OS 账户 home 解析。Candidate smoke 通过 Custom 主界面、Local-first Huihui 默认、一条短 Local 回答、一条无害只读 shell 工具调用、一条动态目录中的 `GPT-6.1-Sol` low effort Codex 回答、Schedule 页面，以及 Computer Use 默认关闭。Candidate 的 Local 回答约耗时 2 分 41 秒；这是普通 Local 性能证据，不是独立的 Computer Use 冷 prefill 门槛。

Candidate 已晋升至 `/Applications/DS Harness.app`；仅保留一份 rollback：`/Applications/DS Harness.rollback-2026-10-04.app`。正式安装为 arm64、`dev.dsh.desktop.custom`、0.2.0-rc.2，严格／深度签名验证通过；当前 `app.asar` SHA-256 为 `22fa9856996ccc7744975b9c29569d4abac521716c7b35d21527ee6d41fa918a`。Rollback 的 `app.asar` SHA-256 为 `084bf057914adf5e52745a214eceb147d24296b63a3f488abf35a6587771a776`。Installed smoke 正常加载现有正式 profile 与 history，然后在一个新 smoke conversation 中分别完成 Huihui Local 与官方 `GPT-6.1-Sol` turn；Schedule 页面可打开，Computer Use 仍关闭。该正常安装 smoke 按任务授权使用了正式 profile；candidate 未使用该 profile，没有执行 profile migration 或 rewrite。

Candidate 工作期间，因 candidate 与 formal 共用 bundle identifier，CUA 应用句柄解析曾短暂意外启动正式 App。它在既有 listener 冲突处退出，candidate-only smoke 随后继续；candidate 退出后才进行 formal-only installed smoke。意外启动期间没有运行模型 turn。当前安装版在生成时显示通用的“深度求索中”；通用设置仍有“工作步骤展示”选项（当前为“标准”）。用户偏好更丰富、可见的步骤进度，已记录为后续 UI 工作；本次发布没有改动或重打包此 UI。Computer Use 代码和安全成果保留，默认关闭；冷性能资格仍暂停在 `COLD_PERFORMANCE_MODEL_SUITABILITY`，本次 Core Release 未运行该资格。

本次 closeout 未修改源码，只在此补充 release/status ledger。打包产物 provenance 仍指向上述源码 SHA；文档提交会单独推进分支 SHA。

## P-PROJECT-SLIM 清理清单

本清单在 `2026-10-04` 清理前记录。下表中的生成产物属于非活动 checkout；对应源码 worktree 与 lockfile 会保留。下列历史 app 哈希均不等于正式 App 或唯一 rollback 的哈希。

| Checkout | Branch @ HEAD | `.desktop-build` | 历史 app.asar |
|---|---|---:|---|
| `/Users/kongda/Developer/Local/deepseek-harness` | `master` @ `a305151ffd83556500b2eb8841b029d7c23fb7f0` | 954552 KiB | `0.1.5-rc.2`：`468eaf25e07b9db7d7758b9fd214be6859255f5de02f87c302c4301639d3513e` |
| `/Users/kongda/Developer/Local/worktrees/dsh-codex-subscription` | `feature/codex-subscription` @ `b7ad141ed4a3f75a6652e1d86a8cc09aa8500c19` | 4418544 KiB | `0.1.6-alpha.2`：`98be4e0d9b2447a65669d044b6ada7fa8096a170c7e72eff2ba9b48626f5b181`；内含 rollback 副本：`da9324b2db28141057d3402aadfcd5e9c323a1dd155998717df9e8321a2a6a74` |
| `/Users/kongda/Developer/Local/worktrees/dsh-pmodel-recovery` | `recovery/pmodel-20260928` @ `e84102f2a3db4968bc5d96ecc338be934cc183e6` | 2485848 KiB | `0.1.6-alpha.2`：`da220fafaafa103144ab821428bc1d44e68a760ef72ac62e43b95ee1e1862dc6` |

保留的正式 App 哈希为 `22fa9856996ccc7744975b9c29569d4abac521716c7b35d21527ee6d41fa918a`；rollback 哈希为 `084bf057914adf5e52745a214eceb147d24296b63a3f488abf35a6587771a776`。历史 package targets、downloads、非活动 `node_modules` 与已确认忽略且可再生成的输出均可从保留的源码和 lockfile 重建，现已删除。主 checkout 的 `.desktop-build` 中 development homes 和 session 数据仍保留；仅删除了生成的 targets 与 downloads。另外两个 `.desktop-build` 内没有名为 home 的目录，现已整体删除。当前 Computer Use evidence 和其他独立 DSH 临时 evidence 均未触碰。

## Computer Use I1 最终恢复资格

P-COMPUTER-I1-FINAL-RESUME 仍为 BLOCKED_WITH_DIAGNOSTIC_EVIDENCE，恢复点为 COLD_PERFORMANCE_MODEL_SUITABILITY。当前源码包括已完成的项目瘦身与 runtime feedback/preset 实现。经审核的 V1 呈现仍为三个 OBSERVE 工具和五个须审批的 ACT 原语，未知工具不予呈现。既有 context、Host 与 Native 安全资格继续有效；不重复历史 context、安全和 UI 测试集。

实际机器目录确认当前选中模型为 Huihui-Qwen3.8-27B-abliterated-GSQ-RCO-IQ3_S.gguf；Original Qwen3.8 IQ3_S 是另一套可用文本 profile。本轮仅使用用户明确指定的 Huihui 模型及已经就绪的 canonical 机器服务，llama.cpp b10809-5266f24da、单个 65,536-token slot。隔离源码 Host 使用独立 DSH_HOME、profile 和 workspace；机器资源仍来自真实账户 home。正式应用、rollback、正式 profile、模型文件、manager 与 LaunchAgent 配置未触碰。

当前 standard-preset 请求呈现共 41 个工具，其中恰八个 CU 工具，并保留 27 条 Skill 目录和普通非 CU 能力。精确 admission 为 18,657 输入 tokens，其中 CU schema 边际占 6,664 tokens，保留 8,192-token 输出预算和 4,096-token 余量。冷请求仅在 probe 使用 cache_prompt=false；服务器 slot 证据确认零 token 复用。181.22 秒时仅处理 12,288 输入 tokens，尚无生成内容；295.41 秒时处理到 18,653 tokens，速度为 63.14 tokens/s。未改变的 300,000ms idle timeout 在 300.471 秒后以 TIMEOUT 结束 turn，零生成内容、零 CU call。

紧邻缓存请求使用相同模型与工具呈现。首个生成 reasoning 出现在 3.002 秒，一次成功的 mcp__cua-driver-mcp__list_windows 结果在 13.861 秒内完成。服务器对 90 个新增 tokens 的 prompt evaluation 为 2.37965 秒。两个 probe 合计零 ACT call、零 retry、零物理动作。Global Stop 后租约为 RELEASED、in-flight 为零，隔离 Host 干净退出。暖请求功能成功确认 OBSERVE 通路可用，但不满足既有的“两次冷 OBSERVE 请求均在 180 秒内产生首个生成内容”要求。

因此当前机器/部署和所需冷 V1 负载仍裁决为 CURRENT_LOCAL_MODEL_NOT_VIABLE。未采用 timeout 增大、模型替换、runtime 调参或安全变更。Candidate build count 为零；性能资格仍阻塞，未运行 Native candidate qualification、遗留 UI Native smoke、promotion 或 installed smoke。既有 Native 安全证据及两个安装 bundle 均保留。I1 不是 COMPLETE；UI 源码交付继续完成、Native smoke 继续 pending。恢复需要用户明确选择合适 Local 模型，或有证据的当前部署改善满足既有冷性能要求。诊断证据保留在 /private/tmp/dsh-i1-resume-_xtxnqja/diagnostics.json，同目录包含序列化请求、精确计数、服务器 timing 与 profile 隔离记录；这些持久结论不依赖该临时目录长期存在。
## Local 模型适用性后续检查

P-COMPUTER-I1-MODEL-SUITABILITY-AND-FINAL-CLOSEOUT 仍为 BLOCKED_WITH_DIAGNOSTIC_EVIDENCE，恢复点为 COLD_PERFORMANCE_MODEL_SUITABILITY。复用已有 Huihui 结果：18,657-token 冷请求缓存复用为零，在 300.471 秒 timeout 时仍无生成内容或 CU call，处理速度为 63.14 tokens/s。紧随其后的 warm 请求成功执行一次 list_windows OBSERVE，但不满足既定的两次 cold 要求。

当前 local-model manager 仅提供两套已安装文本 profile：Huihui Qwen3.8-27B abliterated IQ3_S 和 Original Qwen3.8-27B IQ3_S。两者都通过相同 GGUF llama-server 通路加载，模型规模和量化等级相同，使用 65,536 context、Flash Attention 和 xhigh reasoning。服务器显示八个 worker threads；当前 Huihui 部署已将 65 层模型全部 offload 至 GPU，KV 为 f16。Manager 未提供 GPU offload、batch、thread 数或 prompt-cache 容量的独立运行时控制。既有 ledger 已记录 physical batch 1,024 与 2,048，以及限制为 1,024 MiB 的 prompt cache 测试，均未通过冷资格；没有发现新的正式低风险参数可采用，也未修改 manager 或 LaunchAgent。

唯一已安装的备用文本 profile 通过隔离 Session 的 canonical model-selection API 显式选择。没有修改 profile router 或默认模型。请求保留 41-tool catalog、八个 CU tools、8,192 输出预算和现有 reasoning/tool contract；精确 admission 为 18,656 input tokens。服务器报告 prefix reuse 为零。184 秒后的采样已处理 10,240 tokens，仍无生成内容；隔离 Host 在 240.782 秒时停止，服务器已处理 16,056 prompt tokens 中的 14,336，生成 tokens 和 tool call 均为零。采样时服务器在 185.82 秒已处理 12,288 tokens（66.13 tokens/s）。未观察到首内容时间或完整 tool decision；该 profile 未通过冷性能时限，其 tool quality 未完成资格确认。后续请求未能确认缓存复用，且在首个生成内容之前停止，因此不构成额外质量证据。

Canonical manager 没有第三套已安装文本 profile；剩余 Qwen Image profile 用于图像生成，不是文本模型 route。因此两套已安装的 27B IQ3_S 文本 profile 均未能证明符合 cold V1 要求，目前没有合格模型。Huihui DSH 模型配置、全局默认路由、机器 manager 与 LaunchAgent 内容保持不变。仅通过 runtime-start 临时切换至 38 后已恢复 huihui；模型接口 READY，LaunchAgent 原 SHA-256 未变。没有下载模型，也没有修改安全或工具呈现 contract。

已安装候选的 MODEL_SUITABILITY_RESOLVED 为 FAIL。Candidate package、candidate Native CU、pending UI Native smoke、formal promotion 和 installed smoke 均为 NOT_RUN。既有 Native safety、Schedule/Codex 拒绝及 no-replay 证据继续复用。I1 仍未完成；需要某个 Local 模型/部署满足既有的两次 cold 要求，并完成后续 candidate 与 release qualification。18,657-token 请求仅要赶上 180 秒首内容时限，prompt processing 就至少需要 103.7 tokens/s；实际候选还需留出余量，同时保持 OBSERVE planning 正确。本任务没有推荐或下载任何未安装模型。
