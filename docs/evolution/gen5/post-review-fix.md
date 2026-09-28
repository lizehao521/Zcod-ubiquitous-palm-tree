# gen5 · post-review-fix（复核后修复腿）

日期：2026-09-29。执行者：post-review 修复腿。范围：Job 1（P1 文件门天花板）、Job 2（引用腐烂）、
Job 3（P2 别名优先级）、Job 4（两条过期事实申报的更正清单）。仪器与 `tree.json` 未动。
所有读数为本腿实跑；`pnpm lint` / `pnpm typecheck` 在本裁剪检出**无法执行**（无 oxlint/tsc/依赖），不写成通过。

## 1. Job 1 — 终态先复现，再改门

本腿实测（Node v24.13，直跑 `setTimeout`）：

```
TimeoutOverflowWarning: 100000000000000000000 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
FIRED after 4ms (asked 1e20)
TimeoutOverflowWarning: 2147483648 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
FIRED after 5ms (asked 2147483648)
```

即"配了个大超时"= 约 1ms 触发，`http/index.ts:79-83` 无钳制，每个请求几乎立刻 abort。修复锚在这个读数上。

**schema 改动**（`adapters/src/config/schema.ts`，580 → 588 行）：

- `:19` 新增具名常量 `const MAX_TIMER_DELAY_MS = 2_147_483_647;`（注释写明为何不 import env 侧那个：
  两文件之间的相对 **value** 导入（NodeNext `./x.js`）在 type stripping 下不改写说明符，会把可测的一侧拖死）
- `:43` `timeout: nonNegativeFiniteNumberSchema.max(MAX_TIMER_DELAY_MS).optional()`（原 `:35` 无 `.max`）

**没有覆盖什么**（明确边界）：

1. 只作用于 `network.timeout`。`positiveNumberSchema` 及其消费者（`toolConcurrency.maxConcurrency` `:231`、
   `modelStream.idleTimeoutMs`、provider `timeout/timeoutMs`、`metadataBudget`、exec `timeoutMs`）**一行未动**。
   MAIN-10 的裁决（并发不借计时器上限封顶，运营上界属产品决定）保持原样，未新增任何天花板。
2. `mcp.timeoutMs` / hook 超时是否需要同一天花板：**本腿认为语义上同类（都是挂给 setTimeout 的延时），
   但越出本轮射程，未改动**，登记为待决项交主代理。
3. 第三条门未闭：`ConfigPortImpl.set()` / `merge()` 仍无校验，所以现状是"两条受控规则 + 一个裸入口"。
4. **文件侧 `.max()` 在本环境执行不了**：本腿直接探针
   `await import(".../schema.ts")` → `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`。
   ⇒ 文件门行为状态 = **WARN-unverifiable**，只有源码文本断言 + 人工审查支撑，没有任何运行时断言被跑过。

**漂移守卫**（新文件 `adapters/tests/config-timeout-ceiling-drift.test.ts`，90 行 / 4 例）：
读两侧源文本，断言 `MAX_TIMER_DELAY_MS\s*=\s*([0-9_]+)` 各自恰好 1 处且同值、同等于 2^31-1；
断言应用点（`NETWORK_TIMEOUT_RULE … maxMs: MAX_TIMER_DELAY_MS` / `timeout: …max(MAX_TIMER_DELAY_MS)`）；
断言 `.max(` 在 schema.ts 恰好 1 处（兄弟键被顺手封顶时红）；断言基础判据链未被改写。
**它是文本比较，不是运行时共享**：抓数值分叉，抓不到"同值被语义不同地应用"（`>=`、自定义 refine、接到别的键）。

反向证据（`.hermess-snapshots/mut/` 镜像树，深度与原位一致，跑完即删）：

| 形态 | 读数 |
| --- | --- |
| 干净（真文件） | `tests 4 pass 4 fail 0` |
| MUT-A：文件侧常量 `+1` | `tests 4 pass 3 fail 1` —「两扇门的天花板分叉了」 |
| MUT-B：还原数值、摘掉 `.max()` | `tests 4 pass 2 fail 2` |
| 收尾 | 真文件 `grep -c ".max(MAX_TIMER_DELAY_MS)"` = 1；`mut/` 已删，`NO_MUT_LEFT` |

## 2. Job 2 — 引用腐烂：逐个重开文件核对后的 before → after

