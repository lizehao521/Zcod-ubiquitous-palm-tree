# review-quality · M3 stage-2 audit of `draft-predict.md`

判据来源：`docs/evolution/review-checklist.md` A/B/C/D + `apps/zcode-cli/AGENTS.md`。
所有结论按"实读签名"给出；本轮我只读源码，未改任何代码。仓库oracle 实测（stage-2 起点，未变动）：
`node docs/evolution/verify.mjs` → `files=2 PASS=2 FAIL=0 WARN=0 cases=39/39 fit=100`。

## 1. T-C2 —— 严重度 **P1 维持**，反记忆化论证 **成立**，修复方案 **改写**

实读链：`node-execution-adapter-run.ts:68` → `outputEncoding.ts:248 resolveLegacyExecutionOutputEncoding`
→ `:263 readWindowsActiveCodePageEncoding` → `:207 execFileSync(comSpec, ["/d","/s","/c","chcp"], {env, timeout:1_000, windowsHide:true})`。
唯一调用点确认（grep 全 `packages` 只命中 run.ts:6/68），stage 1 的"ONE caller"成立。
消费方全在 `async run()` 内且都不需要同步值：`BashFileOutput` 构造 (run.ts:74-80)、`createOutputCollector` (:81-98)、
`attachPipedOutput` (:307)；`onOutputEncodingResolved` (run.ts:73) 只是把值写进 `record.legacyOutputEncoding`
（`node-execution-adapter-lifecycle.ts:63-65`、`:227-229`），是事后可变字段 → await 化不破坏任何契约。
run.ts:72 的中文注释（"避免重复同步执行 chcp"）说明这里是**去重修复的落点**，不是疏漏。

反记忆化论证：成立且我要加强。`chcp` 报的是**控制台输出码页**（进程共享状态），env 快照里唯一决定它的是
`:255-262` 的 override，而 override 命中时根本不起子进程 → env 指纹对失效**零覆盖**。用户在自己的 Bash 命令里
执行 `chcp 65001` 就会改变同一控制台的码页，env 一字不变。缓存版会把 cp936 继续喂给 UTF-8 输出 = 乱码，
比卡顿更坏。**接受 stage 1 对 scope-pool grp 9 "按 env 指纹记忆化"的否决。**

严重度定级（对照 checklist D 的 P0 判据"绕过取消/超时"）：不构成 P0。取消在冻结后仍被服务：
`run.ts:47` 与 `:174` 两次检查 `signal.aborted`（`:177` 才注册监听器），且 `:116` 注释表明本次 run 自己的
timeout 计时器在 spawn 之后才起 → 冻结不占用命令超时预算，只延迟外部取消/`armForegroundDeadline`
（lifecycle:220）。**升级触发条件写死**：win32 下 10 个并发 run（`env-config.adapter.ts:16 DEFAULT_MAX_TOOL_CONCURRENCY = 10`）
的同步 chcp 串行累加实测 > 1s，即按"绕过取消/超时"升 P0。

stage 1 漏项：`node-execution-adapter-run.ts` 实测 **399 行**（`wc -l`），400 行法律只剩 1 行余量。
它的 blast radius 栏写"Low"不成立 → 见 §4 的行数预算。

## 2. T-缝2 —— 两半**判反了**：config 半收下（并升级），http 半驳回

- `resolveDefaults(lookup, defaults)` **确实可抽出纯模块**（决定性事实：`ConfigKey` 不是 enum，
  而是 `contracts/src/config/index.ts:12-82` 的点号字符串常量对象，`:82` 派生同名类型）
  → 纯模块按字符串联合类型建键，测试直接传字面量对象。`DefaultRuntimeConfig` 是 `:290` 的**值常量**，
  必须以参数注入。stage 1 写 "value-imports ConfigKey/ConfigScope **enums**" 事实有误（是 const 对象），
  不可加载的结论不变。
