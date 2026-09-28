# draft-scan · gen5 M5 融合轮第一棒：config 收口的值平价回归审计

范围：只审计 gen4 `adapters/src/config` 三处 key→默认值映射收口是否改变了任何**可观测值**。
本棒零代码改动，只写本报告。调用方枚举（`has()`/`get()` of skill/command）、导入闭包/死导出、
新模块变异测试均归另两名代理，未重复。

## 0. 方法与可达性（先说尺子）

- 旧代码不是凭报告文字复原的：`.hermess-snapshots/blobs/81acadf0…`（18 000 B / 492 行，同时含
  `getDefaultValue` 与 `Config key not found`，全库唯一命中）= gen4 改造前的 `config/index.ts`，
  已拷到仓库外临时目录逐行读取。`baseline-pre-gen4.json` 给该文件的清单哈希是 `ca5a32d924162816`，
  该前缀在 blobs 下无对应文件 ⇒ 清单哈希与 blob 命名不总是一致，本棒的旧代码依据是 blob 内容本身，不是清单。
- `contracts/src/config/index.ts` 顶部全是 `import type` ⇒ 它**可以**被 `node --test` 直接加载
  （与简报前提相反：不可加载的是经 `@zcode/*` 包名的 value import）。因此 Duty 1/4 不是纯静态阅读：
  探针同时执行 `DefaultRuntimeConfig` + `resolve-snapshot.ts`，并把旧 `getAll()` 的逐字段表达式
  逐键复刻成对照侧（oracle），7 tests / 7 pass。
- `pnpm typecheck` / `lint` / `architecture:check`：**未执行**（本裁剪检出无 tsc/oxlint/依赖）。
- 仪器（只跑不改）：`node docs/evolution/verify.mjs` → `files=5 PASS=5 FAIL=0 WARN=0 cases=68/68 fit=100`。

## 1. Duty 1 — 39 键默认值平价（空 store，逐键执行读数）

`covered=Y` = `DefaultRuntimeConfig` 里存在该路径；`lit=Y` = 改造前 `getAll()` 用的是硬编码字面量。

| # | key | before | after | covered | lit | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | modelStream.idleTimeoutMs | 600000 | 600000 | Y | N | same |
| 2 | permission.mode | "build" | "build" | Y | N | same |
| 3 | permission.allowedTools | [] | [] | Y | N | same |
| 4 | permission.disallowedTools | [] | [] | Y | N | same |
| 5 | permission.autoApproveHighRisk | false | false | Y | N | same |
| 6 | permission.allowMediumRiskInAuto | false | false | Y | N | same |
| 7 | storage.dir | "~/.zcode" | "~/.zcode" | Y | N | same |
| 8 | storage.sessionDbPath | "~/.zcode/cli/db/db.sqlite" | 同左 | Y | N | same |
| 9 | network.httpProxy | undefined | undefined | **N** | N | same（两边都不回落） |
| 10 | network.noProxy | undefined | undefined | **N** | N | same（同上） |
| 11 | network.caCertFile | undefined | undefined | **N** | N | same（同上） |
| 12 | network.timeout | 180000 | 180000 | Y | N | same |
| 13 | features.compact | true | true | Y | Y | same |
| 14 | features.rewind | true | true | Y | Y | same |
| 15 | features.subagent | true | true | Y | Y | same |
| 16 | features.memory | true | true | Y | Y | same |
| 17 | features.skill | true | true | Y | Y | same |
| 18 | features.mcp | true | true | Y | Y | same |
| 19 | memory.use | true | true | Y | N | same |
| 20 | mcp.servers | {} | {} | Y | N | same |
| 21 | plugins.enabled | true | true | Y | N | same |
| 22 | plugins.dirs | [] | [] | Y | N | same |
| 23 | plugins.enabledPlugins | {} | {} | Y | N | same |
| 24 | plugins.extraKnownMarketplaces | {} | {} | Y | N | same |
| 25 | plugins.options | {} | {} | Y | N | same |
| 26 | plugins.suppressedBuiltins | [] | [] | Y | N | same |
| 27 | skills.enabled | true | true | Y | Y | same |
| 28 | skills.includeInstructions | true | true | Y | Y | same |
| 29 | skills.metadataBudget | 20000 | 20000 | Y | N | same |
| 30 | skills.roots | [] | [] | Y | N | same |
| 31 | skill (→skillOverrides) | {} | {} | Y | N | same |
| 32 | command (→commandOverrides) | {} | {} | Y | N | same |
| 33 | logging.level | "info" | "info" | Y | Y | same |
| 34 | logging.format | "text" | "text" | Y | N | same |
| 35 | toolConcurrency.maxConcurrency | 10 | 10 | Y | N | same |
| 36 | modelAnomalyGuard | {3,3} | {3,3} | Y | N | same |
| 37 | hooks | {false,{},32768,60000} | 同左 | Y | N | same |
| 38 | ui.locale | "en-US" | "en-US" | Y | N | same |
| 39 | ui.theme | "auto" | "auto" | Y | N | same |

