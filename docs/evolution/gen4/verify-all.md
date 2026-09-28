# gen4 · verify-all —— 独立复核（test-all，Hermes M4 并行汇聚轮）

复核者：`test-all`。日期：2026-09-28。立场：不采信任何一份 fix 报告，逐条从源码 + 执行重新推导。
本轮我只写这一个文件，未改动任何 src/spec/test，未执行任何 git 写命令。

## 0. 环境与尺子（先声明能测什么）

- 唯一可执行的尺子：`node --test`（Node v24.13 原生 type-stripping）。
- `pnpm lint` / `pnpm typecheck` / `architecture:check` **在本检出不可执行**（无 oxlint/tsc/vitest、无第三方依赖）。
  本报告任何一处"PASS"都**不**含 lint/typecheck 语义；导出面、类型对齐一律记为 WARN（见 §8）。

## 1. 仪器复跑（duty 1）—— PASS

```
$ node docs/evolution/verify.mjs
PASS pass=  8  tests/config-resolve-snapshot.test.ts
PASS pass= 21  tests/env-config.test.ts
PASS pass=  9  tests/logging-append-queue-options.test.ts
PASS pass= 18  tests/logging-append-queue.test.ts
PASS pass= 12  tests/windows-code-page.test.ts
SUMMARY files=5 PASS=5 FAIL=0 WARN=0 cases=68/68 fit=100

$ node docs/evolution/baseline.mjs diff pre-gen4
基线验证: SUMMARY files=2 PASS=2 FAIL=0 WARN=0 cases=39/39 fit=100
当前验证: files=5 PASS=5 FAIL=0 cases=68/68 fit=100
新增 11 / 改动 8 / 删除 0
```

diff 与实际主张的产出一致（`config/resolve-snapshot.ts`、`exec/windows-code-page.ts`、三个新测试文件、
`config/index.ts`/`outputEncoding.ts`/`node-execution-adapter-run.ts` 均在改动列）：**不存在"报告了工作但 diff 为零"**。
git 侧交叉验证（`git diff --numstat HEAD`）：`config/index.ts` +45/−172、`node-execution-adapter-run.ts` +2/−2、
`outputEncoding.ts` +59/−33。

## 2. 导出面守恒（duty 2）—— PASS，但**主张口径要改**

我用脚本解析两侧全部 `export function|const|class|interface|type|enum` + `export {…}` 块（含 `type` 前缀与 `as` 重命名）：

```
HEAD count=30   WORK count=34
LOST  (0): none
ADDED (4): parseEnvConfigWithDiagnostics, EnvConfigDiagnostic, EnvConfigInvalidReason, ParsedEnvConfig
```

**我主张的是**：跨整轮（HEAD → 工作区）没有任何导出丢失，新增恰好是 M2 为 ENV2-02 加的那 4 个 env 名字。
**fix-config 说的"导出面 34=34"我不能按 HEAD 复现**：HEAD 是 **pre-M1** 基线，不是 fix-config 那一步的 before
（M2/M3 在同一条未提交工作流里已把文件推到自己的形状）。所以"34=34"只能是它自己步内的读数，
用 HEAD 做朴素前后对比会把整轮的工作记到它头上。**M5 起，导出面断言必须写明基线是 HEAD 还是本步进入点。**

同类口径问题：`config/index.ts` 报"500→364"，我量到 **HEAD=491 → WORK=364（净 −127）**。364 对，500 不可复现。

## 3. skill/command 行为变更的调用面穷举（duty 3）—— 主张成立，但等级是"潜在"，不是"已验证无害"

`resolve-snapshot.ts` 让 `get("skill")`/`get("command")` 从「抛 `Config key not found`」变成返回 `{}`。逐条查谁看得见：

| 搜索面 | 命令 | 读数 |
| --- | --- | --- |
| `ConfigKey.Skill` / `ConfigKey.Command` | `grep -rn "ConfigKey\.Skill\|ConfigKey\.Command" packages/` | 7 命中，全在 `adapters/src/config/`（`SkillsEnabled` 等复合名）+ `resolve-snapshot.ts:72` 注释。**0 个外部调用方** |
| `.get("skill")` / `.get("command")` | 同上 | 2 命中，都在 `resolve-snapshot.ts:74` 注释里 |
| 引用 `ConfigKey` 的文件（要调 get(key) 就得引它） | `grep -rln "ConfigKey" --include=*.ts --include=*.tsx` | 7 个，其中 3 个是我的 scratch 副本；真实 4 个：`adapters/src/config/index.ts`、`resolve-snapshot.ts`、`contracts/src/config/index.ts`、`tests/config-resolve-snapshot.test.ts` |
| `configPort`（含 `.config.get(` / `appConfig.get(`） | `grep -rn "configPort" --include=*.ts --include=*.tsx` | **4 命中，全部在 `config-factory.ts`**（:60 字段声明、:260 创建、:263 返回、:264 `config: configPort.getAll()`） |
| 捕获抛错的路径 | `grep -rn "Config key not found"` | **0 命中**（连抛错文案本身都没有第二处引用） |

