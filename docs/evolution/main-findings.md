# 主代理实测发现（不属于任何子代理工作包，交由 M4 处置）

## MAIN-01 · flushSync 在飞分组的重复范围被低报（实测与 spec/测试互相矛盾）

**测法**（脚本 `.hermess-snapshots/fuzz/f1-rescue.mjs`，确定性，非随机）：
注入可延迟的 io（`appendBatch` 内 await 外部掌握的 promise），序列固定为
`enqueue A0,A1,A2` → 让异步 drain 取走这 3 条进入在飞 → `enqueue B0,B1` → `flushSync()` → 再 resolve 异步 promise。

**读数**：
```
delivered = [A0,A1,A2,B0,B1, A0,A1,A2]   // 5 条全部落盘，无丢失
uniqCount = 5, deliveredCount = 8, dup = 3
stats: flushSyncRescuedRecords=3, writtenRecords=5, bufferedRecords=0, flushSyncRaces=1
```

**结论**：
1. F1 的"临终丢失整批"确实被修好了——**无缺失**（`缺失: []`）。
2. 但重复范围 = **整个在飞分组**（此处 3 条全重），不是 spec `specs/logging-persistence/spec.md:68` 写的"同一行会重复一次"。
   上限应是 `maxBytes`（默认 1MiB）/ `maxRecords`（默认 2000）的**一组**，不是 1 行。
3. 现有测试 `logging-append-queue.test.ts:262` 断言的是"flushSync 之后不该再有异步写落到本批"，
   它只覆盖**后续分组**被跳过，**不覆盖**已经交给 io 的那一组会在 resolve 后再落一次；
   这与作者自报的存活变异体 M10（await 前接管检查被 await 后检查吸收）是同一处的两个面。
4. 可达性分级（主代理自查后修正，此前我写错了）：`index.ts:393-395` 就是 `process.once("exit")` 的注册点本身，
   **不是**活进程路径；`logging/index.ts:88/:248-249` 把 `flushSync()` 作为工厂公开方法暴露，
   但全仓 grep 实测**零个生产调用方**（除测试外无人调用）。
   → 所以"活进程里 flushSync 造成整组重复"是**潜在**风险，不是当前活缺陷：**降级为 P2**。
   真正成立的是第 2 条：spec 把重复范围写成"同一行会重复一次"，实测为整个在飞分组（上限 `maxRecords=2000` / `maxBytes=1MiB`），
   属文档与实现不符：**P1**。exit 场景下重复不产生可见后果（进程即结束），所以危害面窄，但范围描述必须改对。

**M4 需要决定的取舍（据上面修正后的分级，别把 P2 当 P0 修）**：
- **必修（P1）**：`specs/logging-persistence/spec.md:68` 的重复范围描述改为"一个在飞分组，上限 `maxRecords`/`maxBytes`"，
  并保留原有取舍理由（重复可去重，临终证据不可恢复）。这是文档与实现不符，属仓库法明文项。
- **补测（P1，成本低）**：现有 A5 不覆盖"已交给 io 的那一组在 resolve 后仍会落一次"。
  新增用例按我的确定性测法（延迟 resolve 的注入 io）断言 `deliveredCount - uniq.size === 在飞分组大小` 且**无缺失**，
  把 M10 这个存活变异体钉住。
- **可不做（P2，仅在引入活调用方时才做）**：`flushSync({ rescue })` 拆分。当前 `factory.flushSync()` 零生产调用方，
  为不存在的路径加开关就是"为假想需求设计"，不做；改为在 spec 里写明"若要给业务路径暴露同步 flush，必须同时定义 rescue 语义"。
- 无论选哪种，**先改 spec:68 那句范围描述**（当前与实现不符，属成文事实错误，P1 级别仓库法：注释/文档与实现一致）。

**验收断言（M4 必须新写，不能靠现有 A5）**：用延迟 resolve 的注入 io 复现"在飞时调用 `flushSync()`"，
断言三件事：① 5 条记录**全部**到达 io（无缺失）；② `deliveredCount - uniq.size === 在飞分组大小`（把重复范围钉成可数的量，
而不是"最多一行"这种量不到的说法）；③ `flushSyncRescuedRecords` 与在飞分组条数一致。
不做"非 rescue 模式 dup===0"这条断言——因为按上面的修正，本轮**不引入** rescue 开关。

