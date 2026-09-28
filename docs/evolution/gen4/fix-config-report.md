# fix-config report · M4 并行汇聚（gen4）

范围：config 默认值解析接缝（Task 1）、`specs/logging-persistence` 范围口径修正（Task 2，纯文本）、
logging 三个存活变异体收口（Task 3，纯测试）。未碰 `adapters/src/exec/*`、`adapters/src/logging/*` 源码、
`append-queue.ts`、`logging-append-queue.test.ts`、`contracts/*`、`bootstrap/*`，未新增 `ZCODE_*`。

## 1. 三处重复映射的确认（改造前）

| 站点 | 位置 | 内容 | 键数 |
| --- | --- | --- | --- |
| S1 `getDefaultValue()` | `config/index.ts:369-450`（+`:451 hasDefaultValue`） | 40 路 switch：key → `defaults.<path>` | 37（**缺 `skill`/`command`**） |
| S2 `getAll()` | `:258-337` | 逐字段 `?? DefaultConfig.x`；其中 `features.compact/rewind/subagent/memory/skill/mcp`、`skills.enabled`、`skills.includeInstructions` 用字面量 `?? true`，`logging.level` 用 `?? "info"`；`network.httpProxy/noProxy/caCertFile` 无回落 | 39 |
| S3 `merge()` | `:76-215` | key↔patch 路径的写入映射（不是默认值表），但内部另有 2 处缺省：`:187 ?? DefaultConfig.modelAnomalyGuard`、`:198 ?? DefaultConfig.hooks` | 39 + 2 |
| S4（附带发现） | `:281` 等 | S1 与 S2 的键集不同 ⇒ `get("skill")` 抛 `Config key not found`（`:255`）而 `getAll().skillOverrides` 回落 `{}`，`has("skill")` 恒 false | — |

文件实测 **500 行**（既有 ≤400 违规，无人报）。MAIN-03 的字面量与 `contracts:308-315,339` 今天等值 ⇒ 漂移风险而非错值。

## 2. 收口形态

新 `adapters/src/config/resolve-snapshot.ts`（162 行，零运行时依赖，`import type` only，可被 `node --test` 加载）：
`CONFIG_SNAPSHOT_KEYS`（39 键，唯一键清单）、`defaultPathOf`（唯一路径映射，只有 `skill→skillOverrides`、
`command→commandOverrides` 两个例外）、`documentedDefaultOf`、`resolveConfigValue`（**唯一 `??` 回落表达式**，
显式写成 `stored === undefined` 以保持 0/false/"" 的在场语义）、`resolveSnapshot`（扁平）、
`assembleConfigSnapshot`（形状由路径生成，因此装配处不可能再长出自面量缺省）。
`index.ts` 的 `get()`/`has()`/`getAll()` 与 `merge()` 的两处深合并缺省全部改走该接缝。

`index.ts` 500 → **364 行**。行数（全部 ≤400）：`index.ts` 364 / `resolve-snapshot.ts` 162 /
`config-resolve-snapshot.test.ts` 331 / `logging-append-queue-options.test.ts` 309。

## 3. 导出面平价（同一脚本、同一正则，改造前后）

`export` / re-export 名集合，脚本 = `^export (class|function|const|type|interface…)` + `^export {…} from` 拆分：
**COUNT=34（前） === COUNT=34（后）**，逐名相同：
ConfigFactoryOptions, ConfigPortImpl, ConfigResult, EnvConfigDiagnostic, EnvConfigInvalidReason,
ParsedEnvConfig, PluginEnabledPatchResult, PluginOptionsPatchResult, PluginRemovePatchResult,
SuppressedBuiltinPatchResult, UiLocalePatchResult, ZCodeConfigFile, ZCodeConfigFileSchema,
addSuppressedBuiltinInFileConfig, createConfig, createConfigPort, createPrioritizedConfig,
enablePluginsByDefaultInFileConfig, getDefaultConfigPath, getScopePriority, getToolConcurrencyConfig,
hasDefaultConfigFile, loadFileConfig, mergeConfigs, parseEnvConfig, parseEnvConfigWithDiagnostics,
removePluginEnabledFromFileConfig, removePluginFromFileConfig, removeSuppressedBuiltinInFileConfig,
resolvePath, resolveWorkspaceStorageDir, updatePluginEnabledInFileConfig,
updatePluginOptionsInFileConfig, updateUiLocaleInFileConfig。

## 4. 真实执行结果