`bootstrap/` 与 `cli/` 确实有 9 个文件消费配置（`createConfig(`：`app/create-app.ts:154`、`auth-login.ts:380`、
`custom-commands.ts:74`、`plugins.ts:445/1025`、`sessions.ts:13/37`、`skills.ts:87`、`zcode-protocol/mcp.ts:36`、
`zcode-protocol/plugins.ts:138/597`、`zcode-protocol-entrypoint.ts:86/138`、`cli/src/tui-startup-locale.ts:27`），
但它们读的是 `ConfigResult.config`（= `getAll()` 的结果），**没有一个拿到 `configPort`**。
`getAll()` 的 `skill`/`command` 在改造前后都落在 `skillOverrides`/`commandOverrides`，形状未变（C6 断言 + 我核对 HEAD）。

**结论：CONFIRMED —— 没有任何调用方的错误路径依赖这条抛错**（不是 P1 FAIL）。
诚实的一半：这条变更在本检出**零观测者**，所以它是"契约变化 + 潜在风险"，不是"跑过没人受伤"。
真正被证明的是下面这条更强的性质（我原本担心有键从"有默认值"退化成"抛错"）：

```
HEAD getDefaultValue switch cases = 37，映射到 ConfigKey 值 37/37（0 未映射）
新 CONFIG_SNAPSHOT_KEYS = 39
REGRESSION（旧 get() 返回默认值、新表里没有 → 现在会抛）= 0
NEWLY-SERVED（旧 get() 抛错、现在返回默认值）= 2 → 恰好 ["skill","command"]
```

行为变化面被精确限定在这 2 个键上，**没有第 3 个键被顺带改掉**。这是本轮最干净的负面结果之一。

## 4. 单一来源主张（duty 4）—— 收口成立，但**表外还剩两个真值持有者**

`adapters/src/config/` 里 `?? ` 共 46 处（全量打印，未截断）。分类后：

- **纯回落点只剩 `resolve-snapshot.ts`**：`index.ts` 代码行内不再有 `?? DefaultConfig.x` / `?? true` / `?? "info"` / `?? "text"`（C7 静态用例强制，注释先剥离）。
  HEAD 侧对照：旧 `getAll()` 一个方法里就有 **31** 处 `??` 表达式 —— "三处站点"指三个位置，不是一行一个，实际收掉的是这 31 条逐字段回落。
- 无害的 `??`（结构/路径/日志，不是配置默认值）：`index.ts:88 sources ?? []`、`index.ts:224 events ?? previous.events`、
  `resolve-snapshot.ts:88 PATH_OVERRIDES[key] ?? key`、`file-config.adapter.ts` 的 baseDir/configFileName/filePath、
  `project-config.adapter.ts` 的 cwd/baseDir/discoveryOrder、`config-factory.ts` 的 plugins 可选映射与 loggerFactory。
  `index.ts:264 new ConfigStore(initial ?? DefaultConfig)` 是把**同一张表**整体当种子，不是第二份字面量 → 记为可接受。

**真残留在表外，且是本轮没动过的地方（M5 必收）：**

1. `env-config.adapter.ts:16 const DEFAULT_MAX_TOOL_CONCURRENCY = 10` —— 它在 `:168`、`:171` 被当**真实返回值**发出，
   与 contracts `DefaultRuntimeConfig.toolConcurrency.maxConcurrency`（C8 断言为 10）构成**同一数值的第二持有者**。
   文件 :14 的注释自己承认"同源"。表若漂移，`getAll()` 跟着表走、`getToolConcurrencyConfig()` 停在 10，**没有任何测试会红**。
2. `env-config.adapter.ts:22` 把 `180000` 写进诊断文案字符串（文本漂移，不会算错值，会撒谎）。
3. `schema.ts:351 server.enabled = server.enable === false ? false : (server.enabled ?? true)` —— `adapters/src/config/` 内
   唯一残存的硬编码布尔默认值，pre-existing，管的是 mcp.servers 内部形状，键表（`mcp.servers` 整对象）天然覆盖不到。

