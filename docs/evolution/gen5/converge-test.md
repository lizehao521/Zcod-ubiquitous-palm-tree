# Gen5 · meta fusion — converge-test（测量腿终审账）

日期：2026-09-29。执行者：test 腿（只测量，不改源/测试/仪器）。仓库：`C:\Users\Admin\Desktop\ZCode-build`。

## 1. 可重复性（oracle 三连跑）

`node docs/evolution/verify.mjs` 连跑 3 次，SUMMARY 行逐字如下，三次完全一致：

```
SUMMARY files=7 PASS=7 FAIL=0 WARN=0 cases=99/99 notRun=0 fit=100
SUMMARY files=7 PASS=7 FAIL=0 WARN=0 cases=99/99 notRun=0 fit=100
SUMMARY files=7 PASS=7 FAIL=0 WARN=0 cases=99/99 notRun=0 fit=100
```

三次 exit=0，逐文件 pass 数逐行一致（8/30/21/9/7/12/12）。结论：套件稳定，非单次侥幸。

## 2. skip/todo 门禁真实咬合（金丝雀）

- 建金丝雀 `adapters/tests/hermess-canary.test.ts`（1 例真跑 + 1 例 `test.skip`），oracle 读数：
  `WARN pass= 1 fail= 0 skip=1 todo=0 exit=0  ...hermess-canary.test.ts`
  `SUMMARY files=8 PASS=7 FAIL=0 WARN=1 cases=100/100 notRun=1 fit=100`，**进程 exit=1**。
  注意假象被正确拦下：cases 分母不含 skip，聚合仍是 100/100/fit=100，仅靠 notRun+WARN+exit≠0 才变红——门禁按设计生效。
- 删除金丝雀后复测：`SUMMARY files=7 ... notRun=0 fit=100`，exit=0；`ls` 确认文件不存在；收尾时 `git status` 无任何 canary 残留。

## 3. 变更真实发生（baseline diff）

`node docs/evolution/baseline.mjs diff pre-gen4`：新增 19、改动 13、**删除 0**。清单覆盖四个工作包：config（env-config.adapter/schema/index/resolve-snapshot + runtime-env-config spec）、exec（windows-code-page + outputEncoding/node-execution-adapter-run + spec）、logging（3 个队列测试文件 + logging-persistence spec）、core-fs-boundary spec，以及 gen3/gen4/gen5 报告与 summary/user-decisions。基线自身验证 2 文件/39 例 → 当前 7 文件/99 例。
对账说明（不是矛盾）：`config-factory.ts`、`append-queue.ts` 等在 pre-gen4 快照之前就已在工作树中成型，故不出现在 diff，但确实属于本轮提交（afb40aa/6c17124）。diff 的"改动"列表是快照相对量，不等于本轮全部足迹——全部足迹以下表（并集自 5 个提交）为准。

## 4. 提交↔工作树完整性

`git status --short` 仅 15 条 `??`（全部是 docs/evolution 闭合文档与仪器），tracked 修改 0，`git diff HEAD` 为空 ⇒ **5 个提交的内容与工作树逐字节一致**。5 提交：

| sha | 主题 | 文件数 | 检查 |
| --- | --- | --- | --- |
| afb40aa | fix(config) env 非法值不静默 | 13（src×5、tests×3、gen1/2/4/5 报告×4、spec×1） | 与主题一致 |
| bcc2bba | chore .gitignore +1（.hermess-snapshots） | 1 | 一致 |
| 8dc082b | docs(core-fs-boundary spec) | 1 | 一致 |
| a94cf52 | perf(exec) code page | 6（src×3、test、报告、spec） | 一致 |
| 6c17124 | perf(logging) 有界异步批量 | 10（src×3、tests×3、报告×3、spec） | 一致 |

无意外文件混入；无 staged 未提交项。**需主代理决策**：`verify.mjs/baseline.mjs/tree.mjs/tree.json/tree.txt` 是本轮仪器而非"闭合文档"，目前全部未跟踪——若推送后 CI/后续轮次要复用尺子，它们（或其子集）应随闭合文档一起入库，否则 oracle 只存在于本机。

## 5. 行数律（≤400）

本轮创建/修改的全部足迹（提交并集实测 `wc -l`）：

resolve-snapshot.ts 162 / windows-code-page.ts 114 / append-queue-contract.ts 64（新）；config-resolve-snapshot.test.ts 331 / env-config-timeout-zero.test.ts 271 / windows-code-page.test.ts 225 / logging-append-queue-options.test.ts 309 / logging-append-queue-rotation.test.ts 347 / append-queue.ts 399 / env-config.test.ts 237 / logging-append-queue.test.ts 345（改）；env-config.adapter.ts 295 / config/index.ts 364（491→364）/ schema.ts **580** / config-factory.ts **491** / node-execution-adapter-run.ts 399 / outputEncoding.ts 294 / logging/index.ts 398；specs：core-fs-boundary 51 / windows-code-page 115 / logging-persistence 253 / runtime-env-config 362。

