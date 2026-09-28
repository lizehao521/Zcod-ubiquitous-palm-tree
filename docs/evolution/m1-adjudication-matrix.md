# M1-A 验收矩阵（主代理实测 env 面全量，用于裁决 A 的修复是否完整）

`env-config.adapter.ts` 的 `ZCODE_` 面只有 8 个 key（全文实测，89 行）：
`STORAGE_DIR`(:26) `SESSION_DB_PATH|SESSION_DB`(:29) `HTTP_PROXY`(:35) `NO_PROXY`(:38)
`AGENT_CA_CERT`(:41) `HTTP_TIMEOUT|TIMEOUT`(:44) `LOG_FORMAT`(:50) `MAX_TOOL_CONCURRENCY`(:56)。

`normalizeNumber`(:78-81) 有三个调用点，修复必须**全部**覆盖，漏一个即判不完整：
1. `:46` `network.timeout`
2. `:58` `toolConcurrency.maxConcurrency`
3. `:70` `getToolConcurrencyConfig()`（读 `process.env`，默认字符串 `"10"`）

## `Number()` 的真实语义 → 非法输入共有 4 种形态（A 的测试必须逐个覆盖）

| 输入 | `Number(v)` | `isNaN` | 现结果 | 后果（timeout 路径） |
| --- | --- | --- | --- | --- |
| `"30s"` | NaN | true → 走 `:80` 返回 0 | 0 | `http/index.ts:79 if (timeoutMs > 0)` 假 → **完全不设超时** |
| `""`（`ZCODE_HTTP_TIMEOUT=`） | 0 | false | 0 | 同上。注意：空串**不**是 NaN，只按 `isNaN` 分支修复会漏掉它 |
| `" "` / `"  \t"` | 0 | false | 0 | 同上 |
| `"-5"` | -5 | false | -5 | `> 0` 假 → 同上；且 `schema.ts:7` `positive()` 在文件路径会拒绝它 → 两条路径不一致 |
| `"0"` | 0 | false | 0 | 需判定：0 是"用户显式关超时"还是非法。文件侧 `positive()` 拒绝 0，故 env 侧接受 0 属语义分裂 |
| `"1e3"` / `"0x10"` | 1000 / 16 | false | 合法 | 需判定是否允许非十进制/科学计数法进配置 |

`maxConcurrency` 同理：`"abc"` → 0 → `bootstrap/src/app/dynamic-workflow-run-launch.ts:163`
`createWorkflowRunSeatGate({ limit: caps.maxConcurrency })`，limit 0 的座位门是**挂死风险**（不是性能问题）。

## D1b（主代理实测新增，非推测）：`Infinity` 的反向失效

`node -e` 实测：`Number("Infinity")` = Infinity，`isNaN` false，`> 0` true → `http/index.ts:79` **会**进 arm，
但 Node 对 `setTimeout(fn, Infinity)` 的行为是：打印 `TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed integer.
Timeout duration was set to 1.` 并**把延时改成 1ms**（实测 "fired after 6 ms"）。
所以 `ZCODE_HTTP_TIMEOUT=Infinity` 的后果与 0 相反但同样致命：**每个请求约 1ms 即超时，全部失败**。
`schema.ts:7` 的 `positiveNumberSchema = z.number().finite().positive()` 在文件路径本来就用 `.finite()` 挡住了这种值；
env 路径没有等价检查 → 与 D1 同根：**env 侧缺少文件侧已有的校验语义**。
判定：A 若只按 `isNaN` 收口而没做有限性检查，记 **P1 未完成**（漏 Infinity/超大值）。
`"1e3"`→1000、`"0x10"`→16、`"10.5"`→10.5 是否允许进配置，A 需在 spec 里显式表态（不许留空）。

## 对照组（不是缺陷，A 不得顺手"修")
- `normalizeLogFormat`(:83-89)：非法值回落 `"text"`，是文档化默认值，且不制造边界值 → 保留。

## 裁决口径
- 若 A 只处理 NaN：判 **P1 未完成**（漏 `""`、`" "`、负数三种形态）。
- 若 A 新增 `ZCODE_*` key：判 **P0 违规**（CLI AGENTS.md 禁止未经 spec 定义新增环境变量）。
- 若 A 让非法值抛错打断启动：判 **P0 违规**（fail-open：非法输入必须降级 + 可观测，不得崩溃）。
- 若 A 无 no-op 对照（合法值仍产出同一数字）：判 **测试无效**（可能测的是常量）。

# M1-B 验收矩阵（日志）

必须保留的安全半边（原 `logging/index.ts:134-136`）：写盘异常**不得**外抛进 agent 路径。
缩窄原同步语义时，以下四项缺一不可，缺项按"丢了安全半边"处理：
1. 队列**有界**（字节 + 条数双上限），满时有计数且自报丢弃量（无界队列 = 慢盘变 OOM）；
2. 崩溃/退出路径有**同步 flush** 钩子，并如实写出最坏丢失窗口（毫秒或条数）；
3. 行序保持 + 跨零点轮转时写对文件；
4. 脱敏（`toSerializableEntry`/redactor）仍在入队前完成，不得绕过。

越界检查：新增的落盘逻辑是否走 `contracts/.../file-system.port.ts` 的 `FileSystemPort`
（实现 `adapters/src/fs/index.ts:115`）；若直接调 `node:fs`，P1 记入 spec 的"未收口"条目，不得口头声称已收口。