## MAIN-02 · T-C2 的代价被高估：本机实测 chcp 同步阻塞 ≈37ms，不是 ~1s

draft-predict 说 `execFileSync(chcp)` 在 `async run()` 里"冻结事件循环，并发 run 的 cancel/timeout 晚 ~1s 才被服务"。
其中 1s 是 `outputEncoding.ts:210` 的 `timeout: 1_000` **上限**，不是观测值。主代理在本机直接做了微测量
（`cmd.exe /d /s /c chcp`，看门狗定时器 30ms 判延迟）：

```
单次同步 chcp：40 / 39 / 37 / 32 / 37 ms → 中位 37ms
3 个异步 chcp 并发：合计 45ms
同步 2 次调用期间的事件循环延迟：39 / 47 / 41 / 82 / 42 ms → 中位 42ms
异步情形的事件循环延迟：0ms
```

推论（据实测，非拍脑袋）：
- 冻结是真的，但**量级是几十毫秒**；`MAX_TOOL_CONCURRENCY=10` 全并发时串行阻塞上界约 `10 × 37 ≈ 370ms`，
  这是**推导值**（用中位数乘并发数），本轮没有实测 10 并发场景，写清楚。
- 相对一次命令执行本身的耗时（Bash 工具跑真实命令），37ms 属噪声级；
  所以 T-C2 的性能理由应定为 **P2**，不是 P1。
- **不要因为"看起来是同步 IO"就升格**。真要动它，唯一低风险形态是"同一次 run 内只解析一次"（已经如此，见
  `node-execution-adapter-run.ts:68-73` 的 `onOutputEncodingResolved` 复用），跨 run 记忆化会引入代码页过期风险
  （`chcp` 反映**活动控制台**，用户可在会话中改 CP，env 快照不能代表它）——draft 这一点判断正确，要保留。
- 若 M4 仍要处理 T-C2，验收必须是：断言跨 run 缓存**必须**在控制台代码页变化后重新读取（模拟 CP 变化 → 再解析），
  否则宁可只做"异步化 + 每次 run 一次"，也不许上无失效条件的缓存。

## MAIN-03 · `getAll()` 的第二条回落路径：实测确认"今天一致"，所以是 P2 而非活缺陷

draft-predict 指出 `config/index.ts:283-289` 的 `features.*` 用字面量 `?? true`、`:321` 的 level 用 `?? "info"`，
而不是像其它键那样 `?? DefaultConfig.<path>`，构成"第二条容易漂移的回落路径"。
主代理实读 `contracts/src/config/index.ts:308-315` 与 `:339` 核对字面默认值：

```
features: { compact: true, rewind: true, subagent: true, memory: true, skill: true, mcp: true }
logging.level: "info"
```

→ 6 个 features 键与 level 的硬编码回落在**今天与 DefaultConfig 完全一致**，没有产生错误读数。
所以这是**漂移风险（P2）**，不是当前 bug；M4 若把它当 P1 去"修"就是过度处理。
值得做的只有一件低成本的事：让 `getAll()` 的这些键改用 `DefaultConfig.<path>`（一处改动、同一文件内、无调用链影响），
并加一条断言"每个键的 getAll() 结果 === get(key) 结果"防漂移。
若 M4 的容量不足，本项可推迟——它不改变任何当前行为。

## 主代理复核记录 · gen4-a（exec / windows-code-page）

用注入依赖直接驱动 `windows-code-page.ts`（非作者的测试文件），7 条全部成立：

| 检查 | 读数 |
| --- | --- |
| `parseActiveCodePage` | `"Active code page: 936."`→`"936"`；无数字→null；`""`→null |
| 65001 短路 | `codePageToEncoding("65001", () => false)` → `"utf8"`（不经 predicate） |
| 未知代码页 | `"9999"`→null；`"936"`（predicate 认）→`cp936` |
| **无跨 run 缓存** | 同一注入 probe 连解两次 → `probeCalls=2`，两次都返回 `cp936` |
| **代码页变化会被读到** | 第二次返回 `950.` → `r1=cp936, r2=cp950, flips=true` |
| **fail-open** | probe 抛 `spawn EACCES` → 不外抛，返回 `null` |
| **非阻塞** | 60ms 慢探针期间 `setImmediate` 先跑（`tickedBeforeResolve=true`，总等待 75ms） |