**39/39 same，0 mismatch。** 9 个 `?? true`/`?? "info"` 字面量换成表查询后与 `DefaultRuntimeConfig`
今日等值（`lit=Y` 那 9 行），即 gen4 说的是「漂移风险而非错值」，本棒实测确认。
`modelAnomalyGuard`/`hooks` 仍是 `DefaultConfig` 的同一引用（探针 `REF_SHARED_*=true`，改造前后一致）。
形状平价：装配出的 16 个顶层键与旧字面量完全同名同序，无多余 `skill`/`command` 顶层键
（`STRAY_SKILL_KEY=false STRAY_COMMAND=false`，路径覆盖把二者放到 `skillOverrides`/`commandOverrides`）。

唯一顺序差异（非值）：`plugins` 组内旧字面量是 `[dirs, enabled, …]`，新按
`CONFIG_SNAPSHOT_KEYS` 顺序产出 `[enabled, dirs, …]` ⇒ `JSON.stringify(getAll())` 字节会变。
其余分组（network/skills/permission/features/ui、顶层）顺序不变。
这是对 gen4 报告 §2「顺序保持与改造前 `getAll()` 的字面量一致」的一处事实修正，P3：只影响
按字节比较/哈希的消费方；本棒**未**枚举这类消费方（调用方枚举越界），
所以只按「已证实为序差、后果未量化」登记 P3，不升格。已知反证方向：
`file-config.adapter.ts:171/607` 序列化的是各自 patch 对象而非 `getAll()` 结果。

## 2. Duty 2 — 37→39 缺口（`skill`/`command`）

- 改造前实况（blob 源码）：`getDefaultValue` 的 switch 确实只有 37 个 case，无
  `ConfigKey.SkillOverrides`/`CommandOverrides`（旧 :369-448，`default: return undefined`）；
  而旧 `getAll()` :317-319 有 `?? DefaultConfig.skillOverrides` ⇒ S1/S2 键集不一致为真。
- **但生产路径上旧 `get("skill")` 不抛错**：`config-factory.ts:235-236` 把
  `DefaultRuntimeConfig` 作为 System 层喂进 `mergeConfigs`，`createConfigPort(merged)`（:260）→
  `ConfigStore.merge` 的 `if (config.skillOverrides !== undefined) set(…)`（旧 :171-176 与新 :186-191
  **逐字节相同**）⇒ store 里本来就有 `skill`/`command` = `{}`，旧 `get()` 在 `:249` 就命中返回 `{}`。
  抛错只在这类端口可达：`createConfigPort(patch)` 的 patch 省略了这两个字段（注入/测试端口）。
- 结论：write 侧从未变（merge 一直能写这两键，「能写不能读」是改造**前**的既有不对称，收口把它关掉了）；
  read 侧对生产工厂构造的端口 **无变化**；对省略该字段的局部端口是 `throw → {}`、
  `has() false → true`（探针：`has_default_table skill new=true`）。
  判定：**消除不一致的静默语义变更，严格更好（读写终于同一张表），不是回归**；
  它是否算行为变更取决于有没有调用方依赖那条抛错——调用方枚举归另一代理，本棒不重复主张。
- 顺带纠正 gen4 报告 §6 的措辞：「唯一行为偏差」应加限定条件（仅未播种端口），生产工厂下该偏差不可达。
- 同一口径也进了成文法律：`specs/runtime-env-config/spec.md:241-245`（§12.1「唯一的行为偏差
  （只发生在抛错路径）」）把 `get("skill")` 曾抛错当作既存可观测行为陈述。本棒实测该抛错在
  `createConfig()` 生产的端口上不可达（System 层已播种这两键），成立范围是「初始 patch 省略
  `skillOverrides`/`commandOverrides` 的端口」。措辞比源码宽，不是值回归；是否收窄交写手定案。

## 3. Duty 3 — 无回落 → 默认回落 的转换：**没有发生**

- `DefaultRuntimeConfig.network` 只定义了 `timeout: 180000`（contracts :305-307），
  `httpProxy`/`noProxy`/`caCertFile` 是接口里的可选字段（:216-218）且**不在默认值对象里** ⇒
  `documentedDefaultOf` 走到 `cursor["httpProxy"] === undefined` 直接返回 undefined（resolve-snapshot :100）。
  旧侧同样不回落（blob :278-280 是裸 `this.store.get(...)`）。⇒ **平价，无新增回落值**。
