# gen5 · fix-tests 报告（日志测试文件：MAIN-04 拆分 + MAIN-06/M7 收口）

角色：Hermes M5「meta fusion」`fix-tests` 写手，只拥有 logging 测试文件。两件事：(1) 修掉本轮自造的
447 行 > 400 违规；(2) 补一条可杀的用例钉死主代理已证明可观测的 M7 变异体。

环境事实：裁剪检出，无 oxlint/tsc/vitest/第三方依赖 ⇒ `pnpm lint`/`pnpm typecheck` 无法执行（未跑，非通过）。
唯一尺子 `node --test`（Node v24.13 类型擦除）。`AppendQueue` 可从 `append-queue.ts:43` 值导入，故纯测试工作不动源码。

---

## 任务 1：拆分超限文件（≤400 行，用例数守恒）

### before / after 文件清单 + 行数

| 文件 | before | after | 用例数(after) |
| --- | --- | --- | --- |
| `adapters/tests/logging-append-queue.test.ts` | **447** | **345** | 12 |
| `adapters/tests/logging-append-queue-rotation.test.ts`（新建） | — | **347** | 7（6 搬移 + 1 新增 M7） |

两个文件均 ≤ 400，MAIN-04 违规收口。未触碰 `append-queue.ts`（源码冻结）。文件名不与
`logging-append-queue-options.test.ts`（O1-O6/U1/F1/D1，gen4 已有）或任何 `env-config*` 冲突。

拆分接缝 = 内聚：`logging-append-queue.test.ts` 留「队列上界 / 分级 drop / 退避 / 自我上报 / 热路径」；
`logging-append-queue-rotation.test.ts` 留「轮转分组 / 单一写者 / flushSync 接管竞态」+ M7。
断言逐条原样搬移，未削弱；两个文件各自带一份注入 harness（测试边界只允许 `logging-append-queue*.test.ts`
命名，无法抽出非 `.test.ts` 的共享 helper，否则会被 verify 当空测试文件计成 WARN）。

### 用例名集合比对（18 例守恒，零静默丢失）

before 的 18 个用例名：A1, A2, A3, A3b, A4, A5, A6, A6b, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16。

after：
- File A（12）：A1, A2, A3, A3b, A4, A8, A9, A10, A11, A13, A14, A16
- File B（6 搬移）：A5, A6, A6b, A7, A12, A15

并集 = 原 18 名，成员与数量完全一致（非仅总数相同）。M7（对应 spec A21）是任务 2 净新增的第 19 例。

### 真实 `node --test` 计数（每文件）

- `logging-append-queue.test.ts`：tests 12 / pass 12 / fail 0
- `logging-append-queue-rotation.test.ts`：tests 7 / pass 7 / fail 0
- 合计 12 + 7 = **19** = 原 18（守恒）+ M7（新增 1）

### `node docs/evolution/verify.mjs` 总量

`files=7 PASS=7 FAIL=0 WARN=0 cases=98/98 fit=100`（无 FAIL、无 WARN）。
相对开工前基线 `68/68`（5 文件）的 +30 = +29（`env-config-timeout-zero.test.ts`，并发 env-config 代理新增，非我账下）
+1（我的 M7）。`node docs/evolution/baseline.mjs diff pre-gen4` 亦为 98/98，日志两行见下：
```
+ apps/zcode-cli/packages/adapters/tests/logging-append-queue-rotation.test.ts
~ apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts
```

---

## 任务 2：M7 可杀用例 + 反向证据

场景（照 MAIN-06 定案复现）：注入 `io.ensureDir` 门控（测试掌握 resolve）→ 入队 `R0`,`R1` 到同一日期文件
→ 触发 drain 回调，批次进入在飞（`inFlight=batch`）并卡在 `await this.io.ensureDir`（`append-queue.ts:238`）
→ 挂起窗口内 `q.flushSync()` 走 `appendBatchSync` 救回（`flushSyncRescuedRecords=2`）→ 释放 ensureDir，泵 6 轮 →
断言只看注入 sink：该批到 `appendBatch` **0 次**、sink 实收行集**无重复**、`rescued=2`。

