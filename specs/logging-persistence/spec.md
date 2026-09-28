# Spec: 日志落盘链路（logging persistence）

状态：已采纳（gen1 修复 `fix-logging-io`）
适用范围：`apps/zcode-cli/packages/adapters/src/logging/`
不适用范围：日志级别、日志格式、脱敏规则、保留天数（本 spec 明确不改）

## 1. 问题（bug 原因）

`adapters/src/logging/index.ts:119-141` 的 `log()` 每写一行都做三件同步 syscall：

1. `ensureLogDir()` → `existsSync` + 可能的 `mkdirSync`（`index.ts:240-245`）；
2. `getLogFileName()` 每行重新 `new Date()` 计算；
3. `appendFileSync(logPath, line, "utf8")`。

`debug` 按 AGENTS.md 的定位承载「协议原始数据、流式 chunk 和逐条工具更新」等最高频诊断
（仓库内 `.debug(` 调用点 107 处，`core/src/runtime/methods/model.ts:191` 等按 tool-input
delta 逐条 flush），因此这条同步写盘路径直接阻塞 agent loop，与 AGENTS.md「使用异步文件
和网络 IO」冲突。

## 2. 所有者与职责

| 对象 | 唯一所有者 | 职责 |
| --- | --- | --- |
| `LoggerFactory` 实例（**每个实例一个队列，不是每进程一个**） | `createNodeLoggerFactory` | 持有唯一一个 `AppendQueue`（该实例的唯一写入者） |
| 待落盘记录队列 | `AppendQueue`（`logging/append-queue.ts`） | 内存有界队列、批量写、轮转分组、失败计数、drop 计数 |
| 真实 fs 与故障注入 | `logging/index.ts` 的 io 适配（`node:fs` / `node:fs/promises` + `maybeThrowStorageFsFault`） | 只做 `mkdir` / `appendFile`，不持有业务状态 |
| 脱敏 | `toSerializableEntry(entry, redactor)`（`logging/serialize.ts`，不改） | 入队前完成；批量写只搬运已序列化好的整行 |
| 保留清理 | `logging/retention.ts`（不改语义） | 仍按文件名日期删除，保留 7 天 |

`log()` 只做：级别过滤 → 构造 entry → 脱敏 → `JSON.stringify` → `queue.enqueue(fileName, line)`。
`existsSync` / `mkdirSync` / `appendFileSync` 从调用方线程移除。

## 3. 队列接口与边界

```
enqueue(fileName: string, line: string, preserve?: boolean): boolean   // 永不抛错
flushSync(): void                                    // 关机/fatal 同步冲刷
stats(): AppendQueueStats                            // 观测：缓冲、写入、丢弃、失败计数
```

`preserve = true` 由 `log()` 在 `level >= LogLevel.Warn` 时传入（`index.ts`），队列本身不认识
`LogLevel`（避免把 contracts 的枚举值导入带回这个必须可被 `node --test` 加载的模块）。

边界（默认可配置，测试注入小值）：

- `maxRecords = 2000`：未写出的记录条数上限。
- `maxBytes = 1 MiB`：未写出的上限（内存上界的真正来源）。
- `line.length + 1` 计入字节，**单位是 UTF-16 码元而不是磁盘字节**：1 MiB 码元 ≈ 2 MiB 常驻内存，
  落盘后的 UTF-8 体积（中文 1 字 = 3 字节）更大。热路径不做逐字符扫描换算，因此内存上界按 ≈2 MiB
  声明，不得写成 1 MiB。
- 单条超过 `maxBytes` 的记录直接拒绝入队并计入
  `rejectedOversizedRecords` —— 入队会立刻破坏字节上界，同步写回又会把阻塞带热路径，
  所以「丢弃并计数」是唯一同时满足内存上界与不阻塞的选择。

## 4. 顺序与轮转保证

