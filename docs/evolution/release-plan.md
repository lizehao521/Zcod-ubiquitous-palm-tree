# 交付计划 · 提交拆分与上 GitHub

规则依据：`apps/zcode-cli/AGENTS.md`「提交规范」——一个功能级变更一个提交、不混依赖/格式/重构、
提交要小到可独立审查、同功能的多文件一起提交。

## 提交序列（每轮结束后由主代理据实增删）

| # | commit 主题 | 纳入文件 | 状态 |
| --- | --- | --- | --- |
| C1 | `chore: 忽略本地进化快照目录` | `.gitignore`（会话开始前即为用户本地已有改动，随本链落库，不改 git config） | 待 |
| C2 | `test(harness): 进化闭环判据、验收器、谱系与证据台账` | `docs/evolution/{verify.mjs,tree.mjs,baseline.mjs,review-checklist.md,scope-pool.md,m1-adjudication-matrix.md,main-findings.md,user-decisions.md,release-plan.md,tree.json,tree.txt}` | 待 |
| C3 | `fix(config): 非法 ZCODE_* 数值不再静默变成 0，并把三处重复的 key→default 表收口` | `adapters/src/config/{env-config.adapter.ts,config-factory.ts,index.ts,resolve-snapshot.ts}`、`adapters/tests/{env-config.test.ts,config-resolve-snapshot.test.ts}`、`specs/runtime-env-config/spec.md`、`docs/evolution/{gen1/env-config-report.md,gen2/env-config-review.md,gen4/fix-config-report.md,gen3/*}` | 待 |
| C4 | `perf(logging): 日志改为有界异步批量落盘并保住 fail-open 半边` | `adapters/src/logging/{append-queue.ts,append-queue-contract.ts,index.ts}`、`adapters/tests/{logging-append-queue.test.ts,logging-append-queue-options.test.ts}`（M5 拆分后为多文件）、`specs/logging-persistence/spec.md`、`docs/evolution/{gen1/logging-report.md,gen2/logging-review.md,gen4/verify-all.md}` | 待 |
| C5 | `perf(exec): Windows 代码页解析移出事件循环` | `adapters/src/exec/{windows-code-page.ts,outputEncoding.ts,node-execution-adapter-run.ts}`、`adapters/tests/windows-code-page.test.ts`、`specs/windows-code-page/spec.md`、`docs/evolution/gen4/fix-exec-report.md` | 待 |
| C6 | `docs(specs): 记录 core 直连 node:fs 的边界例外（用户裁决 D-A）` | `specs/core-fs-boundary/spec.md` | 待 |
| C7 | `feat(config): network.timeout 字面 0 = 显式关闭超时（用户裁决 D-B）` | M5 产物：`env-config.adapter.ts`、`config/schema.ts`、`specs/runtime-env-config/spec.md`、对应测试 | 待 M5 |
| C8 | `docs(evolution): 五轮谱系闭合与总结` | `docs/evolution/{summary.md,tree.json,tree.txt,gen5/*}` | 最后 |

本表是计划原文，状态列停写在"计划时点"；实际落地以文末「落地情况」表为准。

### 已知偏离「一个功能一个提交」的一处，及原因

C3 把两件事放进一个提交：M1/M2 的 env 数值守卫，与 M4 的 key→default 表收口。
原因是两者都落在 `config/index.ts` 同一文件里（守卫需要桶导出 `parseEnvConfigWithDiagnostics`，
收口把同文件从 491 行（`git show afb40aa^:...config/index.ts | wc -l` 实测；
台账曾误记 500，已就地更正）减到 364 行），按文件拆提交会让前一个提交自身缺少可导入的出口，
而按 hunk 拆（`git add -p`）在本环境不可交互、风险高于收益。
代价如实写在这里：**这个提交比理想的大，审查者要同时读两处变更**；
body 里会分两段说清各自动机，不装作是一件事。
其余提交保持"一功能一提交"，日志与 exec 各自独立。

