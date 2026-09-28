# specs/core-fs-boundary/spec.md — core 业务层直连 node:fs 的记账与例外

## 1. 适用的成文法

`apps/zcode-cli/AGENTS.md`「外部 I/O 边界收敛」：
> 除入口层、基础设施层和 adapter 外，业务模块不得直接调用 `fetch`、`http`、`fs`、`child_process`、`process.env` 等底层 I/O API。

收口对象已存在且 core 已在用：`contracts/src/interfaces/file-system.port.ts`（`FileSystemPort`）、
`adapters/src/fs/index.ts:115 NodeFileSystemAdapter`；core 侧注入通道也已有先例
（`core/src/memory/directory.ts:9`、`core/src/runtime/agent-runtime.ts:182,288`）。

## 2. 现状账（实测，非计数式指控）

`core/src` 内直接 `from "node:fs"` 的文件共 **13 个**。本轮被点名的是热路径上的一处：
`core/src/tool/handlers/saved-workflows/store.ts:11-19`（同步 read/write/mkdir/readdir/rename/unlink/stat），
调用面：`core/src/tool/handlers/create-workflow-source.ts:21`、
`core/src/runtime/methods/dynamic-workflow-run-start.ts:82`、
`bootstrap/src/zcode-protocol/saved-workflows.ts:60,75,103`、`bootstrap/.../server.ts:655`、`core/src/index.ts:34`。
同形态先例：`core/src/tool/handlers/bash-git-runtime-safety.ts`（`store.ts:9` 的注释自述）。
**先例不构成许可**：两处同违规一起记账。

## 3. 为什么"完全收口"不是 agent 能自己做的决定

实测两处硬约束：
1. `FileSystemPort` 的动词集（`file-system.port.ts:280-321`）为
   `createDirectory stat readTextFile readBinaryFile readTextFileRange writeTextFile removeFile listDirectory searchFiles searchText`，
   **没有 rename/move/copy**；而 `store.ts:334-385 moveSavedWorkflow` 依赖 `renameSync` + EXDEV 回落。
2. port 方法全异步，`store.ts` 导出全同步，且该文件头部注释（`:5-9`）说明同步是刻意的：
   脚本要在审批弹窗之前就读到内容。改异步要动 6 处跨包调用链并破坏该保证。

→ 完全收口 = 扩 `FileSystemPort` 契约 + 改跨包调用链 + 重定义同步保证，属产品/架构决策。

## 4. 用户裁决（2026-09-28）

**只记例外，不动代码。** 本轮不扩 port 契约，不把 store 接入 port，不扫其余 12 个文件。
注入 port 默认实现仍调 `node:fs` 的折中方案被明确否掉（换皮不算收口）。

## 5. 这条裁决暴露的代价（照原文写，不美化）

- 成文法违规**继续存在**，且没有任何自动检查会拦住它：本 checkout 的
  `pnpm architecture:check` 与 `pnpm lint` 都不可执行（根 `scripts/`、`node_modules` 缺工具链），
  所以这份 spec 是**目前唯一的守门人**，靠人读。
- `moveSavedWorkflow` 的 EXDEV 回落语义继续散在业务层，跨平台行为变更时要在这里改，
  而不是在 adapter 里改一次。
- 后续 agent 若"顺手"把 4 条读/写路径接 port 却留下 move 直连，会造出半收口的第三种状态——
  那种改动需先回到本文件 §4 重开裁决，不许默默发生。

## 6. 重新打开裁决的条件

出现任一情况即重议：port 增加 move/rename 动词；`store.ts` 的同步契约被产品侧取消；
或架构检查工具在本仓恢复可执行且能把该违规纳入 baseline 报告。