行法检查：`execFileSync` 在 `src/exec` 只剩 `outputEncoding.ts:215` 的中文根因注释，无代码调用；
`windows-code-page.ts` 114 行 / `outputEncoding.ts` 294 / `node-execution-adapter-run.ts` 399（净增 0）全部 ≤400。

我这次复核的自身缺陷（照实记）：第一次运行用 `head -40` 截断输出，把 fail-open 与非阻塞两条读数切掉了，
等于"看到的结果不全就下结论"；补跑后才拿到。M4 验证代理**不必重复**上表 7 条，
但必须补测我只到模块边界的部分：override 环境变量短路（`ZCODE_WINDOWS_OUTPUT_ENCODING`）与 locale 回落
都在 `outputEncoding.ts` 内，本环境因 `iconv-lite` 值导入不可加载 ⇒ 仍是 WARN-unverifiable，须由代码审查背书并写明。

## MAIN-04 · 400 行法条自查：本轮**修好一条、又弄出一条**

穷举 `wc -l` 于本轮触碰过的文件（不抽样）：

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `adapters/tests/logging-append-queue.test.ts` | **447** | **本轮自己造成的违规**：gen1-b 建（15 例）→ gen2-b 增到 18 例越线。M5 必须拆（按"基础队列语义"/"轮转与并发竞态"分文件，两文件各自 ≤400，用例总数不许变） |
| `adapters/src/config/index.ts` | 364（原 500） | **本轮修好的既有违规**（M4 fix-config 拆分） |
| `adapters/src/config/file-config.adapter.ts` | 624 | 既有违规，本轮未触碰 → 只记账 |
| `adapters/src/config/schema.ts` | 575 | 既有违规（文件内自带 eslint-disable 说明理由），本轮未触碰 → 只记账 |
| `adapters/src/config/config-factory.ts` | 491 | 既有违规；M2 的 ENV2-01 净增 +24，已在 gen2 报告 ENV2-04 记账未拆 |
| `logging/append-queue.ts` 399 / `exec/node-execution-adapter-run.ts` 399 / `logging/index.ts` 398 | ≤400 | 合规但只剩 1-2 行余量，加任何东西前必须先拆 |

纪律：既有违规不在本轮顺手修（会被动到无关调用面），但**本轮新增的违规必须本轮自己收掉**——
所以 447 那个是 M5 的硬性任务，不是建议。

## MAIN-05 · spec 与实现的归属一致性：抽查通过（干净负结果，别再追）

怀疑点：gen2-b 把 F6（"每进程一个队列"为假）列为"仅记录未修"，因此 `specs/logging-persistence/spec.md`
可能仍在主张一个假的所有权模型（文档与实现不符按判据属 P1）。

实测结论：**spec 已经被改对**，无需返工。
- `spec.md:24`：`LoggerFactory` 实例「**每个实例一个队列，不是每进程一个**」，并说明该实例持有唯一一个 `AppendQueue`；
- `spec.md:189`：保留了后果描述——多实例各持一个队列同时向同一个 `.jsonl` 追加，且 `process.once("exit")` 按工厂注册会累积监听器；
- `spec.md:75`：已按 MAIN-01 修正后的定级写明"活进程里整组重复"是**潜在**风险，唯一使用者是 exit 钩子。

配套计数（穷举，非抽样）：`createNodeLoggerFactory(` 全仓 5 处匹配，其中 1 处是定义本身
（`logging/index.ts:210`），真实创建点 4 处：`config-factory.ts:422`、`bootstrap/src/app/create-app.ts:165`、
`bootstrap/src/zcode-protocol-entrypoint.ts:98`、`cli/src/run.ts:490` —— 与 F6 记的"4 个创建点"一致；
4 个 exit 监听器低于 Node 默认 11 的上限，所以 F6 的 MaxListeners 说法是"再增加实例才会触发"的条件性风险，
不是当前缺陷。**判定：无缺陷，M5 不必复查此项。**

## MAIN-06 · M7 变异体：**已实测可达**，stage 2 的"被吸收"前提被读数推翻

