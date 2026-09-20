# Agent Note: Deterministic 只读 upstream compatibility audit

Status: implemented

[English](2026-09-17-upstream-tracking-read-only-auditor.md) | 中文

## Problem

DS Harness source product 已经稳定，但官方 repository 仍在 Desktop packaging、profile 与 persistence boundary、client composition、Agent/LLM/Session contract、compaction 以及 native runtime dependency 上持续移动。Raw file diff 无法区分 Custom 独有文件与 upstream deletion、大型 documentation change 与小型 data-safety contract change，也无法区分 direct modification overlap 与 Custom code 只是消费的 interface。按文件数或关键词规则判断会制造每日噪音，却不能给出安全的维护边界。

因此 upstream observation 需要一个 source-level 答案：选定的 Git range 是否触达已知 DS Harness compatibility seam。该答案必须 deterministic、可审计、测试时无需模型或网络、在 evidence unknown 时明确承认，并且不能改变 refs、product state、已安装应用或用户数据。它也绝不能声称 static analysis 已证明某个 update 可以安全 merge。

## Decision

Maintenance plane 提供一个 deterministic source-level auditor，以及一份 machine-readable Custom change surface 与 compatibility seam registry。Auditor 将 required target 与显式或默认 product baseline 比较，解释每个 classified impact，写入 Markdown 与 JSON evidence，并且只记录可删除的 local tracker state。

Auditor 自身不 fetch、不调度、不通知、不调用模型、不 merge、不 rebase、不 cherry-pick、不 build、不 package、不 install、不 launch、不迁移数据，也不声称变化可以安全合并。Fetch 与 ref refresh 保留在独立的 monitor 中，使 deterministic classification 依然可以离线使用。

Auditor 刻意位于 DS Harness 产品 runtime 之外。其 report 与 last-audit state 位于已被忽略的 `.artifacts/upstream-audit/` 目录下；它们可删除、可重建，绝不进入 product baseline、user profile、`~/.dsh`、Application Support 或已安装 App。

## Repository topology 与 baseline 角色

`master` 跟踪 `origin/master`，这是唯一配置的 remote，指向官方 upstream 来源。不需要、也没有新增单独的 upstream remote。

不可移动的产品引用仅保留 tag：

```text
ds-harness-product-baseline-2026-09-17
```

技术恢复引用仅保留 tag：

```text
dsh-custom-baseline-2026-09-17
```

维护代码中不内嵌任何 commit identifier。Monitor 通过 tag 解析 product baseline，并从 auditor 自身的 evidence file 读取 audited cursor，因此 baseline 移动无法通过修改 literal 被偷渡进来。

Auditor 分析 `merge-base → target`，而不是直接做 baseline 与 target 的两棵树 diff。这样 Custom 独有文件不会被误报为 upstream deletion，同时 baseline 仍提供 ancestry 与 divergence identity。

## Custom change surface

Tracked registry 将 Custom delta 归入九个维护 domain：Desktop product identity、Desktop packaging、Desktop Custom composition、Stage 6–11 capabilities、profile/runtime boundary、UI integration、tests、documentation，以及 workspace build graph。

Inventory 按 domain 组织，而不是机械倾倒数百个文件。精确 pattern 与解释位于 auditor 旁的 tracked registry，使 auditor、monitor 与未来 isolated-update 工具消费同一份 authority。

## Compatibility seam registry

每个 seam 都记录 upstream surface、Custom dependent surface、interface、重要性、failure mode、detection method、固定 base risk 与 mapped product tests。

| Seam | Contract | Base risk |
| --- | --- | --- |
| `desktop-product-identity-isolation` | product flavor、app id、startup document、`userData`、single instance | CRITICAL |
| `desktop-packaging-runtime-tree` | staging、primary-runtime lock 与 digests、builder target | HIGH |
| `package-set-custom-composition` | Cordis tail patch 与 base/web bundle loading | HIGH |
| `client-package-export-loader` | client/remote exports、generated catalogs、dockkit slots | HIGH |
| `profile-settings-session-boundary` | profile、settings、Session、migration 与 data paths | CRITICAL |
| `agent-run-event-contract` | Run/Attempt correlation、agent lifecycle、tool 与 cancel events | HIGH |
| `llm-provider-stream-contract` | reasoning、request、chunks、durable retry、usage 与 cache | HIGH |
| `session-projection-persistence-contract` | v3 envelope、JSONL、projection replay、ignorable extension events | CRITICAL |
| `compaction-token-surface-contract` | pressure、executor、candidate policy、atomic surface apply | HIGH |
| `diagnostics-remote-ui-contract` | 只读 diagnostics transport 与 Run Details source | HIGH |
| `native-runtime-abi-closure` | Electron/Node/Python ABI 与 packaged native module closure | HIGH |