- 队列是 FIFO；批量写按入队顺序拼接，同一个文件内的行顺序与 `log()` 调用顺序一致。
- 记录在**入队时**绑定目标文件名（`index.ts` 用 entry 自身的 timestamp 计算 `zcode-YYYY-MM-DD.jsonl`），
  而不是写出时再算。由此：跨午夜时队列仍在排空，旧记录落旧文件、新记录落新文件；
  同时修掉「entry 时间戳与文件名各取一次 `new Date()` 可能跨天不一致」的既有隐患。
- 单次批量写按连续相同文件名分组，每组一次 `appendFile`；不同日期文件之间不交错。
- 只有一个写入者：`draining` 标志保证并发 `kick`/`flushSync` 不会对同一文件产生交错写。
- `flushSync()` 与在飞异步批次重叠时（gen2 修正，原文口径是错的）：**保证不丢**。
  在飞批次已经被 writer 从队列取走，而 `process.exit()` 之后它永远不会再完成，
  原实现只冲「尚未取走」的记录 = 整批在飞日志消失。现在 `flushSync()` 把在飞批次一起同步写
  （计入 `flushSyncRescuedRecords`），并把它标记为已接管，writer 恢复后不再写剩余分组。
  代价：若那次异步 `appendFile` 其实已经落盘（只有这种「已完成 syscall、未跑微任务」的窄窗口
  才会发生，且真实 exit 路径不可能走到），**重复范围是交给 writer 的整个在飞分组，不是「同一行」**
  （gen4 按主代理的确定性探针修正原口径：3 条在飞 + 2 条 pending 时调用 `flushSync()`，
  sink 实收 8 行、去重 5 行、重复 3 行 = 在飞分组全部重投，**无缺失**）。
  重复量的上界由批次上界承担：条数 `maxRecords`（默认 2000）、体积 `maxBytes`（默认 1 MiB
  UTF-16 码元），不是「最多一行」。顺序也可能倒置，计入 `flushSyncRaces`。
  取舍依据：重复行可事后去重，丢失的临终证据不可恢复。
- `drain` 里有**两道**接管检查，覆盖两个不同窗口（gen5 按 MAIN-06 定案，推翻 stage-2「await 前那道被
  await 后那道吸收」的判断）：`append-queue.ts:241` 在 `await this.io.ensureDir` **之前**拦一次，覆盖
  「接管发生在 `ensureDir` 这段 await 期间」；`append-queue.ts:243` 在 `await this.io.appendBatch` **之后**
  拦一次，覆盖「接管发生在某个分组 `appendBatch` 期间」。删掉 :241 时，`ensureDir` 挂起窗口内已被
  `flushSync` 接管的那一组会**再被异步写一次 = 整组重复**——这是**可永久观测**的性质（注入 sink 可证伪），
  因此必须钉住：接管发生在 `ensureDir` 窗口时该批到达 `appendBatch` 的次数必须是 0、sink 实收行集无重复。
  既有 `A5/A12/A15` 把写门控在 `appendBatch`（只测 :243），`ensureDir` 窗口此前无人断言，由 **A21** 补上。
  重复范围口径同上一条：一个在飞分组，上界由 `maxRecords`/`maxBytes` 决定（与 §4 上文及 M4 修正一致）。
- 同步冲刷的暴露面（gen4 记账）：当前 `NodeLoggerFactory.flushSync()` 在生产代码里**零调用方**，
  唯一使用者是工厂注册的那个 `process.once("exit")` 钩子，所以「活进程里整组重复」是潜在风险而非
  活缺陷（定级 P2）。**若将来把同步冲刷暴露给业务路径，必须先在本 spec 定义它的 rescue 语义**
  （是救在飞分组还是只冲 pending、重复上界多少、能否关闭），再开代码路径；
  gen4 明确不引入 `flushSync({ rescue })` 开关——为不存在的调用方设计开关属于过度处理。

## 5. Drop 策略与自我上报