## 5. 漂移守卫的变异检验（duty 5）—— **不是仪式，抓得住脏**

`cp src/config/resolve-snapshot.ts .hermess-snapshots/mut/`，测试副本只改 import 路径与两处源码路径算术。
先在**未变异**的副本上确认脚手架本身可跑（防止把 ENOENT 当成"变异被抓"）：

```
CONTROL (pristine copy):  tests 8  pass 8  fail 0
MUTANT（装配点为 features.* 硬编码 true，即改造前的写法）:
✖ C2 装配形状逐键取自同一张表            AssertionError: 装配结果必须与逐键表来源一一对应
   actual features:{compact:true,…} vs expected features:{compact:"D<features.compact>",…}
✖ C3 漂移用例：翻转表里的默认值必须跟着表走   actual: true, expected: false
✖ C4 已存值优先（显式 0/false/空串）        actual: true, expected: false
→ 8 例中 3 例被杀（C2/C3/C4）；scratch 已删除（`.hermess-snapshots/` 不存在）
```

补一句读数：哨兵值设计有效 —— 变异体在生产默认表下取值相同（都是 true），**只有"注入表被绕过"这件事**能让它红，
所以它测的是"唯一回落路径"而不是"值对不对"。这正是 MAIN-03 想要的性质。

## 6. gen1 契约回归 + fail-open（duty 6）—— PASS（含一处新发现）

直接驱动 `parseEnvConfigWithDiagnostics`（该模块只有 `import type`，可加载），一次注入 `ZCODE_MAX_TOOL_CONCURRENCY` 与 `ZCODE_HTTP_TIMEOUT`：

| 输入 | 键缺席 |  typed reason |
| --- | --- | --- |
| `""` / `"  "` | ✓ | `empty` |
| `"30s"` / `"Infinity"` / `"NaN"` / `"1e999"` | ✓ | `invalid_number` |
| `"-5"` / `"0"` | ✓ | `not_positive` |
| `"45000"` | ✗（ honored） | 45000 生效 |
| `"  77  "` | ✗（honored） | 77 生效 |

10/10 符合 gen1 契约，**空串没有掉进 `Number("")===0` 的坑**（守卫在 `env-config.adapter.ts:181`）。

fail-open：8 个畸形输入探针里 7 个不抛（含 `null`、`{}`、缺键、`ZCODE_LOG_FORMAT: "bogus"` → 1 条 `unsupported_value` 诊断）。
**1 个抛错**：`{ ZCODE_MAX_TOOL_CONCURRENCY: {} }` → `TypeError: (value ?? "").trim is not a function`
（`env-config.adapter.ts:179` 的 `parsePositiveNumber`）。可达性：`process.env` 的值恒为字符串，
只有把非字符串塞进"声明为 `Record<string,string|undefined>`"的手工 env 才会触发 → 记 **P3/低危**，
但它确实证明"这条链不会抛"这句**说满了**（M5 加一行 `typeof value === "string"`）。

**新发现（本轮没人主张过）**：`ZCODE_HTTP_TIMEOUT=99999999999999999999` **不带任何诊断地被接受**为 1e20 ms。
gen1 挡 0 的理由正是"0 会让 `timeoutMs > 0` 判假、请求超时整条失效"；一个 1e20 的超时等效于同一后果，
却是这条守卫的上界盲区（`parsePositiveNumber` 只挡 `<= 0` 与非有限值）。

## 7. 400 行法条审计（duty 7）—— 1 条 open FAIL-against-law，但**归属要改**

本轮触碰/新建文件全量 `wc -l`（无抽样）：

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `adapters/tests/logging-append-queue.test.ts` | **447** | **open FAIL-against-law**，M5 硬性任务（18 例，拆两个文件、总数不许变）。**归属更正**：它在 `pre-gen4` 基线里（`baseline.mjs diff` 未把它列为新增/改动），`MAIN-04` 记的是 gen1-b 建、gen2-b 增到 447 —— **不是 M4 两个 fixer 造的**，简报里"本轮 CREATED 它"不成立 |
| `adapters/src/config/index.ts` | 364 | PASS（HEAD 491，−127；本轮修好的既有违规） |
| `adapters/src/config/resolve-snapshot.ts` | 162 | PASS（新建） |
| `adapters/src/exec/windows-code-page.ts` | 114 | PASS（新建） |
| `adapters/src/exec/outputEncoding.ts` | 294 | PASS（HEAD 268，+26） |
| `adapters/src/exec/node-execution-adapter-run.ts` | 399 | PASS，**净零**（`git diff --numstat` +2/−2）——但只剩 1 行余量 |
| `adapters/tests/config-resolve-snapshot.test.ts` | 331 | PASS |
| `adapters/tests/logging-append-queue-options.test.ts` | 309 | PASS |
| `adapters/tests/windows-code-page.test.ts` | 225 | PASS |
| `adapters/src/logging/append-queue.ts` / `logging/index.ts` | 399 / 398 | 合规但各剩 1–2 行（`logging/index.ts` 对 HEAD 已 +161/−12，随时越线） |