Direction 与 dependency 是两个不同事实。即使 Custom 从未修改某个 upstream implementation file，只要它消费该文件提供的 interface，upstream 变化仍可影响 Custom。反过来，附近 package 的普通变化也不会仅因为仓库是 fork 就自动升级风险。

Seam ID 是稳定的 report 与 state vocabulary。`package-set-custom-composition` 被保留，尽管历史 package-set 实现已 retired：该 seam 现在监视把 Custom capability composition 叠加到当前 base 与 web bundle 之上的 `@deepseek-ai/dsh-desktop-custom` tail patch，并且 registry 明确说明这一点，而不是指向已移除的 package。

## Change taxonomy

一个 change 可同时携带多个 category：Documentation、Tests、Dependency/version、Build tooling、Desktop shell、Electron packaging、Runtime、Profile、Cordis/composition、Client UI、Agent loop、Session、LLM/provider、Diagnostics/Run State、Schema/type contract、Native dependency、Security 与 Unknown。Unknown 是正式的 review state，不是 safe。

## Risk model

Risk 基于 contract，不按文件数推导：

- NONE 表示只有 documentation 或 tests，且不触达 registered seam。
- LOW 表示已知 upstream 区域有变化，但不触达 registered Custom seam。
- MEDIUM 表示 adjacent seam implementation、Security surface 或 unknown path 需要 review，但尚无 structural contract evidence。
- HIGH 表示 registered high-value interface、schema 或 build contract 有变化，或检测到 direct overlap、seam rename、native closure 或累计 multi-seam range。
- CRITICAL 表示 product、data、profile 或 Session safety boundary 有变化，或累计证据表明在进行任何 isolated attempt 之前 baseline replay 很可能需要人工适配。

Impact 单调映射为 `UNAFFECTED`、`RELATED_LOW_RISK`、`REVIEW_REQUIRED`、`LIKELY_CONFLICT` 与 `BLOCKING_CHANGE`。Action 映射为 `NO_ACTION`、`REVIEW`、`TEST_REQUIRED` 与 `MANUAL_ADAPTATION_REQUIRED`。Action 只是建议；没有任何东西会执行它。

Range aggregation 刻意保持很小：两个以上 material seam，或三个以上 material category，可把 MEDIUM 升为 HIGH；四个以上 material seam 可把 HIGH 升为 CRITICAL。它从不降低任何 change，也从不声称 merge safety。

## Confidence model

HIGH 表示精确 direct-modification overlap 或 registered contract path，或明确 unrelated 或 documentation-only 规则。MEDIUM 表示 registered adjacent seam 或 Security surface，但没有 structural hit。LOW 表示只有 unclassified path 或 heuristic evidence。Confidence 是类别，不输出伪造的百分比概率；evidence 不足会产生 review，绝不编造 compatibility fact。

## Audit algorithm

CLI 为：

```sh
pnpm upstream:audit --target <commit-or-ref>
```

它接受 `--base`（默认 product baseline tag），要求显式 `--target`，也可为受控测试提供 `--output-dir` 或 alternate registry。它从不猜 target。

Deterministic core 将 base 与 target 解析为 commits，拒绝 missing、ambiguous 或 non-commit refs；要求唯一 merge base 并记录 baseline/upstream divergence；读取支持 rename/copy 的 `merge-base → target` diff；分配 non-exclusive categories；用 old 与 new path 匹配 registered seams；把 direct overlap 与 contract dependency 分开记录；只为 registered Electron/Node/native signal 检查 dependency patch，而不是把每个 dependency change 都判为 HIGH；独立评估每个 seam、按 path 聚合 commits 并应用有限 range aggregation；最后原子写入 human-readable Markdown、machine-readable JSON 与最小 last-audit state。

每个 Git subprocess 都禁用 optional locks 与 filesystem-monitor execution。该命令只使用 read operations。

## Report 与 state model

默认输出为：

```text
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.md
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.json
.artifacts/upstream-audit/last-audit.json
```

Markdown report 携带 audit identity、summary、grouped evidence、commit samples、affected files、Custom surface summary 与 limitations。JSON 保留精确 identity、divergence、全部 classified changed path、group counts 与 evidence、seams、risk、confidence、impact 与 recommended action。State 只保存最近一次 audit 的 ref、commit identity 与 result。删除整个目录不会影响产品；重新运行即可从 Git 与 tracked registry 重建。

## Stage 12 port delta

Auditor 从已完成的 Phase 8B maintenance plane 移植到当前 upstream adaptation。历史 Phase 8B 分类的是当时的产品 surface；Stage 12 把同一套 deterministic engine 重新瞄准 Stage 1–11 implementation。

