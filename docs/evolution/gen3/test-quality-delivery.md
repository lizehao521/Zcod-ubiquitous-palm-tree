# test-quality · M3 stage-3 交付（导入闭包审计 + 本轮交付文档）

- 轮次：Hermes gen3 流水线串行第三棒（stage1 `draft-predict.md` → stage2 `review-quality.md` → stage3 本文）
- 边界：只写本文件；其余全部只读；未执行任何 git 写命令；未改动 `verify.mjs` / `baseline.mjs` / `tree.*` 等仪器
- 范围：本轮新增 4 模块 + 6 个被改消费者 + 5 个新测试，共 15 个文件
- 环境事实：trimmed checkout（只有 `apps/zcode-cli/packages/*`），无 oxlint/tsc/vitest，无第三方依赖 ⇒ **没有任何编译器能替我们发现坏导入**，本审计是唯一的静态闭合尺子

---

## 0. 结论一句话

**抽取工作是导入闭合的（import-closed）**：15 个文件里 70 个真实模块说明符，37 个相对说明符全部解析到磁盘上存在的文件，命名导入/重导出 0 个悬空名字，0 个循环是本轮造成的。本轮欠的只有两件事：一个 447 行的测试文件（成文法律违规），8 个零消费者导出（过宽的公开面）。

仪器读数（`node docs/evolution/verify.mjs`，本轮实际执行）：`files=5 PASS=5 FAIL=0 WARN=0 cases=68/68 fit=100`。

---

## 1. 导入闭包（Duty 1）

机械统计口径如下（全部由脚本枚举，非抽样）：

| 项 | 读数 |
| --- | --- |
| 审计文件数 | 15（4 新模块 + 6 改消费者 + 5 新测试） |
| 文本中 `from "…"` 子句总数 | 71 |
| 其中非导入语句（测试内正则字面量） | 1 —— `adapters/tests/config-resolve-snapshot.test.ts` 里断言源码形状用的 `/\.\/resolve-snapshot\.js/` |
| **真实模块说明符** | **70** |
| import 语句 | 58 |
| `export {…} from` / `export * from` 重导出子句 | 12（+1 归入上行统计差） |
| 相对说明符 | 37 |
| 相对说明符解析成功 | **37** |
| **悬空说明符（文件不存在）** | **0** |
| **命名导入/重导出中目标不存在的名字** | **0** |
| `node:*` 内置说明符 | 14 子句（定义即存在，不是风险面） |
| `@zcode/*` 说明符 | 10 子句 / 27 个名字，其中 `@zcode/contracts`（8 子句 25 名）在本 checkout 内有实体（`packages/contracts/src/index.ts`）且逐个命中；`@zcode/shared` 与 `@zcode/shared/workspace-hook-discovery`（2 子句 5 名）**无法校验**：根 `packages/` 不在 checkout 内 |
| 第三方 | `iconv-lite` 1 子句，依赖未安装，只能核到说明符层 |

**闭合判定：相对边 100% 闭合；跨包边中 `@zcode/contracts` 闭合；`@zcode/shared*`（2 子句）在本 checkout 原理上不可校验，记为盲区而非通过。**

### 1.1 仪器踩到的四个坑（写给下一棒，避免重复误报）

第一版脚本给出的都是假阳性，四个都必须先修再谈结论：

1. **NodeNext 约定**：仓库内所有相对说明符写 `./x.js`，实体是 `./x.ts`。不做 `.js→.ts` 映射会报出 **20 个假"悬空"**（含 `./append-queue.js`、`./index.js`、`./config-factory.js` 等全部真实存在的文件）。
2. **`import type` 的捕获组带尾随空格**：`(type\s+)` 捕获的是 `"type "`，用 `=== "type"` 比较恒假 ⇒ 四个新模块曾被误判为 VALUE 导入，直接影响 Duty 3 的可测性结论。
3. **win32 分隔符**：`path.resolve` 返回反斜杠路径，与正向斜杠的节点键不同 ⇒ 首次循环检测报 `edges=0 / NO CYCLE`，是假绿。
4. **`export {…} from` 解析**：一条专用正则在 `config/index.ts` 上匹配 0 条（该文件 7 个 `from` 行里有 5 个是重导出），导致 12 条边和"重导出消费者"被静默丢掉；改用"从 `from` 处回溯最近的 `import`/`export` 关键字"的统一抽取器后，子句总数 71 与 `grep -c 'from "'` 对齐，才承认读数。

