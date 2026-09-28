# Spec: Runtime Env Config（`ZCODE_*` 环境变量装载契约）

## 1. 范围与状态所有者

本 spec 只覆盖 `apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts` 的
`parseEnvConfig` / `parseEnvConfigWithDiagnostics` / `getToolConcurrencyConfig`，
即「把 `ZCODE_*` 环境变量转成 `RuntimeConfigPatch`」这一层。

配置层级的所有者划分（本层不得越权）：

| 职责                 | 所有者                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| 环境变量的解析与校验 | `env-config.adapter.ts`（本层，唯一）                                  |
| 各来源的优先级与合并 | `config/config-merger.ts` 的 `mergeConfigs`，Env scope 低于 Project/Cli |
| **默认值的唯一归属** | `contracts/src/config/index.ts` 的 `DefaultConfig`                     |
| 默认值的落地点       | `adapters/src/config/index.ts` `ConfigPort.getAll()`                   |
| 运行期消费          | `http/index.ts`、`core/tool/scheduler.ts` 等消费方                     |

关键结论：本层「忽略一个非法值」等价于「该 key 在 Env scope 缺席」，`getAll()` 会回落到
`DefaultConfig`，因此**回落默认值不需要本层自己写第二份默认数字**。已核实：

- `adapters/src/config/index.ts:113-114` — `if (config.network.timeout !== undefined) this.set(ConfigKey.HttpTimeout, ...)`
- `adapters/src/config/index.ts:281` — `timeout: this.store.get(ConfigKey.HttpTimeout) ?? DefaultConfig.network.timeout`
- `contracts/src/config/index.ts:305-307` — `network: { timeout: 180000 }`
- `adapters/src/config/index.ts:182-184` / `:324-327` — `maxConcurrency` 同构，默认 `contracts/src/config/index.ts:342-344` 的 `10`

因此「缺席」与「显式 0」不是等价的：缺席得到 180000（安全边界保留），显式 0 会让
`http/index.ts:79` 的 `if (timeoutMs > 0)` 整块跳过，**请求超时被完全关闭**。

## 2. 缺陷（已复现）

`normalizeNumber` 把不可解析的字符串转成 `0`，而 `0` 在下游被当作合法配置值一路透传：

```
ZCODE_HTTP_TIMEOUT=30s
  -> env-config.adapter.ts:44-46  config.network.timeout = 0
  -> config/index.ts:113-114      ConfigKey.HttpTimeout = 0（覆盖了文件层的合法值）
  -> config/index.ts:281          ?? 不会把 0 当缺席 -> getAll() 返回 0
  -> bootstrap/src/app/create-app.ts:413  timeoutMs: config.network.timeout
  -> http/index.ts:58             ?? 同样不接受 0 -> timeoutMs = 0
  -> http/index.ts:79             timeoutMs > 0 为 false -> 不挂 setTimeout -> 无超时
```

同类：`env-config.adapter.ts:56-58` 的 `ZCODE_MAX_TOOL_CONCURRENCY=abc` -> `maxConcurrency: 0`；
`env-config.adapter.ts:68-72` 的 `getToolConcurrencyConfig()` 同一条路径。
空串尤其危险，因为 `Number("") === 0`，`ZCODE_HTTP_TIMEOUT=` 也会关掉超时。

## 3. 与文件层的契约一致性（必须对齐）

历史形态：文件层对 `network.timeout` 用 `positiveNumberSchema`（拒绝 0），Env 层也拒绝 0，
但 `http/index.ts:79 if (timeoutMs > 0)` 的行为早就是「0 ⇒ 不设计时器」。D-B 裁决（M5）把校验层
与行为对齐，而不是反过来把行为改窄：

- `config/schema.ts:30` — `network.timeout: nonNegativeFiniteNumberSchema.optional()`（**本轮改**：
  `z.number().finite().nonnegative()`，文件层与 env 层对同一字段同语义；同一字段两套规则正是 D1 的根因形态）