范围外的既有债（只记账，本轮未触碰）：`file-config.adapter.ts` 624、`schema.ts` 575、`config-factory.ts` 491。
整个 `adapters` 包 `>400` 行的 `.ts` 有 **32 个**（全量 `find | wc -l | awk` 清点）—— MAIN-04 的台账只覆盖 config 域，
M5 若要立"全包 400 行法"台账，起点是 32 不是 4。

## 8. fix-exec 侧逐条判定

| 主张 | 判定 | 证据 |
| --- | --- | --- |
| `outputEncoding.ts` 的 `execFileSync(chcp)` 已消失，只剩 `:215` 中文根因注释 | **PASS** | `grep -n "chcp\|execFileSync\|execSync\|child_process"` → `:1 import {execFile}`、`:13 WINDOWS_CHCP_ARGS`、`:214/215` 注释、`:268/271/274` 注释；无任何 `execFileSync`/`execSync` 调用点 |
| 决策链移入 `windows-code-page.ts`，`probe`/`encodingExists` 注入 | **PASS** | `:30 WindowsCodePageDeps`、`:33 probe: WindowsCodePageProbe`、`:34 encodingExists: EncodingExistsPredicate`、`:44 WindowsOutputEncodingDeps extends`、`:60/:70/:85/:102` 纯函数 + async 链；该文件除 `import type` 外零运行时依赖 |
| `resolveLegacyExecutionOutputEncoding` 变 async | **PASS** | `outputEncoding.ts:271 export async function`；唯一调用点 `node-execution-adapter-run.ts:69 await`（`:6` import） |
| 399 行、净零增长 | **PASS** | 见 §7 表 |
| `windows-code-page.test.ts` 12/12 | **PASS** | verify.mjs 实测 12/12（我未改判据） |
| 反向证据："同步版本会挂非阻塞断言" | **WARN-unverifiable（守卫本身可证）** | 我复现不了它的反事实过程；但守卫是真的：`S6` 用 `setImmediate` 顺序断言 `["tick","resolved:cp936"]`，另有一条跑真实 `execFile`+`chcp` 的不阻塞用例 |
| 反向证据："加了 env 指纹缓存会挂 no-cache 用例" | **WARN-unverifiable（守卫本身可证）** | `S4` 断言 `probe.calls === 2`（注释即"证明没有跨 run 缓存"）、`S5` 第二次返回不同代码页结果翻转、还有一条断言 env 每次重新读取。缓存化会挂在这里，但"作者真跑过一次加缓存"我无法证明 |
| 代码里"没有跨 run 缓存"（`:268` 注释） | **PASS（结构可证）** | 两个新文件内无模块级可变状态；每次 `resolveLegacyExecutionOutputEncoding` 都走 `options.codePageProbe ?? runChcpCommand` |

## 9. fix-config 侧逐条判定

