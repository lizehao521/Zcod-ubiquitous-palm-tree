# Scope pool（M3 预测扫描 / M4 修复 / M5 融合 的候选证据池）

主代理实测扫描结果，供后续轮次选题。**计数不是缺陷**：每条都要先判定调用频率与失败代价，
再决定 P0/P1/P2；不满足"证据 + 频率"的条目一律不进修复轮（需求不是缺陷）。

扫描口径：`node --test` 可验证性优先（模块的外部导入必须是 `import type`，或被测逻辑能注入依赖）。

## 组 1 · 同步 IO 分布（225 处 / 42 文件，多数在启动路径，属合法）

| 候选 | 位置 | 频率判断要点 | 与 M1 文件冲突 |
| --- | --- | --- | --- |
| C1 保存的工作流存储全同步 | `core/src/tool/handlers/saved-workflows/store.ts:154,207,230,276,278,357,363,375,380` | 由 tool handler 触发，属会话内路径；`listSavedWorkflows` 是 readdirSync + 每文件 readFileSync（N+1 同步读）。需先确认调用频率是否高到值得异步化 | 无 |
| C2 Windows 活动代码页每次执行都同步起子进程 | `adapters/src/exec/outputEncoding.ts:204-221`（`execFileSync(... "chcp", timeout 1000)`）→ 被 `resolveLegacyExecutionOutputEncoding` 调用，`node-execution-adapter-run.ts:68-73` 每次 run 解析一次 | 每次 Bash/命令执行都会走；已有注释承认"重复同步执行 chcp"是代价。可按 env 指纹记忆化 | 无（adapters/src/exec/*，M1 未触碰） |
| C3 子进程/插件启动同步读 | `bootstrap/src/subagents.ts`（7）、`bootstrap/src/app/bundled-plugins.ts`（25）、`adapters/src/plugins/marketplace.ts`（10） | 启动/装载路径，一次性成本；除非能证明在会话循环内重复执行，否则**不是缺陷** | 无 |

## 组 2 · 错误吞噬（极少，说明代码库已收口）

`catch {}` 空捕获在全仓只命中 **1 处**：`adapters/src/exec/bash-file-output.ts:198`（`diagnoseLostBashOutput` 的 statfs 失败回落）。
它属于"诊断增强失败不影响主诊断"，是合法 fail-open。**结论：本仓不存在"到处吞错误"的问题，M3 不得以此为选题方向。**

## 组 3 · 契约一致性（M3 应重点验证的形态）

- 同一字段在两条装载路径上语义不一致：`config/schema.ts:7` `positiveNumberSchema = positive()` 使文件配置拒绝 0/负数，
  而 `config/env-config.adapter.ts:78-81` 的 `normalizeNumber` 把非法值写成 0 并被 `config/index.ts:113` 接受。
  → D1 的根因形态。**同类风险需继续排查**：`env-config.adapter.ts` 里其余 key（LOG_FORMAT、MAX_TOOL_CONCURRENCY 等）
  是否也存在"非法输入 → 有语义的边界值"。
- 外部 I/O 未走统一入口：`contracts/src/interfaces/file-system.port.ts`（`FileSystemPort`，实读签名）
  与 `adapters/src/fs/index.ts:115` `NodeFileSystemAdapter`；`logging/index.ts` 直接 `appendFileSync` 属越界。
  → 审查 M1-B 时必须用这条（见 review-checklist.md B 表）。

## 组 5 · 主代理实测补充（M3/M4 选题用，含可测性判定）

| ID | 证据 | 频率/定性 | `node --test` 可测性（实测） |
| --- | --- | --- | --- |
| C2 | `outputEncoding.ts:207` `execFileSync(... "chcp", timeout:1000)`，唯一调用点 `node-execution-adapter-run.ts:68`（在 `run()` 内） | **每次命令执行都同步起一次 chcp 子进程**（仅 win32）；文件内注释已承认代价 | **不可直接测**：`import(".../outputEncoding.ts")` 实测 `MODULE_NOT_FOUND`。要修必须先抽出零运行时依赖的纯函数模块（参照 gen1-b 的 `append-queue.ts` 做法），否则只能标"未验证" |
| C1 | `core/src/tool/handlers/saved-workflows/store.ts` 直接 `readFileSync/writeFileSync/mkdirSync/readdirSync/renameSync/unlinkSync/statSync`（:154,207,230,276,278,357,363,375,380,390） | 调用点在 `core/src/tool/handlers/create-workflow-source.ts:21`、`core/src/runtime/methods/dynamic-workflow-run-start.ts:82`、`bootstrap/src/zcode-protocol/saved-workflows.ts:60` → **tool 调用与 RPC op 路径** | **未测**：core 层大概率值导入 `@zcode/*` → 需先验加载性 |
| C1-law | CLI AGENTS.md「外部 I/O 边界收敛」原文：*除入口层、基础设施层和 adapter 外，业务模块不得直接调用 `fetch`、`http`、`fs`、`child_process`、`process.env`* | `core/` 是业务层 → C1 首先是**边界违规**（P1），同步 IO 只是它的次生表现。仓库已存在收口对象：`contracts/src/interfaces/file-system.port.ts` + `adapters/src/fs/index.ts:115 NodeFileSystemAdapter` / `:486 createNodeFileSystemAdapter` | 判定修复成本前必须先回答：**core 是否已有注入 port 的既有通道**（有→小改；无→属设计缺陷，按 AGENTS.md 需先与用户对齐，不许堆兜底分支） |
| C3-law | `store.ts:9` 自述"core 的 handler 侧已有同一形态的先例（`bash-git-runtime-safety.ts` 的 readFileSync）" | 先例不是许可：两处同违规应一起记账，修一处不算收口 | — |

## 组 7 · C1 修复成本实测结论（M3 必须先读，别再让 agent 自己撞）

主代理实测两条决定性事实：

1. **core 已有 `FileSystemPort` 注入通道**（不是缺失设计）：`core/src/memory/directory.ts:9`、
   `core/src/memory/recall/manifest.ts:11`、`core/src/runtime/agent-runtime.ts:182,288`、`core/src/runtime/deps.ts:205`。
   → 把 saved-workflows 走 port 属于**沿用既有形态**，不是新抽象。
2. **但 port 动词集不够用**：`contracts/src/interfaces/file-system.port.ts` 实读只有
   `createDirectory(:281) stat(:285) readTextFile(:289) readBinaryFile(:293) readTextFileRange(:297)
   writeTextFile(:301) removeFile(:305) listDirectory(:309) searchFiles(:313) searchText(:317)`
   —— **没有 rename/move**，而 `store.ts:357-381 moveSavedWorkflow` 依赖 `renameSync` + EXDEV 回落。
   且 port 方法是异步的，`store.ts` 现有导出全是同步函数。
3. 调用面实测：`core/src/tool/handlers/create-workflow-source.ts:21`、
   `core/src/runtime/methods/dynamic-workflow-run-start.ts:82`、
   `bootstrap/src/zcode-protocol/saved-workflows.ts:60,75,103`、`bootstrap/.../server.ts:655`、`core/src/index.ts:34`
   → 改同步为异步会**跨包改动调用链**。
4. `core/src` 里直接 `from "node:fs"` 的文件共 **13 个**（不只 C1 一处）。

**结论与纪律**：C1 是真实法律违规，但"完全收口"= 扩 `FileSystemPort` 契约 + 改跨包调用链，属**设计决策**，
按 AGENTS.md「发现设计缺陷时先与用户对齐，不不断增加兜底分支」——M3/M4 不许静默扩契约，也不许为跑通而把 13 个文件一起改。
允许的最小诚实形态：只把已被 port 覆盖的读/写/列/统计路径接入，
`moveSavedWorkflow` 作为**显式记账例外**写进 spec（写明缺 move 动词、需契约变更才能闭合），
不得口头声称"已收口"。其余 12 个文件只记账不修。

## 组 8 · 已排除的"伪缺陷"（主代理实读源码，M3 不得重复追查）

| 候选 | 实测结论 |
| --- | --- |
| 「proxy-fetch 每请求重复读 CA 证书文件」 | **不成立**。`network/proxy-fetch.ts:35-44` 有 `tlsCaCertificatesLoaded` 记忆化；`http/index.ts:132-141` 同样已缓存。两处都不是缺陷 |
| 「每请求调用 `resolveTlsCaCertFile` 有系统调用开销」 | **不成立**。`network/http-config.ts:114-127` 只做候选路径字符串归一，无 `existsSync`/`readFileSync`；且每请求一次相对网络往返可忽略 |
| 「本仓到处吞错误」 | **不成立**。全仓空 `catch {}` 仅 1 处且为合法 fail-open（见组 2） |
| 「`modelStream.idleTimeoutMs` 是配了没人吃的空配置」 | **不成立**。链路实读完整：`config/index.ts:77-78` → `create-app.ts:537` → `bootstrap/src/model-factory.ts:15,33` → `adapters/src/model/runner.ts:108,325` → `runner-stream.ts:137-138` → `:335 timeoutMs: streamIdleTimeoutMs`（真有计时器） |
| 「同步 IO 遍地都是所以都是问题」 | **不成立**。225 处里绝大多数在启动/装载路径（`bundled-plugins.ts` 25 处等）。**判据是频率 × 代价**，不是计数 |

留下的真实候选只剩：**C2**（`outputEncoding.ts:207` 每次命令执行起一次同步 chcp，需先抽纯函数才可测）、
**C1**（`core/.../saved-workflows/store.ts` 业务层直连 `node:fs`，属边界违规；闭合成本见组 7，需先与用户对齐契约扩张）、
以及 M2 正在处理的 gen1 遗留未闭合项。

## 组 9 · M3/M4/M5 定题（主代理裁决，不许另起炉灶）

实读结论决定了后续选题边界：本仓后端面已高度加固（空 catch 1 处、两处 TLS 缓存均已存在、
流式空闲超时确实落地、HTTP 层有 egress 策略与体积上限）。**所以后续轮次的价值不在"再找一个 bug 改"，
而在把"未验证边界"变成"已验证"**——这是可执行证据的真实增量，也是后端架构里最贵的一块（不可观测的装配缝）。

| ID | 题 | 做法（可测性已判定） | owner 文件域 |
| --- | --- | --- | --- |
| T-缝1 | `logging/index.ts` ↔ `AppendQueue` 装配不可加载（enum 值导入） | 把工厂侧决策（级别过滤、脱敏前置、文件名锁定、`kickNow` 触发条件、exit 钩子注册）抽为零运行时依赖的可加载模块并测；目标是让 gen1-b 的 3 条未验证边界降级为可测项 | `adapters/src/logging/*` |
| T-缝2 | `ConfigPort.getAll()` 末段与 `http/index.ts` 计时分支不可加载 | 把"env 缺省回落到 documented default"抽成纯函数（输入各 scope 表 → 输出终值+来源），计时分支同理（输入 timeoutMs → 是否设防/设防值） | `adapters/src/config/*`（M2 之后） |
| T-C2 | `outputEncoding.ts:207` 每次命令执行同步起 chcp（win32） | 抽记忆化纯模块（按 platform+env 指纹注入 runner），断言"第二次解析不再调用 runner" | `adapters/src/exec/*` |
| T-C1 | `core/.../saved-workflows/store.ts` 业务层直连 `node:fs` | 只接入 `FileSystemPort` 已覆盖的读/写/列/统计；`moveSavedWorkflow` 写成 spec 显式例外；不扩契约、不扫其余 12 文件 | `core/src/tool/handlers/saved-workflows/*` |

**禁止方向**：以计数为据的全面异步化/全面 port 化；为跑通而新增 `ZCODE_*`；把启动期一次性同步读当缺陷；
把上表已排除的伪缺陷重新包装成发现。

## 组 6 · 记账（避免后续轮次重复劳动或误判）

- gen1-a / gen1-b 已由主代理独立探针确认（非作者自测）：env 守卫覆盖 `30s / "" / "  " / "-5" / "0" / "Infinity"`，
  合法值 `45000 / 1e3 / 0x10 / 10.5` 不变；队列 `cap=5/200B` 灌 50 条 → `buffered=5 dropped=45 reason=queue-full`，
  异步 `ENOSPC` 不外抛，`flushSync()` 分日期文件落盘。**后续轮次不必重测这些**，应攻击其未验证边界。
- gen1 遗留的已知未闭合项（M2 正在处理，勿抢）：`parseEnvConfigWithDiagnostics` 的诊断**无消费者**
  （`config-factory.ts:192/:368` 仍走 `parseEnvConfig`）；`logging/index.ts`↔队列装配不可加载；
  故障注入由"每行"变"每批"。