- `config/schema.ts:7` — `positiveNumberSchema` 保留原样，`toolConcurrency.maxConcurrency`（`:218`）、
  `modelStream.idleTimeoutMs`、provider `timeout/timeoutMs`、`metadataBudget`、exec `timeoutMs` 等
  **全部用户不变**，0 对它们没有合法语义。
- `config/schema.ts:207-210` — `logging.format: z.enum(["text","json"])`。

本层采用**与文件层一致的非负有限数判据**，不再自行放宽：整数归整是消费方的事，
本层不额外要求整数（`positiveNumberSchema` 也不是 int），否则又造出第二处分叉。
唯一残留的不对称是 §4.1 第 6 步的 `MAX_TIMER_DELAY_MS`：它只在 env 侧拦，文件侧未加 `.max()`，
因为该常量属于 `env-config.adapter.ts`，`schema.ts` 反向 import 它会把 env 层拖进文件层的依赖方向；
要收口就得把常量搬进 `contracts`（本轮不做，记为后续项）。

## 4. 环境变量清单与逐 key 契约

`parseEnvConfig` 只处理下列 key（前缀 `ZCODE_`，可用 `options.prefix` 覆盖）。
未列出的 `ZCODE_*` 一律忽略，本层不接受未声明的环境变量。

| 环境变量                                | 目标路径                              | 类型契约                                   | 非法值语义                                                                 |
| --------------------------------------- | ------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `ZCODE_STORAGE_DIR`                     | `storage.dir`                         | 字符串，原样透传                           | 不改（见 §7）                                                              |
| `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` | `storage.sessionDbPath`            | 字符串，原样透传                           | 不改（见 §7）                                                              |
| `ZCODE_HTTP_PROXY`                      | `network.httpProxy`                   | 字符串，原样透传                           | 不改（见 §7）                                                              |
| `ZCODE_NO_PROXY`                        | `network.noProxy`                     | 字符串，原样透传                           | 不改（见 §7）                                                              |
| `ZCODE_AGENT_CA_CERT`                   | `network.caCertFile`                  | 字符串，原样透传                           | 不改（见 §7）                                                              |
| `ZCODE_HTTP_TIMEOUT` / `ZCODE_TIMEOUT`  | `network.timeout`                     | **有限非负数**（毫秒），JS 数字字面量语法；`0` = 显式关闭请求超时 | 非 0 非法值 **忽略该 key + 诊断**，回落到 `DefaultConfig.network.timeout` = 180000；超过 `MAX_TIMER_DELAY_MS` 也忽略（见 §4.1 第 5 步） |
| `ZCODE_MAX_TOOL_CONCURRENCY`            | `toolConcurrency.maxConcurrency`      | **有限正数**；**0 继续非法**                     | **忽略该 key + 诊断**，回落到 `DefaultConfig.toolConcurrency.maxConcurrency` = 10 |
| `ZCODE_LOG_FORMAT`                      | `logging.format`                      | `"text"` \| `"json"`（大小写不敏感）        | 见 §5.3：非法字符串值语义保持现状（回落 `"text"`），但**必须产出诊断**；非字符串输入整体缺席 + 诊断（MAIN-08）  |

### 4.1 数值 key 的有序判据（顺序本身是契约，短路返回）

D-B 裁决落地后的规则表。实现点：`env-config.adapter.ts` 的 `parseEnvNumberValue(value, rule)`，
`rule = { allowZero, maxMs }`，两个键各一条具名规则（`NETWORK_TIMEOUT_RULE` / `TOOL_CONCURRENCY_RULE`）。

| 步 | 判据 | timeout | maxConcurrency | reason |
| --- | --- | --- | --- | --- |
| 0 | `value === undefined`（key 不在场） | 跳过，无诊断 | 跳过，无诊断 | — |
| 1 | `typeof value !== "string"` 且非 `null` | 非法 | 非法 | `non_string_value` |
| 2 | `value.trim() === ""` | 非法 | 非法 | `empty` |
| 3 | `!Number.isFinite(Number(trimmed))`（`NaN`/`±Infinity`/`1e999`） | 非法 | 非法 | `invalid_number` |
| 4 | `Number(value) < 0` | 非法 | 非法 | `negative` |
| 5 | `Number(value) === 0`（已排除第 2 步） | **合法 = 显式关闭超时** | 非法 | `zero_not_allowed`（仅并发键） |
| 6 | `Number(value) > MAX_TIMER_DELAY_MS`（= `2_147_483_647` ms） | 非法 | **不适用** | `too_large` |
| 7 | 其它有限正数 | 合法 | 合法 | — |

