# Hermes 五模式进化闭环 · 总结（apps/zcode-cli 后端面）

生成时间：2026-09-28 · 长期目标：M1→M5 五模式全闭环 + 上 GitHub
子代理一律配备 `api-scaffolding-backend-architect` 能力；本环境没有技能里假定的 `team_create`，
因此每种模式映射为 **并行 `Agent` 调用 + 逐代理硬文件边界 + 主代理持有判据**。

## 一、五轮形态与实际读数

| 轮 | 模式 | 子代理 | 落地内容 | 实测读数（主代理亲自复算） | 未验证边界 |
| --- | --- | --- | --- | --- | --- |
| M1 | M1 并行发散 | `fix-env-config` + `fix-logging-io` | env 数值守卫；日志改有界异步批量落盘 | 21/21 + 15/15 = 36/36 | env：`ConfigPort.getAll()` 末段、`http` 计时分支；log：工厂装配、exit 钩子、真盘 E2E |
| M2 | M2 对抗互审 | `review-env` + `review-logging` | 诊断接入唯一汇总入口；桶导出补全；注释纠偏；**在飞批次临终丢失 F1**、级别感知保留 F2、自报 schema 违规 F3、400 行拆分 F4 | 21/21 + 18/18 = 39/39；三守卫变异全被抓（删 `finite` → 8 fail） | 同上 + 4 个存活变异体（M7-M10） |
| M3 | M3 流水线串行 | `draft-predict` → `review-quality` → `test-quality` | 只读预测草稿 → 审查推翻/升级判定 → 闭合审计 | 草稿 4 题；stage2 推翻 stage1 一项（`armHttpTimeout` 属装饰）、升级一项（`config/index.ts` 既有超行违法，HEAD 实测 491 行；stage2 当时记作 500，见 §二 的纠正） | 见 `gen3/test-quality-delivery.md` |
| M4 | M4 并行汇聚 | `fix-exec` + `fix-config` → `test-all` | chcp 解析去阻塞（新纯模块，禁跨 run 缓存）；三处重复 key→default 表收口（`index.ts` 491→364，HEAD 实测值）；杀掉 M8/M9/M10 | **68/68，连跑 3 次一致**（5 测试文件）；`baseline diff pre-gen4` = 新增 10 / 改动 8 / 删除 0 | exec：iconv 真实解码、尾延迟改善、await 期取消窗口 |
| M5 | M5 融合 DAG | `draft-scan` + D-B 写手 + 测试拆分写手 + review + test | `timeout=0` 新语义（用户裁决 D-B）+ 拆掉本轮自造的 447 行测试 + M7 定案 | _待 M5 填：真实 pass/fail 计数_ | _待 M5 填_ |

谱系（生成物，勿手改）：`docs/evolution/tree.txt`、`docs/evolution/tree.json`；
M4 结束时 `nodes=7 frontier=[gen2-b, gen4-a, gen4-b]`。

## 二、本轮真实交付的物量

- 新增源模块 4：`logging/append-queue.ts`、`logging/append-queue-contract.ts`、
  `config/resolve-snapshot.ts`、`exec/windows-code-page.ts`
- 新增测试 **8 文件 / 105 用例**，逐文件 TAP 自算与尺子聚合一致，`skipped 0 / todo 0`
  （此前该 checkout 内 `*.test.*` 为 **0**；M4 结束时为 5 文件 / 39 例）
- 新增 spec 4：`runtime-env-config`、`logging-persistence`、`windows-code-page`、`core-fs-boundary`
- 修好的既有违规 1：`config/index.ts` **491 → 364** 行（491 是 `git show HEAD` 实测；
  M3 stage2 报的 "500 行" 与 fix-config 自述同错，由 M4 `test-all` 纠正）
- 导出面：HEAD 30 → 现 34，**丢失 0**；多出的 4 个正是 M2 ENV2-02 有意加入的 env API
- **本轮自己新增、又在本轮内收掉的违规 1**：`adapters/tests/logging-append-queue.test.ts` 447 行
  → M5 拆为 345 + 347；用例名与主代理在拆分过程中抢拍的 28 名快照 `diff` 为空
  ⇒ 原 18 例全在，M7 是真新增的第 19 例（既有违规仍只记账不动）