- 队列满时 **分级 drop-oldest**（gen2 修正）：先丢未保护（Debug/Info）记录里最旧的，
  `preserve`（Warn/Error）记录最后才丢。理由：一条 Error 常常是崩溃的唯一证据，而队列满
  恰恰发生在高压路径，按级别无差别丢最旧的 = 专门在最需要的时候丢证据。
- 受保护记录同样有上界，不做无限优待：`maxProtectedRecords = maxRecords * 0.5`、
  `maxProtectedBytes = maxBytes * 0.5`（`DEFAULT_PROTECTED_RESERVE_RATIO`）。超配额时丢最旧的
  受保护记录并计入 `droppedProtectedRecords`。两级上界都在，队列仍然完全有界；
  被收窄的是「Debug/Info 的存活率」，暴露出来的是「错误风暴会挤掉普通日志」这一原本不可能的行为。
- 每次丢弃累加 `droppedRecords` / `droppedBytes`；写入失败丢弃累加同一计数并单列
  `writeFailures` / `writeFailedRecords` / `rejectedOversizedRecords` / `droppedProtectedRecords`。
- 首次（以及每 `selfReportIntervalMs = 5s` 一次）在发生丢弃或写失败时，向 `selfReport` 回调
  输出一条带 `reason` 的 `AppendQueueStats`（reason 取值：`queue-full` / `queue-full-protected` /
  `write-failed` / `oversized` / `flush-sync-failed`）。上报路径**不经过 `log()`**，因此不会形成
  「上报失败 → 再入队 → 再失败」的递归放大；上报本身失败也被吞掉。
  - 有 console stream（`ZCODE_LOG_CONSOLE=1` 或 `console: {...}`）时写到该 stream；
  - 没有 console stream 时退化为把同一摘要作为一行 `log.append.queue.degraded` 日志入队，
    受同一个 5s 限速约束（每窗口最多一行，量有界），保证「静默丢弃」在纯文件日志场景仍可见。
    gen2 修正：这一行改走 `toSerializableEntry(entry, redactor)`，不再手写 JSON 字面量 ——
    原样把 `level` 写成枚举数字、`status` 写成 `"degraded"`（不在 `isLogStatus` 白名单内），
    与同一文件里其它行不是同一个 schema，`packages/debug/server/sources.ts` 的解析器会丢行。
- 丢弃与失败都不会关闭日志：入队路径永不抛错，writer 失败后退避重试。

## 6. 冲刷点（flush points）

1. 定时器：`flushIntervalMs = 200ms`，且 handle 一律 `unref()` 并可被 `cancelSchedule` 撤销，
   日志队列不得拖延进程退出。
2. 批量阈值：缓冲字节达到 `maxBytes * 0.5` 时立即以 `delay=0` kick（不等定时器）。
3. 错误级别：`LogLevel.Error` 入队后调用 `kickNow()`（仍是异步，不阻塞调用线程），缩小
   「临终日志」窗口。
4. 同步冲刷：`NodeLoggerFactory.flushSync()`，并由工厂在创建队列时注册
   `process.once("exit", () => queue.flushSync())`。选 `exit` 是因为现有 CLI 生命周期
   （`packages/cli/src/shutdown.ts:60-64`、`:137`）最终以 `process.exit()` 收尾，而
   `process.exit()` 会同步触发 `exit` 事件，异步 IO 在此之后不再执行；这是当前仓库唯一
   可靠的同步关机钩子，本模块复用它而不是新增第二个 shutdown 编排器。

## 7. 崩溃丢失窗口（按退出路径分别给口径，gen2 重算）

上界：条数 `maxRecords = 2000`、体积 `maxBytes = 1 MiB` UTF-16 码元（≈2 MiB 内存）、时间 `≤200ms`。

