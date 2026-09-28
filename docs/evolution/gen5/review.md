# gen5 · review（交叉审查腿）

角色：Hermes M5 meta fusion 的 review 腿。只读 + 执行探针，唯一产出本文件。
所有读数来自本腿实测或源码直读；凡未执行的都标 WARN，不写成 PASS。

## 0. 仪器与台账基线（本腿实跑）

- `node docs/evolution/verify.mjs` → `files=7 PASS=7 FAIL=0 WARN=0 cases=99/99 notRun=0 fit=100`
  逐文件：config-resolve-snapshot 8 / env-config-timeout-zero 30 / env-config 21 /
  logging-append-queue-options 9 / logging-append-queue-rotation 7 / logging-append-queue 12 / windows-code-page 12。
- `node docs/evolution/baseline.mjs diff pre-gen4` → `改动 8 / 删除 0`，`基线 39/39` vs `当前 99/99`。
- 工作区：`git status --porcelain` 只有 `docs/evolution/**` 未跟踪（gen5 三份报告中
  `fix-db-report.md`/`fix-tests-report.md` 已随 afb40aa/6c17124 入库，`draft-scan.md` 未跟踪）⇒ 无未提交的代码/测试改动。
- fix-tests 报告里的 `98/98` 是并发写手未完时的实时读数，非缺陷；终态 99/99。

## 1. Duty 1 — 两处手写合法性判据：**不共享谓词、不共享常量，文件门仍无天花板**（P1-drift，成立）

两处规则的实际形态：

| 门 | 判据 | 0 | > 2^31-1 | 同一常量？ |
| --- | --- | --- | --- | --- |
| env | `env-config.adapter.ts:101-125` 步 5（`:116-120`）+ 步 6（`:123`），常量 `MAX_TIMER_DELAY_MS`（`:33`） | 放行（`allowZero:true`） | **拒** `too_large` | — |
| 文件 | `schema.ts:13` `nonNegativeFiniteNumberSchema = z.number().finite().nonnegative()`，仅 `:35` 的 `timeout` 使用 | 放行 | **无 `.max()`，放行** | 否 |

`grep -rn MAX_TIMER_DELAY_MS` 全仓命中 1 个声明（`:33`）+ 1 个消费者（`:41` NETWORK_TIMEOUT_RULE）+ 测试；
`schema.ts` 不 import 它（`schema.ts` 只有 `zod` 与 `import type @zcode/contracts`）。⇒ **两条手写规则，零共享**。

**决定性分歧输入（同一值、两个门、两种结局）：`network.timeout = 1e20`**

- env 门：实测 `parseEnvConfigWithDiagnostics({ZCODE_HTTP_TIMEOUT:"1e20"})` →
  `network` 整体缺席 + 1 条 `too_large` 诊断 ⇒ 回落 180000，安全边界保住。
- 文件门：`schema.ts:396` `ZCodeConfigFileSchema.parse(normalized)` 对 `1e20` **通过**（有限、非负）
  → `config/index.ts:128-129`（判据 `!== undefined`）写入 store → `getAll()` 原样透出
  → `create-app.ts:413` / `script-workflow-child-runtime.ts:213` / `workflow-facade.ts:319` / `auth-login.ts:386`
  → `http/index.ts:58` `timeoutMs = … ?? this.options.timeoutMs …` → `http/index.ts:79-83`
  `if (timeoutMs > 0) setTimeout(…, timeoutMs)` —— **发射点无任何钳制**。
- 本腿在 Node 上直接复现终态：
  `TimeoutOverflowWarning: 100000000000000000000 does not fit into a 32-bit signed integer. Timeout duration was set to 1.`
  → `FIRED after 5ms (asked 1e20)`。即"配了个大超时"= 每个请求约 1ms 就 abort，
  **MAIN-07 的终态从文件这扇门原封不动地进得来**（`2147483648` 同理）。

定级：**P1**（同一字段两套手写规则 + 一个可达输入上可证伪的分歧；正是本轮自认的 D1 根因形态）。
文档并非隐瞒：`spec.md:63-65`（§3）明写"它只在 env 侧拦，文件侧未加 `.max()`"并给出依赖方向理由与后续项。
但 `spec.md:310`（§12.2）把守卫写成 **无限定** 的一句"`> MAX_TIMER_DELAY_MS` 的有限值新增被拒"，
而它所在小节的 `:307` 刚说过"env 与文件两条路都能合法写入 0" ⇒ 读者会理解成两扇门都拦。
**文档比实现强** = checklist 里的 P1 类别。两条必须一起改（收窄句子或补 `.max()`），不许并存。

