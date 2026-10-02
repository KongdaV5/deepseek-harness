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

因此 M3 仍 blocked，candidate 证据通过并不构成最终发布成功。正式安装仍为旧版；Schedule 仅在 migration composition 和 candidate 中启用，Computer Use 仍禁用。Codex 可以执行 scheduled turn，但不能通过官方 external-turn tool surface 管理 DSH Schedule task。再次 promotion 前必须定位并验收 installed profile/catalog resolution。修改文档通过 focused checks，历史 persistence-format 与 reasoning-policy metadata 债务未变。不启动 Computer Use 或无关增强。