必须记住的三条边界，各自有断言（`adapters/tests/env-config-timeout-zero.test.ts`）：

- **第 2 步不许与第 5 步交换**。`Number("") === 0`，把"0 即放行"实现成 `Number(v) === 0 ⇒ 合法` 会让
  `ZCODE_HTTP_TIMEOUT=`（导出脚本里最常见的误设）静默关闭超时。已用变异证伪：删掉第 2 步后
  `""` 读数为 `timeout = 0`、诊断 0 条（`.hermess-snapshots` 反向证据，见 gen5 报告）。
- **第 6 步是消费方天花板，不是公共上限**：`setTimeout` 把延时当 32-bit 有符号整数，
  超过会被 Node 打 `TimeoutOverflowWarning` 并**钳成 1 ms**（MAIN-07 实测），即"配了个大超时"换来每个请求
  约 1 ms 就失败。`maxConcurrency` 没有计时器消费者，它的合理上界是运营/产品数（MAIN-10，**本轮不拍板**），
  因此 `ZCODE_MAX_TOOL_CONCURRENCY=2147483648` 仍按合法正数放行 —— 这是刻意的不对称，不是漏项。
- **第 5 步按值判定，不看字面语法**：`-0`、`00`、`0x0`、`" 0"`、`0e0`、`0.0` 落为"关闭"（裁决已表态），
  `1e-999` 下溢成 `0` 同样落为"关闭"；`-0` 写入前归一为 `+0`，store 里不留第二种表示。
  同一批输入对并发键一律 `zero_not_allowed`。

`not_positive` 这个 reason 已被拆成 `negative`（第 4 步）与 `zero_not_allowed`（第 5 步的并发侧），
因为 D-B 要求"0 与负数的语义必须分开写清"。`ZCODE_LOG_FORMAT` 仍用 `unsupported_value`（值语义）
与 `non_string_value`（类型语义）。

**编号对照**（测试标题沿用 D-B 的 1-5 序号，本表把「缺席」与「类型」也计入序号）：
测试里的 `第 1 步 empty` = 本表步 2、`第 2 步 invalid_number` = 步 3、`第 3 步 negative` = 步 4、
`第 4 步 zero` = 步 5、`第 5 步（MAIN-07）上界` = 步 6。改名成本高于收益，故保留两套序号并在此对齐。

## 5. 接口契约

### 5.1 `parseEnvConfigWithDiagnostics(env, options): { config, diagnostics }`

主入口。`diagnostics: EnvConfigDiagnostic[]`，元素字段：`code`（固定
`"env_config_invalid"`）、`envKey`、`path`、`value`、`reason`、`severity`（固定 `"warning"`）、
`message`、`fallback`（说明回落到的默认值及其所有者）。

按 code/reason 分流，不靠文本匹配（AGENTS.md「不依赖错误文本做流程判断」）。

### 5.2 `parseEnvConfig(env, options): RuntimeConfigPatch`

兼容入口，签名与返回类型**不变**，内部只取 5.1 的 `config`。
M2 后 `createConfig()` 已改用 5.1；本入口仍被 `resolveWorkspaceStorageDir()`（只读
字符串 key `storage.dir`，数值诊断已由同函数内 `createConfig({ env })` 汇总上报）与
`config/index.ts` 桶导出保留，外部调用方无需改动即可编译。

### 5.3 `logging.format` 的取舍

非法 `ZCODE_LOG_FORMAT` 仍返回 `"text"`，与本层默认无关——因为返回 `"text"` 与「忽略」的
最终值恰好相同（`DefaultConfig.logging.format === "text"`），但二者对**下层覆盖**不等价：
忽略会让文件层的 `json` 生效，即环境变量不再能压制项目配置。那是与超时缺陷无关的行为变更，
本 spec 明确不做，只补上诊断让降级可见。此项列为已知不对称。