| 路径 | 实测依据 | 最坏丢失 |
| --- | --- | --- |
| 自然退出（handle 耗尽） | Node 在 `exit` 前触发，`flushSync` 生效 | 0 条（顺序可能倒置，见 §4） |
| `process.exit()` / `process.exitCode` 收尾 | `cli/src/shutdown.ts:63` `exitProcess(...)`、`:137` watchdog | 0 条 |
| SIGINT / SIGTERM / SIGHUP | `shutdown.ts:54-64` → `await cleanup` → `exitProcess(code)` → `exit` | 0 条 |
| 协议入口 fatal（uncaughtException / unhandledRejection） | `cli/src/main.ts:42-46` → `lifecycle.requestShutdown` 或 `process.exit(1)` → `exit` | 0 条 |
| 非协议入口的 uncaughtException | `main.ts:39-48` 只在 `isProtocol` 时装边界；否则 Node 默认打印栈并**以非 0 退出**，仍触发 `exit` | 0 条 |
| `node-repl-host/src/process-lifecycle.ts:50` 自定义 `uncaughtException` 后**不退出** | 该 handler 只 report 不 exit | 继续运行，队列照常冲刷；无额外丢失 |
| `kill -9` / TerminateProcess / 断电 / `process.abort()` | 拿不到 `exit` | ≤2000 条 / ≤1 MiB 码元 / ≤200ms，且**无法自证**（进程没了，计数器也没了） |
| Windows 控制台关闭（无 SIGTERM 语义） | `shutdownSignals()` 在 win32 只注册 SIGINT/SIGTERM | 同 `kill -9` 行 |

关键结论：本仓库当前**不存在**「既不 exit 也不 flush」的路径 —— 所有可控退出都收敛到
`process.exit`/自然退出，`process.once("exit")` 够用。真正拿不到的只有 SIGKILL 类强杀，
这是同步写盘改异步的既定代价，规格上明确接受。

## 8. 失败语义（fail-open）

- writer 捕获所有 `ensureDir` / `appendFile` 异常：不向 `log()` 调用方传播（保留原
  `index.ts:134-136` 「Logging must never break the agent execution path」保证）。
- 失败批次按 `min(backoffInitialMs * 2^(n-1), backoffMaxMs)`（默认 100ms → 上限 2s）重试；
  重试期间记录仍入队（受上界约束）。
- 连续失败达到 `maxConsecutiveFailures = 8` 时放弃该批次（计入 `droppedRecords`），清空退避并
  继续接收新日志 —— 「永久禁用」必须有可见计数，这里体现为 `writeFailures` 单调增长。
- 目录只建一次（`dirReady` 缓存），省掉原来的每行 `existsSync`；`appendFile` 失败时复位该缓存，
  下一次 drain 会重新 `mkdir`，避免「目录被外部删掉 → 日志永久静默且不报错」这一条单点失效路径。
- 故障注入 `maybeThrowStorageFsFault({ operation: "appendFile" | "mkdir" })` 保留在 io 层，
  错误现在由 writer 计数而不是被调用方 try/catch 吞掉。**语义变化**：注入点的触发粒度从
  「每行一次」变成「每个批次（每个连续文件名分组）一次」，带 `maxMatches` 的规则命中次数随之减少。
  gen2 核对：本检出内没有任何规则以日志路径为目标（`ZCODE_E2E_FS_FAULTS` 只被
  `storage/fs-fault-injection.ts` 自身引用），因此**没有现存断言因此变错**；但注入只在
  `ZCODE_ENV=test` 或 `ZCODE_E2E_FS_FAULTS_ALLOW=1` 时武装，生产环境是 no-op。
  另外 `flushSync()` 的同步路径也走注入（`ensureDirSync`/`appendBatchSync`），
  命中即整批计入 `droppedRecords` 并上报 `reason="flush-sync-failed"`。

## 9. 验收场景（括号内为已通过的测试 id）