第三条门（本轮范围外，记账）：`ConfigPortImpl.set()` / `merge()` 无校验（`spec.md:311-312` 自认），
所以只给 schema 加 `.max()` 也仍是"两条规则 + 一个裸入口"。真正的单点是
把 `MAX_TIMER_DELAY_MS` 落进 `contracts`，env 与文件共读同一个常量。
注意 `schema.ts` 本环境不可加载（value import `zod`），文件门的断言只能做成 MAIN-09 那种源码扫描断言。

## 2. Duty 2 — `1e-999` 下溢成 0：**已成文、且有断言**（PASS，附 P3 引用错位）

- 成文：`spec.md:108-109`（§4.1 第三条边界）逐字列出"`1e-999` 下溢成 `0` 同样落为'关闭'"，
  并与 `-0`/`00`/`0x0`/`" 0"`/`0e0`/`0.0` 同批归入"按值判定，不看字面语法"。
- 有测试：`env-config-timeout-zero.test.ts:144-149`（用例名「下溢成 0 的极正值（1e-999）按第 4 步落为「关闭」…」），
  同时断言并发键对同输入是 `zero_not_allowed`。
- 本腿实驱：`{ZCODE_HTTP_TIMEOUT:"1e-999"}` → `timeout = 0`、诊断 0 条 ⇒ 与文档一致。
- P3（不升格）：该用例注释引用"spec §9"，而表态实际写在 §4.1:108；§9 只谈 0 的裁决。
  序号也用测试侧的"第 4 步"，`spec.md:116-118` 已给对照表，属可追踪但指错章节。
- 判断：D1 形状（打字错的科学计数法静默关掉保护）成立，但没人写 `1e-999`，
  且已成文 + 已钉例 ⇒ **保持现状即可**，别再动判据（动它就动了裁决）。

## 3. Duty 3 — fail-open 完整性（本腿直驱 26 组 env + 9 次直读，抛错 0 次）

| 注入 | 结果 |
| --- | --- |
| `ZCODE_LOG_FORMAT` = `{}` / `[1]` / `10` / `true` / `null` / 函数 / `Symbol` | 不抛；1 条 `non_string_value`；`logging` 整体缺席（`value` 渲染 `object`/`array`/`10`/`true`/`null`/`()=>{}`/`Symbol(s)`）⇒ **fix-db §2 该行成立** |
| `ZCODE_MAX_TOOL_CONCURRENCY` = `10` / `{}` / `true` | 不抛；`non_string_value` 诊断 + 缺席 |
| `getToolConcurrencyConfig()` 注入 `10` / `{}` / `true` / `Symbol` / `null` / `"0"` | 全部返回 `10`，不抛 ⇒ **与 fix-db 行 44 一致**；`{}`/`[]` 不再抛 |
| `ZCODE_STORAGE_DIR` = `{a:1}`、`ZCODE_SESSION_DB` = `null`、`ZCODE_HTTP_PROXY` = `{}`、`ZCODE_NO_PROXY` = `7`、`ZCODE_AGENT_CA_CERT` = `[1]` | 不抛、**零诊断**，非字符串**原样写进 patch**（`storage.dir = {"a":1}`） |
| 混合 `{HTTP_TIMEOUT:"45000", LOG_FORMAT:{}, MAX_TOOL_CONCURRENCY:[7]}` | 不抛；合法值保留 + 2 条类型化诊断 |

结论：**"不抛"这条承诺在射程内成立**，且 `spec.md:334-335`（§13.1 残留射程）如实登记了字符串透传键无类型守卫。
需要写手知道的边界：`storage.dir` 是**下游要拿去 `path.join` 的值**（§5.2 指出 `resolveWorkspaceStorageDir()`
就吃这些字符串键），所以"本层不抛"≠"链路不抛"；§6:154 那句"调用方只读返回值就能继续"只对数值键成立。
非缺陷（spec 已声明不改），但**别在任何文档里把它写成"全部 ZCODE_\* 都有类型守卫"**。
`null` 的不对称是刻意的且有文：数值键 → `empty`（`:105` 排除 null + `?? ""`），LOG_FORMAT → `non_string_value`
（`:181` 显式判 null）；§4 表格行 81 + §13.1:333 分别覆盖。

## 4. Duty 4 — spec ↔ 实现/测试 审计

**runtime-env-config/spec.md**

