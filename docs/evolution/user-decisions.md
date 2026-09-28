# 用户裁决登记（2026-09-28，Hermes 进化闭环进行中）

主代理只登记与执行，不替用户决定语义。每条附实测代价。

## D-A · core 直连 `node:fs` 收到哪一步 → **只记例外，不动代码**

- 落点：`specs/core-fs-boundary/spec.md`（已写，含账、硬约束、代价、重开条件）。
- 否决项：扩 `FileSystemPort` 加 move 动词；"接入 4 条已覆盖路径"的折中——
  因为 port 默认实现仍调 `node:fs`，属换皮不算收口。
- 暴露的代价：违规继续存在且**无自动检查**（`pnpm architecture:check`/`pnpm lint` 本 checkout 不可执行），
  这份 spec 是唯一守门人；`moveSavedWorkflow` 的 EXDEV 语义继续散在业务层。

## D-B · `network.timeout = 0` 的语义 → **0 = 显式关闭超时（新语义）**

现状（实测）：`env-config.adapter.ts` 的 gen1 守卫把 `0` 判为 `not_positive` 而丢弃；
`config/schema.ts:7` 的 `positiveNumberSchema` 在文件路径也拒 0；
但 `http/index.ts:79 if (timeoutMs > 0)` 的行为本来就是"0 ⇒ 不设计时器"。
即代码实现早已按"0 = 关闭"行事，只有校验层把它挡在外面。

裁决带来的改动（排入 M5，见任务 #5）：
1. **只有字面 `0`** 对 `network.timeout` 合法并等于"显式关闭"；
   `""`、`"  "`、`"30s"`、`"-5"`、`"Infinity"`、`"NaN"` 继续非法（gen1 的守卫不许放松）。
2. 边界取值必须在 spec 里定死并各自有断言：`"-0"`（`Number("-0") === 0`，但不 `> 0`）、`"0.0"`、`"0e0"`、`" 0"`、`"0x0"`。
3. 文件路径（`schema.ts`）与 env 路径必须同语义，否则又是一条"同一字段两套规则"的老病（D1 的根因形态）。
4. `toolConcurrency.maxConcurrency` 的 `0` **保持非法**——`bootstrap/src/app/dynamic-workflow-run-launch.ts:163`
   `createWorkflowRunSeatGate({ limit: 0 })` 是挂死风险，不是"关闭并发"。
   本条必须写进 spec，防止把 timeout 的新语义顺手推广到别的键。
5. 代价必须写进 spec 正文：显式关闭后挂起的请求**永不超时**，
   且这是用户主动选择的结果，不是被兜底掩盖的异常。

不做的事：不为此新增环境变量；不把 `timeout` 的 0 语义变成默认值（默认仍是 180000）。

### D-B 的真实暴露面（主代理穷举消费方，非抽样）

`network.timeout` 在本仓被当作 `timeoutMs` 交给 HTTP 客户端构造的调用点共 **4 处**
（穷举命令：grep `network\.timeout|ConfigKey.HttpTimeout` 全 `apps/zcode-cli/packages`，
排除 `adapters/src/config/`、`adapters/tests/`、`contracts/src/config/index.ts`；
`zcode-protocol-v4/product-projection.ts:364,382` 是无关字符串字面量 `fault.network.timeout`）：

1. `bootstrap/src/app/create-app.ts:413` — 主 HTTP 客户端
2. `bootstrap/src/app/script-workflow-child-runtime.ts:213` — 工作流子运行时
3. `bootstrap/src/app/workflow-facade.ts:319` — 工作流门面
4. `bootstrap/src/auth-login.ts:386` — **登录/OAuth 请求**

→ 也就是说"显式关闭超时"一旦设成 0，**登录请求也会一起没有超时**：远端不回话时登录会无限挂着，
而不是几十秒后报错。这是 D-B 的代价，不是缺陷，但 M5 必须把它写进 spec 正文（不能只写"0=关闭"），
并在 `auth-login` 那条链上给出可观测提示（关闭超时时留一条 warn/诊断，让用户知道自己选了无超时）。
穷举方式本身也记一笔：我第一次用 `head -14` 截断了这份清单，差点漏掉 `create-app.ts:413` 与 auth-login；
枚举类证据不许带截断读取。

### D-B 前置条件实测：新解析器**已经**能承载 0 值（主代理直驱 `resolve-snapshot.ts`）

`resolve-snapshot.ts:109-116` 的回落表达式写作 `stored === undefined`，实测（真函数注入，非读代码猜）：

