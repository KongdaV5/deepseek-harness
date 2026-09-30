# 上游维护参考

[English](upstream-maintenance.md) | 中文

## 摘要

<a id="summary"></a>

本参考说明 Custom DSH 如何发现官方发布、审查语义影响并选择受影响验证。审查保持已验收的 Custom 产品和正式 App 不变。[接缝 registry](../scripts/upstream-tracking-seams.json) 是唯一声明源；[维护策略](../scripts/upstream-maintenance.json) 记录实际集成的官方祖先。

## 目录

<a id="table-of-contents"></a>

- [命令](#commands)
- [所有权与契约](#ownership-and-contracts)
- [影响与证据](#impact-and-evidence)
- [身份、祖先与统计](#identity-ancestry-and-statistics)
- [观察、集成与验收](#observation-integration-and-qualification)
- [当前 RC 示例](#current-rc-example)
- [延伸探索](#further-exploration)

## 命令

<a id="commands"></a>

在仓库根目录使用已有 Node.js、pnpm、Git、GitHub CLI 和已安装的开发依赖运行以下命令。在线命令读取官方仓库的已发布 release 和 refs；元数据不可用时明确失败。命令不安装依赖。

```sh
pnpm upstream:check
pnpm upstream:inspect --tag dsh-v0.2.0-rc.2
pnpm upstream:inspect --tag dsh-v0.2.0-rc.2 --json --output .artifacts/upstream-maintenance/rc2.json
pnpm upstream:test --report .artifacts/upstream-maintenance/rc2.json
```

`check` 报告 Custom HEAD、已发布 RC/stable 通道、最后集成的 tag/SHA、master、本地对象可用性、merge base 和简要包/重叠统计。没有 stable 时返回 `null`。缺失对象产生 `OBJECTS_MISSING`、未知计数和建议的显式刷新命令。

`inspect` 将官方 tag 解析为精确 SHA、标明发布状态，并比较 merge-base → Custom、last-synced → target 和 merge-base → target。`--master` 显式选择持续变化的开发分支进行开发者审查。未发布 tag 标记为 unpublished，不会被当作已发布的追踪通道 release。

`test` 默认 **DRY RUN**。它列出精确 spec、变化契约、消费者、证据状态和验收缺口。`--run` 只执行重新计算计划中已审查的无凭证单元测试白名单。其他已选 spec 保持为明确的验收要求；选择测试不代表当前产品测试能够验收目标的新格式。报告不能提供可执行命令。

所有命令支持 `--json`。`check` 和 `inspect` 仅在 `--output` 指向 `.artifacts/` 内被忽略文件时写入。输出拒绝 tracked 文件、symlink 和目录外路径。显式 inspect 输出还记录本地 `last-inspected.json`，不改变集成策略。

`check` 或 `inspect` 的 `--refresh` 抓取官方对象，不移动 branch/tag refs，也不写 `FETCH_HEAD`；它将官方 catalog 缓存到被忽略的 `.artifacts/upstream-maintenance/`。默认命令不 fetch。`--offline` 使用缓存并标记来源为 `CACHED_UNVERIFIED`；离线旧元数据不能授权 `--run`。没有有效缓存时，离线操作明确失败。

## 所有权与契约

<a id="ownership-and-contracts"></a>

registry 默认 `UPSTREAM`。显式规则声明 `CUSTOM` 语义所有权或 `MIXED` 共享接缝、理由、不变量、消费契约、受影响 spec 和最低影响等级。后续规则覆盖较宽规则；`GENERATED`、`DERIVED`、`LOCKFILE` 等技术标签补充所有权。规则 pattern 描述模块，不构建第二套所有权清单。待引入契约可以指向 Custom 尚无的包，但所有权 pattern 必须匹配当前文件。

契约变化从提供者传播到依赖契约和 Custom 消费者，即使不存在直接路径重叠。例如替换 Settings 会影响 Codex 和 Local 设置消费者，尽管 Codex adapter 源码未变。registry 校验拒绝缺失测试、陈旧所有权 pattern 或声明符号、缺失依赖和循环。未登记的 Custom 修改产生 `REVIEW_REQUIRED`，不会自动得到安全结论。

关键不变量包括已验收的惠惠 Qwen Local-first 路由、仅官方 Codex 订阅传输、规范 DSH 对话身份、不重放、账号代际隔离、独立 Codex Runtime Maintenance、Custom profile 边界、不静默替换模型和串行 Local runtime 所有权。审查报告需要复验的不变量，不重新验收它们。

## 影响与证据

<a id="impact-and-evidence"></a>

分类使用功能源码变化和依赖因果关系。文件数量、发布版本和直接重叠是描述统计，不足以独立证明风险。仅版本字段变化的包 manifest 属于元数据。文档、locale 和样式变化不使认证证明失效。

| 等级 | 含义 | 必需审查 |
|---|---|---|
| U0 | 文档、locale、格式或样式元数据 | 审查非功能变化 |
| U1 | 无 Custom 消费者的官方叶子变化 | 审查显式同步候选 |
| U2 | 局部 Custom/Mixed 叶子 | 选择受影响叶子验证 |
| U3 | Agent、Session、host、provider、runtime 或 Desktop 契约 | 复验依赖集成 |
| U4 | 持久化、安全或核心配置架构 | 先分阶段语义迁移再验收 |

证据只有 `UNCHANGED`、`AFFECTED` 和 `INVALIDATED` 三种状态。依赖变化使消费者成为 `AFFECTED`；持久化/安全/生命周期证明边界直接变化使相关证据成为 `INVALIDATED`。模型选择器变化保留 Codex Q1 认证证据。Settings 影响设置/认证集成，不会自动使认证代际契约失效。Session 变化不会触发完整 Codex runtime compatibility，除非 App Server adapter/process 契约实际变化。

对应契约变化时，计划器包含 Session/持久化、Codex 投影与设置、Local runtime/默认模型、external turns、Desktop profile/生命周期、模型 catalog/admission、Run Details 传输、任务连续性和 compaction。待引入迁移、Schedule 和 Computer Use 测试在功能集成前保持明确缺口。ABI/payload 工作归属 release qualification。执行白名单排除 Native 构建、package、GUI 启动、Local 推理、真实凭证、profile 修改、迁移、完整 Codex compatibility 和全仓测试。

## 身份、祖先与统计

<a id="identity-ancestry-and-statistics"></a>

报告绑定 Custom HEAD、目标 tag/SHA、真实唯一 merge base、ownership/contract revision、tool/schema version、timestamp 以及 policy、registry、工具源码 digest。计划器拒绝陈旧 HEAD/revision/source、变化的官方 tag、不完整历史和 dirty 产品源码。它从当前官方不可变对象重新计算计划，不信任报告选择的 spec。Git replace、graft、shallow history、祖先歧义和进行中的 merge/rebase/cherry-pick 操作明确失败。

主要统计采用 50% rename 相似度、完整 rename detection 和 copy detection OFF。rename 计为一个逻辑变化；源路径与目标路径都参与重叠和所有权检查。复制源不会自动成为冲突。如果另外用 Git 执行 copy 诊断，其结果不是主要报告统计。缺失对象不代表落后提交数为零。

目标必须来自 `deepseek-ai/deepseek-harness`。Fork/mirror remote 身份和任意输入 SHA 被拒绝。已发布 release 元数据区分 RC、stable、draft 和未发布 tag。已记录官方 tag 移动或删除触发失败审查；last-synced tag/SHA 必须保持为 Custom 的实际祖先。报告仅包含仓库相对源码路径和源码事实，不含 home 路径、token、对话或 profile 数据。

## 观察、集成与验收

<a id="observation-integration-and-qualification"></a>

追踪通道包含已发布 RC 和 stable release。同步通道要求未来明确批准不可变官方 tag 加精确 SHA。Master 保持为显式开发者审查。`lastSynced` 是提交的集成 pin，目前为 `dsh-v0.1.6-alpha.2`。被忽略的 `lastInspected`、catalog 和 fetch 状态属于观察。monitor 的 watch cursor 记录已观察/通知内容；推进它不会消除兼容债务或推进集成 pin。现有 branch monitor 和 scheduler 仍属于开发者工具；这些命令不安装或改变任何外部计划。

源码同步与 release qualification 分离。本工具没有实现 `upstream:sync` 或 `release:qualify`。未来同步必须消费新鲜的审查身份并保留 Custom 不变量；验收必须独立覆盖迁移、payload、runtime 和正式产品要求。因此观察、集成和验收版本可以不同。

## 当前 RC 示例

<a id="current-rc-example"></a>

对照已验收 Custom 分支审查 `dsh-v0.2.0-rc.2` 得到 **U4 / STAGED_SEMANTIC_MIGRATION**。tagged 源码将 Session 格式 3 → 4，增加为未知 ignorable 事件加 `plugin:` 前缀的迁移，并用 volatile Config/profile patch 编辑和 legacy import 替代 Settings-file 持久化。精确匹配的 Custom `codex/subscription-state`、`task/checkpoint` 和 `task/result-manifest` 投影需要明确的迁移设计。Desktop 生命周期变化需要专项验证。这些是报告中的阻塞项；目标尚未集成或验收。

Schedule 和 Computer Use 报告为 **AVAILABLE**，需要明确的产品激活决定。Schedule delivery/recovery、Computer Use provider 权限/teardown 及共享生命周期交互保持为未来验收工作。审查不会启用它们。下一迁移入口是 build/config/plugin 基础，然后分别处理持久化和 provider 阶段。

## 延伸探索

<a id="further-exploration"></a>

参见[开发指南](development.zh.md)、[测试](testing.zh.md)、[只读审计实现](../scripts/upstream-audit.ts)和[共享维护实现](../scripts/upstream-maintenance.ts)以了解各自归属的契约。

## 开发注记

<a id="dev-note"></a>

无。