| 断言 | 判定 | 证据 |
| --- | --- | --- |
| §9.1「穷举为 4 处 consumer」 | **PASS** | 四个 file:line 逐个核对为真：`create-app.ts:413`、`script-workflow-child-runtime.ts:213`、`workflow-facade.ts:319`、`auth-login.ts:386`；排除项 `product-projection.ts:364,382` 确为字符串 `fault.network.timeout` |
| §12.1 按 draft-scan 收窄 | **PASS** | `spec.md:294-298` 新增「措辞收窄（M5 draft-scan 的更正）」，与 draft-scan §2 的"System 层已播种 ⇒ 生产端口不可达"一致；draft-scan §2 结尾"是否收窄交写手定案"已落地 |
| §12:285-286 静态校验清单 | **PASS** | `config-resolve-snapshot.test.ts:269-273` 五条正则齐全（`?? true`/`?? false`/`?? "info"`/`?? "text"`/`?? DefaultConfig\.[A-Za-z]`）+ `:281` 禁 `getDefaultValue`/`hasDefaultValue`；spec 末项带点是准确的 —— `index.ts:264` 的 `initial ?? DefaultConfig`（裸标识符）合法 |
| §12:269「index.ts 从 500 行降到 364 行」 | **WARN/P3** | 364 实测为真；"500" 与 draft-scan §0/§6 的 blob 实测 492 行、主台账 491 不一致 ⇒ 数字要就地改成 492（或删掉具体数） |
| §1:22-25 的 `config/index.ts:113-114` / `:281` / `:182-184` / `:324-327` 标为"已核实" | **FAIL（引用腐烂）** | 实际守卫在 `index.ts:128-129`；`:281` 现在是被删掉的 `?? DefaultConfig.x` 的**注释**（`:279-280`），回落已由 `assembleConfigSnapshot` 承担 —— §1 的证据地址与同一文件 §12 自相矛盾。`contracts` 侧 `:306`/`:343` 才是 `180000`/`10` 的真位置 |
| §3:54/56/59 的 `schema.ts:30` / `:218` / `:207-210` | **FAIL（引用腐烂）** | 真值 `:35`（timeout）/ `:223`（maxConcurrency）/ `:212-214`（loggingSchema.format 枚举），**整齐偏移 +5** —— 正是 fix-db 自己在 `schema.ts:13` 插入 5 行造成的位移，一处都没回头改 |
| §2:36-45 用 `env-config.adapter.ts:44-46`/`:56-58`/`:68-72` 描述 `normalizeNumber` 缺陷 | **WARN/P3** | 该函数已不存在，这几个行号现在是 `MAX_TIMER_DELAY_MS` 与两条规则；历史章节没标"改前地址" |
| §12.2:310 上界守卫无限定 | **P1** | 见 Duty 1 |

**logging-persistence/spec.md**

| 断言 | 判定 | 证据 |
| --- | --- | --- |
| §4:74-80「双重接管检查」行号 | **PASS** | `append-queue.ts:238` ensureDir / `:241` await 前守卫 / `:242` appendBatch / `:243` await 后守卫，逐行核对与文档、与 fix-tests 申报一致；"A5/A12/A15 只门控 appendBatch"经核实在 rotation 文件（`:196/:260/:285`），确实测不到 `:241` ⇒ 补 A21 的理由成立 |
| §9 A21 行 | **PASS** | 与 `logging-append-queue-rotation.test.ts:305` 的用例同名同断言；引用的反向读数与 fix-tests §任务2 一致 |
| §11 拆分入口 + 命令 + 12/7 | **PASS** | 实跑 12 / 7；行数 345 / 347；用例名并集与 fix-tests 申报的 A1…A16 + M7 对得上（本腿核了 B 侧 7 个名字） |
| §11:225 `verify.mjs → files=2 … 39/39` | **WARN/P3** | 该行未标日期，当前是 7 files / 99 / 99；§11:211 有"gen2"标签而 :225 没有 ⇒ 加标签即可 |
| §10.5 在 §10 之前 | 不处理 | 已有裁决：编号乱序不值得再动标题行 |

fix-db §6（漂移断言"不保证什么"）诚实且与 MAIN-09 一致；但它只讨论了**默认值表**的第二持有者，
没有讨论**合法性判据**的第二份规则 —— 后者才是本轮根因形态，本腿在第 1 节补上。
fix-db §2 的"改前"整列（18 行 THREW）与"221 → 295"的起点行数：`git show afb40aa^:…env-config.adapter.ts` 是 89 行，
说明那个 221 行中间态从未入库 ⇒ **WARN-unverifiable（历史）**；终点 295 与 `schema.ts` 的 `575 → 580（+5）`
本腿都用 `git show` 独立复现，**PASS**，没有被悄悄多写。