- `create-app.ts:413` 的后果：**无**。该处读的是 `configResult.config.network.*`，而
  `configResult.config = configPort.getAll()`（config-factory :261）⇒ 它确实走新接缝，但三个字段
  改造前后同为 `undefined`（own-key 存在、值 undefined，两侧都是），下游
  `createNodeWebFetchHttpClientAdapter({proxyUrl: undefined, …})` 不变。
- 出口决策链：`http/index.ts:64-68` 把 `httpProxy/noProxy` 交给 `proxyResolver`（缺席时回落到 env 捕获）；
  `:168 if (!proxyUrl …)` 走直连 `fetch`；`:272-273 assertPublicEgressProxyBoundary` 在无代理时提前 return
  （public egress 才允许走本地 DNS 校验）。若默认值表哪天补上 `""`，`!proxyUrl`/`Boolean(proxy.proxyUrl)`
  都按假值处理成「无代理」，`noProxyMatched` 亦不变 ⇒ 今天这条链没有任何按 `undefined` 分支的读数被翻转。
- 附带事实（非本轮改动）：`merge()`/`set()` 用 `!== undefined` 作在场判据，所以
  `""` 可被写入并被当作「已存值」透出（旧新一致）。

## 4. Duty 4 — `?? true`/`?? "info"` → 表查询的三态等价（执行读数）

9 个键（features.\*6 + skills.enabled + skills.includeInstructions + logging.level）× 三种 store 状态：

| store 状态 | before | after | 判定 |
| --- | --- | --- | --- |
| 键缺席 | `true` ×8 / `"info"` | `true` ×8 / `"info"` | 9/9 same |
| 存 `false` | `false` | `false` | 9/9 same |
| 存 `""` | `""` | `""` | 9/9 same |

27/27 无分歧。已证伪前提「`?? true` 会把存进去的 `false` 读成 `true`」：两侧都返回 `false`，
`resolveConfigValue` 的 `stored === undefined` 与 `??` 在这三态上等价（`??` 也只在 null/undefined 回落）。

**唯一不等价态 = 存 `null`**（旧 `??` 回落成默认，新 `=== undefined` 把 `null` 当已存值透出）：
9/9 `before=true|info → after=null`。可达性实测：文件路径被 zod 挡住
（schema.ts:33-40 `features.*: z.boolean().optional()`，`null` 校验失败），env 适配器零 `null` 字面量，
`config-merger`/`mergeConfigs` 不产 `null` ⇒ 仓库内无可达写入方，只有直接 `set(key, null)`
（index.ts:288 运行期无校验）能造出来。判定：**潜在语义收窄，P2/latent，不是可观测回归**；
建议在 resolve-snapshot 注释里把「null 从回落改为透传」写成显式决策（现为隐含）。

## 5. 台账（排除掉的伪缺陷 / 仍需他人收的）

- 排除：默认值漂移（0/39）、`?? true` 布尔态（27/27）、形状与顶层键（同 16 键同序）、
  引用共享（未新增拷贝）、无回落网络串（仍 undefined）、`skill`/`command` 写侧（逐字节未变）。
- 记 P3：`plugins` 组内键序变化（仅字节比较敏感）。
- 记 P2：`null` 透传（无可达写入方，属设计口径未成文）。
- 未做（越界）：`has()`/`get()` 调用方枚举、死导出、新模块变异测试；端到端 `ConfigPortImpl` 断言
  仍不可加载（`@zcode/contracts` 包名 value import）。

## 6. 前后谱系的自证与本棒的时效性

- 「before」不是 HEAD 的替代品而是同一份字节：`git show HEAD:…/config/index.ts` 的 sha256 前缀
  `81acadf07e16df3d`、492 行，与 blob 逐字节相等（`HEAD==blob true`）⇒ 本轮工作区里
  `config/index.ts` 的 M 状态就是 gen4 收口本身，对照侧取的就是它。
- 同时有两名代理在写 config 层：`config-factory.ts`（+33 行）与 `env-config.adapter.ts`（+165 行）
  在工作区已 M。本棒的可达性论证只依赖 `config-factory.ts` 里
  `DefaultRuntimeConfig` System 层（:235-236）、`createConfigPort(merged)`（:260）、`configPort.getAll()`（:261）
  三行，实测该文件的 diff 对这 3 个符号**命中 0 次** ⇒ 未被并发改动；
  `env-config.adapter.ts` 改名后现状 `null` 计数仍为 0 ⇒ Duty 4 的 null 不可达结论在读到的实时内容上重跑过一遍。

REGRESSION: none（39/39 默认值平价、三态布尔平价、无回落字段保持 undefined；
两条 P2/P3 记为口径与顺序事实，非值变更。）