纪律：不用 `git add -A`；每次 `git add` 后 `git status` 复核实际入库内容；
提交前跑 `node docs/evolution/verify.mjs` 并把真实数字写进 commit body（未执行的验证不得写成已执行）。
谱系图 `docs/evolution/tree.txt` 是生成物，命令固定为
`node docs/evolution/tree.mjs render > docs/evolution/tree.txt`；每轮结束重跑，不许手改。

## 认证与网络

本机代理配置、凭据状态与 CI 前置失败原因属**个人工作目录与本机环境信息**，
按 `apps/zcode-cli/AGENTS.md`「开源内容与敏感信息」不入库；记录留在本地运维笔记
（`.hermess-snapshots/release-notes-local.md`，已被 gitignore）。
入库部分只保留两条事实性结论，以及一条后来被实测推翻的预测（保留原文并标出，不静默改写）：

1. 本 checkout 不含根 `packages/`、`scripts/`（`git ls-files` 实测 0 条），
   而 `.github/workflows/ci.yml` 的 typecheck/lint/architecture/build 指向它们 →
   在这个裁剪树上直接推 CI 必然出现**结构性红灯**，与本次改动无关。
   ~~推送后 CI 会出现结构性红灯~~：**已被实测推翻**，见下节。红灯的成因不是缺 CI 配置，
   而是缺 CI 要构建的那棵树；闭合方式是把改动重放到全量底座上，而不是改他们的 workflow。
2. 本轮真实可执行证据只有 `node --test`（`node docs/evolution/verify.mjs` 的三态表）。
   `pnpm lint` / `pnpm typecheck` 在本环境无法执行，任何提交信息都不得声称它们通过。
   全量底座上由 CI 跑出的结论见下节；两条证据链分开记账，不互相冒名。

## CI 实测结论（全量底座，run 36460317426 = head `a82fc12`；run 36462166522 = 当前 head `f90a641`）

搬运方式：`evolution/hermes-m1-m5-full` = 目标仓库 `main` 的全量树 + 本轮 10 个提交 cherry-pick 重放；
与本仓库历史无共同祖先，用 `--allow-unrelated-histories -X ours` 合并，
`README`/`LICENSE` 保留项目版本。本仓库的 `main` 与裁剪树不受影响。

下表取自 `a82fc12` 那次（第一次由红转绿的 run）。其后的 `aebb49d`、`f90a641` 是纯文档提交，
各自触发一次 CI：`aebb49d` 的 Build/Test 被下一次推送的并发组取消（GitHub cancel-in-progress，
是这次推送的副作用而非缺陷），`f90a641` 五个作业再次全 success。
每次推送都会让 head 前移并作废上一个 run，所以这张表读作"这些提交各自跑绿过"，
不读作"PR 上最后一次运行"——最后一轮以 PR 页面当前的 check 列表为准。

| 作业 | 结论 | 关键步骤 |
| --- | --- | --- |
| Lint | success | `pnpm lint` |
| TypeCheck | success | `pnpm typecheck` |
| Architecture Check | success | `pnpm architecture:check` |
| Build | success | `pnpm build` —— 上一版 `61c3ede` 正是在这一步失败（7 处 TS2345） |
| Test | success | `pnpm --filter @zcode/desktop run test --if-present` |

head 走到 `84cdc26` 后同样是五个作业全 success，差别在两步骤：TypeCheck 多出
`pnpm --filter zcode-cli run typecheck`，Test 多出 `pnpm --filter @zcode/adapters run test`，
读数见下两节。

两条不体面、但必须写进台账的读数，是当时这条"绿"的边界。原文保留在下面，闭合读数紧跟其后，
不改成"一开始就知道"的样子。

> **边界一（当时的判断）**：根 `pnpm typecheck` 覆盖不到 `apps/zcode-cli`：它是一条显式列举的
> `tsc -b packages/rpc … packages/desktop/tsconfig.host.json`（11 项，实测其中没有 `apps/`）。
> 所以 TypeCheck 作业绿灯不能证明 M1–M5 的改动没有类型错误；那 7 处 TS2345 是 Build 作业抓出来的。
> 成因不是 CLI 包没类型检查——`apps/zcode-cli` 自己有 `typecheck: turbo run typecheck`，
> 且 `pnpm-workspace.yaml` 里它就是工作区成员；只是根 TypeCheck 作业没调用它，
> 而 `build: pnpm -r build` 递归到了它。
> 当时结论：把 `apps/zcode-cli` 纳入根 typecheck 会暴露既有类型债，是一次独立改动，不与本修复混做。