违规判定：**本轮新增违规 0**。schema.ts 与 config-factory.ts >400 但均为既有违规（实测 pre-run `git show afb40aa^`：575→580、466→491），本轮只使其小幅增长，未由本轮首次越线。399/398 的三个文件贴线合规。
既有 >400 且本轮未触碰的存量账：全库（排除 node_modules/dist，ts+mjs）共 155 个 >400 文件，除上述 2 个被触碰者外 **153 个为未触碰存量**，top 摘录（完整清单见下节折叠）：bootstrap/src/zcode-protocol-v4/product-projection.ts 5477、bootstrap/src/zcode-protocol/server-operations.ts 4057、v4-gateway.ts 3454、adapters/src/plugins/marketplace.ts 2724、core/src/subagent/runner.ts 2142、adapters/src/mcp/index.ts 1950、v4-bridge.ts 1912、adapters/src/fs/index.ts 1878、telemetry/src/agent-trace-runtime.ts 1674、adapters/src/model/runner-stream.ts 1655，其余 143 个介于 402–1530 行（adapters/src/config/file-config.adapter.ts 624 亦在列，本轮未动）。

<details>153 项完整清单（wc -l，降序）已由测量腿在收尾会话逐行打印，全部为本轮未触碰存量；关键相邻项：contracts/src/config/index.ts 410、adapters/src/config/file-config.adapter.ts 624、adapters/src/storage/index.ts 498。</details>

## 6. 变异抽测（最新守卫：有序 env 判据）

在 `.hermess-snapshots/mut/` 镜像树复制 `env-config.adapter.ts`，删除第 108–110 步"空串先于 0 判"的行（`if (trimmed.length === 0) return {ok:false,reason:"empty"}`；复制体残留 0 处），真文件未动（收尾 grep 确认守卫在）。测试副本路径深度与原位一致，import 与源码扫描断言原样可跑。

- 对照（真套件）：`# tests 30 pass 30 fail 0`。
- 变异体：`# tests 30 pass 26 **fail 4** skipped 0 todo 0`。变红用例：`D-B 有序判据：每一步一条 case（短路顺序即契约）`、`顺序不可交换：D-B 记录的决定性陷阱`、`MAIN-08：非字符串 env 值不得抛错`（3 个顶层 not ok，含 4 个子断言失败）。
- 语义确认：删掉该步后 `Number("")===0` 短路放行空串 ⇒ 正是原 D1 bug 的重演路径，套件必红。**守卫被真实测试锁定**。scratch 已删（`NO_MUT_LEFT`），未污染 oracle（verify.mjs SKIP_DIRS 本就跳过 `.hermess-snapshots`）。

## 7. 守恒式独立对账（TAP 自sum vs oracle）

逐文件 `node --test --test-reporter=tap` 自取：8+30+21+9+7+12+12 = **99**，与 oracle `cases=99/99` 一致；7 个文件各自 TAP 尾行 `skipped=0 todo=0 cancelled=0 fail=0` 全部成立。两个独立来源同数，聚合可信。

## 8. 未验证边界总账（tree.json 10 节点，24 条原始申报）

按字面 dedup 后 24 条唯一，但存在同义重复，归并后 ~19 项，分类：

**(a) 结构性、永久审查-only**
1. SIGKILL/断电窗口不可自证（1×）。

**(b) 需工具链/依赖，未来轮可闭**
2. ConfigPort.getAll()/回落 180000/10 消费端（2×，@zcode/contracts 值导入）。
3. 桶导出运行时可见性 + 6 个被改接消费者不可加载（2×，@zcode/* 未链；含"53 星桶上 export* 展开器失效⇒44 候选未判"）。
4. schema.ts 不可加载（zod 未装）⇒ `.nonnegative()` 无执行断言（1×，文件路径上界归审查腿）。
5. http/index.ts 运行期分支（proxy-agent 缺失）（1×）。
6. `0` 的端到端 getAll()→http/index.ts:79（1×）。
7. logging/index.ts↔queue 装配（3 条同义：enum 值导入/contracts 未链）（3×）。
8. config/index.ts 不可加载⇒装配靠纯模块+源码扫描（1×）。
9. @zcode/shared 子路径不可解析（1×）。
10. process.exit flushSync 钩子实跑、createConfig() 端到端 warn（2×）。

**(c) 现在伸手就能闭（无人费那个劲，直说）**
11. **"iconv-lite 未安装"这条申报是错的**：实测 `adapters/node_modules/iconv-lite` 存在。iconv-lite 真实解码集合（1×）+ outputEncoding"只能静态"（1×）→ 现在就能写执行测试，两条作废申报应改写。
12. 变异体 M7–M10 存活（clampPositive/unref/unshift 顺序/await 前接管检查 4 守卫无测试）（1×）→ 与本轮 mutate 手法相同，纯 node --test 可闭。
13. 真盘/跨平台 E2E（2×）、中文输出命令 E2E（1×）、cmd.exe 尾延迟与 10 并发改善幅度（1×）：本机 Windows 即可 spawn 子进程验证语义（幅度类留 benchmark）。
14. await 后新取消窗口仅靠既有 stoppedBeforeSpawn（1×）→ 注入式假 timer 可闭。
15. auth-login"关闭时留 warn"（1×）→ bootstrap/ 在本 checkout 存在，可测，只是越出本轮射程。

(c) 合计 10 条申报现在就可闭，其中 2 条（iconv-lite）是**过期事实**，若原样入库会成为账目污点，建议主代理在闭合文档前改写。

## 9. 不一致清单（原样上报）

- tree.json 两条 iconv-lite 申报与实测矛盾（见 8-c11）。
- baseline diff 足迹 ≠ 提交足迹全集（快照时点差，见 3；非缺陷，记账防误读）。
- 仪器 verify.mjs/baseline.mjs/tree.* 未入库（见 4），"只差闭合文档"的说法只对报告类文档成立。
- 除上述外，全部测量与本腿简报预期（7/99/notRun=0/fit=100/10 节点）吻合。
