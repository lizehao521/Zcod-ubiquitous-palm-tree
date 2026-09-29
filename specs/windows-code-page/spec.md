# Spec: Windows 活动代码页解析（windows code page）

状态：已采纳（gen4 修复 `fix-exec`，finding T-C2）
适用范围：`apps/zcode-cli/packages/adapters/src/exec/windows-code-page.ts`、`outputEncoding.ts` 的 Windows 分支、`node-execution-adapter-run.ts` 的调用点
不适用范围：UTF-8 缓冲区判定与解码（`decodeExecutionOutputBuffer` / `createExecutionOutputStreamDecoder`，语义不改）、非 Windows 平台（`platform !== "win32"` 直接 `null`，不改）

## 1. 问题（bug 原因）

`outputEncoding.ts` 原 `readWindowsActiveCodePageEncoding()` 用 `execFileSync(cmd.exe /d /s /c chcp, {timeout: 1000})`
——**同步**子进程，阻塞事件循环；唯一调用点 `node-execution-adapter-run.ts:68` 位于 `async run()` 内，
即**每次命令执行都要付一次同步 spawn**（Bash 是最热的工具，`ZCODE_MAX_TOOL_CONCURRENCY` 默认 10）。

本机实测（Windows + Git Bash，主代理采集；后来者请勿重复争论严重性）：

| 观测项 | 数值 |
| --- | --- |
| 单次同步 `chcp` | 中位 **37 ms**（40/39/37/32/37） |
| 同一次读改为异步后事件循环 lag | **0 ms** |
| 10 次串行同步（模拟 10 并发 run 各自解析编码） | 中位 **520 ms**（641/527/495/520/485） |
| 源码里的 `1000` | 是 `timeout` **上限**，不是观测值 |

M3 stage 2 的升级判据是「10 并发 >1s ⇒ P0」；实测 520 ms ⇒ **保持 P1**，本次修复只解除阻塞，不做性能抢救。

阻塞的真实危害不是「本 run 慢 37 ms」，而是这 37 ms 内**其他 run 的 cancel/close 无人服务**
（取消本身仍在本 run 的 `run.ts:47` 与 `:174` 被服务，所以不会把 run 卡死，只是延迟别人的服务窗口）。

## 2. 设计选择：改成异步并在原调用点 await（方案 a）

两条候选里只留一条：

- **（a）已采用**：`resolveLegacyExecutionOutputEncoding()` 改为 `async`，唯一调用点 `run()` 里 `await`。
  一条路径、一次解析、无同步残留。
- （b）未采用：保持同步签名、把异步预取提前到同一 run 内再「等」。需要同时存在「预取句柄 + 同步取值」
  两条路径，任何一侧漏 await 就把阻塞带回来，且没有任何调用方需要同步签名。

代价（明写）：已经处于 aborted 状态的请求仍会在 `run.ts:47` 早退，**不会**触发 `chcp`；但在 `await`
窗口内才被取消的请求，其停止结果要等到 `run.ts:174` 之后的既有 `stoppedBeforeSpawn()` 检查才落地，
即本 run 的取消响应最坏延后一次 `chcp` 往返（实测中位 37 ms，且不再阻塞他人）。原先同步实现下
这 37 ms 是「本 run + 同进程所有 run」一起冻结，因此是净改善，不是回归掩盖。

## 3. 为什么**没有**跨 run 缓存（staleness 论证）

禁止以 env 指纹为 key 做进程级缓存：

- 唯一由 env 决定的输入是 `ZCODE_WINDOWS_OUTPUT_ENCODING`（`outputEncoding.ts`），它在 spawn **之前**
  就短路返回，env 快照对它给的是 0 覆盖率——它本来就不需要缓存。
- `chcp` 真正测量的是**活动控制台代码页**，用户可以在会话中途执行 `chcp 65001` 改变它，env 完全不变。
  跨 run 缓存会把第一次读到的 `cp936` 一直贴给后续 run，导致 UTF-8 输出被按 GBK 解码成乱码，
  而且没有任何可命名的失效条件。**命名不出失效条件就不许加缓存。**
- 因此本模块**每次 run 读一次**，无模块级可变状态。测试 (a)(b) 就是在钉这条语义：注入 runner
  第二次返回不同代码页时结果必须翻转。

每次 run 解析的东西：活动代码页 → legacy 编码字符串（或 `null`）。其余（locale 判定、env 覆盖）都是纯函数。

## 4. 契约

### 4.1 `windows-code-page.ts`（零运行时 import，可被 `node --test` 直接加载）