Taxonomy 与 change-surface domain 为当前 workspace layout 重写。Seam ID 被保留，但每个 evidence path 现在都指向当前实现：`apps/desktop/src` 下的 Desktop flavor 与 data-boundary 模块、`apps/desktop/scripts` 下的 primary-runtime scripts、`packages/bundle/desktop-custom`、Stage 6–11 capability packages、`packages/api/runtime-diagnostics-controller`、`packages/api/gateway`、`packages/api/remotes`、`packages/typert`、`packages/session/session-checkpoint-policy`、`packages/compaction/compaction-task-aware-policy` 与 `packages/client/ui-run-details`。当前 workspace 已不包含的 retired root 从 registry 中删除，而不是继续携带。

Stage 11 transient diagnostics transport 没有创建新 seam。现有 diagnostics seam 拥有那份 compatibility contract，因此其 evidence 扩展为覆盖 Typert Remote stream face、Gateway stream transport、Resource Registry 与 connection seats、以及 Run Details dock，而 seam 数量保持为十一个。

## Verification

Auditor suite 只使用本地临时 Git repository，无需网络。它覆盖：no upstream changes、documentation-only changes、unrelated package changes、带 direct overlap 的已知 product/data seam、跨 closed 与 open path 的 rename 与 move attribution、不会提升 unrelated manifest 的 Electron/native dependency signal、unknown-path review behaviour、cumulative multi-seam escalation、missing、ambiguous 与 non-commit refs，以及生成 Markdown、JSON 与 state 同时保持 Git refs、HEAD 与 index 不变。它还额外证明当前 agent-loop contract path 映射到 agent event seam、Gateway 与 Resource Registry path 映射到 diagnostics seam、token-meter 与 compaction path 映射到 compaction seam，以及 base bundle patch change 映射到 composition seam。

Registry suite 证明十一个稳定 seam ID、完整 seam evidence、历史 package-set implementation 的 documented retirement、Stage 11 与 Stage 10 evidence 扩展、全部 retired package root 的缺失，以及不内嵌 commit identifier。

## Safety boundaries

没有任何 baseline tag 被移动、重建、retag 或删除。Auditor 不执行 merge、rebase、cherry-pick、reset、push、build、package、install、launch，也不读取用户数据。已安装的 DS Harness 应用保持在其访问路径之外。Product baseline 是 comparison 与 recovery identity，不是 tracker state，生成的 state 也绝不 commit 进去。

## Known limitations 与 deferred work

Static analysis 无法证明 runtime compatibility、clean replay、native loadability、UI correctness、migration safety 或 test success。Semantic break 可能在 seam 注册前逃过 path rule。Commit grouping 基于 path，Markdown 只显示 capped samples，但存储的 counts 与 changed paths 精确。Registry 针对已验证的 DS Harness 产品；Custom dependencies 变化时必须同步演进。Unknown 或 unclassified path 保持可 review，绝不能被静默重分类为 safe。

## Alternatives considered

- **直接对 product baseline tree 与 upstream target 做 diff。** 放弃，因为每个 Custom 独有文件都会表现为 upstream deletion。最终使用 merge-base 到 target 的 range，并独立映射 Custom surface。
- **使用 changed-file count 或宽泛关键词作为 risk score。** 放弃，因为数量不表达 contract risk，全局关键词还会让 unrelated package change 产生噪音。
- **让模型判断 upstream 是否安全。** 放弃，因为 safety gate 必须 deterministic、可离线测试、可复现，并在 evidence unknown 时明确承认。
- **让 auditor 自动 fetch、merge、rebase、test 或 adapt。** 放弃，因为 observation 与 mutation 需要独立 authority 与 failure boundary。
- **把 tracker state 存入 product profile 或 product baseline。** 放弃，因为 maintenance state 既不是 user data 也不是 product runtime state；ignored `.artifacts` state 可丢弃、可重建。
- **为 Stage 11 diagnostics packages 新增 seam。** 放弃，因为现有 diagnostics seam 已经拥有那份 compatibility contract；额外的 seam 只会放大告警而不增加 evidence。

## Consequences

- Maintainer 获得一份有 evidence 的 inventory，覆盖 Custom domain、upstream seam、risk、confidence、recommended action 与 targeted product tests。
- 大型 upstream range 会产生保守的 stop signal，但不会把每个 changed file 都视为同等危险。
- Custom-only files 不会被误报为 upstream deletion，即使没有 path overlap，indirect contract dependency 依然可见。
- Unknown path 保持可 review，而不是被称为 safe；documentation、tests 与 unrelated manifests 也不会产生无意义的 high-risk 噪音。
- Report 与 state 是 local generated artifacts；删除它们或从不运行 auditor 都不会影响 product runtime 或用户数据。
