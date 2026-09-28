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

### 已知偏离「一个功能一个提交」的一处，及原因

C3 把两件事放进一个提交：M1/M2 的 env 数值守卫，与 M4 的 key→default 表收口。
原因是两者都落在 `config/index.ts` 同一文件里（守卫需要桶导出 `parseEnvConfigWithDiagnostics`，
收口把同文件从 500 行减到 364 行），按文件拆提交会让前一个提交自身缺少可导入的出口，
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
入库部分只保留两条事实性结论：

1. 本 checkout 不含根 `packages/`、`scripts/`（`git ls-files` 实测 0 条），
   而 `.github/workflows/ci.yml` 的 typecheck/lint/architecture/build 指向它们 →
   推送后 CI 会出现**结构性红灯**，与本次改动无关。
2. 本轮真实可执行证据只有 `node --test`（`node docs/evolution/verify.mjs` 的三态表）。
   `pnpm lint` / `pnpm typecheck` 在本环境无法执行，任何提交信息都不得声称它们通过。

## 落地情况（截至 M5 两腿审查中）

| 已落提交 | 主题 | 对应本计划 |
| --- | --- | --- |
| `6c17124` | `perf(logging): 日志落盘改为有界异步批量，并保住 fail-open 半边` | C4 |
| `a94cf52` | `perf(exec): Windows 代码页解析移出事件循环` | C5 |
| `8dc082b` | `docs(specs): 记录 core 业务层直连 node:fs 的边界例外` | C6 |
| `bcc2bba` | `chore: 忽略本地进化快照目录` | C1 |
| `afb40aa` | `fix(config): 非法 ZCODE_* 数值不再静默降级，key→default 表收口为单一来源` | C3 **+ C7 合并** |

待落：C2（判据与工具）、C8（谱系闭合与总结）。

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