闭合读数取自 head `84cdc26`（run 36468163831，五个作业全 success）：

1. **TypeCheck 空洞已闭合，且"会暴露一堆债"的假设被实测推翻。**
   作业现在两步都跑：`pnpm typecheck`（根，显式 11 项 `tsc -b`）+
   `pnpm --filter zcode-cli run typecheck`。作业日志里能看到后者真的执行了：
   `Running typecheck in 17 packages`、`Tasks: 27 successful, 27 total`、
   `Cached: 0 cached`、`Time: 1m39.47s`。**既有类型债 = 0 处 `error TS`**，
   代价只是冷缓存多花 1m39s。
   - 落地时踩到一个真问题：`apps/zcode-cli/AGENTS.md` 明文那条
     `pnpm --dir apps/zcode-cli typecheck` 在 CI 上失败（`sh: 1: turbo: not found`，
     run 36466186122 的 TypeCheck exit 1，Build/Test 被连带 skip）。
     根因：`apps/zcode-cli` 是自带 `pnpm-workspace.yaml` + `pnpm-lock.yaml` 的嵌套工作区，
     `turbo` 只在它自己的 devDependencies（^2.4.0）里，根 `pnpm install --frozen-lockfile` 不装它。
   - **残留风险（未修，属动依赖，需单独定）**：`--filter` 形态依赖 runner 提供的全局 turbo 2.9.14，
     探针日志里有这条 WARNING。干净修法是在 CI 里再装一次嵌套工作区依赖，或把 turbo 提到根 devDeps。
> **边界二（当时的判断）**：Test 作业没有牙齿。`@zcode/desktop` 的 `package.json` 里没有 `test` 脚本
> （实测），`--if-present` 因而是空操作；`ci.yml` 与 `release.yml` 中 `zcode-cli`、`apps/` 均出现 0 次
> （实测）→ 本轮的 8 个可加载测试文件 / 105 例**不在任何 CI 作业里执行**，
> 它们只在本地 `node --test` 尺子下成立。但别读成"CI 完全不碰这个包"：`pnpm build` 会编译它，
> 那 7 处 TS2345 正是在 CLI 包里被抓出来的——**被编译、不被测试**。
> 当时结论：要让 CI 真跑这些用例，得先定跑器形态（Node 原生类型擦除，还是先构建再跑），
> 这是产品级选择，等对齐后再动。

2. **Test 空洞已闭合，跑器形态就是仓库自己已有的那套。** `@zcode/adapters` 声明了 `test` 入口，
   Test 作业调用它；ubuntu + `node: v24.21.0` 的作业日志为
   `> node --test --test-reporter=tap "tests/*.test.ts"` →
   `# tests 105 / # suites 11 / # pass 105 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`。
   "CI 的 Node 24 能吃 TS 类型擦除"因此是被执行证明的，不是推断；
   选它的理由不是省事：全仓没有任何 `vitest` 依赖（实测 0 处），
   仓库自带的 4 个 `.test.ts` 用的同样是 `node:test` + `node:assert/strict`。
   - **装牙齿的当轮就抓到一条真缺陷**：旧断言 `order[0] === "tick"` 的隐含前提是
     "子进程比一个事件循环 turn 慢"。Windows 恰好满足；Linux 上 `cmd.exe` 不存在、
     spawn 立刻以 ENOENT 失败，rejection 的微任务排在 `setImmediate`（宏任务）之前 ⇒
     `# pass 104 / # fail 1`，且**两次独立 run 读数一致 —— 不是 flaky，是前提错**。
     修法与反向证据见提交 `d56f2a1` 与 `specs/windows-code-page/spec.md` §5 的 S8。
   - desktop 那行 `--if-present` 原样保留：落地时实测 32 个工作区包 0 个声明 `test` 脚本，
     所以它当时是空操作；现在它仍是空操作，只是不再等于"Test 作业什么都没跑"。
   - 两次仪器假绿记在这里当反面教材（都是我自己的错，不是被测物的）：
     `命令 | tee 日志` 在 Actions 默认 `bash -e`（无 pipefail）下退出码取 tee，
     再叠 `continue-on-error: true`，于是 `fail 1` 被报成 success；
     以及首条 `grep` 无匹配返回 1 会让 `bash -e` 直接中断读数步骤 —— 0 错误反而让读数步骤失败。

