# Agent Note: Deterministic 只读 upstream compatibility audit

Status: implemented

[English](2026-09-17-upstream-tracking-read-only-auditor.md) | 中文

## Problem

Final Product baseline 已经稳定，但官方 repository 仍在持续改变 Desktop packaging、profile/persistence boundary、client composition、Agent/LLM/Session contract 与 native runtime dependency。Raw file diff 无法区分 Custom 独有文件与 upstream deletion、大量 documentation change 与小型 data-safety contract change，也无法区分 direct modification overlap 与 Custom code 间接消费的 interface。按文件数或纯关键词判断会制造每日噪音，却不能提供安全的维护边界。

Phase 8B 需要回答：选定的 upstream Git range 是否触达已知 DS Harness compatibility seam。答案必须 deterministic、可审计、测试时无需模型或网络、明确表达 unknown evidence，并且不能改变 source refs、product state、installed applications 或 user data。它不能声称 static analysis 已证明 update 可以安全 merge。

## Decision

Phase 8B.1 实现一个 deterministic source-level auditor，以及一份 machine-readable Custom change surface 与 compatibility seam registry。Auditor 将 required target 与显式 base 或默认 Final Product baseline 比较，解释每个 classified impact，写入 Markdown/JSON evidence，并且只记录可删除的 local tracker state。

它自身不 fetch、不调度、不通知、不调用模型，也不 merge、rebase、cherry-pick、build、package、install、launch、迁移数据或声称变化可以安全合并。

Auditor 与 DS Harness 产品 runtime 完全分离。生成的 report 和 last-audit state 位于已有 gitignore 覆盖的 `.artifacts/upstream-audit/`。它们可删除、可重建，不进入 Final Product baseline、用户 profile、`~/.dsh`、Application Support 或已安装 App。

## Git 拓扑与 baseline 角色

仓库为 `/Users/kongda/Developer/Local/deepseek-harness`。`master` 跟踪 `origin/master`；`origin` 是唯一配置的 remote，指向官方来源 `https://github.com/deepseek-ai/deepseek-harness.git`。`origin/HEAD` 和 remote 声明的默认 branch 均为 `master`。不需要、也没有新增单独的 upstream remote。

不可移动的产品引用保持为：

```text
ds-harness-product-baseline-2026-09-17
→ bfba98b9bd9390735242ad57840050850a3c11b5
```

技术恢复引用保持为：

```text
dsh-custom-baseline-2026-09-17
→ 9d9762e7d2567248050559f2ac1b04e9f2a766f2
```

