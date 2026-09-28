# gen5 · fix-db — `network.timeout` 的 env 数值契约（D-B / MAIN-07 / MAIN-08 / MAIN-09）

范围：`adapters/src/config/env-config.adapter.ts`、`adapters/src/config/schema.ts`、
`adapters/tests/env-config.test.ts`、新增 `adapters/tests/env-config-timeout-zero.test.ts`、
`specs/runtime-env-config/spec.md`。未触碰 `config/index.ts`、`resolve-snapshot.ts`、`config-factory.ts`、
`logging/`、`exec/`、`contracts/`、`bootstrap/` 与任何判据文件。无新 `ZCODE_*` 键。

## 1. 最终有序规则（实现点 `parseEnvNumberValue(value, rule)`，`rule = { allowZero, maxMs }`）

| 步 | 判据 | timeout（`NETWORK_TIMEOUT_RULE`） | maxConcurrency（`TOOL_CONCURRENCY_RULE`） | reason |
| --- | --- | --- | --- | --- |
| 0 | key 缺席（`undefined`） | 跳过，无诊断 | 跳过，无诊断 | — |
| 1 | 非 `string` 且非 `null` | 拒 | 拒 | `non_string_value` |
| 2 | `trim() === ""` | 拒 | 拒 | `empty` |
| 3 | `!Number.isFinite()` | 拒 | 拒 | `invalid_number` |
| 4 | `Number(v) < 0` | 拒 | 拒 | `negative` |
| 5 | `Number(v) === 0`（已排除步 2） | **合法 = 显式关闭超时** | 拒 | `zero_not_allowed` |
| 6 | `Number(v) > MAX_TIMER_DELAY_MS` = `2_147_483_647` | 拒 | **不适用**（MAIN-10：并发上界是运营/产品数，不替产品拍板） | `too_large` |
| 7 | 其它有限正数 | 合法 | 合法 | — |

`not_positive` 拆成 `negative` + `zero_not_allowed`（D-B 第 3 步要求语义分写）。`-0` 归一为 `+0` 后入库。
文件层同步：`schema.ts` 新增 `nonNegativeFiniteNumberSchema = z.number().finite().nonnegative()`，
**只**给 `network.timeout`（`:30`）；`maxConcurrency` 与其余 10 处 `positiveNumberSchema` 用户一字未动。

## 2. before → after 全表（`parseEnvConfigWithDiagnostics` 直驱实测，非读码推断）

| 输入 | timeout before | timeout after | maxConcurrency before | maxConcurrency after |
| --- | --- | --- | --- | --- |
| `""` / `"  "` | empty，缺席 | empty，缺席（不变） | empty，缺席 | empty，缺席（不变） |
| `"30s"` / `"1,000"` / `"abc"` | invalid_number | invalid_number | invalid_number | invalid_number |
| `"NaN"` / `"Infinity"` / `"1e999"` | invalid_number | invalid_number | invalid_number | invalid_number |
| `"-5"` / `"-1"` / `"-1e20"` | not_positive | **negative** | not_positive | **negative** |
| `"0"` `"0.0"` `"0e0"` `" 0"` `"0x0"` `"00"` `"+0"` `"0.00"` | not_positive，缺席 | **合法 0，0 条诊断** | not_positive | **`zero_not_allowed`，缺席** |
| `"-0"` | not_positive | 合法 0（归一为 `+0`） | not_positive | `zero_not_allowed` |
| `"1e-999"`（下溢成 0） | not_positive | 合法 0（按值判定，spec §4.1 已表态） | not_positive | `zero_not_allowed` |
| `"007"` `"1e3"` `"10.5"` `"2.5"` | 7 / 1000 / 10.5 / 2.5 | 不变 | 同左 | 不变 |
| `"45000"`（控制组） | 45000，0 诊断 | 不变 | 45000，0 诊断 | 不变 |
| `"2147483647"` | 合法 | 合法（边界不误伤） | 合法 | 合法 |
| `"2147483648"` / `"4294967296"` / `"1e20"` / `"99999999999999999999"` | **合法，0 诊断** | **too_large，缺席** | 合法（1e20 → 1e20） | 合法（MAIN-10 未搬 timer 天花板） |
| `null` | empty，缺席 | empty，缺席（实测保持不动） | empty，缺席 | empty，缺席 |
| `{}` / `[]` / `[7]` / `10` / `true` | **THREW TypeError** | `non_string_value`（value 字段渲染 `object`/`array`/`10`/`true`），缺席 | **THREW** | 同上 |
| `ZCODE_LOG_FORMAT` 的 `{}`/`[]`/`10`/`true`/`null`/函数 | **THREW**（`null` 也抛，改前实测） | `non_string_value`，`logging` 整体缺席 | — | — |
| `getToolConcurrencyConfig("2147483648")` | 2147483648 | 2147483648（不变） | — | — |
| `getToolConcurrencyConfig(10 / {} / "0")` | 10 / **THREW** / 10 | 10 / **10**（不再抛） / 10 | — | — |

