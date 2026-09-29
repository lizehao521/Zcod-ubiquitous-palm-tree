# gen1 修复报告：日志落盘热路径异步化（fix-logging-io）

范围：`apps/zcode-cli/packages/adapters/src/logging/`
Spec：`specs/logging-persistence/spec.md`
结论口径：只改了「字节何时落盘」，没改日志级别、格式、脱敏规则、保留天数。

## (a) 已确认的热路径

`apps/zcode-cli/packages/adapters/src/logging/index.ts:119-141`（修复前）的同步 `log()`：

- `ensureLogDir(this.logDir)` → `existsSync` + 条件 `mkdirSync`（原 `:240-245`）
- `getLogFileName()` 每行重新 `new Date()` 计算（原 `:247-249`）
- `appendFileSync(logPath, line, "utf8")`（原 `:133`）

调用链：`createNodeLoggerFactory` → `NodeFileLogger.log()`（`child()` 复用同一份依赖，原
`:107-117`）。工厂被 `packages/cli/src/run.ts:490`、`packages/bootstrap/src/zcode-protocol-entrypoint.ts:98`、
`packages/bootstrap/src/app/create-app.ts:165`、`packages/adapters/src/config/config-factory.ts:412` 使用。
`debug` 按 AGENTS.md 承载「协议原始数据、流式 chunk、逐条工具更新」，仓库内 `.debug(` 调用点 107 处
（例如 `packages/core/src/runtime/methods/model.ts:191` 按 tool-input delta 逐条 flush），
所以每行 2~3 次同步 syscall 直接压在 agent loop 上，与「使用异步文件和网络 IO」冲突。

原 `catch {}`（`:134-136`，注释「Logging must never break the agent execution path」）是必须保留的契约。

## (b) 队列设计

新模块 `logging/append-queue.ts`（361 行，零运行时外部依赖，fs/时钟/调度全注入）；
`logging/index.ts`（389 行）只做接线。

- **唯一所有者**：一个工厂 = 一个 `AppendQueue` = 一个写者；`child()` 共享同一实例，
  不新建第二条落盘链路。
- **边界**：`maxRecords=2000`、`maxBytes=1MiB`（内存上界由字节 cap 保证，条数 cap 是次级）、
  `flushIntervalMs=200`、高水位 `maxBytes*0.5`、退避 `100ms → 上限 2s`、
  `maxConsecutiveFailures=8`、自我上报窗口 `5s`。全部提取为 `LOG_APPEND_*` 常量，
  可经 `NodeLoggerFactoryOptions.appendQueue` 覆盖（未新增环境变量）。
- **入队即热路径**：`log()` = 级别过滤 → `createEntry` → `toSerializableEntry`（脱敏在入队前，
  批量不绕过 redactor）→ `JSON.stringify` → `enqueue(fileName, line)`。零 syscall。
  `ensureLogDir` 的 `existsSync` 换成 writer 里的 `dirReady` 缓存 + `mkdir(recursive)`。
- **Drop 策略**：drop-oldest（保留最新上下文），累加 `droppedRecords`/`droppedBytes`；
  单条超过 `maxBytes` 直接拒绝并入列 `rejectedOversizedRecords`（入队会破坏字节上界，
  同步写回会把阻塞带回热路径）。丢弃/写失败按 5s 窗口自我上报一次：有 console stream 就写
  console（不回流队列，避免递归），否则落一行 `log.append.queue.degraded` 日志。
  计数器永远可由 `factory.getAppendQueueStats()` 拉取。
- **顺序与轮转**：FIFO + 连续同名分组，每组一次 `appendFile`；**文件名在入队时按 entry 自身
  timestamp 决定**（而不是写出时再取一次 `new Date()`），所以排空过程中跨午夜时旧行进旧文件、
  新行进新文件，同时修掉「entry 时间戳与文件名可能不同日」的既有隐患。
- **冲刷点**：① `flushIntervalMs` 定时器（一律 `unref()` 且可 `cancelSchedule`，不拖进程退出）；
  ② 高水位 `delay=0` 立即冲刷；③ `LogLevel.Error` 走 `kickNow()`（仍异步）；
  ④ 同步冲刷 `factory.flushSync()` + 工厂注册的 `process.once("exit", () => queue.flushSync())`。
  选 `exit` 而不是新造 shutdown 编排器：现有生命周期（`packages/cli/src/shutdown.ts:60-64,137`）
  最终以 `process.exit()` 收尾，`exit` 回调同步执行，之后异步 IO 不再运行。
- **fail-open**：writer 捕获全部 `mkdir`/`appendFile` 异常（含 `maybeThrowStorageFsFault` 注入），
  不向调用方传播；失败批次回退队首 + 指数退避；连续 8 次失败才丢该批次并计数、清退避后继续接收，
  因此不存在「静默永久禁用」。`appendFile` 失败会复位 `dirReady`，目录被外部删除后能自愈。
  console streaming 行为完全未变。