## 5. Duty 5 — 行数法（≤400），本腿 `wc -l` 实测

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `adapters/src/config/env-config.adapter.ts` | 295 | PASS（与申报一致） |
| `adapters/src/config/schema.ts` | 580 | 既有违规，记账；`afb40aa^` = 575 ⇒ 本轮 +5，与申报一致，无隐性增长 |
| `adapters/src/logging/append-queue.ts` | 399 | PASS（冻结源码，离上限 1 行，后续任何新增都会破法） |
| `adapters/tests/env-config.test.ts` | 237 | PASS |
| `adapters/tests/env-config-timeout-zero.test.ts` | 271 | PASS（与申报一致） |
| `adapters/tests/logging-append-queue.test.ts` | 345 | PASS |
| `adapters/tests/logging-append-queue-rotation.test.ts` | 347 | PASS |
| `specs/runtime-env-config/spec.md` | 362 | PASS（362/400，本轮再加就顶格） |
| `specs/logging-persistence/spec.md` | 253 | PASS |
| `docs/evolution/gen5/{draft-scan,fix-db-report,fix-tests-report}.md` | 159 / 90 / 116 | PASS |

MAIN-04 的自造违规（447）已收口；本轮**没有**新增 >400 的文件。
`find adapters -name "*.ts" -exec wc -l` 全树扫出的 >400 命中**共 31 个，全在 `adapters/src`，含已单独记账的
`config/schema.ts`（580）即"本轮触碰 1 个 + 既有债务 30 个"
（`fs/index.ts` 1878、`mcp/index.ts` 1950、`plugins/marketplace.ts` 2724、`model/runner-stream.ts` 1655、
`config/file-config.adapter.ts` 624、`config/config-factory.ts` 491 等），除 schema.ts 外本轮均未触碰 ⇒ 只记账。

## 6. Duty 6 — 本腿自选敌意扫描：**两个 timeout 别名同时在场 = 顺序决定胜负，且可静默关闭超时**（P2）

实测（`parseEnvConfigWithDiagnostics` 直驱）：

```
{ZCODE_HTTP_TIMEOUT:"9000", ZCODE_TIMEOUT:"5000"} -> timeout=5000, 诊断 0 条
{ZCODE_TIMEOUT:"5000",     ZCODE_HTTP_TIMEOUT:"9000"} -> timeout=9000, 诊断 0 条
{ZCODE_HTTP_TIMEOUT:"9000", ZCODE_TIMEOUT:"0"}     -> timeout=0,    诊断 0 条   ← 超时被静默关掉
{ZCODE_HTTP_TIMEOUT:"9000", ZCODE_TIMEOUT:"2147483648"} -> timeout=9000, 诊断 1 条 too_large(ZCODE_TIMEOUT)
```

机制：`:161` 把两个键并进同一个 `else if`，循环按 `Object.entries` 的插入顺序逐条覆盖，
`:165` 无条件赋值 ⇒ **后在场者赢**，没有任何"别名冲突"诊断。
真实 `process.env` 的插入顺序来自环境块/`export` 顺序，不是用户意图，因此这个赢者是未定义量。
最坏形态第三行：一个"9000 的显式超时"被同进程里另一处 `ZCODE_TIMEOUT=0` 顶掉，
终态正是 §4.1:101-103 花整节守住的"静默关闭超时"，只是换了一扇门进来。
好的一面：非法别名**不会**覆盖合法主键（第四行），因为被拒的值走缺席分支。

文档缺口：§4 表格把两键并成一行（`:79`），§8 场景 6（`:192-193`）只测"单独设别名"，
**没有任何一处定义两个键同时在场时的优先级**；`env-config-timeout-zero.test.ts:124-133` 与
`env-config.test.ts:80-87` 也都没有同时设两键的用例。
建议交 converge 腿定案（不属本腿权限）：主键赢，或冲突时产出 1 条诊断并保留主键；
两种都要补一条用例，且不得触碰步 5/步 6 的判据。

次要观察（非缺陷）：`ZCODE_MAX_TOOL_CONCURRENCY="2.5"` → `2.5` 合法放行，
`getToolConcurrencyConfig("2.5")` → `2.5`；`spec.md:80` 写的是"有限正数"，
`schema.ts:223` 的 `positiveNumberSchema` 也不要求整数 ⇒ **两扇门在这里是一致的**（与 Duty 1 相反）。
小数并发会一路流到 `createWorkflowRunSeatGate({limit})`（`bootstrap`，本腿射程外且不可加载），
是否要 `Int` 属产品口径，登记为待决而不是缺陷。