| spec 位置（改前） | 改前引的 | 本腿实测真值 | 改后 |
| --- | --- | --- | --- |
| `:22` | `config/index.ts:113-114` | 守卫在 `index.ts:128-129` | `:128-129` |
| `:23` | `index.ts:281` = `… ?? DefaultConfig.network.timeout` | `:281` 实为 `return assembleConfigSnapshot(this.store.lookup(), DefaultConfig);`；`??` 回落已在 gen4 删除（与同文件 §12 静态校验清单矛盾） | 改写成 `:281` + 唯一回落点 `resolve-snapshot.ts:109-115` |
| `:24` | `contracts/index.ts:305-307` | 305 `network: {` / 306 `timeout: 180000,` / 307 `}` —— 核实为真 | 不动，标注"本轮复核" |
| `:25` | `index.ts:182-184` / `:324-327`，`contracts:342-344` | 写入在 `:198-199`；`:324-327` 已不存在（文件 364 行）；contracts 342/343/344 为真 | 改 `:198-199`，contracts 保持 |
| `:54` | `schema.ts:30` | 修复前 `:35`（fix-db 在 `:13` 插 5 行），本腿加天花板后 `:43` | `:43`（并写清两次位移的来源） |
| `:56` | `schema.ts:218` | 现 `:231`（+5 与 +8 两次位移） | `:231` |
| `:59` | `schema.ts:207-210` | loggingSchema 块现 `:220-222` | `:220-222` |
| `:146`（§5.4） | `config/index.ts:483` re-export | 文件 364 行，`export {` 在 `:349`，`getToolConcurrencyConfig` 在 `:350` | `:349-351` |
| `:251`（§11） | 静态核实 `:281` / `:324-327` 的 `?? DefaultConfig.*` | 同上：`??` 已删；`config/index.ts:113` 也是旧址 | 改指 `:128` + `config-resolve-snapshot.test.ts` 对唯一装配点的断言，并写明旧句已失效 |
| `:269`（§12） | "从 500 行降到 364 行" | `git show afb40aa^:…index.ts \| wc -l` = **491**；364 实测为真；draft-scan 的 492 是含结尾换行的 blob 计数 | 改 491，保留 364，并注明 492 差异 |
| `:32`（§2） | `env-config.adapter.ts:44-46/:56-58/:68-72`、`config/index.ts:113-114/:281` | 该函数已不存在，行号今为规则常量与两条判据 | 整节标注「**改前地址**，仅为留痕」（review 的 WARN/P3） |
| `:63-65` + `:310`（§3 / §12.2） | 一处自认"只在 env 侧拦"，一处把守卫写成无限定 | 两条门现已共线 | **同一次改齐**：§3 写共线形态 + 文本比较的局限 + 本腿反向读数；§12.2 改为"env 与文件两条门都拒"，并写明文件侧 = WARN-unverifiable、附 1ms 实测读数 |

未处理（越出本腿边界，只登记）：`specs/logging-persistence/spec.md:225` 的 `39/39` 缺 gen 标签（review §7.3），
该文件不在本腿可改清单内。

## 3. Job 3 — 别名优先级：定案为"文档化既有规则"

实测（本腿直驱 `parseEnvConfigWithDiagnostics`）：

```
{ZCODE_HTTP_TIMEOUT:"9000", ZCODE_TIMEOUT:"5000"}          -> timeout=5000, 诊断 0 条
{ZCODE_TIMEOUT:"5000", ZCODE_HTTP_TIMEOUT:"9000"}          -> timeout=9000, 诊断 0 条
{ZCODE_HTTP_TIMEOUT:"9000", ZCODE_TIMEOUT:"0"}             -> timeout=0,    诊断 0 条   ← 静默关闭
{ZCODE_HTTP_TIMEOUT:"9000", ZCODE_TIMEOUT:"2147483648"}    -> timeout=9000, 1 条 too_large(ZCODE_TIMEOUT)
{ZCODE_HTTP_TIMEOUT:"9000", ZCODE_TIMEOUT:""}              -> timeout=9000, 1 条 empty(ZCODE_TIMEOUT)
```

规则（写进 spec §4 表格下方新段 + §8 场景 6a）：两键**无语义优先级**，生效形态是
`Object.entries(env)` 插入顺序的**后出现者写胜（last-write-wins）**，因为 `env-config.adapter.ts:161-173`
把两键并进同一个 `else if`、`:165` 无条件覆盖，且不产出冲突诊断。给定同一个 env 对象它是确定的；
`process.env` 的插入序来自环境块/`export` 顺序而非用户意图 ⇒ "谁赢"对使用者是未定义量。

**未改实现、未加诊断**，理由：规则稳定可述，改优先级属行为变更且要新增 reason 码（越出 P2 射程）。
代价原样写在正文：后出现的合法 `0` 能顶掉先出现的显式超时；消除它需要一条别名冲突诊断 → 后续项。
**（主代理更正，2026-09-28 16:2x：本行的"→ 后续项"已作废。用户随后裁决为「主键赢 + 不一致出诊断」，**
**已实现于 `env-config.adapter.ts`（新增 reason `alias_conflict`，两方向实测均 `9000` + 1 条诊断），**
**并同步改写 spec §4 与 §8 场景 6a。本报告的 last-write-wins 段落保留为决策过程记录，不代表当前行为。）**
好的一面也钉了：非法的后来者不清空先写入的合法值（走缺席分支）。
测试：`env-config-timeout-zero.test.ts`（271 → 319 行）新增 2 例 —— 「别名优先级：两键同时在场时后出现者写胜
（两个顺序都测）」（含 `TIMEOUT:"0"` 的静默关闭读数）与「非法的后来者不覆盖先出现的合法值」。