**崩溃丢失窗口（诚实口径）**：正常最坏 = 最近 `200ms` 内的日志，上界 `2000 条 / 1MiB`；
超过 `maxBytes*0.5` 的量会被高水位提前冲掉，因而实际窗口更小；`Error` 级 ≈ 一个 tick。
走 `process.exit`/CLI 信号关机 → 同步冲刷，丢 `0 条`。`kill -9`、断电、`process.abort()` 拿不到
`exit`，仍是最多 `200ms / 2000 条 / 1MiB`，且这部分丢失无法自证（不会有计数器），属于异步化的既定代价。

## (c) 实际执行的命令与结果

```
$ node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts
ℹ tests 15  ℹ suites 0  ℹ pass 15  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
ℹ duration_ms 746.40   (Node v24.13.0)

$ node --check apps/zcode-cli/packages/adapters/src/logging/index.ts        → OK（无输出）
$ node --check apps/zcode-cli/packages/adapters/src/logging/append-queue.ts → OK（无输出）
```

覆盖用例：A1 控制组顺序/完整性（500 行逐条比对 + `writes<60` 证明批量）、A2 写失败不抛且重试成功、
A3/A3b 上界（循环内断言 `bufferedRecords<=3`、`bufferedBytes<=100` 恒成立 + `droppedBytes=21`）、
A4 超大记录拒绝、A5 `flushSync` 顺序、A6/A6b 在飞写跨午夜轮转与同名分组、A7 单写者
（`maxConcurrentWriters===1`）、A8 持续失败不永久禁用、A9 定时器冲刷、A10 上报去重、
A11 高水位 `delay=0`、A12 `flushSync` 撞在飞批次（不丢不重、`flushSyncRaces=1`）、A13 热路径零 syscall。

未执行 / 不可执行（如实记录，不写成通过）：

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check`、`pnpm knip`：本裁剪检出无 `typescript`/`tsc`、
  无 `oxlint`，根 `packages/`、`scripts/` 不存在，第三方依赖未安装 → **无法运行**。
- **未验证边界**：`logging/index.ts` 无法在本环境被加载执行，实测报
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@zcode/contracts' imported from ...logging/index.ts`
  （`adapters/node_modules/@zcode` 根本不存在，所有 workspace 包都没链接；即使链接了，
  `index.ts` 对 `LogLevel`/`LogLevelName` 的 enum value import 也会让 Node type-stripping 失败）。
  因此「工厂↔队列接线、Error 级 `kickNow`、`process.once("exit")` 冲刷、真实 fs + 故障注入 io 适配」
  目前只有代码审查 + `node --check` 级证据，**没有运行时证明**。这也是把逻辑拆成
  `append-queue.ts` 的原因，而不是藏起来的绕过手段。
- 未做真实磁盘/跨平台 E2E（Windows、macOS、Linux 的实际 `appendFile` 行为、断电窗口）；
  交互与关机链路 E2E 场景需要在完整检出里补。

## (d) 遗留风险

1. E2E 故障注入粒度从「每行一次」变成「每批次一次」，带 `maxMatches` 的规则命中次数会减少；
   错误仍可见并可计数，但既有 E2E 断言若按行数匹配需要复核。
2. 若同一 `logDir` 被多个进程共享（例如 CLI 与 host 同时写），原来就有的跨进程行交错风险不变，
   但每个进程的单写者保证是我这条链路的边界，不覆盖多进程场景。
3. `flushSync` 与在飞异步批次的重叠只保证不丢不重、可能顺序倒置，由 `flushSyncRaces` 暴露；
   `exit` 路径实际不会命中该重叠。
4. 未验证 index.ts 集成（见上）。后续轮次应在完整检出里用 `pnpm typecheck` + 真实 fs 的
   vitest/E2E 场景补证。

## (e) 本次写入的文件

- `specs/logging-persistence/spec.md`（新建，含 owner/边界/drop 策略/冲刷点/丢失窗口/验收表）
- `apps/zcode-cli/packages/adapters/src/logging/append-queue.ts`（新建）
- `apps/zcode-cli/packages/adapters/src/logging/index.ts`（改为入队 + io 适配 + flushSync/exit 钩子 + 观测接口）
- `apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts`（新建，15 个用例全绿）
- `docs/evolution/gen1/logging-report.md`（本文件）

未触碰：`adapters/src/config/*`、`adapters/src/http/*`、`logging/retention.ts`（只读）、
`bootstrap/*`、`.gitignore`；未运行任何 `git` 命令；未加第三方依赖。