### 第三个洞：tests/ 不被任何类型尺子覆盖（读数已取，改动等你定）

包 `tsconfig.json` 的 `include` 只有 `src/**/*`，而 `node --test` 的类型擦除**不做类型检查**，
所以本轮测试文件自身的类型错误此前量不到。把它纳入类型检查的探针形态是
`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`（`include` 加 `tests/**/*`、`rootDir` 放到包根、
`allowImportingTsExtensions` —— 测试按 Node 24 要求写显式 `.ts` 说明符），再由 turbo 先建工作区依赖。
run 36468381368（head `d5acd53`）的读数：

- `TOTAL_TS_ERRORS=3`，**落在 `tests/` 的 = 3，落在 `src/` 的 = 0**，全是 `TS2339`：
  - `tests/env-config-timeout-zero.test.ts:28` 两处 —— 三元把两种形状并成 union 后，
    `node?.timeout` 与 `node?.maxConcurrency` 各自在另一支上不存在；
  - `tests/env-config.test.ts:40` 一处 —— `Property 'timeout' does not exist on type 'never'`。
    上一行已经断言 `config.network === undefined`，于是 `config.network?.timeout` 恒为 undefined：
    **这是一条形同虚设的断言**，tsc 报成类型错误，等于顺手抓到一条不证明任何东西的用例。
- 第一次量错了：用独立 tsconfig 跑裸 `tsc` 得到 `TOTAL_TS_ERRORS=328`，其中 158 条
  `TS2307 Cannot find module '@zcode/contracts'`、100 条连锁 `TS2339` ——
  裸 tsc 不先构建工作区依赖，量的是仪器而不是被测物。
- 这条改动会不会让 CI 变红：会，除非同时修掉那 3 处。修法是测试侧的两行改写
  （把 `node?.x` 的三元拆成各自对象上的访问；删掉那条恒真断言或改成断言 ConfigPort 未被写入），
  不动实现、不动构建配置以外的东西。

### 新闸门是否会咬（变异反向验证，已验）

作业绿不等于闸门有效，前面已经两次被自己的仪器骗到。所以在探针分支 `evolution/ci-probe`
的 head `972ef33` 注入一处落在 `include`（`src/**/*`）内的类型错误
（`adapters/src/config/env-config.adapter.ts` 里 `export const …: number = "deliberate-type-error"`）。
run 36469253096 的读数：**闸门会咬**——

- `PROBE CLI TypeCheck` 作业 failure，读数 `TOTAL_TS_ERRORS=1`、`1 error TS2322`、`FILES_WITH_ERRORS=1`；
- 同一错误也被 `Build` 作业抓到（Build failure，Test 因 needs 被 skip）⇒ 两道闸门都真的覆盖这个包；
- 由此前一条 `debt = 0` 的读数才可信：同一台仪器喂进 1 条错误就报 1 条。

顺带量到一个顺序性质：包的 typecheck 写成 `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`，
src 先失败时 `&&` 短路，`tests/` 那 3 条就不报了（这一轮读数里 `落在 tests/ 的=0`，
而上一轮 src 干净时报 3 条）。如果将来真要采纳这个形态，
建议改成 `; ` 串接或两条独立 turbo task，否则 src 一红就看不见 tests 的账。

该探针分支是丢弃用的，读数取完就连分支一起删，不带进交付分支。

### 本链验证范围声明（哪些真跑过，哪些跑不了）

本机（Windows，Node v24.13.0，裁剪检出无 `node_modules`）**实际执行**：