- 提交按功能拆分（logging / exec / fs 边界例外 spec / .gitignore / config 合并包 /
  审查后修复 / 判据工具与轮次记录 / 谱系闭合 / 交付状态更正）；
  **提交数不写死**，现算：`git rev-list --count 69dfda4..HEAD`

## 二·五、M5 融合 DAG 的落地状态（六腿全落，含审查后修复）

| 腿 | 状态 | 实测读数 |
| --- | --- | --- |
| `draft-scan` | 已落 | 39/39 默认值同值、布尔键三存储态 27/27 等价，判词 **REGRESSION: none**；并纠正了主代理的一条断言（`contracts` 配置文件其实可执行，因其自身全是 `import type`） |
| `fix-db` | 已落（在 `afb40aa` 内） | env 套件 21+30=51/51；主代理独立驱动复现全部读数（0 族合法、空串先判、`too_large`、非字符串不外抛、`maxConcurrency` 不搬天花板） |
| `fix-tests` | 已落 | 447 行拆为 345+347；28 个用例名与主代理抢拍快照 `diff` 为空；M7 变异复现 `{0,0}`→`{1,2}` |
| `review` | 已落 | **确认 P1 漂移**：`MAX_TIMER_DELAY_MS` 只在 env 侧，`schema.ts:13` 从不引用它 ⇒ 配置文件写 `1e20` 仍直达 `setTimeout` 被钳成 1ms（复现 `FIRED after 4ms`）；另查出 9 处 spec 引用行号腐坏与"别名后出现者写胜"的未定案项。其自陈的 duty-6 扫描给出别名实测表 |
| `test`（汇聚） | 已落 | 3 连跑读数完全一致；skip 门实证（有 skip ⇒ WARN + `notRun=1` + exit 1，且聚合数字仍显示 100/100 ⇒ 只有门会拦）；差分 19 增/13 改/0 删；TAP 自算 99 与尺子一致；行法零新增违规；**判 (c) 类 10 条"今天就能闭"，其中 2 条 iconv-lite 申报是过期事实** |
| `post-review fixer` | 已落（`ab419db`） | 文件侧 `.max(2_147_483_647)` + 文本漂移守卫（clean 4/4；把常量 +1 ⇒ 1 红；数值还原但删 `.max()` ⇒ 2 红）；`schema.ts` 因 zod 未装不可加载 ⇒ `.max()` 只到静态审查，未执行 |
| 主代理改判（用户裁决） | 已落（`ab419db`） | 别名改「主键赢 + `alias_conflict` 诊断」，两方向实测均 `9000` + 1 条；**改实现后尺子立刻 104/105 红**（fixer 原"后出现者写胜"用例），修断言集后回 105/105 —— 改判据要连测试一起改，不是改测试迁就实现 |

## 三、闭环掉的缺陷（都有可复现证据，不是叙述）

1. **D1**：`ZCODE_HTTP_TIMEOUT=30s` → `0` → `http/index.ts:79` 不设计时器 → 全站无超时。
   修复前用一条断言复现，修复后 env/文件两条路径同语义。
2. **D1b**：`ZCODE_HTTP_TIMEOUT=Infinity` → Node 把 `setTimeout(fn, Infinity)` **钳成 1ms** → 每个请求秒死。
   判据里我实测过钳制行为才写入。
3. **F1**：`flushSync()` 只排空 `records`，已被 drain 取走的在飞批次在真实 `process.exit()` 路径上永远写不完
   → 临终日志整批丢失，而 spec 当时声称"exit 零丢失"。现为可计数 + 明确取舍。
4. **MAIN-06（M7）**：删掉 `append-queue.ts:241` 的 await 前检查，同一场景从
   `asyncBatchCalls=0 / dup=0` 变成 `1 / 2` → 该守卫可观测，"被 await 后检查吸收"的说法被推翻。
   注意重复写在 mutant 里 `writeFailures` 仍为 0：**只能数注入 sink 实收行数**。

## 三·五、交付状态（闭合时实测）

- 本地自基线 `69dfda4` 起的全部提交都在这个分支上，工作树干净（`git status -uall` 0 条）。
  提交数与累计物量**不写死在这里**，请现算：
  `git rev-list --count 69dfda4..HEAD` 与 `git diff --shortstat 69dfda4..HEAD`
  （上一次实测 52 文件 / +7528 / −243；写死数字会被"补一条更正"这个动作本身作废，
  本节前面已经因此错过一次，不再犯）