- 真实缺陷比 stage 1 的"3 处字面量漂移（P2）"大：同一个 key→default 映射在
  `adapters/src/config/index.ts` 里写了**三遍**（`getDefaultValue :369-450`、`getAll :258-337`、
  `merge :76-215`），而该文件实测 **500 行 = 已违反 ≤400 法律**（stage 1 未报）。
  根 AGENTS.md「避免重复状态和多条写入路径」直接命中。→ 抽取**不是可测性仪式，而是法律要求的拆分**。
- `armHttpTimeout(timeoutMs)→{armed,ms}` **驳回（仪式）**。`http/index.ts:79-84` 里"设防"就是那个
  `setTimeout` 副作用本身；返回布尔值的纯函数只能在发射点之外断言，且该文件本来就载不动
  （`:8 proxy-agent`、`:9-17 createHttpClientError`）。写进 spec 的"未验证边界"，不占 M4 名额。
- 0 值路由记账（不要升级成 P0 断言）：`getAll:281` 的 `?? DefaultConfig.network.timeout` 会**保留 store 里的 0**
  → `:79 timeoutMs > 0` 为假 → 超时守卫消失。可达路径只剩 `ConfigPortImpl.set :343` / `merge :114`
  （`ConfigStore.set :48-59` 无校验）；env 路由已被 gen1 修掉，文件路由被 `positive()` 挡住。
  本轮只要求 spec 写明 `0` 的语义 + 三态记 **WARN-unverifiable**（找不到仓库内 0 的写入者）。

## 3. 4 条存活变异体：3 条必须收，1 条**明确不做**

关键算术：收 mutant **不需要新守卫**，也就不需要拆 399/398 的文件。`AppendQueue` 已导出
（`append-queue.ts:43`），`tests/logging-append-queue.test.ts:8` 就是以值导入它 → 模块载得动。
但该测试文件已 **447 行** → 新用例必须落到**新测试文件**，别再堆它。

| mutant | M4 判定 | 收口方式（无源码改动） |
| --- | --- | --- |
| `clampPositive` `:391`，被 `:90-105` 用 | **必收** | `new AppendQueue({maxRecords:-5, maxBytes:0, flushIntervalMs:NaN, backoffMaxMs:0})` + 灌 N 条，断言仍按默认上界缓冲/冲刷（守卫删掉即 drop-all，可区分） |
| `timer.unref?.()` `:205`/`:217` | **必收** | 注入 fake `AppendQueueTimer`，断言 `unref` 被调用次数 ≥1（checklist C：不得拖住进程退出） |
| 失败批次 `this.records.unshift(...batch)` `:292` | **必收** | 写失败→再冲刷，断言恢复顺序与入队顺序一致（FIFO 非 LIFO） |
| 前置 `inFlight !== batch` `:241`/`:243` 被 `:254` 吞 | **不做** | 要求修复者先给出可驱动的交错时序书面论证；拿不出就留"未验证边界"。禁止为跑绿加兜底分支，也禁止顺手删除该判断 |

## 4. M4 工作清单（owner 两两不相交）

**Fixer A — exec**：新 `adapters/src/exec/windows-code-page.ts`（异步 runner + 纯 `resolveCodePage(chcpOut,{encodingExists})`）
+ `outputEncoding.ts`（删 `:204-221`，268→≈230）+ `node-execution-adapter-run.ts:68` 改为 `await`。
硬约束：`run.ts` 改后 **≤399 行**（净增 0；WHY 中文注释放新模块）。前置 spec：新建 `specs/windows-output-codepage/spec.md`
（主代理更正：该路径出自我给本轮的简报，实际落地名为 `specs/windows-code-page/spec.md`，
已随 `a94cf52` 入库；本行保留原文以留审计痕迹，不静默改写审查腿的结论。）
（写"每次 run 重新解析、禁止跨 run 缓存、win32-only、失败回落 `:223 resolveWindowsLocaleLegacyEncoding`"）。
新测试 `adapters/tests/exec-output-codepage.test.ts`，三条判据：
(a) 两次 run → 注入 runner 调用 **2 次**（缓存实现 = FAIL）；(b) 两次 run 间模拟 chcp 输出变化 → 返回编码跟着变；
(c) resolve 之前 `setImmediate` 的回调**先于** promise 落地（对当前 `execFileSync` 必然 FAIL = checklist A.3 的反向证据）。
真实 cmd.exe 延迟与 iconv 解码 = WARN-unverifiable。