- `node --test`：`windows-code-page` 单文件 12/12；批形态与包内形态各 105/105；
- `node docs/evolution/verify.mjs` 连续 3 次同读数（全量树 `files=12 PASS=8 FAIL=0 WARN=4 105/109 fit=92`；
  裁剪树 `files=8 PASS=8 FAIL=0 WARN=0 105/105 fit=100`）；
- 变异反向证据：实现改回同步读取 ⇒ 该文件 12 例中 9 例变红；
  第一次变异（阻塞 40ms 但仍 await 真实子进程）**没有**变红 —— 说明"阻塞一会儿"不等于"同步实现"；
- JSON / tsconfig 可解析检查、`ci.yml` 的 tabs / U+FFFD / 残留 run id 检查（全部为 0）。

本机**未执行**，任何位置都不写成通过：`pnpm lint`、`pnpm typecheck`、
`pnpm --dir apps/zcode-cli typecheck`、`pnpm architecture:check`（无 oxlint/typescript/turbo 二进制，
根 `scripts/` 缺失）。Linux 侧行为一律由 GitHub Actions 日志读数证明，
本文件里每条 Linux 结论都附了对应的 run 与作业名。

## 落地情况（截至 CI 转绿）

| 已落提交 | 主题 | 对应本计划 |
| --- | --- | --- |
| `6c17124` | `perf(logging): 日志落盘改为有界异步批量，并保住 fail-open 半边` | C4 |
| `a94cf52` | `perf(exec): Windows 代码页解析移出事件循环` | C5 |
| `8dc082b` | `docs(specs): 记录 core 业务层直连 node:fs 的边界例外` | C6 |
| `bcc2bba` | `chore: 忽略本地进化快照目录` | C1 |
| `afb40aa` | `fix(config): 非法 ZCODE_* 数值不再静默降级，key→default 表收口为单一来源` | C3 **+ C7 合并** |
| `ab419db` | `fix(config): 文件侧补超时上界，别名改为主键优先且冲突必留痕` | C3 的后续裁决（D-C + 用户裁决别名口径） |
| `821128b` | `docs(evolution): 进化闭环的判据工具、五轮记录与主代理台账` | C2 |
| `61d7388` | `docs(evolution): 五轮谱系闭合与总结` | C8 |
| `01fc6f2` | `docs(evolution): 交付状态入册并校正聚合数字` | C8 的更正 |
| `32d407f` | `docs(evolution): 把会自毁的写死数字换成现算指令` | C8 的更正 |

C1–C8 全部落完，无待落项。全量底座那一侧另有 `61c3ede`（并入目标仓库 `main`）
与 `a82fc12`（修 `pnpm build` 抓出的 7 处类型错误），它们只存在于
`evolution/hermes-m1-m5-full`，不在本仓库历史上。

### CI 补洞链路的提交（本地 main ↔ 分支 cherry-pick）

两个改动各自独立提交，先经用户确认才推 `evolution/hermes-m1-m5-full`：

| 本地 main | 分支上 | 主题 |
| --- | --- | --- |
| `eaca16a` | `3686426` | `test(adapters): 为包内 8 个测试文件声明可被调用的 test 入口` |
| `d1d95f0` | `fc9ff9a` | `ci: 把 AGENTS.md 已写的 CLI typecheck 与测试入口接进作业` |
| `d56f2a1` | `0a3052a` | `test(windows-code-page): 非阻塞断言的前提改由测试自己保证（Linux CI 实测 fail 1）` |
| `2e5fce4` | `84cdc26` | `fix(ci): TypeCheck 作业改用实测可用的 --filter 形式` |
| `f9c5b81` | 待推 | `docs(ci): 作业注释只留可泛化的原因，读数搬回台账` |

说明：`d1d95f0` 接进去的 `--dir` 形式在 CI 上失败，故有 `2e5fce4` 一条修正；
两条都是同一处作业的不同形态，不合并成一个提交，保留"先接错、再由 CI 纠正"的顺序，
免得读史时以为一次就接对了。