判据理由（写进用例注释）：mutant 里 `writeFailures` 恒为 0 —— 重复写对任何自报计数器都隐形，
**只有数 sink 真正收到的批次/行**才抓得到，故不能用队列自报计数。

`append-queue.ts` 中「await ensureDir 与 await appendBatch 之间的第一条 `if (this.inFlight !== batch) break;`」
实测命中第 **241** 行（与主代理读数一致；ensureDir=238、appendBatch=242）。

### base vs mutant 读数（`.hermess-snapshots/mut/aq.mut.ts`，删第 241 行；跑完已删）

```
BASE    {"asyncBatchCalls":0,"syncBatchCalls":1,"delivered":[["sync","R0\nR1\n"]],"dup":0,"rescued":2,"writeFailures":0}
MUTANT  {"asyncBatchCalls":1,"syncBatchCalls":1,"delivered":[["sync","R0\nR1\n"],["async","R0\nR1\n"]],"dup":2,"rescued":2,"writeFailures":0}
verdict_M7_is_observable = true
```

与 MAIN-06 完全一致。进一步把 rotation 测试文件指向 mutant 跑（同一批 7 例）：
`tests 7 / pass 6 / fail 1`，唯一红的是 M7（`AssertionError: asyncBatchCalls：await 前接管检查必须让 drain 停手`，
即 `assert.equal(1, 0)`）；A5/A6/A6b/A7/A12/A15 不受影响（它们门控 `appendBatch` 测的是 `:243`，
`:241` 的删除只影响 `ensureDir` 窗口）。⇒ 正式用例可杀 M7，MAIN-06 结论成立，M7 不再属「不可观测」。

---

## 任务 3：spec 台账（`specs/logging-persistence/spec.md`）

- §4：新增一道「双重接管检查」条目，写明 `:241`(await ensureDir 前) 与 `:243`(await appendBatch 后) 覆盖
  不同窗口，钉住「接管发生在 ensureDir 时不产生重复分组」的可永久观测性质；重复范围口径与 §4 上文及
  M4 修正一致（一个在飞分组，上界 `maxRecords`/`maxBytes`）。
- §9：新增 **A21** 验收行（M7）。
- §11：记录两个拆分入口文件 + 精确 `node --test` 命令 + 12/7 读数 + M7 base/mutant 反向读数；
  把 gen1「M7 冗余分支/被吸收/不动」的旧裁决标注为已被 MAIN-06 推翻（消除文档与实现并存的不一致）。

---

## 下一轮该跑的确切命令

```
node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts        # 期望 12/12
node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue-rotation.test.ts # 期望 7/7
node docs/evolution/verify.mjs                                                           # 期望全绿、0 FAIL/WARN
node docs/evolution/baseline.mjs diff pre-gen4
```

M7 复证（可选）：复制 `append-queue.ts`，删除 `await this.io.ensureDir` 与 `await this.io.appendBatch`
之间第一条 `if (this.inFlight !== batch) break;`（当前实测第 241 行），令 rotation 文件的 import 指向副本后
`node --test`，期望 `pass 6 / fail 1`（仅 M7 红）。用完删除 scratch（scratch 目录 `.hermess-snapshots/mut` 被 verify 跳过）。

---

## 剩余 WARN-unverifiable / 边界

- `logging/index.ts`（工厂↔队列接线、Error 级 `kickNow`、`process.once("exit")`、故障注入 io 适配）
  仍无法在本检出加载（`@zcode/contracts` 未链接 + enum 值导入使 type-stripping 失败）⇒ 仅代码审查级证据。
- `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check` 本环境不可运行，记为未执行，不写成通过。
- `env-config-timeout-zero.test.ts`(+29) 与 `env-config.test.ts` 属并发 env-config 代理，我只读取其计数、未改动。
- 未做真实磁盘 E2E（Win/mac/Linux `appendFile` 与断电窗口）。