**Fixer B — logging 测试 + config 拆分**：新 `adapters/tests/logging-append-queue-options.test.ts`（§3 前三条）
+ 新 `adapters/src/config/resolve-snapshot.ts`（纯，`import type` only）+ `adapters/src/config/index.ts`
（`getAll`/`getDefaultValue` 共用一张表，500→**≤400**）+ `specs/runtime-env-config/spec.md` 补一节（单一映射、`0` 语义）。
新测试 `adapters/tests/config-snapshot.test.ts`：对 `ConfigKey` 全部键断言 `snapshot(lookup, defaults)[k] === get(k)`，
并把 `features.*`/`skills.enabled`/`logging.level` 的 `true`/`"info"` 字面量（`:284-289`、`:311-312`、`:321`）换成表来源。

两域无共享文件 → 不与 400 行墙冲突（A 侧只需守 run.ts；B 侧的拆分是法律要求本身）。
T-缝1（`logging/index.ts` 工厂侧抽取）**不进 M4**：它才是真正需要先拆 398 行文件的大动作。

## 5. DO NOT

- 不给 `chcp` 结果加任何跨 run 缓存/TTL/指纹；不动 `:255-262` override 优先级；不新增 `ZCODE_*`。
- 不改 `packages/shared`/协议；不碰 `adapters/src/http/*`（含 §2 驳回项）；不改 `verify.mjs`/`tree.mjs`/`baseline.mjs`。
- 不为"证明修复有效"而把 `run()` 的 spawn 前逻辑搬家重构（只改 `:68` 一处取值的形态）。
- 不动 `append-queue.ts`/`logging/index.ts` 源码（399/398 墙）；不追加到 447 行的旧测试文件。
- 不扩 `FileSystemPort`、不扫 `core/src` 其余 12 个 `node:fs` 文件、不把 `store.ts` 改异步。
- 不重提 grp 8 已排除项（proxy TLS 缓存 / `resolveTlsCaCertFile` / 全仓空 catch / "225 处同步" / `modelStream.idleTimeoutMs`）。

## 6. T-C1：**确认 BLOCKED**（stage 1 正确，我不翻案）

`file-system.port.ts:280-321` 实读只有 10 个动词且全 async，grep `rename|move|copy` 在该文件**零命中**
（只有 `removeFile :305`）；`store.ts:334 moveSavedWorkflow` 依赖 `renameSync`（`:15` 导入）。
`store.ts:1-9` 头注释给出同步的设计理由：`prepareApproval` 契约是同步的，以 `saved` 源发起的 run 必须在弹窗
**之前**读到脚本 —— 8 个导出函数（`:56-334`）全同步不是巧合。
我试过找 agent-only 闭口：把 `node:fs` 改成注入 io 只能让文件"可测"，默认实现仍直连 `node:fs`，
边界违规（grp 5 C1-law）原封不动 → 属装饰，不算收口。要真闭合必须（a）扩契约加 move 动词或（b）跨 6 处调用点改异步，
两者都是设计决策。**需用户裁决**：move 动词进契约（并定 EXDEV 回落语义），还是把同步例外永久写进 spec。

## 7. 仍未解决 / 需要用户

1. T-C1 的两条路（扩契约 vs 记账例外）——本轮唯一真正的决策阻塞点。
2. `network.timeout = 0` 是否是有意的"关闭超时"语义？spec 一句话就能定，但定义会决定 §2 记账项是否升 P0。
3. T-C2 的 P0 升级判据需要一次 win32 实测（10 并发 chcp 串行延迟）。当前环境跑不了真实 spawn，只能留 WARN。
4. `logging/index.ts` 工厂侧（T-缝1）在 398 行墙内无法推进：要么先批准一次拆分，要么它继续当"未验证边界"。