合并偏离说明：计划里 C3（M1/M2/M4 的配置守卫与表收口）与 C7（M5 的 D-B 语义）是两个提交，
实际合成一个（`afb40aa`）。原因是三者都落在同两个文件里
（`env-config.adapter.ts` 既持有守卫又持有新的按序规则；`specs/runtime-env-config/spec.md` 同理），
按文件拆会让前一个提交导出 HEAD 里不存在的名字，按 hunk 拆需要交互式 `git add -p`（本环境不可用）。
代价已在该提交 body 里写明：审查者要一次读三处动机。
另：中文提交信息经 Git Bash heredoc 落盘后做过完整性检查——
`i18n.commitEncoding` 未设（默认 UTF-8），5 条信息中 `U+FFFD` 0 处、`????` 连串 0 处。

## 提交路径就绪性（实测）

- `.husky/` 目录不存在，`core.hooksPath` 未设置 → `prepare: husky` 从未在本 checkout 执行过，
  **没有 pre-commit 门禁**。因此 `pnpm verify:pre-push`（lint + architecture:check）不会自动跑，
  纪律只能靠人：每次 commit 前手动跑 `node docs/evolution/verify.mjs` 并把真实数字写进 commit body。
- `.git/hooks` 里只有两个**活动**钩子：`post-commit`、`post-checkout`，内容都是 Qoder 自身的 AI 代码追踪，
  带 `|| true` 且在提交之后运行 → 不会拦住提交，也不会改写暂存内容。不属于本任务范围，不动它们。
- `core.autocrlf=true` 且 `.gitattributes` 对 `*.mjs`/`*.sh` 强制 `eol=lf`：
  本轮新增的 `verify.mjs`/`tree.mjs`/`baseline.mjs` 会按 LF 入库（符合仓库注释里"避免 CRLF 破坏 shebang"的意图），
  `git status` 里出现的 "LF will be replaced by CRLF" 警告属正常换行归一，不是冲突。
- 远程与凭据状况见 `.hermess-snapshots/release-notes-local.md`（不入库）。
- **暂存前必须做一次根目录清扫**：只有 `.hermess-snapshots/` 被 gitignore，
  而子代理在做导出对账时会在仓库根写出 `.hermess-extract.mjs`、`.hermess-head-index.ts`、`.hermess-head-exports.txt`
  这类**未被忽略**的一次性脚本（实测 mtime 相差几十秒，属运行中产物）。
  规则：等对应代理结束 → 删净这些文件 → 再逐名 `git add`，全程不用 `git add -A`。
- 注意 `.gitignore` 里的规则是**根锚定**（`/.hermess-snapshots`），
  嵌套位置的同名目录**不会被忽略**：M3 审计代理就在 `adapters/` 下见过一份
  `head-index.ts` 快照产物（现已被其自行清除，实测 `ls` 不存在）。
  因此清扫要覆盖整树：`git status --untracked-files=all` 逐条看，而不是只看仓库根。
  已实测（23:39）当前未跟踪共 **35** 条，全部是本轮 intended 产物，无残留。
  不打算为此加宽 ignore：加一条全局 `**/.hermess-*` 会把将来真正要入库的同名产物一起吞掉。


## gen6 C 线：收口发布的本地准备（2026-09-28）

gen6 不新开战线。C 线在本轮只做**本地可完成**的部分；远端动作（推 GitHub / 合 main / 等 CI 绿）
需要网络，由用户在有网环境执行。本节是可复制的命令序列，不是已执行记录。

### 本地已备

- 谱系节点 `gen6-a` 已追加（`tree.mjs add`，不手改 `tree.txt`），`render` 后
  `nodes=12 frontier=[gen4-a, gen3-audit, gen5-b, gen6-a] stale=0`。
- `verify.mjs` 全量三态表：`files=10 PASS=10 FAIL=0 WARN=0 cases=119/119 notRun=0 fit=100`。
- 本地工作树干净（`git status --porcelain` 只剩 3 个与进化无关的本地文件：
  `ci_fail_screenshot.png`、`linux-job-web.html`、`remote-release.yml`，均为探针遗留，不入提交）。

