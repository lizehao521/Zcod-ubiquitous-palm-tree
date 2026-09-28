# Env Config Report (gen1 / fix-env-config)

## (a) 已确认的传播链（逐跳核实，非推断）

```
ZCODE_HTTP_TIMEOUT="30s"
  adapters/src/config/env-config.adapter.ts:44-46   normalizeNumber -> config.network.timeout = 0
  adapters/src/config/index.ts:113-114              timeout !== undefined -> set(ConfigKey.HttpTimeout, 0)
                                                     （0 会覆盖文件层已经校验过的合法值）
  adapters/src/config/index.ts:281                  ?? DefaultConfig.network.timeout  —— ?? 不挡 0
  bootstrap/src/app/create-app.ts:413               timeoutMs: configResult.config.network.timeout
  adapters/src/http/index.ts:58                     ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS —— 同样不挡 0
  adapters/src/http/index.ts:79                     if (timeoutMs > 0) 为 false -> 不挂 setTimeout
                                                     => 一个环境变量拼写错误静默关闭全部请求超时
```

同类：`env-config.adapter.ts:56-58`（`ZCODE_MAX_TOOL_CONCURRENCY=abc` -> 0）与
`:68-72`（`getToolConcurrencyConfig` 的 `?? "10"` 之后仍走 `normalizeNumber`）。
`core/src/tool/scheduler.ts:56` 的 `options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY`
同样不接受 0，所以 0 会真的落到并发上界。
`ZCODE_HTTP_TIMEOUT=""` 更隐蔽：`Number("") === 0`，空值也关掉超时。

契约冲突已核实：`config/schema.ts:7` `positiveNumberSchema = z.number().finite().positive()`，
`:30` `network.timeout` 与 `:218` `toolConcurrency.maxConcurrency` 都用它 ——
文件层对同一字段拒绝 0，Env 层接受 0，两层对同一 key 契约不一致。
默认值唯一归属是 `contracts/src/config/index.ts:305-307`（`network.timeout: 180000`）与
`:342-344`（`maxConcurrency: 10`），落点在 `adapters/src/config/index.ts:281`、`:324-327`。

## (b) 选定的契约与它暴露的唯一取舍

契约：**非法（空 / 非有限 / 非正）数值 = 该 key 在 Env scope 缺席 + 产出诊断**，
由 `ConfigPort.getAll()` 回落到 `DefaultConfig`（超时 180000、并发 10）。
判据与文件层 `positiveNumberSchema` 严格对齐（因此不额外要求整数），不做比文件层更宽的例外。
接口：新增 `parseEnvConfigWithDiagnostics(env, options) -> { config, diagnostics }`；
`parseEnvConfig` 签名与返回类型不变（薄封装），`getToolConcurrencyConfig` 增加可选注入参数
（零参调用仍兼容）并回落到命名常量 `DEFAULT_MAX_TOOL_CONCURRENCY = 10`。
不抛异常、不退出进程、不新增运行时依赖（本层保持只有 `import type` 外部依赖）。

**没有**任何一处代码把 0 当作这两个字段的合法语义（文件层 schema 明确 `.positive()`；
`engine.ts:583` 用 `Math.max(1, ...)` 把 0 抬回 1；`contracts` 未定义「无超时」哨兵），
所以不保留「显式 0」语义，spec §9 记录了这条结论。

暴露的取舍（一句话）：诊断通道建好了但**还没被消费** ——
`config-factory.ts:192` 仍走兼容入口，`config/index.ts:483` 也未 re-export 新 API，
两者都在我的文件边界之外。因此当前环境里非法 env 是「安全回落 + 不可见」，
而不是「安全回落 + 已上报」。接入只需 `config-factory.ts` 换调用并把 `diagnostics`
并入已有的 `logConfigDiagnostics`（`:172-177` 已有文件层同款通道）。

第二个取舍：`ZCODE_LOG_FORMAT` 的非法值仍返回 `"text"`（保持 Env 覆盖项目配置的既有行为，
属无关变更不做），只补 `unsupported_value` 诊断让降级可见；spec §5.3 记录了这条已知不对称。

## (c) 测试命令与真实输出

```
node --test apps/zcode-cli/packages/adapters/tests/env-config.test.ts
tests 21 / suites 5 / pass 21 / fail 0 / cancelled 0 / skipped 0 / todo 0
duration_ms 203.408
真实进程退出码：REAL_NODE_EXIT_CODE=0
```

含 no-op 控制断言（防「一律忽略」式假修复）：`AC-4 control` 要求
`ZCODE_HTTP_TIMEOUT=45000`、`ZCODE_MAX_TOOL_CONCURRENCY=4`、`ZCODE_LOG_FORMAT=json`
仍返回原值且 `diagnostics` 为空；`AC-8 control` 要求 `getToolConcurrencyConfig({…"3"…})` 仍是 3。

`pnpm typecheck` / `pnpm lint` **未运行**：裁剪仓库无 `typescript`/`oxlint`，
`packages/adapters/package.json` 也无 `node_modules/@zcode/*` 链接。如实记录为未验证。

## (d) 未能验证的用例与原因

- spec 验收场景 1/2/3/5 的最后一跳「经 `ConfigPort.getAll()` 得到 180000 / 10」未执行：
  `config/index.ts` 与 `config-merger.ts` 有 `@zcode/contracts` 的 **value** import
  （`ConfigScope, ConfigScopePriority`），裁剪环境装载即 `ERR_MODULE_NOT_FOUND`。
  改为断言该跳的可观察前提 `config.network === undefined`（即 `config/index.ts:113` 的
  `!== undefined` 守卫生效、不会写入 `ConfigKey.HttpTimeout`），并静态核实 `:281`/`:324-327` 回落。
- `http/index.ts` 的 `timeoutMs > 0` 分支未做运行时端到端验证：该文件有
  `proxy-agent`（value import，未安装）且在我的文件边界之外。链路上第 6、7 跳是读码核实。
- 真实启动路径（bootstrap 装配）未执行，原因同上。

## (e) 我写过的文件

- `specs/runtime-env-config/spec.md`（新建目录 + spec，含逐 key 契约、非法值语义、默认值归属、8 条验收场景、遗留项）
- `apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts`（修改，唯一被改的源文件）
- `apps/zcode-cli/packages/adapters/tests/env-config.test.ts`（新建目录 + 21 个断言用例）
- `docs/evolution/gen1/env-config-report.md`（本文件）

未触碰 `adapters/src/logging/*`、`adapters/src/http/*`、`config/schema.ts`、`config/index.ts`、
`config/config-factory.ts`、`bootstrap/*`、`.gitignore`；未运行任何 `git` 写操作、未做 `pnpm install`。