### 5.4 `getToolConcurrencyConfig(env = process.env)`

遗留的直读入口，无调用方（仅 `config/index.ts:483` re-export）。
现在接受可注入的 `env`（默认 `process.env`，向后兼容），非法值回落到
命名常量 `DEFAULT_MAX_TOOL_CONCURRENCY = 10`，不再产出 0。
该入口**没有诊断通道**，因此本 spec 认定它是重复默认值的来源，应被 `ConfigPort`
取代或删除；在其消亡前必须与 `DefaultConfig` 保持同一个数字。

## 6. Fail-open 规则（项目法律）

- 本层不得抛异常、不得 `process.exit`、不得阻断启动：任何非法值走「忽略 + 诊断」，
  调用方只读返回值就能继续。
- 本层不得移除既有安全边界：非法超时一律回落默认（180000），而不是变成「无超时」。
- 诊断必须有消费者（M2 已闭环）：`createConfig()` 改用 `parseEnvConfigWithDiagnostics`，
  env 诊断与 user/project 诊断在 `logConfigDiagnostics` 同一入口、同一字段命名
  （`configScope:"env"`、`diagnosticCode/Message/Path`、`event: "config.env.invalid"`、`envKey`）
  上报到既有 logger。env 解析被提前到上报之前，但它是 `options.env` 的纯读取，
  合并顺序与优先级不变；全部 env 值非法时 Env scope 仍整体缺席（不产生空覆盖层）。
- 不新增第三方依赖、不新增运行时 value import（本层保持仅 `import type` 依赖 `@zcode/contracts`，
  使本层可被 `node --test` 直接装载）。

## 7. 明确不做

- 不改字符串类 key（storage/proxy/caCert）。文件层对它们要求 `z.string().min(1)`，
  但 Env 层空串在 `resolveProxyForRequest` 与 storage 解析里已经是 falsy 走回落，
  没有证据表明其造成安全边界消失；改动会牵连代理与存储目录解析，属于无关变更。
- 不新增 `ZCODE_*` key（`apps/zcode-cli/AGENTS.md` 明确要求新变量先定义用途与测试）。
- 不改 `RuntimeConfigPatch` / `ConfigKey` / schema 定义。

## 8. 验收场景（given/when/then）

1. **GIVEN** 无其他配置来源 **WHEN** `parseEnvConfig({ ZCODE_HTTP_TIMEOUT: "30s" })`
   **THEN** `config.network` 为 `undefined`（不产生空对象），`diagnostics` 有 1 条
   `reason = "invalid_number"`、`envKey = "ZCODE_HTTP_TIMEOUT"`、`path = "network.timeout"`；
   经 `ConfigPort.getAll()` 后 `network.timeout === 180000`（超时仍被挂上）。
2. **GIVEN** 无其他配置来源 **WHEN** `parseEnvConfig({ ZCODE_HTTP_TIMEOUT: "0" })`（D-B 之后的语义）
   **THEN** `config.network.timeout === 0`、`diagnostics` 为空，`getAll()` 保留 0（回落表达式只把
   `undefined` 当缺席），于是 `http/index.ts:79` 的 `timeoutMs > 0` 为假 ⇒ **请求超时被显式关闭**。
   同一输入对 `ZCODE_MAX_TOOL_CONCURRENCY` 必须是 `reason === "zero_not_allowed"` 且整体缺席。
3. **GIVEN** 无其他配置来源 **WHEN** `parseEnvConfig({ ZCODE_MAX_TOOL_CONCURRENCY: "abc" })`
   **THEN** `config.toolConcurrency` 为 `undefined`，诊断 `reason = "invalid_number"`，
   有效并发为默认 10 而不是 0。