改前全表 18 行 `THREW`，改后 0 行。

## 3. 反向证据（scratch `.hermess-snapshots/mut/`，跑完已删除）

| 变异 | 删除内容 | 变红的用例（`env-config-timeout-zero.test.ts`） |
| --- | --- | --- |
| a | 步 6 的 `if (rule.maxMs !== undefined && num > rule.maxMs) return …` | **4 例**：`第 5 步（MAIN-07）：超过 32-bit 有符号延时的有限正数必须拒绝`、`第 5 步边界：上限本身合法`、`别名 ZCODE_TIMEOUT 带同一套判据与同一个 path`、`合法的 0 与非法的 0 用同一个诊断形状…` |
| b | 步 2 的 `if (trimmed.length === 0) return …`（= 交换步 2 与步 5） | **4 例**：`第 1 步 empty：空串/空白在 Number() 之前就被挡住，绝不落为 0`、`empty 先于 zero，所以 ZCODE_HTTP_TIMEOUT= 不会静默关闭超时`、`null 的既有行为保持不动…`、`诊断的 value 字段仍是 string…`。实测读数：`ZCODE_HTTP_TIMEOUT=""` → `timeout = 0`、诊断 0 条 —— 正是 `user-decisions.md` 记的决定性陷阱，现序挡住 |
| c | 步 1 的 `typeof` 守卫（只删数值判据那一处，LOG_FORMAT 分支保留） | **11 例**：9 条 `${label} 走类型化诊断而不是 TypeError…`（object/array/array-of-number/number/float/boolean/nan-number/symbol/function）+ `诊断的 value 字段仍是 string…` + `混合输入…`；`TypeError` 回归 |

## 4. 真实执行结果

- `node --test adapters/tests/env-config-timeout-zero.test.ts` → **pass 30 / fail 0**（新增文件，271 行）
- `node --test adapters/tests/env-config.test.ts` → **pass 21 / fail 0**（改了 AC-2、负数 reason、
  「安全边界」判据收窄为「非法输入不得变成 0」；用例数与改前一致）
- `node docs/evolution/verify.mjs` → **SUMMARY files=7 PASS=7 FAIL=0 WARN=0 cases=99/99 fit=100**
  （开工前是 5 文件 68/68；差值 = 我的 +30 与并发写手 fix-tests 的新文件）
- `node docs/evolution/baseline.mjs diff pre-gen4` → 改动 8 / 删除 0，
  `基线验证 39/39` vs `当前验证 99/99`，无回归项。

## 5. 行数与文件代价

- `schema.ts`：575 → **580（+5）**。既有 ≤400 违规只记账，本轮不重构；新增 = 1 行 schema 定义 + 4 行中文注释。
- `env-config.adapter.ts`：221 → **295（+74）**，仍 <400。
- `spec.md`：§3、§4.1（新表）、§8 场景 2、§9/§9.1、§12.1、§12.2、§13（新增三小节）按代码实况改写。

## 6. 漂移断言不保证什么（MAIN-09）

它是**文本比对**，不是共享常量：读 `contracts/src/config/index.ts` 与 adapter 的源文本，
用正则取 `timeout:` / `maxConcurrency:` 的数字字面量（各自恰好 1 处，计数也进断言）比对 adapter 的
`DEFAULT_NETWORK_TIMEOUT_MS` / `DEFAULT_MAX_TOOL_CONCURRENCY`，并要求 fallback 文案插值自这些常量。
它**不看运行时求值**、不覆盖经函数/展开得到的默认值、不校验类型一致性，
默认值改写成等价但不同字面的形态（拆行、注释、表达式）就可能假绿或假红。
真正的一次收口仍是删掉 `getToolConcurrencyConfig` 这个第二持有者（§5.4）。

## 7. 本环境未能验证（如实）

- `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check`：无 oxlint/tsc/依赖，**未执行**。
- `schema.ts` 无测试可跑（value import `zod` + `@zcode/contracts`，`node --test` 装载即失败）：
  `nonNegativeFiniteNumberSchema` 只做了源码审视，`.nonnegative()` 的实际拒收行为未执行断言。
- 0 值端到端穿过 `ConfigPort.getAll()` → `http/index.ts:79` 的落地：`config/index.ts` 不可加载，
  沿用 `user-decisions.md` 的主代理实测（`stored 0 → network.timeout = 0`）。
- `auth-login.ts:386` 链路上「关闭超时留一条 warn/诊断」：属 `bootstrap/` 射程（本代理禁改），未落地，
  已写进 spec §9.1 作为后续项。
- `ZCODE_TIMEOUT` 之外没有新增键；`MAIN-10`（并发上界该是多少）需要产品数字，本轮只留不对称证据，未替你拍板。