| # | 场景 | 期望 |
| --- | --- | --- |
| A1 | 控制组 happy path：500 条 + 周期性定时器冲刷 | 行顺序与内容与入队完全一致，`droppedRecords=0`，批次写次数 < 60（证明批量） |
| A2 | `appendFile` 前两次抛错 | `enqueue()` 不抛错；`writeFailures>=2`；重试成功后日志仍在；成功写失败自我上报 `reason="write-failed"` |
| A3 | `maxRecords=3` 压入 10 条 | 循环内 `bufferedRecords<=3` 恒成立；`droppedRecords=7`、`droppedBytes=21`；留下的必须是 `m7,m8,m9`（drop-oldest） |
| A3b | `maxBytes=100`，每条 40B | `bufferedBytes<=100` 恒成立并有丢弃计数 |
| A4 | 单条超过 `maxBytes` | 拒绝入队 + `rejectedOversizedRecords=1`，其余记录正常写盘 |
| A5 | `flushSync()` 有 pending | 未写出的行同步落盘且顺序正确，`flushSyncCalls=1`，缓冲清零 |
| A6 | 写盘在飞时跨过午夜 | 旧时间戳行进旧文件、新时间戳行进新文件，无丢无重 |
| A6b | 同批次内混排两个日期 | 按连续分组各写一次，每行落到自己所属文件 |
| A7 | 慢盘 + 连续 `kickNow()` | 同一时刻只有一个写者（`maxConcurrentWriters=1`） |
| A8 | 永远写失败且 `maxConsecutiveFailures=2` | 批次被丢弃并计数，日志链路未禁用，后续 `enqueue` 仍返回 true |
| A9 | 定时器冲刷 | 未到 `flushIntervalMs` 不写盘；推进时钟后 pending 落盘 |
| A10 | 自我上报去重 | 同一 5s 窗口只上报一次；窗口过期后可再报；上报不得给队列加记录 |
| A11 | 高水位 | 缓冲越过 `maxBytes*0.5` 时以 `delay=0` 立即冲刷 |
| A12 | `flushSync` 撞在飞批次 | 在飞批次被同步接管：`flushSyncRescuedRecords=1`、两行都在 `syncWrites` 里，不丢；接管后 writer 不得再写剩余分组 |
| A13 | 热路径无 syscall | 连续 200 次 `enqueue` 后没有任何 fs 调用，全部留在内存队列 |
| A14 | 队列满且混有 Warn/Error | 先丢 Info（`i1`、`i2`），`e1`、`e2` 仍在，`droppedProtectedRecords=0` |
| A15 | `flushSync` 接管多分组批次 | 剩余分组（`DAY_2`）只落盘一次，writer 停手 |
| A16 | 纯错误风暴 | 受保护记录超过 `maxRecords*0.5` 时被丢并计入 `droppedProtectedRecords`，同时 `info` 仍存活（两级上界） |
| A17 | 敌意选项（`0` / 负数 / `NaN` / `Infinity` / 小数 / 极大值）经 `clampPositive` 归一 | 有效上界仍是正数且有界：`maxRecords<=1` 时保留 1 条而非丢光，`NaN/Infinity` 时回落 2000 条 / 1 MiB，`backoffMaxMs=0` 时退避下界 1ms（gen4 新增，`logging-append-queue-options.test.ts` O1–O6，杀掉 M8） |
| A18 | 注入的调度器记录 `unref` 调用次数 | 交出去的每一个定时器句柄都被 `unref` 过（含被 `cancelSchedule` 撤销的那个），否则日志队列会拖住进程退出（gen4 新增 U1，杀掉 M9） |
| A19 | 写失败发生在 `await` 期间、此刻新入队一条 | 恢复批次排在最前且顺序与入队一致（`r1,r2,late`），证明是 `unshift` 而非 `push`（gen4 新增 F1，杀掉 M10） |
| A20 | 在飞分组 3 条 + pending 2 条时调用 `flushSync()` | sink 实收 8 行、去重 5 行、重复数 === 在飞分组大小 3、无缺失、`flushSyncRescuedRecords=3`、`flushSyncRaces=1`（gen4 新增 D1，把 §4 修正后的重复范围钉成可数的量） |
| A21 | `flushSync()` 在 `await ensureDir` 挂起窗口内接管一个 2 条在飞批次 | 释放 ensureDir 后该批到达 `appendBatch` **0 次**、sink 实收行集**无重复**、`flushSyncRescuedRecords=2`；删 `:241`（await 前接管检查）后同一断言必须 FAIL——实测 `asyncBatchCalls=1`、`dup=2`，且 `writeFailures` 仍为 0（重复对自报计数器隐形，只能数注入 sink 实收）。钉死「接管发生在 `ensureDir` 时不得产生重复分组」这一可永久观测的性质（gen5 新增 M7，`logging-append-queue-rotation.test.ts`，杀掉 MAIN-06 的 M7 变异体） |