stage 2 把 M7 记为"await 前的 inFlight 接管检查被 await 后的检查吸收"，据此**推迟**了它。
我实读 `append-queue.ts:222-263` 后认为该前提不成立，两条检查覆盖的是不同窗口：

- `:236` `this.inFlight = batch` 之后，第一个 await 是 `:238 io.ensureDir(this.dir)`；
- `:241`（**await 前**检查）覆盖的正是"接管发生在 `ensureDir` 这段 await 期间"这一窗口：
  此时 `flushSync()` 已把整批同步落盘并置 `inFlight = undefined`，`:241` 会 break，
  从而**不再**把 group 1 交给 `io.appendBatch`；
- `:243`（**await 后**检查）覆盖的是"接管发生在某个 group 的 `appendBatch` 期间"。
  删掉 `:241` 而保留 `:243` 的后果：group 1 会被 `flushSync` 与异步写各落一次 → **整组重复**，
  单分组场景同样成立（`:243` 的 break 只保护后续分组，救不了已发出的这次）。

→ 所以 M7 是可观测的，不是"本环境不可测"。**定案测试（M5-E 必须实做并出真实读数）**：
注入一个在 `ensureDir` 里挂起（不自动 resolve）的 io；触发异步 drain 后在挂起窗口内调用 `flushSync()`；
再 resolve。断言 `io.appendBatch` 对该批的调用次数为 0（只允许 sync 落盘），且 delivered 无重复。
然后删掉 `:241` 做变异，断言该用例必须 FAIL —— 若它不 FAIL，说明我的推导错了，
以读数为准把 M7 改回"不可观测"，并在 spec 记账。

我这条分析本身的边界：纯静态，没跑变异、没写用例。它只是把 E 的靶子从"要不要做"变成"怎么做"。

**实测读数（主代理已跑，2026-09-28）**：把 `append-queue.ts` 复制成 base 与"只删第 241 行"的 mutant
（删除点定位方式：`await this.io.ensureDir` 行与 `await this.io.appendBatch` 行之间的第一条
`if (this.inFlight !== batch) break;`，实测命中第 241 行），
用"在 `ensureDir` 内挂起、外部掌握 resolve"的注入 io 跑同一场景：

```
BASE    {"asyncBatchCalls":0,"syncBatchCalls":1,"delivered":[["sync","R0\nR1\n"]],"dup":0,"rescued":2,"written":2,"writeFailures":0}
MUTANT  {"asyncBatchCalls":1,"syncBatchCalls":1,"delivered":[["sync","R0\nR1\n"],["async","R0\nR1\n"]],"dup":2,"rescued":2,"written":2,"writeFailures":0}
verdict_M7_is_observable = true
```

场景脚本要点（M5-E 直接照此写成正式用例）：
1. `io.ensureDir` 返回一个由测试掌握的 pending promise；`schedule` 把回调收进数组；
2. 入队 `R0`,`R1` → 手动触发 drain 回调 → drain 卡在 `ensureDir`（此时 `inFlight = batch`）；
3. 挂起窗口内调用 `q.flushSync()`（走 `appendBatchSync`，`flushSyncRescuedRecords=2`）；
4. 释放 `ensureDir`，再跑 6 个 `setImmediate` 让异步路径走完；
5. 断言：`asyncBatchCalls === 0`、落盘行集无重复（`dup === 0`）、`rescued === 2`。
   删掉 `:241` 后同一断言必须 FAIL（实测 `asyncBatchCalls=1, dup=2`）。
   注意 mutant 里 `writeFailures` 仍是 0 —— 重复写不会被任何现有计数器发现，
   所以**只能用注入 sink 实收行数来判**，看队列自报计数会漏。

**M5-E 的结论**：M7 不再属于"不可观测"，必须补这条用例；`main-findings` 里 stage 2 记的
"await 前检查被 await 后检查吸收"这一句应视为**已推翻**。

## MAIN-07 · 我漏掉的一种失效：有限但超过 32-bit 的延时（test-all 提出，主代理实测确认）

