# gen2 · logging 落盘对抗审查（review-logging）

范围：`adapters/src/logging/*`、`adapters/tests/logging-*.test.ts`、`specs/logging-persistence/spec.md`。
未碰 `fs-fault-injection.ts`（见 F5：无现存断言因此变错）。命令与计数全部为本机实测。

## 发现表

| ID | 级 | 位置 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| F1 | P1 | `append-queue.ts:165-194`（改前）/ `spec.md §4 §7` | `flushSync()` 只冲 `this.records`，在飞批次已被 `drain` 的 `splice` 取走；真实 `process.exit` 路径上那次 `appendFile` 永远不再完成 ⇒ **整批在飞日志消失**，而规格写着「走 exit 钩子丢 0 条」 | **已修**：`flushSync` 接管在飞批次（新计数 `flushSyncRescuedRecords`），writer 恢复后不再写剩余分组；A12/A15 实测 M6 变异 fail=2。两害相权取「最多重复一行」，理由写进 §4 |
| F2 | P1 | `append-queue.ts:299-309`（改前 `trimToCap`） | 队列满时按级别无差别丢最旧：高压路径恰恰最容易堆 Warn/Error，一条 Error 可能是崩溃唯一证据 | **已修**：两级有界策略 —— 先丢未保护，受保护配额 `maxRecords*0.5` / `maxBytes*0.5`，超配额丢最旧受保护并计入 `droppedProtectedRecords`（A14/A16，M4/M5 变异被杀）。队列仍完全有界 |
| F3 | P1 | `index.ts:352-365`（改前） | 降级自报手写 JSON：`level` 写成枚举**数字**、`status: "degraded"` 不在 `isLogStatus` 白名单（`contracts/src/logging/logger.ts:45`），与同一文件其它行（`toSerializableEntry` 产出 `level` 为小写名）不是同一 schema，`packages/debug/server/sources.ts` 解析器会丢行 | **已修**：改走 `toSerializableEntry(entry, redactor)`，脱敏与入队同一条路径（`createLogAppendQueue` 新增 `redactor` 形参） |
| F4 | P1（法律） | `append-queue.ts` 441 行（我改后） | 违反 CLI AGENTS.md 单文件 ≤400 行 | **已修**：契约类型拆到 `append-queue-contract.ts`（64 行，纯类型，`import type` 被擦除 ⇒ 本模块仍零运行时外部依赖，`node --test` 可加载）。现 399 行 |
| F5 | P2 | `spec.md §3` | 原口径称 `maxBytes = 1 MiB` 即内存上界，实际按 `line.length` 记 UTF-16 码元 ⇒ 常驻 ≈2 MiB，落盘 UTF-8 更大 | 记入 spec（§3 单位口径），不改热路径换算（不新增扫描成本） |
| F6 | P2 | `index.ts:383` + 4 个工厂创建点（`zcode-protocol-entrypoint.ts:98`、`create-app.ts:165`、`config-factory.ts:412`、`cli/src/run.ts:490`） | 每实例一个 `process.once("exit")`，从不移除；第 11 个实例触发 `MaxListenersExceededWarning`，多实例各持一个队列同时追加同一 `.jsonl` ⇒ §2 的「每进程一个队列」不成立 | 记为 P2 + 纠正 spec 措辞。改法（模块级单监听 + 队列集合）会把 `index.ts` 推过 400 行，本轮不做 |
| F7 | P2 | `index.ts:100/119/147` | `NodeFileLogger.logDir` 已成死字段（落盘目录由队列持有） | 记录，未删（牵动 `child()` 签名） |
| F8 | P2 | `append-queue.ts` M7-M10 存活变异 | `clampPositive/clampRatio` 无测试注入非法配置；`timer.unref` 本环境不可观测；失败批次 `unshift` 的 FIFO 恢复顺序无人断言；`drain` 里 await 前的接管检查被 await 后同类检查覆盖（冗余分支） | 记录（无效守卫清单），未强行补 |

## 各退出路径丢失窗口（实测源码，非推测）

自然退出、`process.exit`（`shutdown.ts:63/137`）、SIGINT/SIGTERM/SIGHUP（`shutdown.ts:54-64`）、
协议入口 fatal（`main.ts:42-46`）、非协议入口未捕获异常（Node 默认打印后仍走 `exit`）：
**接管后 0 条**（原实现为「在飞整批」）。强杀/断电/`process.abort()` 与 Windows 控制台关闭
（`shutdownSignals()` 在 win32 只注册 SIGINT/SIGTERM）：**≤2000 条 / ≤1 MiB 码元 / ≤200ms，且无法自证**。
未发现「既不 exit 也不 flush」的第三类路径。

## 命令与真实结果

- `node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts` → `tests 18 / pass 18 / fail 0`（基线 15/15）
- `node docs/evolution/verify.mjs` → `files=2 PASS=2 FAIL=0 WARN=0 cases=39/39 fit=100`
- 变异（副本 `.hermess-snapshots/mut/`，已删）：M1 fail=1、M2 fail=1、M3 fail=3、M4 fail=1、M5 fail=2、M6 fail=2；M7/M8/M9/M10 SURVIVED
- `node --check logging/index.ts` OK；`wc -l`：append-queue 399 / index 398 / contract 64
- **未执行**：`pnpm lint`、`pnpm typecheck`、`pnpm architecture:check`（本机无 oxlint/tsc/vitest、无第三方依赖、根 `packages/`+`scripts/` 缺失）——不写成通过
- **未验证边界**：`index.ts` 装配面（第三参 `preserve`、`LogLevel.Error` 的 `kickNow`、`exit` 钩子、`redactor` 形参传递）在本检出不可加载，仅代码审查级证据

## 本轮暴露出此前被隐藏的东西

「exit 时丢 0 条」是靠一条永远不会完成的异步写撑起来的假保证 —— 现在它被拆成可计数的
`flushSyncRescuedRecords`，代价是多出来一条真实的取舍：**临终路径可能重复一行**；
同时两个文件都贴着 400 行上限（399/398），下一轮任何新增都必须先拆文件，而不是先加守卫。