---

## 2. 死导出（Duty 2）：8 个零消费者公开名字

口径：全仓 `apps/zcode-cli` 1388 个 `.ts/.tsx`，把每个 import 子句**和**重导出子句都解析到模块，再看目标是否等于该新模块。测试计入消费者，但单独标出。

| 模块 | 导出数 | 零消费者导出 | 内部自用次数 |
| --- | --- | --- | --- |
| `adapters/src/logging/append-queue.ts` | 5 | `AppendQueueOptions` | 3 |
| `adapters/src/logging/append-queue-contract.ts` | 4 | 无 | — |
| `adapters/src/config/resolve-snapshot.ts` | 8 | `ConfigDefaults` | 5 |
| `adapters/src/exec/windows-code-page.ts` | 13 | `WINDOWS_UTF8_CODE_PAGE`、`CODE_PAGE_ENCODING_PREFIX`、`UTF8_ENCODING`、`EncodingExistsPredicate`、`WindowsCodePageDeps`、`WindowsOutputEncodingDeps` | 2–4 |

**严重度定级（不升格）**：这 8 个都不是死代码——每个都在自己模块内被使用（自用次数见上表），违规的是"公开面比实际需要宽"：一个没人 import 的导出是一份没人验证过的契约。按需求分层，它们是 `outside-spec`，不是 `violates-spec`。真正值得动的是 `windows-code-page.ts`：13 个导出里 6 个零消费者 + 4 个仅测试使用，公开面应收窄到 `outputEncoding.ts` 实际用的 3 个（`resolveWindowsOutputEncoding`、`WindowsCodePageProbe`、`WindowsCodePageProbeInput`）。

**仅测试使用（src 内零消费者，本轮新测试是唯一用户）——8 个**：
`AppendQueueTimer`（自 append-queue.ts）、`CONFIG_SNAPSHOT_KEYS`、`defaultPathOf`、`resolveSnapshot`、`parseActiveCodePage`、`codePageToEncoding`、`resolveCodePage`、`readWindowsActiveCodePageEncoding`。
其中 `resolveSnapshot` 值得注意：`config/index.ts` 只对外重导出了 `assembleConfigSnapshot` / `documentedDefaultOf` / `resolveConfigValue` / `ConfigLookup`，`resolveSnapshot` 生产路径无人调用，只有 `config-resolve-snapshot.test.ts` 用。契约成立与否目前完全依赖测试自己。

---

## 3. type-only vs value：哪些接缝在本环境能被测（Duty 3）

| 模块 | 导入形态 | 本环境可加载 | 证据 |
| --- | --- | --- | --- |
| `logging/append-queue-contract.ts` | 零导入 | 纯类型模块，运行期不产出代码 ⇒ **天然无可执行面**，永久 review-only | 静态：无任何 `from` 子句 |
| `logging/append-queue.ts` | 1× `import type`（相对，擦除）+ 1× 类型重导出 | **可加载，已被测** | 2 个测试文件真实 import 它，`node --test` 18+ 通过 |
| `config/resolve-snapshot.ts` | 1× `import type` `@zcode/contracts`（擦除） | **可加载，已被测** | `config-resolve-snapshot.test.ts` 通过 |
| `exec/windows-code-page.ts` | 零导入 | **可加载，已被测** | `windows-code-page.test.ts` 12 通过 |
| `config/env-config.adapter.ts` | 仅 `import type` `@zcode/contracts` | **可加载，已被测** | `env-config.test.ts` 通过 |
| `logging/index.ts` | **VALUE** `@zcode/contracts`、`@zcode/shared` | **不可加载** | 依赖根 `packages/`，checkout 内无实体 |
| `config/index.ts` | **VALUE** `@zcode/contracts` | **不可加载** | 同上 |
| `config/config-factory.ts` | **VALUE** `@zcode/contracts`、`@zcode/shared/workspace-hook-discovery` | **不可加载** | 同上 |
| `exec/outputEncoding.ts` | **VALUE** `iconv-lite`（第三方未安装） | **不可加载** | `node_modules` 缺失 |
| `exec/node-execution-adapter-run.ts` | VALUE 兄弟模块（含 outputEncoding）+ `@zcode/contracts` | **不可加载（传递）** | 经由 outputEncoding |