### 跨历史合并路径（用户裁决点）

两条路（「跨历史」原文）：

1. **强推覆盖 main**（`git push --force origin main`）——丢目标仓 main 的既有历史
   （`c821398 Initial commit`），不可逆。
2. **跨历史合并**（`git merge --allow-unrelated-histories -X ours <full-base-branch>`）——
   保留 main 的 `c821398` 作为第二父，造一个跨历史合并提交，可 revert。

**gen6 推荐 2（跨历史合并）**：可回滚、语义已在 `evolution/hermes-m1-m5-full` 验证过、
不丢目标仓既有历史。强推仅当用户明确要「抹掉 main 历史」时才选。

### 命令序列（用户在有网环境执行）

```bash
# 前置：本地 main 已含本轮全部提交（含 099e09a gen6）
cd <ZCode-build>

# 1. 确认本地 main 与远端 main 的关系（无共同祖先是预期的）
git fetch origin main
git merge-base main origin/main   # 应输出空（无共同祖先）

# 2. 把本轮 main 的两个新提交（gen6 A 线 + C 线文档）重放到全量底座分支
#    本地全量分支 evolution/hermes-m1-m5-full 目前停在 828e861（= main 的 e7dab5a，
#    即 gen6 之前），需要把 099e09a / 030468e cherry-pick 过去并推远端：
git checkout evolution/hermes-m1-m5-full
git cherry-pick 099e09a 030468e
#    冲突处置：两份提交都只动 docs/evolution + specs + adapters/tests，全量底座上这些
#    文件与裁剪树一致（cherry-pick 重放时验证过），预期零冲突；README/LICENSE 不在这两提交里。
git push origin evolution/hermes-m1-m5-full
#    等该分支 CI 五作业全绿（远端证据，本地不冒充）
git checkout main

# 3. 跨历史合并（路径 2）：把全量底座分支合进 main
git merge --allow-unrelated-histories -X ours origin/evolution/hermes-m1-m5-full
#   合并冲突（-X ours 偏本地）按 release-plan 跨历史节处置；README/LICENSE 保留项目版本
#   注意：main 的 099e09a/030468e 与全量分支 cherry-pick 进来的同内容提交构成
#   "同一改动两条历史"，-X ours 会保留 main 侧文本；合并后 tree 等价，无行为差异

# 4. 推 main（非强推；是普通 push 新增一个跨历史合并提交）
git push origin main

# 5. 等 CI 五作业（Lint/TypeCheck/Architecture/Build/Test）跑完
#    每次推送 head 前移作废旧 run，看 PR 页面当前 check 列表为准
#    预期全 success（依据 head 84cdc26 的实测读数；CI 绿是远端证据，本地不冒充）

# 6. 清理本地探针工作树（.hermess-snapshots 下 wt-teeth/wt-full/wt-probe/blobs）
#    先确认无未提交有价值内容，再 rm -rf；blobs 是 git-snapshot 后镜像，可重建

# 4. 等 CI 五作业（Lint/TypeCheck/Architecture/Build/Test）跑完
#    每次推送 head 前移作废旧 run，看 PR 页面当前 check 列表为准
#    预期全 success（依据 head 84cdc26 的实测读数；CI 绿是远端证据，本地不冒充）

# 5. 清理本地探针工作树（.hermess-snapshots 下 wt-teeth/wt-full/wt-probe/blobs）
#    先确认无未提交有价值内容，再 rm -rf；blobs 是 git-snapshot 后镜像，可重建
```

### 边界声明（不注水）

- 本地**没有**执行过 `git merge` / `git push` / CI——本轮无网络。
- 上述命令序列是「待用户执行」，不是「已执行」；CI 绿是远端证据，缺证据不写成通过。
- `adapters/node_modules/zod` 不在 lockfile 内；全量底座 `pnpm install` 会以官方 node_modules 覆盖此目录，
  因此 C 线合 main 后 CI 的 Test 作业走的是全量 `pnpm install` 的 zod，不是本裁剪树手搓的这份——
  两条证据链分开记账。