- `node --test .../config-resolve-snapshot.test.ts` → **8 tests / 8 pass / 0 fail**（C1–C8；C8 含逐键 `getAll===get===documented default`）。
- `node --test .../logging-append-queue-options.test.ts` → **9 tests / 9 pass / 0 fail**（O1–O6、U1、F1、D1）。
- `node docs/evolution/verify.mjs` → `files=5 PASS=5 FAIL=0 WARN=0 cases=68/68 fit=100`（基线为 files=2 cases=39/39）。
- `node docs/evolution/baseline.mjs diff pre-gen4` → **新增 10 / 改动 8 / 删除 0**，其中我方 6 项：
  `+resolve-snapshot.ts`、`+config-resolve-snapshot.test.ts`、`+logging-append-queue-options.test.ts`、
  `~config/index.ts`、`~specs/logging-persistence/spec.md`、`~specs/runtime-env-config/spec.md`
  （其余 4 新增 + 3 改动属 fixer A 与主代理文件）。
- `pnpm typecheck` / `pnpm lint` / `architecture:check`：**未执行**（本裁剪检出无 tsc/oxlint/根 `packages`、`scripts`）。
- `config/index.ts` 本身仍不可加载（value import `@zcode/contracts`）⇒ 接缝行为由「纯模块动态测 + 源码静态扫描」两段证据覆盖，
  未做端到端 `ConfigPortImpl` 断言。

证伪探针（`.hermess-snapshots/mut/`，跑完即删）：注入变异体后读数与断言冲突 ⇒ 断言非空转。
`clampPositive` 恒等 ⇒ `maxRecords=0`: buffered=0/dropped=5（应 1/4）、`NaN`: buffered=2300/dropped=0（应 ≤2000/300）、
`schedule delay=NaN`（应 200）；删 `unref` ⇒ `[0,0]`（应每个 ≥1）；`unshift→push` ⇒ `["late","r1","r2"]`（应 `["r1","r2","late"]`）；
把 `?? true`/`?? "info"` 塞回解析器 ⇒ `[true,"info"]`（应 `[false,"warn"]`）。

## 5. 变异体账

已收：M8 选项归一化（O1–O6）、M9 `timer.unref`（U1，旧假句柄是空实现所以观测不到，换成计数器后可证伪）、
M10 失败批次恢复顺序（F1）。仍未收且本轮不做：M7 `drain` await 前的 `inFlight` 接管检查（`:241/:243` 被 `:254` 吸收）
——按 stage-2 裁决需要先给出可驱动的交错时序书面论证，禁止为跑绿加兜底分支。

## 6. 剩余 WARN / 明示

- **唯一行为偏差**：`get("skill")`/`get("command")` 由「抛错」变为返回文档默认 `{}`，`has()` 同步变 true。
  实测本检出内零调用方依赖该抛错（`has()` 全仓无调用；消费方只读 `getAll()`）。已写进 spec §12.1。
- `network.timeout === 0` 的解除超时路由：只经无校验的 `set(:343)`/`merge(:114)` 可达，env 与文件路由均被挡；
  仓库内找不到写 0 的生产调用方 ⇒ **WARN-unverifiable**，未新增守卫分支（0 是否=「显式关闭」属产品决策，已单独提问）。
- `merge()` 未表驱动：truthy 与 `!== undefined` 两种在场判据混用，统一会让 `storage.dir=""`、`logging.level=""`
  落进 store 改变读数 ⇒ 行为变更，超出本发现射程，spec §12.3 记账。
- `clampPositive` 对**上界**无钳制（`maxBytes: 1e15` 透传，O6 只证明条数上界仍独立兜住）——设计事实，非本轮缺陷。
- `getAll()` 返回的数组/对象仍是 `DefaultConfig` 的同一引用（改造前后一致，未新增拷贝）。

## 7. Task 2（纯文本）

`specs/logging-persistence/spec.md` §4：把「同一行会重复一次」改为**整个在飞分组**（实测 3/3 重投、去重后 5 条齐全、无缺失），
重复上界 = 批次上界 `maxRecords`(2000)/`maxBytes`(1 MiB 码元)；保留原取舍理由（重复可去重、临终证据不可恢复）。
新增一条：同步冲刷若暴露给业务路径（今天 `factory.flushSync()` 生产零调用方），必须先定义 rescue 语义；
本轮**不**引入 `rescue` 开关（P2/declined）。§9 增 A17–A20，§11 更新变异体账。