**可测性结论**：4 个新模块里 3 个真被测（append-queue / resolve-snapshot / windows-code-page），1 个是纯契约不可测（append-queue-contract）。6 个被改消费者**全部不可加载**，其中 `logging/index.ts`、`config/index.ts`、`config-factory.ts` 属永久 review-only（跨包 value 导入），`outputEncoding.ts` 与 `node-execution-adapter-run.ts` 只卡在 `iconv-lite` 一个依赖上——装上依赖即可转为可测，是最便宜的接缝升级点。**本轮唯一没被任何测试接触过的接缝，就是那 3 个 barrel/工厂文件**，它们只经过静态审查。

---

## 4. 循环检查（Duty 4）：`forbidCycles: true`

图口径：仅相对边（含 `import` 与 `export-from` 两个方向）。

- 范围 A（15 个审计文件 + `logging/`、`config/`、`exec/` 三目录全部 `.ts`）：**43 节点 / 76 边 / 1 对互指**
- 范围 B（整个 `adapters` 包）：211 节点 / 443 边 / 3 对互指

点名要查的两对，结论是**都不是循环**：

- `logging/index.ts` → `logging/append-queue.ts`：仅单向（`logging/index.ts:19`），`append-queue.ts` 不回指 `index`。
- `config/index.ts` → `config/resolve-snapshot.ts`：仅单向（`config/index.ts:16`），而 `resolve-snapshot.ts` 没有任何相对导入。**抽取本身没有造环。**

唯一在范围内的环（本轮之外，但必须记账）：

```
adapters/src/config/index.ts  ⇄  adapters/src/config/config-factory.ts
  index.ts:323   export function createConfigPort(...)          ← 定义方
  config-factory.ts:23   import { createConfigPort } from "./index.js"
  config-factory.ts:260  const configPort = createConfigPort(merged)   ← 在函数体内，延迟求值
  index.ts:359-364  export { createConfig, resolveWorkspaceStorageDir, … } from "./config-factory.js"
```

- 归因：**不是本轮造成的**。两条边都存在于 HEAD：`config-factory.ts:23` 与 `config/index.ts:491`（当时 index.ts 还是 491 行；本轮把 resolve-snapshot 抽出后 index.ts 500→364，只是把这条边的行号从 491 挪到 364，没有新增也没有消除）。git 历史只有 2 个提交且 `8289845` 是浅边界，blame 无法再往前追溯，故用 `git show HEAD:` 与脏工作区对比来定案。
- 运行期风险：`createConfigPort` 只在函数体内调用，非模块初始化期解引用 ⇒ ESM 下良性，不会 TDZ 崩。但它是**成文法律违规**，且本环境无法用测试驱动它（两侧都是不可加载的 VALUE 跨包文件）。修法留给写手：把 `createConfigPort` 从 `config/index.ts` 移到独立模块（或直接放进 `config-factory.ts`），barrel 只重导出。
- 范围 B 另外两对（既有台账，非本轮范围）：`model/model-execution.ts ⇄ model/official-coding-plan-gateway.ts`、`model/runner-attribution.ts ⇄ model/runner-status.ts`。

---

## 5. Barrel / 重导出完整性（Duty 5）

- `config/index.ts`：公开面 34 个名字，13 条重导出子句 **0 条断裂**。对 `./env-config.adapter.js` 的重导出在 ENV2-02 修复后逐项命中适配器真实导出（诊断相关名字均解析成功），`./resolve-snapshot.js`、`./schema.js`、`./config-merger.js`、`./config-factory.js`、`./file-config.adapter.js`、`./project-config.adapter.js` 同样 0 缺名。
- `logging/index.ts`：公开面 23 个名字。调用方（全仓扫描）：`adapters/src/index.ts:11`（`export * from`，即 `@zcode/adapters` 入口）、`adapters/src/config/config-factory.ts:31`（`createNodeLoggerFactory`）、`bootstrap/src/app/create-app.ts:6` 与 `bootstrap/src/zcode-protocol-entrypoint.ts:3`（`@zcode/adapters/logging` → `createNodeLoggerFactory`）、`cli/src/run.ts:2`（`@zcode/adapters` → `createNodeLoggerFactory`）。**对外被引用的名字全部在 23 个公开面里，0 个悬空**；`AppendQueue`/`AppendQueueIo`/`AppendQueueStats`/`AppendQueueTimer` 的类型重导出也已核对存在。
- `forbidDeepImports` 侧观察：`bootstrap`/`cli` 都走 `@zcode/adapters/<sub>` 而不是深路径，本轮没有新增深导入。