4. **回归控制（防「一律忽略」式假修复）** **WHEN** `parseEnvConfig({ ZCODE_HTTP_TIMEOUT: "45000", ZCODE_MAX_TOOL_CONCURRENCY: "4", ZCODE_LOG_FORMAT: "json", ZCODE_HTTP_PROXY: "http://example.invalid" })`
   **THEN** `network.timeout === 45000`、`toolConcurrency.maxConcurrency === 4`、
   `logging.format === "json"`、`network.httpProxy === "http://example.invalid"` 且 `diagnostics` 为空。
5. **GIVEN** 用户文件配置 `network.timeout = 60000` **WHEN** 进程带 `ZCODE_HTTP_TIMEOUT=""`
   **THEN** Env scope 不带 `timeout`，合并后仍是 60000（空串不被解析成 0 而覆盖文件配置），
   并产生一条 `reason = "empty"` 诊断。
6. **WHEN** `parseEnvConfig({ ZCODE_TIMEOUT: "30s" })`（别名）
   **THEN** 与场景 1 同语义，诊断 `path` 仍为 `network.timeout`。
7. **WHEN** 传入 `null`/未定义 env、或全是非 `ZCODE_` 前缀的变量
   **THEN** 返回 `{ config: {}, diagnostics: [] }` 且不抛异常。
8. **WHEN** `getToolConcurrencyConfig({ ZCODE_MAX_TOOL_CONCURRENCY: "abc" })`
   **THEN** `maxConcurrency === 10`；`getToolConcurrencyConfig({ ZCODE_MAX_TOOL_CONCURRENCY: "3" })`
   **THEN** `maxConcurrency === 3`；`getToolConcurrencyConfig({})` **THEN** `10`。

## 9. 「显式 0 是否有意义」的结论（D-B 裁决，2026-09-28 更新）

**`network.timeout = 0` 是合法值，语义 = 显式关闭请求超时**；这条语义只对这一个键成立。

- 文件层与 env 层同时放行 0（`schema.ts` 的 `nonNegativeFiniteNumberSchema`、本层的
  `NETWORK_TIMEOUT_RULE = { allowZero: true }`），下游 `resolve-snapshot.ts:109-116` 用
  `stored === undefined` 判缺席，实测 `stored = 0` 能原样穿过 `getAll()/assemble()` 不被吞掉。
- `toolConcurrency.maxConcurrency` 的 0 **保持非法**（reason `zero_not_allowed`）：
  `bootstrap/src/app/dynamic-workflow-run-launch.ts:163` 的 `createWorkflowRunSeatGate({ limit: 0 })`
  是挂死风险，`core/src/tool/scheduler.ts:56` 的 `??` 也不接受 0 作为「取消上界」。
  **不得把 timeout 的新语义推广到别的键** —— 这条不对称是裁决的一部分，不是待统一的历史遗留。

### 9.1 D-B 的代价（必须写在正文里，不是脚注）

设 `ZCODE_HTTP_TIMEOUT=0` 之后，**挂起的请求永不超时**，这是用户主动选择的结果而不是被兜底掩盖的异常。
本仓把 `network.timeout` 当 `timeoutMs` 交给 HTTP 客户端构造的调用点穷举为 **4 处**
（grep `network\.timeout|ConfigKey.HttpTimeout` 全 `apps/zcode-cli/packages`，排除 `adapters/src/config/`、
`adapters/tests/`、`contracts/src/config/index.ts`；`zcode-protocol-v4/product-projection.ts:364,382`
是无关字符串字面量 `fault.network.timeout`）：

1. `bootstrap/src/app/create-app.ts:413` — 主 HTTP 客户端
2. `bootstrap/src/app/script-workflow-child-runtime.ts:213` — 工作流子运行时
3. `bootstrap/src/app/workflow-facade.ts:319` — 工作流门面
4. `bootstrap/src/auth-login.ts:386` — **登录/OAuth 请求**

即：关掉超时后**登录请求也一起没有超时**，远端不回话时登录会无限挂着而不是几十秒后报错。
`user-decisions.md` 还要求在 `auth-login` 链上留一条可观测提示（关闭超时时 warn/诊断），
那属于 `bootstrap` 射程，本轮未落地，登记为后续项（本层已能在诊断/回落层面对该选择可见）。