首次真实 audit 通过独立的 `git fetch origin --prune` 刷新 remote refs，没有 merge 或 rebase。当时 `origin/master` 为 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`，与 Final Product baseline 的唯一 merge base 为 `c291e7961a515f6d7af9304e7fd1d257929aef26`，divergence 为 baseline 独有 12 commits、upstream 独有 666 commits。

Auditor 分析 `merge-base → target`，而不是直接做 `baseline → target` 两棵树 diff。这样 Custom 独有文件不会被错误报告成“被 upstream 删除”。Baseline 仍提供 ancestry/divergence identity；registry 则单独把 upstream 变化映射到 Custom change surface。

## Custom change surface

Tracked registry 将 Custom delta 归入以下维护 domain：

| Domain | Custom 职责 | 重要 upstream 依赖 |
| --- | --- | --- |
| Desktop product identity | DS Harness 名称、bundle id、Custom flavor、startup branding、Official 产品隔离 | Electron identity、startup、`userData`、single-instance contract |
| Desktop packaging | Custom package/install 路径、runtime tree、builder inputs、package set | staging layout、packaged Node Host、Electron builder、build/release contract |
| Custom composition | 内建 `desktop-custom-composition` 与 development composition | Cordis patch schema、base/web bundles、package resolution |
| Phase 2–7 capabilities | Run State、observation、run policy、Task Checkpoint、reasoning、compaction、diagnostics | Agent、LLM、Session、compaction、token-meter contract |
| Profile/runtime boundary | `desktop-custom`、隔离的 Electron data、bundled Host、刻意共享的 settings/Session | profile linking、storage、migration、runtime descriptor |
| UI integration | Run Details、idle closure、startup shell、title | remote transport、renderer slots/layout、startup URL |
| Tests | contract、composition、packaging、UI、安全回归 | Vitest、fixtures、build faces |
| Documentation | 双语决策、subsystem 页面、generated catalogs、attestations | pairing 与 generated-doc 约定 |
| Workspace/build graph | references、lockfile、metadata、exports、release families | workspace discovery、TypeScript faces、package exports 与 dependencies |

Inventory 按 domain 组织，不机械倾倒数百个文件。精确 pattern 与解释位于 `scripts/upstream-tracking-seams.json`，确保 auditor 与未来 isolated-update 工具使用同一份 authority。

## Compatibility seam registry

每个 seam 都记录 upstream surface、Custom dependent surface、interface、重要性、failure mode、detection method、固定 base risk 和 mapped tests。

| Seam | Contract | Base risk | 代表性 mapped tests |
| --- | --- | --- | --- |
| `desktop-product-identity-isolation` | product/app id、startup、`userData`、single instance | CRITICAL | Desktop main/startup/project-manager tests |
| `desktop-packaging-runtime-tree` | staging、package set、runtime descriptor、builder target | HIGH | signature/runtime-closure fixtures |
| `package-set-custom-composition` | Cordis patch 与 built-in package loading | HIGH | capability loader-composition suites |
| `client-package-export-loader` | client/remote exports、loader、slots、renderer registry | HIGH | Run Details 与 client-package tests |
| `profile-settings-session-boundary` | profile、settings、Session、migration、data paths | CRITICAL | profile/project 与 checkpoint schema tests |
| `agent-run-event-contract` | Run/Attempt、agent/tool/retry/cancel events | HIGH | Run projection、policy、checkpoint guards |
| `llm-provider-stream-contract` | reasoning、request、chunks、retry/error、usage/cache | HIGH | adapter、reasoning-policy、Run State service tests |
| `session-projection-persistence-contract` | durable event、JSONL、projection replay、persistence | CRITICAL | Run projection 与 Task resume suites |
| `compaction-token-surface-contract` | pressure、compaction、validation、atomic surface apply | HIGH | compaction-policy/basic 与 resume tests |
| `diagnostics-remote-ui-contract` | 只读 diagnostics remote 与 Run Details source | HIGH | diagnostics transport 与 Run Details tests |
| `native-runtime-abi-closure` | Electron/Node/native ABI 与 packaged module closure | HIGH | runtime closure、runtime fixture、signature tests |

Direct modification overlap 与 contract dependency 是不同事实。即使 Custom 从未修改某个 upstream implementation file，只要它消费该文件提供的 interface，upstream 变化仍可影响 Custom。反过来，附近 package 的普通变化也不会仅因为仓库是 fork 就自动升级风险。

## Change taxonomy

一个 change 可同时属于多个 category：

- **Documentation** — Markdown、双语记录和 documentation tree。
- **Tests** — test source 与 fixture。
- **Dependency/version** — manifests、lockfiles、workspace definitions、runtime version files。
- **Build tooling** — scripts、project references、bundler/test/CI configuration。
- **Desktop shell** — Electron main-process 与 Desktop shell source。
- **Electron packaging** — builder configuration 与 package/install/prepare entry points。
- **Runtime** — Host、packaged runtime、native system、SDK runtime。
- **Profile** — profile、configuration、path、Desktop project selection。
- **Cordis/composition** — bundles、Cordis patches、loader、composition。
- **Client UI** — client packages、web app、layout、renderer integration。
- **Agent loop** — agent 与 core-agent source。
- **Session** — Session format、controller、persistence、core Session source。
- **LLM/provider** — LLM、provider、adapter、streaming source。
- **Diagnostics/Run State** — diagnostics 与 governed Run policy packages。
- **Schema/type contract** — 显式 type、schema、protocol、contract surface。
- **Native dependency** — native system 或具名 native-module surface。
- **Security** — security、permission、sandbox、security-workflow surface。
- **Unknown** — 没有 registry taxonomy evidence；它是正式 review state，不是 Safe。

## Risk model

Risk 基于 contract，不按文件数推导：

- **NONE** — 只有 documentation/tests，且不触达 registered seam。
- **LOW** — 已知 upstream 区域有变化，但不触达 registered Custom seam。
- **MEDIUM** — adjacent seam implementation、Security surface 或 unknown/unclassified path 需要 review，但尚无 structural contract evidence。
- **HIGH** — registered high-value interface/schema/build contract、direct overlap、seam rename、native closure 或累计 multi-seam range 有变化。
- **CRITICAL** — product/data/profile/Session safety boundary 有变化，或累计证据表明 baseline replay 很可能需要人工适配后才能进行 isolated attempt。

Impact 单调映射为 `UNAFFECTED`、`RELATED_LOW_RISK`、`REVIEW_REQUIRED`、`LIKELY_CONFLICT`、`BLOCKING_CHANGE`。Action 映射为 `NO_ACTION`、`REVIEW`、`TEST_REQUIRED`、`MANUAL_ADAPTATION_REQUIRED`。Action 只是建议；Phase 8B.1 从不执行。

Range aggregation 有意保持简单：两个以上 material seams 或三个以上 material categories 可把 MEDIUM 升为 HIGH；四个以上 material seams 可把 HIGH 升为 CRITICAL。它不会降低任何 change，也不会声称 merge safety。

## Confidence model

- **HIGH** — 精确 direct-modification overlap 或 registered contract path；或明确 unrelated/document-only 规则。
- **MEDIUM** — registered adjacent seam 或 Security surface，没有 structural hit。
- **LOW** — 只有 unclassified path/heuristic evidence。

Confidence 是类别，不输出伪造的百分比概率。Evidence 不足会产生 `Unknown`/review，不会编造 compatibility fact。

## Audit algorithm

CLI 为：

```sh
pnpm upstream:audit --target <commit-or-ref>
```

它接受 `--base`（默认 Final Product tag），要求显式 `--target`，也可为受控测试提供 `--output-dir` 或 alternate registry。它不会猜 target。

Deterministic core：

1. 将 base/target 解析为 commits，拒绝 missing、ambiguous、non-commit refs；
2. 要求唯一 merge base，记录 baseline/upstream divergence；
3. 读取支持 rename/copy 的 `merge-base → target` Git diff；
4. 分配可多选 taxonomy categories；
5. 用 old/new path 匹配 registered seams；
6. 分开记录 direct overlap 与 contract dependency；
7. 只为 registered Electron/Node/native signal 检查 dependency patch，不把每个 dependency change 都判为 HIGH；
8. 独立评估每个 seam，按 path 聚合 commits，并应用有限的 range aggregation；
9. 原子写入 human-readable Markdown、machine-readable JSON 和最小 last-audit state。

全部 Git subprocess 禁用 optional locks 和 filesystem-monitor execution，且只使用 read operations。命令自身不 fetch；未来 monitor 必须把 remote ref 更新作为独立、显式步骤。

## Report 与 state model

默认输出：

```text
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.md
.artifacts/upstream-audit/<base>-<sha>__<target>-<sha>.json
.artifacts/upstream-audit/last-audit.json
```

Markdown report 包含 audit identity、summary、grouped evidence、commit samples、affected files、Custom surface summary、limitations。JSON 保留精确 identity、divergence、全部 classified changed paths、group counts/evidence、seams、risk、confidence、impact、recommended action。State 只保存最近一次 audit 的 ref/SHA/result identity。删除整个目录不会影响产品；重新运行即可从 Git 和 tracked registry 重建。

## Initial real audit

首次 audit 使用 Final Product baseline 与真实刷新后的 `origin/master`：

| Field | Result |
| --- | --- |
| Base | `bfba98b9bd9390735242ad57840050850a3c11b5` |
| Target | `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` |
| Merge base | `c291e7961a515f6d7af9304e7fd1d257929aef26` |
| Range | 666 upstream commits；3,188 changed files |
| Affected seams | 全部 11 个 registered seams |
| Highest risk | CRITICAL |
| Confidence | MEDIUM |
| Manual review | YES |
| Result | `BLOCKING_CHANGE` |

这是后续 isolated work 的 static stop signal，不表示 upstream 无法适配。Upstream range 实质改变了 Desktop identity/profile paths、Session/persistence contracts、Agent/LLM/client/composition surfaces，以及 Electron/native runtime dependencies；因此不能绕过 review 或直接 replay。

## Test mapping 与 verification

`scripts/upstream-audit.spec.ts` 使用本地临时 Git repository，不需要网络。它验证：

- no upstream changes；
- documentation only；
- unrelated package changes；
- known product/data seam changes；
- 使用 old/new paths 的 rename/move attribution；
- Electron/native dependency version signal，且不会提升 unrelated manifests；
- unknown/unclassified review behavior；
- cumulative multi-seam escalation；
- missing、ambiguous、non-commit refs；
- 生成 Markdown/JSON/state，同时保持 Git refs、HEAD、index 不变。

Registry 将每个高价值 seam 映射到已有 targeted product tests，使 Phase 8C 无需再发明第二套 dependency map 即可选择 evidence。

## Safety boundaries

Phase 8B.1 没有修改两个 baseline tag，没有执行 merge/rebase/cherry-pick/reset、push、build、package、install、launch App，也没有读取用户 settings、profiles、Sessions 或 Application Support。`/Applications/DS Harness.app` 与 `/Applications/DSH Desktop.app` 均不在 auditor 访问路径中。

Final Product baseline 是 comparison/recovery identity，不是 tracker state。Generated state 不会 commit 进 baseline。产品代码和用户数据不依赖 tracker state。

## Known limitations 与 future integration

Static analysis 无法证明 runtime compatibility、clean replay、native loadability、UI correctness、migration safety 或测试成功。Semantic break 可能在 seam 注册前逃过 path rule。Commit grouping 基于 path；Markdown 只显示 capped samples，但存储的 counts 与 changed paths 精确。当前 registry 针对已验证 DS Harness 产品；Custom dependencies 变化时必须同步演进。

Phase 8B.2 可以在 auditor 外新增 explicit monitor，但必须保持 fetch/notification/scheduling 与 deterministic classification 分离。Phase 8C 可在 isolated worktree 使用 seam-to-test mapping，并在 CRITICAL/data-safety evidence 下停止。本记录没有实现这两个阶段。

## Alternatives considered

- **直接对 Final Product baseline tree 与 upstream target 做 diff。** 放弃，因为每个 Custom 独有文件都会表现为 upstream deletion。最终使用 merge-base 到 target 的 range，并独立映射 Custom surface。
- **使用 changed-file count 或宽泛关键词作为 risk score。** 放弃，因为数量不表达 contract risk，全局关键词还会让 unrelated package change 产生噪音。当前 evidence 使用 registered paths、direct overlap、contract dependency、rename identity 与有限 dependency signal。
- **让 LLM 判断 upstream 是否安全。** 放弃，因为 safety gate 必须 deterministic、可离线测试、可复现，并在 evidence unknown 时明确承认。未来可以叠加人工或 AI-assisted explanation，但不能替换 static core。
- **让 auditor 自动 fetch、merge、rebase、test 或 update。** 放弃，因为 observation 与 mutation 需要独立 authority 与 failure boundary。Phase 8B.1 只分类已有 Git objects，并写入 ignored reports。
- **把 tracker state 存入产品 profile 或 Final Product baseline。** 放弃，因为 maintenance state 既不是 user data，也不是 product runtime state。Ignored `.artifacts` state 可丢弃、可重建。

## Consequences

- Maintainer 获得一份有 evidence 的 authority，覆盖 Custom domains、upstream seams、risk、confidence、recommended action 与未来 targeted tests。
- 大型 upstream range 会得到保守 stop signal，但不会把每个 changed file 都视为同等危险。
- Custom-only files 不会被误报为 upstream deletions；即使没有 path overlap，indirect contract dependency 仍然可见。
- Unknown path 会进入 review，而不是被称为 safe；纯 documentation/tests 与 unrelated manifests 也不会产生无意义的 high-risk 噪音。
- Report 与 state 是 local generated artifacts；删除它们或从不运行 auditor 都不会影响 DS Harness runtime 或用户数据。
- Static analysis 仍不能证明 replay、runtime、native ABI、UI、migration 或 test compatibility。Isolated adaptation 与 verification 仍是未来工作。