```
stored 0          -> network.timeout = 0
stored -0         -> network.timeout = -0      （JS 里 -0 === 0，行为等同关闭；spec 需表态）
stored 60000      -> 60000
absent(undefined) -> 180000（走 documentedDefaultOf）
assembleConfigSnapshot(stored 0) -> snapshot.network.timeout = 0
```

结论：D-B 只差"允许 0 进入 store"这一层（env 守卫 + `schema.ts` 的 `positive()`），
下游 `getAll()/assemble()` 不会把 0 当缺席吞掉——**不必改 resolve-snapshot**，M5 的改动面因此收窄。

探针自纠（不算模块缺陷）：我第一版把 lookup 写成"对任何键都返回同一个值"的常量函数，
于是打出 `features.compact = 0` 这种荒谬读数——那是**我的输入列替被测值做了主**，
不是解析器的错。正确结论只取按键取值的行。

### D-B 的缓解事实（主代理逐处核对 `http/index.ts` 全部 9 处 timeout 提及）

`network.timeout` 在 HTTP adapter 里只有**一个**作用点：`:58` 取值 → `:79 if (timeoutMs > 0)` → `:80-83` 起 abort 计时器，
配套只有 `:127 clearTimeout` 与 `:361 code:"timeout"` 错误码。
**没有** socket 超时、没有 keepAlive 超时、没有第二处隐式依赖同一个数。
⇒ 设 0 的效果是干脆利落的一处"不设墙钟保护"，不存在半开半关的状态。

但要写清一条容易误读的点：**关闭 `network.timeout` 不等于所有流式保护都关了**。
模型流的空闲超时是另一条独立链（`runner-stream.ts:137-138 → :335`，由 `modelStream.idleTimeoutMs` 供值），
仍然生效。所以 D-B 的"最坏后果"精确落在**普通一次性请求**上——
包括 `auth-login.ts:386` 的令牌交换：那一类请求若远端不回包就会无限挂着。
spec 里必须按这个粒度写代价，不写成"所有网络调用都不超时"。

### D-B 实现规则（主代理实测起点表 + 必须避开的陷阱）

当前实现（gen1 守卫）实测读数，`parseEnvConfigWithDiagnostics` 直连驱动：

| 输入 | timeout 现值 | 原因 | maxConcurrency 现值 | 原因 |
| --- | --- | --- | --- | --- |
| `"0"` `"-0"` `"0.0"` `"0e0"` `" 0"` `"0x0"` | undefined | not_positive | undefined | not_positive |
| `"007"` | 7 | 合法 | 7 | 合法 |
| `""` `"  "` | undefined | empty | undefined | empty |
| `"30s"` `"NaN"` `"Infinity"` | undefined | invalid_number | undefined | invalid_number |
| `"-5"` | undefined | not_positive | undefined | not_positive |
| `"1e3"` `"10.5"` `"4"` `"10"` | 1000 / 10.5 / 4 / 10 | 合法 | 同左 | 合法 |

**陷阱（决定性）**：`Number("")` 和 `Number("  ")` 都等于 `0`。
所以"0 表示显式关闭"绝不能实现成 `Number(v) === 0 ⇒ 放行`，
否则 `ZCODE_HTTP_TIMEOUT=`（导出脚本里最常见的误设）就会**静默关掉超时**——
那正是 D1 的缺陷形态换了个名字回来。

必须按这个顺序判定，且顺序本身要写进 spec：
1. `value.trim() === ""` → **非法**（`empty`），保持现状；
2. 非有限数（NaN / Infinity）→ **非法**（`invalid_number`），保持现状；
3. `Number(value) < 0` → **非法**（`negative`，可与 not_positive 合并但语义要写清）；
4. `Number(value) === 0`（已排除 1）→ **仅 `network.timeout` 合法**，语义 = 显式关闭请求超时；
5. 其它正数 → 合法。

边界取值必须在 spec 里逐个表态（`"-0"`、`"00"`、`"0x0"`、`" 0"` 都按第 4 步落为"关闭"）；
`toolConcurrency.maxConcurrency` 的第 4 步**不适用**，0 继续非法（挂死风险），
且 spec 要写明"不得把 timeout 的新语义推广到其它键"。

## 重开条件

任何一条被后续实测推翻（例如 0 值在真实链路上被 `??` 吞掉而根本没到 `http/index.ts:79`）都要回到本文件改裁决，
不许在实现里偷偷偏离。