## 10. 已知遗留（本层之外）

- （M2 已闭环）`config/index.ts` 桶导出已补 `parseEnvConfigWithDiagnostics` 及
  `EnvConfigDiagnostic`/`EnvConfigInvalidReason`/`ParsedEnvConfig` 类型；
  `createConfig()` 已接入 `logConfigDiagnostics`。全部 env 值非法时 `envConfig` 为 `{}`，
  `Object.keys(envConfig).length > 0` 自然跳过 Env scope——期望语义（不产生空覆盖层）。
- 仍未被执行的验证跳：`config-factory.ts` 与 `config/index.ts` 含 `@zcode/contracts` 的
  value import，裁剪环境 `node --test` 装载即 `ERR_MODULE_NOT_FOUND`，上述接入只能按
  代码审视确认（诊断字段命名、logger 通道、合并顺序），不能在本环境跑端到端断言。
  接入的行为等价性由前提保证：`createConfig` 内 env 解析是 `options.env` 的纯读取。
- `getToolConcurrencyConfig` 与 `DefaultConfig` 存在两份 10，应被 `ConfigPort` 取代。

## 11. 测试入口

`node --test apps/zcode-cli/packages/adapters/tests/env-config.test.ts`
（Node 24 原生 type stripping + 内置 test runner；仓库裁剪后无 vitest/tsc/oxlint，
故 `pnpm typecheck` / `pnpm lint` 在当前环境不可运行，须如实记录。）

场景 1/2/3/5 的「经 `ConfigPort.getAll()` 后得到有效默认值」这一跳**未被执行**：
`config/index.ts` 与 `config-merger.ts` 有 `@zcode/contracts` 的 value import，
裁剪环境会 `ERR_MODULE_NOT_FOUND`。测试改为断言该跳的可观察前提
（`config.network === undefined`，即 `config/index.ts:113` 的 `!== undefined` 守卫不成立、
不会写入 `ConfigKey.HttpTimeout`），并用静态核实 `:281` / `:324-327` 的 `?? DefaultConfig.*` 回落。

## 12. key→默认值映射的唯一归属（gen4 收口，T-缝2 / MAIN-03）

`DefaultConfig`（`contracts/src/config/index.ts:290`）是默认值的唯一所有者；本层原先在
`adapters/src/config/index.ts` 里把**同一份 key→默认值映射写了三遍**：

| 站点 | 原形态 | 现在 |
| --- | --- | --- |
| `getDefaultValue()`（原 `:369-450`） | 40 路 switch，逐键 `return defaults.x.y` | 删除，改调 `documentedDefaultOf(DefaultConfig, key)` |
| `getAll()`（原 `:258-337`） | 逐字段 `?? DefaultConfig.x`，且 `features.*`（6 键）/`skills.enabled`/`skills.includeInstructions` 用字面量 `?? true`、`logging.level` 用 `?? "info"` | 删除，改调 `assembleConfigSnapshot(this.store.lookup(), DefaultConfig)` |
| `merge()` 内的深合并缺省 | `?? DefaultConfig.modelAnomalyGuard`、`?? DefaultConfig.hooks` | 改调 `resolveConfigValue(...)` |

收口落点：`adapters/src/config/resolve-snapshot.ts`（零运行时依赖，只有 `import type`，
因此可被 `node --test` 直接加载）。它持有三件事，且各只有一处：键清单
`CONFIG_SNAPSHOT_KEYS`（39 个键，等于 `getAll()` 的字段集）、键到默认值的路径
（`defaultPathOf`，只有 `skill → skillOverrides`、`command → commandOverrides` 两个例外，
因为 `ConfigKey` 是点号字符串常量而不是枚举）、以及唯一的回落表达式
`resolveConfigValue`。`index.ts` 从 500 行（已违反 CLI AGENTS.md 的 ≤400 法律）降到 364 行，
公开导出面 34 个名字不变。

回落语义**没有**改变：`resolveConfigValue` 显式写成 `stored === undefined ? 默认 : stored`，
即只把「缺席」当缺省，`0` / `false` / `""` 都是已存值（这是 §9 口径的实现前提）。