---

## 6. 400 行法律（Duty 6）

本轮范围内 >400 的文件：

| 行数 | 文件 | 归属 |
| --- | --- | --- |
| 447 | `adapters/tests/logging-append-queue.test.ts` | **本轮新增 ⇒ 本轮欠，不可豁免** |
| 491 | `adapters/src/config/config-factory.ts` | 本轮被改消费者，但 HEAD 已是 491 ⇒ 既有违规，仅记账 |

贴近上限（未违规，抽刀时注意别踩）：`logging/append-queue.ts` 399、`logging/index.ts` 398、`exec/node-execution-adapter-run.ts` 399。前两个是本轮新建/重写的，**已经贴着天花板**，后续任何加行都得先拆。

既有台账（非本轮范围，全仓 `adapters` >400 共 33 个文件，列几个代表）：`config/file-config.adapter.ts` 624、`config/schema.ts` 575、`plugins/marketplace.ts` 2724、`mcp/index.ts` 1950、`fs/index.ts` 1878、`model/runner-stream.ts` 1655、`model/model-execution.ts` 1080、`plugins/index.ts` 991。
另记一条发布卫生项：`adapters/.hermess-snapshots/head-index.ts`（491 行）是本流水线自己的快照产物，落在包目录内且触发行数法；它在 `git status` 里不属于本轮点名文件，提交前的清扫需要单独处置（不要顺手删，也不要为它放宽 ignore）。

---

## 7. 本轮我不 claim 的东西（防下一棒误读）

1. **不 claim 类型正确性**：没有 `tsc`，只核到"说明符存在 + 名字在导出面里"，不核赋值兼容、泛型、可选性。
2. **不 claim 跨包全绿**：`@zcode/shared` 与 `@zcode/shared/workspace-hook-discovery`（2 子句 5 名）在 trimmed checkout 里没有实体，属于结构性盲区。
3. **不 claim 死导出=死代码**：8 个零消费者名字都在自己模块内自用，违规维度是公开面宽度。
4. **一次仓库级跨包名字扫描报了 44 行"MISSING"，我不当结论交出去**：抽查 `ModelSelection` 在 `contracts/src/events/session.events.ts` 确实有导出、`contracts/src/index.ts` 有 53 条 `export *`，说明是我的 `export *` 链展开在超宽 barrel 上失配（假阳性）。要真验跨包名字，得先写一个能吃 53-star barrel 的枚举器，那是独立一棒的工作量。
5. 未跑 `pnpm typecheck` / `pnpm lint`：本 checkout 无 oxlint/tsc/vitest，命令不存在，不是跳过。

---

## 8. 交给 M5 的动作清单（按优先级，只列本轮实测支撑的）

1. 拆 `adapters/tests/logging-append-queue.test.ts`（447→≤400）——本轮自己造的违规，与 MAIN-04 同题。
2. 收窄 `exec/windows-code-page.ts` 公开面：只留 `resolveWindowsOutputEncoding` + 两个 Probe 类型，其余 6 个零消费者导出改为模块内私有或 `export type` 收敛。
3. 消 `config/index.ts ⇄ config-factory.ts` 互指：`createConfigPort` 移出 barrel。
4. `logging/append-queue.ts` 的 `AppendQueueOptions`、`resolve-snapshot.ts` 的 `ConfigDefaults` 同样收口。
5. 若要给 `outputEncoding.ts` 接缝上真测试：它是 5 个不可加载文件里唯一只卡第三方依赖的，比装 `@zcode/shared` 便宜。
