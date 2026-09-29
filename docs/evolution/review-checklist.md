# Hermes 进化闭环 · 审查判据（M2 / M3 / M5 共用）

判据来源：仓库根 `AGENTS.md` + `apps/zcode-cli/AGENTS.md` + 本环境实测约束。
主代理持有判据所有权；子代理不得为了通过判据而修改本文件。

## A. 证据门槛（最高优先）

1. **只认 `node --test` 的真实输出**。本机没有 `oxlint` / `tsc` / `vitest`，也没有装第三方依赖
   （无 `zod` / `proxy-agent` / `@zcode/*` 链接），所以 `pnpm lint`、`pnpm typecheck`、
   `pnpm --dir apps/zcode-cli typecheck` **一律无法执行**，任何人写"已跑 lint/typecheck 通过"即为造假。
2. 每条"已修复"必须给出：可执行命令 + pass/fail 计数原文。
3. 每条 P0/P1 修复必须带**反向证据**：修复前该断言确实失败或确实复现（如 D1 用
   `parseEnvConfig({ZCODE_HTTP_TIMEOUT:"30s"}).network.timeout === 0` 复现）。
4. **空转检查**：全绿要配 no-op 对照（故意让被测值不变时测试仍应失败），
   否则可能测的是自己写的常量。
5. 无法在本环境验证的边界（如 `logging/index.ts` 因 enum 值导入无法被 type stripping 加载）
   必须写成"未验证边界"，不得外推为通过。

## B. 仓库法律（违反即 P1，改动语义错即 P0）

| 规则 | 出处 | 审查动作 |
| --- | --- | --- |
| 改行为前先写/改 spec | 根 AGENTS.md / CLI AGENTS.md | `specs/<area>/spec.md` 是否先于实现存在且与实现一致 |
| 使用异步文件与网络 IO | 根 AGENTS.md「日志」节 | 热路径是否仍有 `*Sync`（`appendFileSync`/`mkdirSync`/`readFileSync`） |
| 外部 I/O 收口到 adapter/port | CLI AGENTS.md「外部 I/O 边界收敛」 | 是否绕过 `contracts/src/interfaces/file-system.port.ts` 的 `FileSystemPort`；`adapters/src/fs/index.ts:115` 是 `NodeFileSystemAdapter` |
| 错误默认向上冒泡，不许低层吞掉 | CLI AGENTS.md「错误处理优先」 | 新增 `catch {}` 必须证明是 fail-open 边界（如日志不得打断 agent 路径），并带可见计数器 |
| 单文件 ≤ 400 行 | CLI AGENTS.md | 新文件行数；超限需拆 |
| 字面量提取为命名常量 | CLI AGENTS.md | 队列上限、字节预算、定时器 ms 不得散落 |
| 不新增环境变量 | CLI AGENTS.md「工作规范」 | diff 里出现 `ZCODE_` 新 key 即 P0（要先在 spec 定义） |
| bugfix 注释写原因（中文） | 根 AGENTS.md | 每处修复有一行中文 WHY |
| 跨平台 | CLI AGENTS.md | 不得只按 win32 行为实现；路径/换行/权限要走 `node:path`/`fs` |
| 提交拆分：一个功能一个提交 | CLI AGENTS.md「提交规范」 | 最终 push 前按功能拆 commit，不混格式改动 |

## C. 安全半边（缩窄兜底时必须保留）

- 日志：**永不打断 agent 执行路径**（原 `logging/index.ts:134-136` 语义）；异步化后仍须满足——
  写盘异常不外抛、崩溃路径同步 flush、队列有界（无界队列 = 慢盘变 OOM）。
- 配置：非法输入不得**移除既有安全边界**。把超时置 0 等于关掉超时，属于安全边界消失，不是"降级"。
- 任何新增开关/队列/缓存都必须能被观测（计数、丢弃量、积压），否则视为不可观测行为。

## D. 分级

- **P0**：改变运行语义或移除安全/资源边界（双重调用、静默禁用超时、无界内存、绕过取消/超时）。必须本轮修复。
- **P1**：违反仓库法律但不改变对外行为（缺 spec、同步 IO 在非热路径、字面量散落、注释与实现不符）。建议本轮修复。
- **P2**：报告遗漏、命名、可读性。记录，不强行扩面。

## E. 反审查造假清单（V2 条款）

审查方必须 **grep 真实签名**再判定对错，禁止按假想 API 判断。典型翻车：
- 假设 `FileSystemPort.appendFile(...)` 存在（实际接口见 `file-system.port.ts:301` 附近，需实读）；
- 假设 `?? ` 会把 0 当缺省（不会，这正是 D1 的传播原因）；
- 假设 `pnpm install` 能救（离线/裁剪 checkout，不在本轮范围）。