## 7. converge 腿必须重跑的具体项

1. `node docs/evolution/verify.mjs` → 期望 `files=7 PASS=7 FAIL=0 WARN=0 cases=99/99 notRun=0 fit=100`；
   以及三条 `node --test`：`env-config-timeout-zero`（30）、`logging-append-queue`（12）、`…-rotation`（7）。
2. 若给 `network.timeout` 补天花板：`MAX_TIMER_DELAY_MS` 与 `schema.ts` 必须**共读同一个数**（放 `contracts`），
   只改一处就是把 P1 换个位置；同时把 `spec.md:310` 的无限定句子与 `:63-65` 的不对称声明一次改齐。
   `schema.ts` 不可加载 ⇒ 文件门的证据只能做源码扫描断言，并在报告里写"未执行运行时断言"。
3. 引用腐烂就地修：`spec.md:22-25` → `config/index.ts:128-129` 并删掉 `:281` 的"已核实"回落证据；
   `:54/:56/:59` → `schema.ts:35 / :223 / :212-214`；`:269` 的"500 行"→ 492（或去掉数字）；
   `logging spec:225` 的 39/39 加 gen 标签。
4. `1e-999` 用例注释的"spec §9"改成 §4.1:108（一行，不动判据）。
5. 别名优先级：定案 → 补"两键同时在场"用例（期望固定赢者或 1 条冲突诊断）→ 同步写进 §4 表格与 §8。
6. 任何 env 判据改动后重跑第 3 节那张 26 组注入表（含 5 个字符串透传键与 7 个 LOG_FORMAT 非字符串），
   确认"抛错 0 次"仍然成立。

## 8. 判定汇总（claim | verdict | evidence）

| claim | verdict | evidence |
| --- | --- | --- |
| env 有序判据 8 步与表一致 | PASS | `env-config.adapter.ts:101-125` 直读 + 26 组实驱 |
| 0/`-0`/`1e-999` 放行且 0 诊断；`""`/空白 → empty；`30s`/`NaN`/`Infinity`/`1e999` → invalid_number；`-5` → negative；`2147483647` 合法；`2147483648`/`4294967296`/`1e20` → too_large；`maxConcurrency` 的 `0` → zero_not_allowed 且大值合法；非字符串不抛 | PASS | 本腿逐值复现 |
| `ZCODE_LOG_FORMAT` 非字符串/`null` 由抛错改为类型化诊断 | PASS | 7 种非字符串实驱，0 抛错 |
| `getToolConcurrencyConfig` 同获非字符串保护 | PASS | 9 次直读全为 10，含 `{}`/`Symbol`/`null` |
| `schema.ts` 只 +5（575→580） | PASS | `git show afb40aa^:… \| wc -l` = 575 |
| adapter 221 → 295 | 终点 PASS / 起点 WARN-unverifiable | 295 实测；89 = HEAD^，221 中间态从未入库 |
| 文件门与 env 门共享一条规则 | **FAIL（P1-drift）** | `schema.ts:13` 无 `.max()`；`1e20` 经文件门到 `http/index.ts:80`；本腿复现钳成 1ms |
| §12.2:310 的上界守卫覆盖两条路 | **FAIL（文档强于实现，P1）** | 与 §3:63-65 自相矛盾 |
| §9.1 的 4 个消费点 | PASS | 四个 file:line 逐个核对 |
| §12.1 已收窄 | PASS | `:294-298` |
| spec 引用的行号新鲜 | **FAIL（P2/P3 腐烂）** | §1/§2/§3 至少 7 处地址失效，schema 侧齐偏 +5 |
| 447 行违规收口 + 19 例守恒（18 名 + M7） | PASS | 345/347 实测、12/7 实跑、B 侧 7 个用例名核对 |
| M7 base `{0,0}` vs mutant `{1,2}` | PASS（同意，非本腿复现） | scratch 已删；本腿核了 `:238/:241/:242/:243` 结构与"A5/A12/A15 只门控 appendBatch"这两条使复现成立的前提 |
| §4 双重接管检查行号 | PASS | 逐行核对 |
| §11 命令与读数 | PASS | 实跑 |
| 别名同时在场的优先级 | **FAIL（P2，未成文、顺序决定、可静默关超时）** | 第 6 节四行读数 |
| `pnpm lint` / `typecheck` / `architecture:check` | 未执行（本检出无 tsc/oxlint/依赖），不写成通过 | 环境事实 |
