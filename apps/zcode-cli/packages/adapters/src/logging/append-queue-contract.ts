// ============================================================
// AppendQueue 的类型契约（纯类型模块，零运行时导出）
//
// 拆出原因：`append-queue.ts` 加入分级丢弃与在飞批次救回后超过 CLI AGENTS.md 的
// 单文件 400 行上限；契约与本文件用 `import type` 连接，会被 Node 的 type-stripping
// 整句擦除，因此 `append-queue.ts` 仍然没有任何运行时外部依赖，可被 `node --test` 直接加载。
// ============================================================

/** 注入的定时器句柄：真实实现必须 unref，否则日志队列会拖延进程退出。 */
export interface AppendQueueTimer {
  unref?(): void;
}

/** fs / 时钟 / 调度 / 自我上报的注入边界；本模块不直接接触 node:fs。 */
export interface AppendQueueIo {
  ensureDir(dir: string): Promise<void>;
  appendBatch(dir: string, fileName: string, payload: string): Promise<void>;
  ensureDirSync(dir: string): void;
  appendBatchSync(dir: string, fileName: string, payload: string): void;
  now(): number;
  schedule(callback: () => void, delayMs: number): AppendQueueTimer;
  cancelSchedule?(timer: AppendQueueTimer): void;
  selfReport?(summary: AppendQueueStats): void;
}

export interface AppendQueueOptions {
  dir: string;
  io: AppendQueueIo;
  maxRecords?: number;
  maxBytes?: number;
  flushIntervalMs?: number;
  /** 缓冲达到 maxBytes * 该比例时立即冲刷，不等定时器。 */
  highWaterRatio?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  maxConsecutiveFailures?: number;
  selfReportIntervalMs?: number;
}

export interface AppendQueueStats {
  bufferedRecords: number;
  bufferedBytes: number;
  /** 成功提交的批次写次数（一次批次可含多条记录）。 */
  writes: number;
  writtenRecords: number;
  writtenBytes: number;
  droppedRecords: number;
  droppedBytes: number;
  /** 被丢弃的 Warn/Error 记录数：非 0 意味着崩溃证据可能缺失，必须单独可见。 */
  droppedProtectedRecords: number;
  rejectedOversizedRecords: number;
  writeFailures: number;
  writeFailedRecords: number;
  flushSyncCalls: number;
  /** flushSync 与在飞异步批次重叠次数：该情形下在飞批次被同步接管，顺序可能倒置。 */
  flushSyncRaces: number;
  /** 被 flushSync 从「在飞但尚未确认落盘」状态救回的记录数。 */
  flushSyncRescuedRecords: number;
  consecutiveWriteFailures: number;
  backoffMs: number;
  selfReports: number;
  /** 最近一次自我上报的触发原因，便于排查是队列满还是磁盘故障。 */
  reason?: string;
}