- 已推送到 `https://github.com/lizehao521/Zcod-ubiquitous-palm-tree` 的**新分支**
  `evolution/hermes-m1-m5`，远端 ref 实测与本地 HEAD 同为 `61d7388`。
- **该仓库的 `main` 未被改动**，仍是它自己的 `c821398 "Initial commit"`：
  两边历史无共同祖先，直推 main 只能靠强推覆盖或造一个跨历史合并提交，
  二者都由用户裁决，不作为默认动作。PR 入口：
  `https://github.com/lizehao521/Zcod-ubiquitous-palm-tree/pull/new/evolution/hermes-m1-m5`
- 合并后 CI 预期红灯：`ci.yml` 的 typecheck/lint/architecture/build 指向本 checkout
  不存在的根 `packages/`、`scripts/`（`git ls-files` 实测 0 条），与本轮改动无关。
- 发布面扫描：本轮改动的 50 个文件内，个人路径/账号名/token 形态/本机代理端口 **0 命中**；
  机器局部信息只留在 gitignore 的运维笔记里。

## 四、判据工具（主代理持有，子代理明令禁改）

| 工具 | 用途 | 已验证它自己能抓到脏 |
| --- | --- | --- |
| `docs/evolution/verify.mjs` | 全仓 `*.test.ts` 三态表（PASS/FAIL/WARN-未验证）+ fit | 注入失败用例→FAIL；缺依赖模块→WARN 不算绿；无用例→WARN 且 exit 1 |
| `docs/evolution/tree.mjs` | 谱系追加与渲染，fit 只从真实用例数算 | `4/6` → 0（不是 67）；双分支并行时 frontier 保留两个叶子 |
| `docs/evolution/baseline.mjs` | 快照/差分，证明"改动真发生" | 零改动 → 报警且 exit 1 |

## 五、排除掉的"伪缺陷"（防止后续重复追查）

`proxy-fetch` TLS 每请求重读（已记忆化）、`resolveTlsCaCertFile` 开销（纯字符串）、
全仓到处吞错误（空 `catch {}` 仅 1 处且合法）、"225 处同步 IO 所以都有问题"（绝大多数在启动路径）、
`modelStream.idleTimeoutMs` 是空配置（实读到 `runner-stream.ts:335` 真有计时器）。
台账见 `docs/evolution/scope-pool.md` 组 8。

## 六、环境限制如实声明

- 本 checkout 缺根 `packages/`、`scripts/`、`patches/`；`node_modules` 无 `oxlint`/`typescript`/第三方依赖。
  → `pnpm lint`、`pnpm typecheck`、`architecture:check`、`knip` **全部无法执行**，本文任何位置都不把它们写成通过。
- 唯一尺子是 `node --test` + Node 24 原生类型擦除；两种情况在本环境不可加载：
  (a) **值**导入 `@zcode/*` / `zod` / `proxy-agent` 这类未安装或无法按包名解析的依赖；
  (b) **相对值导入写成 `./x.js`**（本仓 NodeNext 约定）——类型擦除不改写说明符，盘上只有 `.ts`，
  所以必定 `ERR_MODULE_NOT_FOUND`（见 `main-findings.md` MAIN-11，含一处被推翻的旧结论：`iconv-lite` 其实装着）。
  相关缝以"未验证边界"记，不折算成绿灯；也不要为了跑通把 `.js` 改成 `.ts`，那会破坏真实构建。
- GitHub Actions：~~`ci.yml` 指向缺失目录，push 后必然出现结构性红灯，与本次改动无关。~~
  **该预测已被实测推翻**：红灯的成因是缺 CI 要构建的那棵树，不是缺 workflow。
  把本轮提交 cherry-pick 到目标仓库 `main` 的全量树后，五个作业（Lint/TypeCheck/Architecture/Build/Test）
  在 head `1429983` 上全 success；后续把 CLI 的 typecheck 与测试入口接进作业，读数见
  `release-plan.md` 的「CI 实测结论」一节。
  仍然成立的一半：本裁剪检出自己跑不了 `pnpm lint`/`pnpm typecheck`/`architecture:check`，
  所以 CI 的绿灯不能反过来当成本地证据，两条证据链分开记账。