`env-config.adapter.ts` 的守卫只查 `NaN/Infinity/非正`，实测全部放行且**零诊断**：
```
"2147483648" -> timeout 2147483648, diagnostics 0
"4294967296" -> timeout 4294967296, diagnostics 0
"99999999999999999999" -> timeout 100000000000000000000, diagnostics 0
```
后果我实测过：`setTimeout(fn, 1e20)` 打出
`TimeoutOverflowWarning: … does not fit into a 32-bit signed integer. Timeout duration was set to 1.`
→ **每个请求约 1ms 就超时**。这与 D1b（`Infinity`）是同一个终态，只是走的是"有限值"这条路，
而我在 `m1-adjudication-matrix.md` 里只测了 `Infinity` 没测"有限但 > 2^31-1"，
gen1 的 `finite` 守卫因此**不足以**挡住它——这是我判据的漏项，不是子代理的。
正确上界：Node 的 32-bit 有符号延时上限 `2_147_483_647 ms`（≈24.8 天），超过即应拒绝并出诊断。

## MAIN-08 · 非字符串 env 值会让守卫自己抛 TypeError（"永不打断启动"被说过）
实测 `parseEnvConfigWithDiagnostics({ZCODE_MAX_TOOL_CONCURRENCY: v})`：
```
{} / [] / 10 / true  -> THREW TypeError: (value ?? "").trim is not a function
null                 -> ok（被 ?? 吸收）
```
可达性如实定级：`process.env` 本身只放字符串，但 `config-factory.ts:192` 走的是**可注入的 `options.env`**
（宿主/桌面侧构造的对象），签名又只靠 TS 类型兜着 → 属"调用方违约即崩"。
判为 **P2**：当前无生产调用方传非字符串，但 spec 里"fail-open：非法输入不得打断启动"这句话被说过，
必须补 `typeof value !== "string"` 归入 invalid 分支，并把这句话改成与实际一致或补齐实现。

## MAIN-09 · 两处记账（draft-scan / test-all 实测，非推测）
- `env-config.adapter.ts:16 DEFAULT_MAX_TOOL_CONCURRENCY = 10` 是表值的**第二持有者**，目前无断言对它。
  注意修法有约束：该模块的全部价值在于只有 `import type`，因此**不许**改成 import 真实表
  （一改就变不可加载，gen1 的 21 条 env 用例全部退化成 WARN）。
  正确形态：保留字面量 + 加一条**源码扫描**断言（读 `contracts` 源文本比对 10/180000），漂移时红。
- `getAll()` 装配后 `plugins` 组的键**顺序**变了（`enabled` 提前），`JSON.stringify(getAll())` 字节会变（P3）；
  未穷举按字节比较的消费方，M5 若不改就在 spec 里写明"顺序不保证"。
- 我此前记录的数字要纠正：`config/index.ts` 在 HEAD 是 **491 行**（不是 500，stage 2 报错了口径），
  现在 364；导出面 HEAD 30 → 现 34，**丢失 0**，多出的 4 个正是 M2 ENV2-02 有意加的。
  447 行测试文件由 **gen1-b 创建、gen2-b 增到越线**（属本次闭环，M4 没造它，但仍归 M5 拆）。

## MAIN-10 · 二阶观察：`maxConcurrency` 没有上界，且 MAIN-07 的计时器上界**不适用**于它
实测 `parseEnvConfigWithDiagnostics`：
```
"1000000"    -> maxConcurrency 1000000,  diagnostics 0
"1e15"       -> maxConcurrency 1e15,    diagnostics 0
"2147483648" -> maxConcurrency 2147483648, diagnostics 0
"-0"         -> undefined,              diagnostics 1（not_positive）
```
含义：`createWorkflowRunSeatGate({limit: 1e15})` 等于**没有并发上界**，极端值下是多路同时执行的
资源耗尽风险，而不是 D1 那种"关掉安全边界"。它需要的是一条**运营上限**（比如按核数或固定 N 钳制），
而那个 N 属产品决定，不是 2^31 计时器上限的类比——所以 MAIN-07 的修法不许顺手套到这里。
本轮处置：只记账，不加钳制；`fix-db` 的边界里也没有这一项（它会保持 0 非法、正数照放）。
顺带记下刻意保留的不对称：`-0` 在 `maxConcurrency` 上非法，而按 D-B 落地后 `-0` 在 `network.timeout` 上
应等于"关闭"（`Number(-0) === 0` 且 `> 0` 为 false）。这条不对称要在 spec 里写明，
防止后来者"统一"成一套规则。