新增的可执行证据（`adapters/tests/config-resolve-snapshot.test.ts`，8 例全绿）：

- 逐键断言「回落值 === 注入表里该键的值」，并用**哨兵表**（每个键的默认值替换成可识别字符串）
  装配整份快照与手写期望形状 `deepStrictEqual`：任何残留的 `?? true` / `?? "info"` 都会在这里失败。
- 漂移用例：把表里的 `features.compact` 翻成 `false`、`logging.level` 翻成 `"warn"`，
  断言解析结果跟着表走（已用变异副本证伪：把硬编码字面量塞回解析器后读数是
  `[true,"info"]`，与断言的 `[false,"warn"]` 冲突 → 断言不是空转）。
- `get()` 口径与 `getAll()` 口径逐键相等（`pickByPath(assembled,k) === snapshot[k]`），
  并与从 contracts 源码里取出的 `DefaultRuntimeConfig` 字面量逐键相等——MAIN-03 原先靠人读源码
  确认的「今天一致」现在是断言。
- 静态校验 `index.ts`：剥掉注释后不得再出现 `?? true` / `?? false` / `?? "info"` /
  `?? "text"` / `?? DefaultConfig.`，也不得再有 `getDefaultValue`/`hasDefaultValue`。

### 12.1 唯一的行为偏差（只发生在抛错路径，且射程比原先记载更窄）

原 `getDefaultValue()` 的 switch 缺 `ConfigKey.SkillOverrides` / `CommandOverrides` 两个 case，
于是 `get("skill")` 抛「Config key not found」而 `getAll()` 却回落成 `{}`，`has("skill")` 恒为 false。
键清单统一后这两个键有了 documented default：`get("skill")` 返回 `{}`、`has("skill")` 为 true。

**措辞收窄（M5 draft-scan 的更正）**：那个 throw 在生产链路上本来就到不了 ——
`config-factory.ts:235-236` 会把 `DefaultRuntimeConfig` 作为 System 层种子喂给 `merge()`，
`merge()` 因此总是写入这两个 key，旧的 `get()` 在真实启动路径上读出 `{}` 而不是抛错。
所以准确说法是：**原 throw 只在「某个 `ConfigPort` 的初始 patch 省略了这两个字段」时才可观察**
（例如直接 `new ConfigPortImpl()` 后不 merge），不是进程级的既有行为。

实测本检出内没有任何调用方用 `get`/`has` 读这两个键（`bootstrap` 的四处消费方都读
`getAll()` 结果的 `skillOverrides`/`commandOverrides`，`config-merger.ts` 同理），
且 `ConfigPort.has()` 全仓零调用方。本 spec 认定原形态是同一份映射写三遍造成的分裂，而不是契约。

### 12.2 `network.timeout === 0`：从「无人能写」变成「有一条受裁决的入口」

`getAll()` 的回落保留 store 里的 `0` ⇒ `http/index.ts:79` 的 `timeoutMs > 0` 为假 ⇒ 计时器不挂。
M5 之前这条终态不可达（env 被 `not_positive` 挡、文件被 `.positive()` 挡），现在 **env 与文件两条路都能
合法写入 0**，这是 D-B 的选择而非漏项；代价见 §9.1。
仍然生效的守卫：`0` 之外的一切非法形态（空串、`30s`、`NaN`、`Infinity`、负数）继续被拒并出诊断，
`> MAX_TIMER_DELAY_MS` 的有限值新增被拒（MAIN-07，替代原来的 `TimeoutOverflowWarning` 钳成 1ms），
非字符串输入不再抛 `TypeError`（MAIN-08）。`ConfigPortImpl.set()` 与 `merge()` 仍是无校验入口，
本轮不新增兜底分支。

### 12.3 `merge()` 为什么仍逐键写（刻意不收口）