- 提交路径无 husky 门禁（实测），门禁全靠手动执行 `verify.mjs` 并把真实数字写进 commit body。

## 七、遗留与需要人定的事

- 用户裁决 D-A：core 直连 `node:fs` 只记例外不动代码 → 见 `specs/core-fs-boundary/spec.md`（含代价：当前无自动检查会拦）。
- 用户裁决 D-B：`network.timeout = 0` = 显式关闭超时 → M5 落地，必须守住"空串不等于 0"这一条，
  且 `maxConcurrency` 的 0 继续非法。代价已实测：4 个消费点里含 `bootstrap/src/auth-login.ts:386`，
  即登录请求也会一起失去超时。
- 既有超行数文件只记账不修：`file-config.adapter.ts` 624、`schema.ts` 575、`config-factory.ts` 491。

## 八、gen6 补记（A 线还债：M5 三处欠账的闭合状态）

gen6 不新开战线，只闭合 `tree.txt` 自记的 gen5 三处带引号边界（节点 `gen6-a`，父 `gen5-c`）：

1. **A1 · zod 欠账已闭**：`adapters/node_modules/zod`（4.6.5）从本机 pnpm store v10 离线重建（ESM `index.js` 闭包
   95 文件 + CJS `index.cjs` 闭包 95 文件；workspace 全量 install 因 `@zcode/model-option-map` 缺失不可行，
   故不走 lockfile，全量底座 `pnpm install` 会覆盖此目录——它只服务本裁剪树的可执行验证面）。
   `schema.ts` 首次可被 `node --test` 装载，文件门 `.max(2_147_483_647)` 从「文本漂移守卫 + 静态审查」升级为
   **执行断言 + 自包含变异复现**（`config-schema-timeout-exec.test.ts`，10 例全绿：`2^31-1` 过 / `2^31` 拒 /
   `0` 过 / 负数拒 / `∞`·`NaN` 拒；变异 M1 常量 +1 ⇒ 上界漏拦 2^31、M2 摘 `.max()` ⇒ 1e20 放行，
   各 1 条可观察失败证明断言不是空转）。`schema.ts` 的 zod 阻碍自 gen6 起解除；CJS 条件入口未被执行测试
   覆盖（记为未验证边界）。
2. **A2 · set()/merge() 未校验入口——证据收窄，取舍不变**：只读红队探针（grep 全 `packages/**` + 逐条人工复核
   11 个 `*.set` 命中）实测**包外 0 个 `ConfigPort.set()` / `.merge()` 调用点**，唯一写入路径是
   `config-factory.ts:260` 的 `createConfigPort(merged)` 构造注入。M5 的裁剪裁决（不加守卫）**维持**，
   但台账从「0/超大值可以从那里进」收窄为「仅未来跨包直接调用可绕过，本树内无此调用方」，判词与残留射程
   见 `specs/runtime-env-config/spec.md` §12.2a。
3. **A3 · timeout=0 端到端——主代理直驱读数替换为真进程实测**：`http-timeout-zero-e2e.test.ts`（4 例全绿）
   用真挂起的 `127.0.0.1:0` 回环服务器 + 3s 观察窗计时，实测 `timeoutMs=0` ⇒ 请求挂满观察窗不被超时 abort
   （读数 3064ms）；对照组 `timeoutMs=500` ⇒ 519ms abort；`setTimeout(fn, 1e20)` ⇒ Node 实打
   `TimeoutOverflowWarning` 钳成 1ms 触发（MAIN-07 症状当下仍成立的活体证据）。inline 分支副本与
   `http/index.ts:79-84` 的 6 锚点文本等价断言兜住漂移。

读数（`node docs/evolution/verify.mjs`，gen6 收尾实测）：`files=10 PASS=10 FAIL=0 WARN=0 cases=119/119 notRun=0 fit=100`；
谱系 `nodes=12 frontier=[gen4-a, gen3-audit, gen5-b, gen6-a] stale=0`。C 线（收口发布）在本轮只做本地准备，
远端动作留用户在有网环境执行（判据与命令序列见 `release-plan.md` 的「gen6 C 线」节）。
