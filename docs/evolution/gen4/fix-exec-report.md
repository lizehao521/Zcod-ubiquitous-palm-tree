# gen4 · fix-exec 报告（T-C2：Windows 代码页解析阻塞事件循环）

角色：`fix-exec`（M4 parallel converge），负责 Windows code-page 解析路径。
边界：只写 `adapters/src/exec/{windows-code-page.ts,outputEncoding.ts,node-execution-adapter-run.ts}`、
`adapters/tests/windows-code-page.test.ts`、`specs/windows-code-page/spec.md`、本报告。
`adapters/src/config/*`、`adapters/src/logging/*` 属 fixer B，未触碰；判据脚本未改；无 git 操作；无新增 `ZCODE_*`。

## 1. 对 brief 的核对结果（逐条，全部按当前源码验证）

| brief 断言 | 结论 | 证据 |
| --- | --- | --- |
| `outputEncoding.ts:204-221` 是 `execFileSync(cmd.exe /d /s /c chcp, {timeout: 1000})` | **确认** | 原 204-221 行原文一致，含 `encoding: "utf8"`、`windowsHide: true` |
| 唯一调用点 `node-execution-adapter-run.ts:68` 在 `async run()` 内 | **确认** | 全 `apps/zcode-cli` grep `resolveLegacyExecutionOutputEncoding` 只有 import（:6）+ 该调用（:68）；`run()` 为 `async` |
| 无人需要同步拿编码 | **确认** | 消费者 `BashFileOutput`（:74-80）、`createOutputCollector`（:81-98）、`attachPipedOutput` 全在 `async run()` 内；`onOutputEncodingResolved` 类型是 `(encoding: string \| null) => void`（`execution-adapter-types.ts:36`），lifecycle 只做 `record.legacyOutputEncoding = encoding` 赋值 |
| 取消仍在 `:47` 与 `:174` 被服务 | **确认并加强** | `:125-128` 的 `stoppedBeforeSpawn()` 与 `:185/:192` 的检查都在我的 await **之后**，所以 await 窗口内到达的取消由既有检查接住，无需新增分支 |
| 只有 `ZCODE_WINDOWS_OUTPUT_ENCODING` 是 env 派生且先于 spawn 短路 | **确认** | 原 :255-262；`chcp` 的subject（活动控制台代码页）与 env 无关 ⇒ 禁止跨 run 缓存 |
| 实测 37 ms / 520 ms ⇒ 保持 P1 | **采用**，未重复测量 | 反向证据里同步实现单次耗时 35.5 ms，与 37 ms 中位一致；异步真实 `execFile` 单次 35.4 ms 但 lag 0 |
| 严重性升级门槛（>1s ⇒ P0） | **不触发** | 520 ms < 1s，保持 P1，本次只解除阻塞，不做额外抢救性优化 |

无任何一跳与 brief 不符，未出现需要上报的偏差。

## 2. 设计选择：方案 (a) —— 改异步并在唯一调用点 await

- `resolveLegacyExecutionOutputEncoding` 签名改为 `Promise<string | null>`，生产默认执行器是
  `node:child_process` 的**异步 `execFile`**（保留 `timeout: 1000` 上限、`windowsHide`）。
- 决策链（覆盖 env → 活动代码页 → locale 回退）整体搬到零运行时 import 的
  `windows-code-page.ts`，由它接受注入的 `probe` 与 `encodingExists`；`outputEncoding.ts` 退化为
  真实依赖适配层（env 大小写不敏感读取 + iconv 判定 + 子进程）。
- **只留一条路径**：没有「同步签名 + 提前预取」的第二条路（方案 b 未实现），`execFileSync` 已从
  `src/exec/` 的调用中彻底消失（仅剩注释提及）。回退顺序与 `null` 语义逐字保持：覆盖 env 写了不存在的
  编码仍返回 `null` 且不再回退；活动代码页为 `65001`（`utf8`）时仍落 locale 回退值。
- 没有跨 run 缓存，没有模块级可变状态；`localeLegacyEncoding` 做成惰性函数，保持旧实现的求值顺序
  （覆盖 env 命中时不付 `Intl.DateTimeFormat().resolvedOptions()` 的开销，测试 S1 钉住）。

**代价（一条，明写）**：已 aborted 的请求仍在 `run.ts:47` 早退（不 spawn）；但在 await 窗口内才被取消的
请求，其停止结果要等 `:174` 之后的既有检查落地，本 run 的取消响应最坏延后一次 `chcp` 往返（本机实测 ~35 ms，
且不再冻结别人）。原先的同步实现是「本 run + 同进程所有 run」一起冻结，故为净改善。

## 3. 测试与真实读数

```
node --test apps/zcode-cli/packages/adapters/tests/windows-code-page.test.ts
→ tests 12  pass 12  fail 0
```

仓库判据（未修改，只跑）：