```
parseActiveCodePage(chcpStdout: string): string | null
    // 取第一段 3–5 位数字；"Active code page: 936" → "936"；无数字 → null
codePageToEncoding(codePage: string, encodingExists: (e) => boolean): string | null
    // "65001" → "utf8"；其他 → "cp<codePage>"，encodingExists 为假 → null
resolveCodePage(chcpStdout: string | null, deps: { encodingExists }): string | null
    // null 输入 → null（失败即回退，不抛）
readWindowsActiveCodePageEncoding(deps): Promise<string | null>
    deps = {
      env: NodeJS.ProcessEnv,                       // 传给被注入的命令
      comSpec: string,                              // 由调用方解析（Windows 下 env 大小写不敏感）
      probe(input: {comSpec, env}): Promise<string> // 注入的命令执行器，返回 stdout
      encodingExists(encoding: string): boolean     // 注入 iconv 判定，避免本模块依赖 iconv
      observeFailure?(error: unknown): void         // 错误形态：reject 被归一为 null 前先交给观测口
    }
    // 错误形态：probe reject/throw → resolve(null)；永不 reject（回退链是功能，不是崩溃）
```

### 4.2 `resolveLegacyExecutionOutputEncoding`（签名改为 async）

```
resolveLegacyExecutionOutputEncoding(options: {
  platform: NodeJS.Platform;
  processEnv: NodeJS.ProcessEnv;
  codePageProbe?: (input) => Promise<string>;   // 测试注入；缺省为 node:child_process execFile 异步实现
  encodingExists?: (e: string) => boolean;      // 测试注入；缺省为 iconv.encodingExists
}): Promise<string | null>
```

回退顺序**逐字保持**（`win32` 才走 2–4）：

1. `ZCODE_WINDOWS_OUTPUT_ENCODING`（trim 后非空）→ `encodingExists` 为真返回该值，否则 **`null`**（不再回退，保持原语义）；
2. 活动代码页解析结果存在且 **≠ `utf8`** → 返回该 legacy 编码；
3. 否则 → locale legacy 编码（LC_ALL/LC_CTYPE/LANG → `Intl` locale，zh→gb18030、ja→cp932、ko→cp949、ru→cp866、默认 cp437）。

`null` 语义不变：非 win32、覆盖 env 写了不存在的编码，都返回 `null`，调用方按 UTF-8 处理。
异步 `chcp` 仍带 `timeout` 上限 1000 ms（超时 → reject → `null` → 走 locale 回退）。

## 5. 验收场景

| # | 给定 | 期望 |
| --- | --- | --- |
| S1 | 覆盖 env `ZCODE_WINDOWS_OUTPUT_ENCODING=cp936` | 返回 `cp936`，**probe 调用 0 次**（不 spawn） |
| S2 | probe reject（cmd.exe 不存在 / 超时） | 不抛错，落到 locale 回退（中文 locale → `gb18030`） |
| S3 | probe 返回 `Active code page: 12345`，`encodingExists("cp12345")` 为假 | 落 locale 回退（未知代码页按不存在处理） |
| S4 | 连续两次解析，注入同一 runner | runner 恰好被调用 **2 次**（证明无跨 run 缓存） |
| S5 | 第二次 runner 返回 `65001` | 第二次结果翻转为 `utf8` 路径（证明代码页变化会被下一次 run 读到） |
| S6 | 解析前 `setImmediate` 排队的回调 | 在 resolution promise settle **之前**执行（非阻塞证明；对同步实现该断言必须失败） |
| S7 | `Active code page: 936` + `encodingExists` 为真 | `cp936`；`65001` → `utf8`；乱码输出 → `null`/locale 回退 |
| S8 | 用 `process.execPath` 起一个**带真实延迟**的子进程作为 probe，解析前 `setImmediate` 排队 | `tick` 仍先于 resolution（非阻塞的真实子进程证明，三平台同一条断言）；同步实现下必须变红 |

## 6. 本环境不可验证（WARN）

- 真实 `cmd.exe` 的 `chcp` 延迟分布（本机异步实现只测过事件循环 lag = 0 ms，未测尾延迟）。
  「异步不阻塞事件循环」这条不再依赖 cmd.exe：S8 用 `process.execPath` 起子进程并显式等待，
  所以三平台都能验；不在覆盖范围内的仍是**真实 chcp 的延迟分布**本身。
  历史教训：S8 前身直接起 `cmd.exe`，Windows 上因为进程启动 >1 个 loop turn 而恰好通过，
  Linux CI 上 cmd.exe 不存在、spawn 立即以 ENOENT 失败，resolution 的微任务排在
  `setImmediate` 之前，实测 104/105 变红 —— 断言的前提应由测试自己保证，不该交给平台运气。
- iconv-lite 对 `cp936`/`gb18030` 的真实解码正确性：本仓库裁剪后未安装依赖，任何 value import
  `iconv-lite` 的模块（含 `outputEncoding.ts`）在 `node --test` 下都 `ERR_MODULE_NOT_FOUND`，
  因此被证明的是**注入 predicate 后的决策逻辑**，不是 iconv 本身。
- `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check` 在此检出不可运行（根 `packages/`、`scripts/` 缺失）。