| 主张 | 判定 | 证据 |
| --- | --- | --- |
| 三处重复收口到 `resolve-snapshot.ts`，`??` 只剩一处 | **PASS（范围：`index.ts` 的三条 key→默认值路径）** | §4/§5；HEAD `getAll()` 31 处 `??` → 现在表内一条 `resolveConfigValue` |
| `config/index.ts` 500→364 | **部分 FAIL（数字）** | HEAD=491；364 对，"500"不可复现（§2） |
| 导出面 34=34 | **口径 FAIL / 实质 PASS** | HEAD 30 → 工作区 34，LOST=0，ADDED=4 恰好 M2 的 env 名字（§2） |
| `config-resolve-snapshot.test.ts` 8/8、`logging-append-queue-options.test.ts` 9/9 | **PASS** | verify.mjs + 我在副本上独立跑出 8/8 |
| 变异体 M8(clampPositive)/M9(timer.unref)/M10(unshift FIFO) 被杀 | **PASS（守卫存在且被执行）** | `logging-append-queue-options.test.ts:232 U1` 以 `handle.unrefCalls >= 1` 计数（注释解释旧测试因空实现而观测不到 M9）；`append-queue.ts:205 this.timer.unref?.()` 在被测侧；O1–O6/A17 对应 clampPositive；A19 对应 `unshift` 顺序。9/9 实测通过 |
| spec §4 更正 flushSync 重复范围为"一批 in-flight，受 maxRecords/maxBytes 约束" | **PASS** | `specs/logging-persistence/spec.md:71`：重复量上界由批次上界承担（条数 `maxRecords` 默认 2000、体积 `maxBytes` 默认 1 MiB），不再是"一条" |
| `merge()` 故意不做表驱动 | **PASS（与 C7 不冲突）** | `index.ts:206/218` 把默认值委托给 `resolveConfigValue`/注入表，深合并语义保留，未新增第二条回落 |
| `get("skill")/get("command")` 返回 `{}` 且零调用方 | **PASS（潜在级）** | §3 穷举 + `REGRESSION=0`、`NEWLY-SERVED=2` |

## 10. M5 必办清单（只取我亲自量出来的）

1. **拆 `adapters/tests/logging-append-queue.test.ts`（447 > 400）**，18 例总数不变（MAIN-04 已定拆法）。唯一的 open 法条违规。
2. **杀掉 `toolConcurrency` 的第二持有者**：`env-config.adapter.ts:16/168/171` 的 `DEFAULT_MAX_TOOL_CONCURRENCY = 10` 必须与
   表同源（读表或在测试里断言等于 `documentedDefaultOf`），并把 `:22` 文案里的 `180000` 换成从表取的插值。
3. **`parsePositiveNumber` 加 `typeof value === "string"` 守卫**（`env-config.adapter.ts:179`），让"不抛错、不阻断启动"这句话变成事实。
4. **给超时加上界**：`ZCODE_HTTP_TIMEOUT=1e20` 现在无诊断被接受，与 gen1 挡 0 的理由同形；`clamp` + 新 reason。
5. **`schema.ts:351` 的 `?? true`** 要么入表要么在 spec 里写明"schema 归一化，不是配置默认值"，别让它继续冒充残留。
6. **台账与口径**：`main-findings.md` 的"500→364 / 34=34"按 HEAD 更正为 491→364、30→34（LOST 0）；
   447 行违规的归属从"M4 自造"更正为"gen2-b 遗留"；`>400` 全包计数 32 一并入台账。
7. **未跟踪面**：`resolve-snapshot.ts`、`windows-code-page.ts`、`append-queue.ts`、`append-queue-contract.ts`、
   整个 `adapters/tests/`、`docs/evolution/gen4/` 至今全是 `??`（未跟踪）。M5 收尾前必须 add，否则"验证过的工作"随时可被清掉。

## 11. WARN-unverifiable 汇总（本环境的天花板，不写成通过）

- `pnpm lint` / `pnpm typecheck` / `architecture:check` / `knip`：**不可执行**（工具链与依赖不在检出内）。类型层面的导出等价、未用导出、架构边界一律未验证。
- `ConfigPortImpl` 端到端（真 `getAll()`/`get()` 在真 contracts 默认表上的行为）：**无法加载**（`index.ts` value-import `@zcode/contracts` → `ERR_MODULE_NOT_FOUND`）。
  我用两段静态证据替代：§3 的 37/39 键映射差集 + §5 的 C7/副本实测；这不等于跑过类。
- fix-exec 两条反事实（加回同步 / 加缓存）：**它们说跑过，我只能证明守卫存在且现在为绿**。
- 代码注释里的性能数（本机 `chcp` 中位 37 ms、10 并发约 520 ms）：我没重测，按"上限读数"记录。
- 跨平台：本轮全部证据产自 Windows；`windows-code-page` 在 macOS/Linux 的退化路径只有测试里的"返回 null"断言，未在真机验证。

## 12. 一句话判决

**两个 fixer 的核心主张成立，没有编造产出**（68/68、diff 非零、变异体能被杀、行为变化精确锁在 2 个键、0 导出丢失）。
被夸大的只有三处口径：`500→364`、`34=34`、以及把 447 行违规记到 M4 头上；
真正被漏掉的风险是 `env-config.adapter.ts` 里那张表的**第二持有者**和 `1e20` 超时上界。下一轮按 §10 建。
