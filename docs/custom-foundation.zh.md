# Custom foundation 迁移 ledger

[English](custom-foundation.md) | 中文

## 基础与验证范围

P-UPSTREAM-0.2-M1 在 `migration/upstream-0.2-rc2` 分支上从官方 `dsh-v0.2.0-rc.2` 的精确 tag 开始。可信 `feature/codex-subscription` 分支保持不变。Custom 原始祖先是 `dsh-v0.1.6-alpha.2`。本工作包的官方 target 固定。

Candidate 采用官方 Config、ConfigEditor、profile composition、agent-preset 架构、Session V4 codec 和 immutable generation publisher。Custom 状态限于产品身份、Local inventory、非秘密 Codex 配置与 mapping，以及 task authority。本基础不保留旧 Settings store、settings-file 包或完整 Custom runtime。

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
