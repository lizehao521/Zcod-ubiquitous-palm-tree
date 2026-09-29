# M2 交叉审查 · env-config 工作包（gen2, review-env）

## 发现与处置

| ID | 级别 | 位置 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| ENV2-01 | P1 | `config-factory.ts:192`（改前） | `parseEnvConfigWithDiagnostics` 的诊断有产出无消费者：192 走兼容入口，`logConfigDiagnostics`（原 172-177）只收 user/project。作者自报缺口，即本包靶子 | 已修：env 解析提前并入 `logConfigDiagnostics`，同 logger、同字段命名（configScope/diagnosticCode/Message/Path/event/severity，`event:"config.env.invalid"`，另附 envKey/diagnosticReason）。纯读取提前，合并不变；schema.ts 在边界外，未动 |
| ENV2-02 | P1 | `config/index.ts:483` | 桶导出缺 `parseEnvConfigWithDiagnostics` + 3 个类型，包外拿不到诊断入口 | 已修：补齐（含 `ParsedEnvConfig`/`EnvConfigDiagnostic`/`EnvConfigInvalidReason` 类型） |
| ENV2-03 | P1 | `env-config.adapter.ts:26-31` | 注释称与 `ConfigDiagnostic` "structurally compatible" 为假：`env_config_invalid` 不在 `ConfigDiagnosticCode`（`schema.ts:313-316`），且无 `filePath` | 已修：注释改为如实描述（镜像字段名、非同一类型），与 ENV2-01 实现一致 |
| ENV2-04 | P2 | `config-factory.ts` 现 491 行、`config/index.ts` 500 行 | 超 400 行上限是既有基线（改前已 467/491），本包 diff 最小化（+24/+9），拆分超出本轮范围 | 记录 |
| ENV2-05 | P2 | `ZCODE_LOG_FORMAT` 仍回落 "text" | 核对 `config-merger.ts:32-45,133-135`：Env scope 高于 Project/User，若改「忽略」则文件层 `json` 反胜 Env——确属行为变更；spec §5.3 已声明该不对称并只补诊断 | 作者理由成立，不改 |
| ENV2-06 | P2 | `getToolConcurrencyConfig` 双份默认 10 | 全库 grep：除 barrel 与测试外无生产调用方；spec §5.4 已认定其应消亡 | 记录 |
| ENV2-07 | — | 宽松旧行为依赖方 | grep 全部调用点：仅 factory 192/368。无任何代码依赖 `0`（spec §9：文件层 `positive()` 本就拒绝 0/负/Infinity；`core/src/tool/scheduler.ts:56` 的 `??` 不吃 0）。env 此前唯一"覆盖"就是把毒值压过文件层合法值——key 缺席严格更安全 | 审计通过 |

## 变异测试（证明 21 例非空转）

删 `parsePositiveNumber` 单个守卫 → 指向副本跑原测试（scratch 已删）：
- 删 `empty` 守卫 → 1 fail（AC-5 `reason==="empty"` 变 not_positive）。
- 删 `finite` 守卫 → 8 fail（AC-1/AC-3/AC-6/sibling/AC-7 hostile/compat/AC-8；`Infinity`、`NaN` 全漏过——即 m1 矩阵 D1b 的 1ms 毒路径）。
- 删 `positive` 守卫 → 5 fail（AC-2、negative/infinity、hostile、"never yields 0" 边界）。
三守卫全部被抓，无空转；AC-4 对照组防「一律忽略」假修复。

## 实际执行的命令与真实计数

- `node --test apps/zcode-cli/packages/adapters/tests/env-config.test.ts` → **pass 21 / fail 0**（修后）。
- `node docs/evolution/verify.mjs` → env-config **PASS 21/0**；logging-append-queue **FAIL（pass 14/fail 1，属对手机械包）**；SUMMARY `files=2 PASS=1 FAIL=1 WARN=0 cases=35/36 fit=94`。
- 语法探针：`import("./config-factory.ts")`、`import("./config/index.ts")` → `ERR_MODULE_NOT_FOUND '@zcode/contracts'`（= 解析通过、无语法错，但**未运行**）。
- `pnpm lint` / `pnpm typecheck`：本环境不可执行，未运行，不写作通过。

## 剩余未验证跳

1. `createConfig()` 端到端真写出一条 `config.env.invalid` warn（value import 无法装载，仅审视确认）。2. 桶导出运行时可见性。3. `ConfigPort.getAll()` 回落 180000/10 的消费端（前提已静态核实 `config/index.ts:113/:281`、`contracts:306/:343`）。

## 本轮暴露了什么

以前 `ZCODE_HTTP_TIMEOUT=30s` 是"安全的静默降级"——拼错一个环境变量会悄无声息地把超时/并发边界改掉且日志零痕迹；现在它会与文件诊断同批 warn，同时暴露出 factory/barrel 两层在本环境从未被运行时执行过这一事实。