## 10.5 未验证边界（gen2 复核，不得外推为通过）

- 队列 ↔ 工厂的装配（`index.ts`）仍不可在本检出加载：`enqueue(..., level >= LogLevel.Warn)` 的第三参、
  `LogLevel.Error` 的 `kickNow()`、`process.once("exit")` 注册、`toSerializableEntry` 走的降级行、
  `dirReady` 复位，全部只有代码审查级证据。
- 每创建一个工厂就注册一个 `process.once("exit")`，且从不移除：实测 4 个创建点
  （`bootstrap/src/zcode-protocol-entrypoint.ts:98`、`bootstrap/src/app/create-app.ts:165`、
  `adapters/src/config/config-factory.ts:412`、`cli/src/run.ts:490`）。第 11 个实例会触发
  Node 的 `MaxListenersExceededWarning`，多实例还会各持一个队列同时向同一个 `.jsonl` 追加。
  本轮未改（改法要在 `index.ts` 引入模块级监听 + 队列集合，会把文件推过 400 行），记为 P2。
- `NodeFileLogger.logDir` 已是死字段（落盘由队列持有），删除会牵动 `child()` 与构造签名，记为 P2。

## 10. 不在本 spec 范围

- 不新增环境变量、不改 `LogLevel`/`LogLevelName`、JSONL 字段、脱敏规则、`LOG_RETENTION_DAYS`。
- 不改 console streaming（`formatConsoleLine`）行为，仍是同步写 stderr。
- 不引入第三方依赖。
- 不改 `bootstrap/*`、`packages/cli/src/shutdown.ts`、`config/*`、`http/*`、`retention.ts` 语义。

## 11. 验证（真实执行结果）

- gen2（`review-logging`）后：`node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts`
  → `tests 18 / pass 18 / fail 0`（改前基线 15/15；A12 按新口径重写，新增 A14/A15/A16）。
- gen5（`fix-tests`，MAIN-04 收口 + MAIN-06 定案）：原 447 行文件已超 CLI AGENTS.md 的 ≤400 行上限，
  按内聚拆成两个各自 ≤400 的入口，18 个用例名逐一保留（拆前后用例名集合相同）：
  - 队列上界 / 分级 drop / 退避 / 自我上报 / 热路径：`logging-append-queue.test.ts`（12 例，345 行）
    → `node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts`（`tests 12 / pass 12 / fail 0`）
  - 轮转分组 / 单一写者 / flushSync 接管竞态 + M7：`logging-append-queue-rotation.test.ts`（6 例搬移 + 1 例新增 A21/M7，347 行）
    → `node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue-rotation.test.ts`（`tests 7 / pass 7 / fail 0`）
  两条命令合计 12 + 7 = 19 例 = 原 18 例（无静默丢失）+ M7（A21）新增 1 例。选项归一化/`unref`/恢复顺序
  仍在 `logging-append-queue-options.test.ts`（O1-O6/U1/F1/D1，非本次拆分范围）。
  M7 反向证据（`.hermess-snapshots/mut/`，跑完即删）：把 `append-queue.ts` 复制成 base 与「只删第 241 行」的
  mutant，用 `ensureDir` 内挂起的注入 io 跑同一场景，读数 `base {asyncBatchCalls:0, syncBatchCalls:1, dup:0,
  rescued:2, writeFailures:0}` vs `mutant {asyncBatchCalls:1, syncBatchCalls:1, dup:2, rescued:2,
  writeFailures:0}`；把 rotation 文件指向 mutant 跑，`tests 7 / pass 6 / fail 1`（仅 M7 红），证伪成功。
