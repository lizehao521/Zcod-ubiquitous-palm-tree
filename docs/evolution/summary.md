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
- 新增测试 **7 文件 / 99 用例**，且 `skipped 0 / todo 0`（此前该 checkout 内 `*.test.*` 为 **0**）
- 新增 spec 4：`runtime-env-config`、`logging-persistence`、`windows-code-page`、`core-fs-boundary`
- 修好的既有违规 1：`config/index.ts` **491 → 364** 行（491 是 `git show HEAD` 实测；
  M3 stage2 报的 "500 行" 与 fix-config 自述同错，由 M4 `test-all` 纠正）
- 导出面：HEAD 30 → 现 34，**丢失 0**；多出的 4 个正是 M2 ENV2-02 有意加入的 env API
- **本轮自己新增、又在本轮内收掉的违规 1**：`adapters/tests/logging-append-queue.test.ts` 447 行
  → M5 拆为 345 + 347；用例名与主代理在拆分过程中抢拍的 28 名快照 `diff` 为空
  ⇒ 原 18 例全在，M7 是真新增的第 19 例（既有违规仍只记账不动）
- 已落地提交 5 个：logging / exec / fs 边界例外 spec / .gitignore / config 合并包

## 二·五、M5 融合 DAG 的落地状态（写手三腿已落，审查与汇聚两腿在跑）

| 腿 | 状态 | 实测读数 |
| --- | --- | --- |
| `draft-scan` | 已落 | 39/39 默认值同值、布尔键三存储态 27/27 等价，判词 **REGRESSION: none**；并纠正了主代理的一条断言（`contracts` 配置文件其实可执行，因其自身全是 `import type`） |
| `fix-db` | 已落（在 `afb40aa` 内） | env 套件 21+30=51/51；主代理独立驱动复现全部读数（0 族合法、空串先判、`too_large`、非字符串不外抛、`maxConcurrency` 不搬天花板） |
| `fix-tests` | 已落 | 447 行拆为 345+347；28 个用例名与主代理抢拍快照 `diff` 为空；M7 变异复现 `{0,0}`→`{1,2}` |
| `review` | 已落 | **确认 P1 漂移**：`MAX_TIMER_DELAY_MS` 只在 env 侧，`schema.ts:13` 从不引用它 ⇒ 配置文件写 `1e20` 仍直达 `setTimeout` 被钳成 1ms（复现 `FIRED after 4ms`）；另查出 9 处 spec 引用行号腐坏与"别名后出现者写胜"的未定案项。其自陈的 duty-6 扫描给出别名实测表 |
| `test`（汇聚） | 已落 | 3 连跑读数完全一致；skip 门实证（有 skip ⇒ WARN + `notRun=1` + exit 1，且聚合数字仍显示 100/100 ⇒ 只有门会拦）；差分 19 增/13 改/0 删；TAP 自算 99 与尺子一致；行法零新增违规；**判 (c) 类 10 条"今天就能闭"，其中 2 条 iconv-lite 申报是过期事实** |

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
- GitHub Actions：`ci.yml` 指向缺失目录，push 后必然出现结构性红灯，与本次改动无关。
- 提交路径无 husky 门禁（实测），门禁全靠手动执行 `verify.mjs` 并把真实数字写进 commit body。

## 七、遗留与需要人定的事

- 用户裁决 D-A：core 直连 `node:fs` 只记例外不动代码 → 见 `specs/core-fs-boundary/spec.md`（含代价：当前无自动检查会拦）。
- 用户裁决 D-B：`network.timeout = 0` = 显式关闭超时 → M5 落地，必须守住"空串不等于 0"这一条，
  且 `maxConcurrency` 的 0 继续非法。代价已实测：4 个消费点里含 `bootstrap/src/auth-login.ts:386`，
  即登录请求也会一起失去超时。
- 既有超行数文件只记账不修：`file-config.adapter.ts` 624、`schema.ts` 575、`config-factory.ts` 491。