```
node docs/evolution/verify.mjs
→ PASS env-config 21/21 · logging-append-queue 18/18 · windows-code-page 12/12
  SUMMARY files=3 PASS=3 FAIL=0 WARN=0 cases=51/51 fit=100

node docs/evolution/baseline.mjs diff pre-gen4
→ 新增 5（含 windows-code-page.ts / .test.ts / spec.md；config/resolve-snapshot.ts 与 gen3/review-quality.md 是 fixer B 与主代理的并发产物）
  改动 4（我的：node-execution-adapter-run.ts、outputEncoding.ts；config/index.ts、release-plan.md 非我所写）
  删除 0；基线 39/39 → 当前 51/51 fit=100
```

必测断言的覆盖：

- (a) 无跨 run 缓存：S4 —— 连续两次解析，注入 runner 计数 **恰好 2**。
- (b) 失效生效：S5 —— 第二次 runner 返回 `65001` ⇒ 结果由 `cp936` 翻转为回退值 `cp437`；反向序列
  `65001 → 950` ⇒ `cp437 → cp950`。
- (c) 非阻塞：S6 —— 解析**之前**排队的 `setImmediate` 回调先于 resolution settle；另加一条真实
  异步 `execFile cmd.exe /d /s /c chcp` 的同款断言（本机耗时 35.4 ms，`order[0] === "tick"`）。
- (d) 控制组：`Active code page: 936` + `encodingExists` 为真 ⇒ `cp936`；`65001` ⇒ `utf8`（决策链
  落 locale 回退）；无数字/`null` ⇒ `null` ⇒ locale 回退；S1 覆盖 env ⇒ probe 调用 0 次；
  S2 命令 reject ⇒ 不抛错、走回退且 `observeFailure` 收到 1 次；S3 `cp12345` 判不存在 ⇒ 回退。

## 4. 反向证据（临时件，跑完即删，已删除）

放在 `.hermess-snapshots/mut/`，用后即 `rm -r`（目录本身非我创建，只删了自己新建的 `mut/`）：

1. `windows-code-page-sync.ts` + `sync-blocking-proof.test.ts`：修复前的**同步** `execFileSync` 形状，
   跑同一条 S6 断言 ⇒ **FAIL**（`actual: 'resolved:cp936'` / `expected: 'tick'`，test 35.533 ms 全程冻结）。
   这证明 (c) 不是恒真断言。诚实附注：注入 fake probe 的那条 S6 只证明「解析器自身不做同步工作」，
   真正区分「unblocked vs blocked」的是这条对真实 `execFileSync` 的失败证据 + 真实异步 `execFile` 那条通过。
2. `windows-code-page-cached.ts` + `cached-should-fail.test.ts`：故意加上「按 env 指纹的跨 run 缓存」
   （本次明令禁止的做法）⇒ S4 **FAIL**（`calls 1`，期望 2）、S5 **FAIL**（第二次仍是 `cp936`，期望 `cp950`）。
   这证明 (a)(b) 真在钉「每次 run 重读」，不是白测。

## 5. 文件法（≤400 行）

| 文件 | 行数 |
| --- | --- |
| `apps/zcode-cli/packages/adapters/src/exec/windows-code-page.ts`（新） | 114 |
| `apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts` | 294（原 268） |
| `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts` | **399（未增行，仍 ≤400）** |
| `apps/zcode-cli/packages/adapters/tests/windows-code-page.test.ts`（新） | 225 |
| `specs/windows-code-page/spec.md`（新） | 115 |

`run.ts` 的改动是等量替换（旧注释 1 行换成新 WHY 注释 1 行 + `await` 前缀），因此没有触发「加行先拆文件」。

## 6. 本环境仍不可验证（WARN，不写成通过）

- **已做到的静态检查**：`node --experimental-strip-types --check` 对
  `node-execution-adapter-run.ts`、`outputEncoding.ts`、`windows-code-page.ts` 三个文件均无输出（语法 +
  可擦除类型合法）。这**不是** `tsc`，不做类型推断，因此签名匹配仍属未验证项。
- `pnpm lint` / `pnpm typecheck` / `pnpm --dir apps/zcode-cli typecheck` / `pnpm architecture:check`：
  裁剪检出缺根 `packages/`、`scripts/`，**无法执行**，未执行即未通过。
- `outputEncoding.ts` 与 `node-execution-adapter-run.ts` 的**真实加载/类型正确性**：它们 value-import
  `iconv-lite` / `@zcode/contracts`，在 `node --test` 下 `ERR_MODULE_NOT_FOUND`，因此这两处的改动只经
  过人工阅读 + 被验证过的纯逻辑模块（`windows-code-page.ts`）承担决策；调用点 `await` 是否被 TS 类型
  接受属于不可本机验证的静态检查项（`run()` 已是 `async`，签名匹配人工可核）。
- 真实 `cmd.exe` 的 `chcp` 尾延迟分布、并发 10 次的实测改善：只跑过单次（35.4 ms）。
- iconv-lite 对 `cp936`/`gb18030` 的实际解码正确性与 `encodingExists` 的真实集合：被证明的是注入
  predicate 后的决策，不是 iconv 本身。
- E2E（真实 Bash 工具跑一次带中文输出的命令、Windows 控制台代码页切换后的端到端表现）：无运行入口，未做。