## 4. 门禁与真实计数

| 命令 | 读数 |
| --- | --- |
| `node --test …/config-timeout-ceiling-drift.test.ts` | `tests 4 pass 4 fail 0` |
| `node --test …/env-config-timeout-zero.test.ts` | `tests 32 pass 32 fail 0`（改前 30，+2 别名） |
| `node --test …/env-config.test.ts` | `tests 21 pass 21 fail 0` |
| `node --test …/config-resolve-snapshot.test.ts` | `tests 8 pass 8 fail 0` |
| `node docs/evolution/verify.mjs` | `SUMMARY files=8 PASS=8 FAIL=0 WARN=0 cases=105/105 notRun=0 fit=100`（改前 7 files / 99） |
| `node docs/evolution/baseline.mjs diff pre-gen4` | `新增 22 / 改动 13 / 删除 0`；`基线 39/39` → `当前 105/105`（本轮净增：1 个测试文件 + 4 例 + drift 文件） |
| `node docs/evolution/tree.mjs` | 未跑（本腿不改台账） |
| `pnpm lint` / `pnpm typecheck` | **无法执行**：无 oxlint/tsc/第三方依赖 ⇒ 不声明通过 |

行数律：`schema.ts` 580 → **588**（既有违规，本轮 +8，未新开违规文件）；
`specs/runtime-env-config/spec.md` 362 → **400**（贴线，≤400 达标但已无余量 —— 下一轮再加就必须拆 spec）；
`env-config-timeout-zero.test.ts` 319、drift 90，均 <400。

## 5. Job 4 — 交主代理的 `tree.json` 更正清单（本腿无权编辑）

以下条目与本腿/上游两腿的实测矛盾，请用 `node docs/evolution/tree.mjs note --id <node> --note "..."` 落地；
`unverified` 数组里的过期项要同批改写，不能只加 note 留着错句子。

1. **id=gen4-a**（`unverified` 现含「iconv-lite 真实解码集合」「中文输出命令的 E2E 未跑」）：
   `iconv-lite` **确实已安装**（`apps/zcode-cli/packages/adapters/node_modules/iconv-lite` 存在；主代理两次复测，
   gen4-b 的 note 也已写明真因是 NodeNext `./x.js` 值导入）。"未安装/不可解码"的任何残留说法作废；
   「中文输出命令的 E2E」在本机 Windows 用 `node --test` + `child_process` 就能闭，属于"伸手可闭"，不是环境限制。
   建议 note：`iconv-lite 实测已安装（adapters/node_modules），真实解码集合与中文输出 E2E 均可在本机用 node --test 驱动子进程闭合；此两条为过期申报，不是环境限制。`
2. **id=gen2-b**（`unverified` 现含「变异体 M7-M10 存活=…四条守卫无测试覆盖」「真盘/跨平台 E2E 未跑」）：
   M7 已被 gen5-b 的正式用例钉死（converge 与 review 两腿各自复现：指向变异副本时 rotation 7 例中恰好 1 例红），
   M8/M9/M10 已在 gen4-b 击杀 ⇒ "M7-M10 存活"整条作废。真盘/跨平台 E2E 同理改写成"现在可闭、尚未闭"。
   建议 note：`M7 已由 gen5-b 正式用例钉死（反向读数：rotation 7 例中恰好 1 例红），M8/M9/M10 已在 gen4-b 击杀；"M7-M10 存活"作废。真盘/跨平台 E2E 与 await 后取消窗口为"本机可闭、本轮未闭"，不是结构性不可测。`
3. **id=gen4-b**（`label` 写「index.ts 500→364」）：实测 `git show afb40aa^:…config/index.ts | wc -l` = **491**，
   label 里的 500 与 spec 同步更正为 491（364 为真）。
4. **id=gen4-a / gen5-a** 涉及"文件路径上界归审查腿/schema 不可加载"的表述：本轮已把天花板加进
   `schema.ts:43`，状态是**已修但 WARN-unverifiable**（探针 `ERR_MODULE_NOT_FOUND: 'zod'`），
   不得升格为"已验证"；漂移由 `config-timeout-ceiling-drift.test.ts` 文本守卫兜住。

## 6. 遗留（不静默）

- `env-config-timeout-zero.test.ts:145` 用例注释仍写"spec §9"，应为 §4.1（review §7.4）。
  该文件的修改权限本腿只授到"别名用例"，故**未改**，交主代理一行落地。
- 真共享常量（把 `MAX_TIMER_DELAY_MS` 落进 `contracts`，env 与文件共读）仍是后续项；现状是两份同值副本 + 文本守卫。
- 别名冲突诊断：~~后续项~~ **已落地**（reason `alias_conflict`，主键优先；见本报告上方的主代理更正）。
- `specs/logging-persistence/spec.md:225` 的 gen 标签：越界未动。