- `node docs/evolution/verify.mjs` → `files=2 PASS=2 FAIL=0 WARN=0 cases=39/39 fit=100`。
- 变异测试（`.hermess-snapshots/mut/`，跑完已删除；把 `append-queue.ts` 复制为
  `append-queue.mut.ts`，测试副本 import 该拷贝）：
  10 个变异里 6 个被杀 —— M1 字节上界(fail=1)、M2 超大拒绝(fail=1)、M3 上报窗口初值(fail=3)、
  M4 受保护配额(fail=1)、M5 分级丢弃(fail=2)、M6 在飞救回(fail=2)。
  **4 个存活 = 无效守卫**：M7 `drain` 里 await 前的接管检查（gen1 记为「被 await 后同类检查覆盖，冗余分支」，
  此判断已由 MAIN-06 实测推翻，见下方 gen5 收口）、
  M8 `clampPositive/clampRatio` 选项归一化（没有任何测试注入非法配置）、
  M9 `timer.unref?.()`（假句柄是 no-op，本环境根本观测不到）、
  M10 失败批次 `unshift` 改 `push`（FIFO 恢复顺序无人断言）。
  gen4 复核：M8/M9/M10 已由 `logging-append-queue-options.test.ts` 收口（A17/A18/A19），
  并且用变异副本做过证伪——注入变异体后读数分别是 `buffered=0 dropped=5`（应为 1/4）、
  `buffered=2300 dropped=0`（应 ≤2000/300）、`schedule delay=NaN`（应为 200）、
  `unref 次数 [0,0]`（应每个 ≥1）、恢复顺序 `["late","r1","r2"]`（应 `["r1","r2","late"]`），
  即这些断言不是空转。M9 之所以旧测试观测不到，是因为旧假句柄的 `unref()` 是空实现，
  换成计数器后即可证伪；M7 由 gen5 收口：MAIN-06 实测证明「await 前的接管检查」并非冗余——它守住的是
  `flushSync` 在 `await ensureDir` 窗口内接管的场景，删掉 :241 会让那一组重复落盘而 `writeFailures` 仍为 0，
  只有数注入 sink 才看得见，故 stage-2「被吸收 / 不动」的裁决作废，改由 A21（rotation 文件）钉死并出反向读数。
- `node --check` 对 `logging/index.ts` 与 `logging/append-queue.ts` 均无输出（语法可解析）。
- **未验证边界**：`logging/index.ts` 本身无法在本检出被加载执行，因此「工厂 ↔ 队列接线、
  Error 级 `kickNow`、`process.once("exit")` 冲刷、故障注入 io 适配」只有代码审查级证据。
  实测失败原因：`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@zcode/contracts' imported from
  ...adapters/src/logging/index.ts` —— 本裁剪检出里 `adapters/node_modules/@zcode` 根本不存在，
  所有 workspace 包都没链接；即便链接了，`index.ts` 对 `LogLevel`/`LogLevelName` 的 value import
  （enum 声明）也会让 Node 的 type-stripping 失败。
- `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check` 在本检出不可运行（无 tsc、无 oxlint、
  根 `packages/`、`scripts/` 缺失，第三方依赖未安装），如实记录为**未执行**，不写成通过。
- 未做真实磁盘 E2E：Windows/macOS/Linux 上的实际 `appendFile` 行为、断电丢包窗口需要后续
  在完整检出里用 E2E 场景复核。