## MAIN-11 · 我的尺子有一条硬边界：NodeNext 的 `./x.js` **值**导入在类型擦除下必失败
实测（`import("./apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts")`）：
```
ERR_MODULE_NOT_FOUND: Cannot find module '...\exec\windows-code-page.js'
imported from ...\exec\outputEncoding.ts
```
两条被推翻的既有记录：
1. **"iconv-lite 未安装"是错的**：`node.require.resolve` 实测命中
   `adapters/node_modules/iconv-lite/lib/index.js`。M3 闭合审计的 duty-3 分类沿用了这个错判，我也抄进了台账。
2. **真正的机制**：仓库用 NodeNext 约定，相对导入一律写 `.js`（构建后 tsc 产出 `.js`），
   而 `node --test` 的类型擦除**不改写说明符**，盘上只有 `.ts` ⇒ 任何"被 `.js` 相对路径值导入"的模块都装不起来。

推论（对所有轮次都成立，不是本轮新现象）：
- 能加载的模块（`append-queue.ts`、`resolve-snapshot.ts`、`env-config.adapter.ts`、`windows-code-page.ts`）
  共同点是：它们对外部的相对导入全是 `import type`（被整句擦除），或干脆没有相对值导入。
- `outputEncoding.ts` 因为**值**导入 `windows-code-page.js`，在源码里加了那一行之后就永久不可加载了——
  也就是说 fix-exec 把逻辑抽出去的动作，顺带把它自己的宿主模块变成了 review-only。
  它自己申报过 WARN，方向和结论对，**理由当时是错的**（它说 iconv-lite）。
- 想在 `node --test` 下测这类缝，唯一形态是：被测逻辑所在的新模块保持零相对值导入，
  测试直接 import 那个新模块（这就是 gen1-b/gen4-a 的 12/12 能跑起来的原因）。
  不要为了"能跑"去把 `.js` 改回 `.ts`——那会破坏真实构建。

## MAIN-12 · fail-open 半边实测通过（含最坏的一条逃逸猜想）

猜想：`kick()` 里是 `void this.drain()`（`append-queue.ts:203`），
所以一旦异常穿出 `drain()`，`void` 并不吞异常 ⇒ 会变成 **unhandledRejection**（Node 默认 mode=throw，进程会死）。
最可能的注入点就是自我上报：`index.ts:358` 那条 `queue.enqueue(...)` 不在 try 里，
而 `reportSelf` 又同时被入队路径和写失败路径调用。

实做（注入 io：`ensureDir`/`appendBatch`/`ensureDirSync`/`appendBatchSync` 全抛，
`selfReport` 也抛，`maxConsecutiveFailures=2`、`selfReportIntervalMs=0`，手动驱动 6 轮定时器 + 入队 + `flushSync()`）：
```
{"selfReportCalls":2,"seen":[],"stats":{"writeFailures":2,"selfReports":2}}
```
`seen` 里同时挂了 `unhandledRejection`、`uncaughtException`、定时器同步抛出、`flushSync` 抛出四个探针，**全部为空**。

机制核对：`append-queue.ts:349-353` 的 `reportSelf` 把 `this.io.selfReport?.(...)` 包在 try 里，
中文注释"上报失败不能影响日志链路本身"——所以猜想被实现挡住了，不是巧合。
另核对 `index.ts:167-176`：`enqueue` + `kickNow` 也在 try 内（原 gen1 的 fail-open 半边保住了）；
`:358` 那条裸 `queue.enqueue` 之所以安全，是因为它的调用链最终落在上述两处 try 之内。

**结论：无缺陷。** 但这条要留着，因为它给出了后续代理的硬要求：
以后任何"在 drain/exit 路径上新增会抛的调用"都必须同时落在这两处 try 之内，
否则 `void this.drain()` 会把它变成进程级异常。M5 复核不许重复我这次实验，直接引用读数即可。

## 边界提醒（写给 M4，别撞墙）
- `append-queue.ts` 现 **399 行**、`index.ts` 现 **398 行**：加新逻辑前必须先拆（400 行是成文法）。
- 主代理持有的判据文件不许改：`verify.mjs` / `tree.mjs` / `baseline.mjs` / `review-checklist.md` /
  `m1-adjudication-matrix.md` / `scope-pool.md` / 本文件由主代理追加。