`merge()` 是「`RuntimeConfigPatch` 路径 → `ConfigKey`」的**写入**映射，不是默认值映射，
且各键的在场判据不一致：`permission.mode`、`storage.dir`、`storage.sessionDbPath`、
`logging.level` 用 truthy，其余用 `!== undefined`。把守卫统一成 `!== undefined` 会让
`ZCODE_STORAGE_DIR=""`、`logging.level=""` 这类空串写进 store，从而把 `getAll()` 的读数从
默认值改成 `""`——那是行为变更，超出本条发现的射程。本轮只把它内部的两处缺省并入唯一回落点，
其余形态记账为后续项（若要收口，需先逐键定「在场且为空串」的语义）。

## 13. M5 落地补记（MAIN-08 / MAIN-09 / 测试入口）

### 13.1 fail-open 承诺的可执行版本（MAIN-08）

§6 那句「本层不得抛异常」原先是**说过头了**：`process.env` 只放字符串，但
`config-factory.ts:192` 走的是可注入的 `options.env`，类型只靠 TS 兜着。实测（改前）
`{ZCODE_HTTP_TIMEOUT: {} | [] | 10 | true}` 会让 `parseEnvConfigWithDiagnostics` 抛
`TypeError: (value ?? "").trim is not a function`；`ZCODE_LOG_FORMAT` 同形（含 `null`，
因为该分支调 `.toLowerCase()`）。现在非字符串一律落为 reason `non_string_value` 的诊断 + 该 key 整体缺席，
不再抛错；诊断的 `value` 字段仍是 `string`（对象渲染成 `object`/`array`，标量渲染成 `String()`），
以免 logger 的消费者去做类型分支。`null` 的既有行为按实测保持不动：数值键仍走 `?? ""` 落为 `empty`。
**残留射程**：字符串透传类 key（storage/proxy/caCert）的非字符串输入仍原样写入（§7 明令不改），
它们不会抛错，因此不违反 fail-open，但类型正确性没有守卫 —— 记为已知边界，不是本轮缺陷。

### 13.2 表值的第二持有者只能用源码扫描断言（MAIN-09）

`env-config.adapter.ts` 的 `DEFAULT_MAX_TOOL_CONCURRENCY = 10` 与 `DEFAULT_NETWORK_TIMEOUT_MS = 180000`
是 `DefaultConfig` 数值的副本。**修法约束**：不许改成 import 真实表 —— 本模块的全部价值在于只有
`import type`，一旦 value import `@zcode/contracts` 就变不可加载，env 用例会整体退化成 WARN。
因此 `adapters/tests/env-config-timeout-zero.test.ts` 里的断言是**读源文本做正则比对**：
`contracts/src/config/index.ts` 的 `timeout:` / `maxConcurrency:` 数字字面量（各自恰好 1 处，计数也进断言）
必须等于 adapter 声明的同名常量，且 fallback 文案必须插值自这些常量。

这不保证的东西要说清：它是**文本比较守卫，不是共享常量**。它不看运行时求值、不覆盖
`DefaultConfig` 经函数/表达式/多层展开得到的值、不检查类型一致性，改格式（拆行、加注释、换成语句等价写法）
就可能假红或假绿；真正的单点归属仍然是把默认值集中到 `DefaultConfig` 并删掉这个直读入口（§5.4）。

### 13.3 `getAll()` 输出里 `plugins.*` 的键顺序不保证

M4 装配后 `plugins` 组内键的**顺序**变了（`enabled` 提前），因此 `JSON.stringify(getAll())` 的字节
与 pre-M4 不同。本 spec 认定**对象键顺序为 unspecified**：任何按字节比较 `JSON.stringify` 输出的消费方
都视为契约误用，需要自行排序后再比较。（本环境未穷举按字节比较的消费方，此项为边界声明。）

### 13.4 测试入口

- `node --test apps/zcode-cli/packages/adapters/tests/env-config.test.ts`（21 例）
- `node --test apps/zcode-cli/packages/adapters/tests/env-config-timeout-zero.test.ts`（30 例：§4.1 每步一条、
  顺序不可交换、MAIN-07 上界与并发键不对称、MAIN-08 非字符串、MAIN-09 源码扫描漂移断言）
- 整仓：`node docs/evolution/verify.mjs`

