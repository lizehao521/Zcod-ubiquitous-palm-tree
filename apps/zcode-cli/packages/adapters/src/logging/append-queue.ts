// ============================================================
// 有界异步追加写队列（日志落盘的唯一写入者）
//
// 拆成独立模块的原因：`logging/index.ts` value-import 了 @zcode/contracts 的
// LogLevel/LogLevelName enum，Node 原生 type-stripping 无法加载它；本模块零运行时
// 外部依赖（契约走 `import type`，会被整句擦除）、fs 与调度全部注入，
// 因此可被 `node --test` 直接验证。
// ============================================================

import type {
  AppendQueueIo,
  AppendQueueOptions,
  AppendQueueStats,
  AppendQueueTimer,
} from "./append-queue-contract.js";

export type {
  AppendQueueIo,
  AppendQueueOptions,
  AppendQueueStats,
  AppendQueueTimer,
} from "./append-queue-contract.js";

interface QueuedRecord {
  fileName: string;
  line: string;
  bytes: number;
  /** Warn/Error 记录：队列满时最后才被丢弃，见 trimToCap 的两级上界。 */
  preserve: boolean;
}

const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_MAX_BYTES = 1_024 * 1_024;
const DEFAULT_FLUSH_INTERVAL_MS = 200;
const DEFAULT_HIGH_WATER_RATIO = 0.5;
const DEFAULT_BACKOFF_INITIAL_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 2_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;
const DEFAULT_SELF_REPORT_INTERVAL_MS = 5_000;
/** Warn/Error 记录最多占用总上界的这一比例，保证普通日志不会被错误风暴挤死。 */
const DEFAULT_PROTECTED_RESERVE_RATIO = 0.5;

export class AppendQueue {
  private readonly dir: string;
  private readonly io: AppendQueueIo;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly flushIntervalMs: number;
  private readonly highWaterBytes: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly selfReportIntervalMs: number;
  private readonly maxProtectedRecords: number;
  private readonly maxProtectedBytes: number;

  private readonly records: QueuedRecord[] = [];
  private bufferedBytes = 0;
  private draining = false;
  private inFlight: QueuedRecord[] | undefined;
  private timer: AppendQueueTimer | undefined;
  private backoffUntil = 0;
  private backoffMs = 0;
  // 初值必须是 -Infinity：注入的时钟可能从 0 开始，用 0 会把首次上报当成「窗口内已上报」吞掉。
  private lastSelfReportAt = Number.NEGATIVE_INFINITY;

  private statsState: AppendQueueStats = {
    bufferedRecords: 0,
    bufferedBytes: 0,
    writes: 0,
    writtenRecords: 0,
    writtenBytes: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    droppedProtectedRecords: 0,
    rejectedOversizedRecords: 0,
    writeFailures: 0,
    writeFailedRecords: 0,
    flushSyncCalls: 0,
    flushSyncRaces: 0,
    flushSyncRescuedRecords: 0,
    consecutiveWriteFailures: 0,
    backoffMs: 0,
    selfReports: 0,
  };

  constructor(options: AppendQueueOptions) {
    this.dir = options.dir;
    this.io = options.io;
    this.maxRecords = clampPositive(options.maxRecords, DEFAULT_MAX_RECORDS);
    this.maxBytes = clampPositive(options.maxBytes, DEFAULT_MAX_BYTES);
    this.flushIntervalMs = clampPositive(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    const ratio = options.highWaterRatio ?? DEFAULT_HIGH_WATER_RATIO;
    this.highWaterBytes = Math.max(1, Math.floor(this.maxBytes * clampRatio(ratio)));
    this.backoffInitialMs = clampPositive(options.backoffInitialMs, DEFAULT_BACKOFF_INITIAL_MS);
    this.backoffMaxMs = clampPositive(options.backoffMaxMs, DEFAULT_BACKOFF_MAX_MS);
    this.maxConsecutiveFailures = clampPositive(
      options.maxConsecutiveFailures,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    );
    this.selfReportIntervalMs = clampPositive(
      options.selfReportIntervalMs,
      DEFAULT_SELF_REPORT_INTERVAL_MS,
    );
    this.maxProtectedRecords = Math.max(
      1,
      Math.floor(this.maxRecords * DEFAULT_PROTECTED_RESERVE_RATIO),
    );
    this.maxProtectedBytes = Math.max(1, Math.floor(this.maxBytes * DEFAULT_PROTECTED_RESERVE_RATIO));
  }

  /**
   * 热路径入口：纯内存操作，永不抛错、永不触发 syscall。
   * 返回 false 表示该记录被拒（超大记录），调用方无需处理，计数器已记录。
   * `preserve` = Warn/Error：队列满时最后才被丢（仍受独立比例上界约束）。
   * 字节按 UTF-16 码元计（1 码元 = 2 字节实际内存），因此 1 MiB 预算对应约 2 MiB 常驻内存，
   * 落盘后的 UTF-8 体积可能更大；这里不换算真实字节，因为热路径不做额外字符串扫描。
   */
  enqueue(fileName: string, line: string, preserve = false): boolean {
    const bytes = line.length + 1;
    if (bytes > this.maxBytes) {
      // 单条就超过字节上界：入队会立刻破坏内存上界，同步写回又把阻塞带回热路径。
      this.statsState.rejectedOversizedRecords += 1;
      this.reportSelf("oversized");
      return false;
    }
    this.records.push({ fileName, line, bytes, preserve });
    this.bufferedBytes += bytes;
    this.trimToCap();
    this.refreshBufferedGauges();
    if (this.bufferedBytes >= this.highWaterBytes) {
      this.kick(0);
    } else {
      this.kickScheduledIfIdle();
    }
    return true;
  }

  /**
   * 关机/fatal 同步冲刷：挂在 process "exit" 上，因为现有 CLI 以 process.exit() 收尾，
   * 之后异步 IO 不再执行，只有同步写能保证临终日志落盘。
   */
  flushSync(): void {
    this.statsState.flushSyncCalls += 1;
    // 根因：真实 process.exit 路径上「在飞」的异步 appendFile 永远不会再完成，原实现只冲
    // 尚未取走的记录，等于整批在飞日志静默消失（规格却写着「丢 0 条」）。
    // 修法：把在飞批次一起同步写。极窄窗口内异步写其实已经落盘时会出现重复行，
    // 对 JSONL 可事后去重；丢失的临终证据不可恢复，所以两害相权取重复。
    const rescued = this.inFlight;
    if (rescued) {
      this.statsState.flushSyncRaces += 1;
      this.statsState.flushSyncRescuedRecords += rescued.length;
      // 清空标记 = 通知在飞的 drain：剩余分组别再写了，由这次同步写接管。
      this.inFlight = undefined;
    }
    const buffered = this.records.splice(0, this.records.length);
    if (buffered.length === 0 && !rescued) {
      this.refreshBufferedGauges();
      return;
    }
    const batch = rescued ? [...rescued, ...buffered] : buffered;
    this.bufferedBytes -= sumBytes(buffered);
    this.refreshBufferedGauges();
    this.cancelTimer();
    try {
      this.io.ensureDirSync(this.dir);
      for (const group of groupByFileName(batch)) {
        this.io.appendBatchSync(this.dir, group.fileName, group.payload);
        this.statsState.writtenRecords += group.records.length;
        this.statsState.writtenBytes += sumBytes(group.records);
      }
      this.statsState.writes += 1;
    } catch {
      // 关机路径的写失败同样不能抛：进程正在退出，吞掉并计数。
      this.statsState.writeFailures += 1;
      this.statsState.writeFailedRecords += batch.length;
      this.statsState.droppedRecords += batch.length;
      this.statsState.droppedBytes += sumBytes(batch);
      this.statsState.droppedProtectedRecords += countProtected(batch);
      this.reportSelf("flush-sync-failed");
    }
  }

  stats(): AppendQueueStats {
    this.refreshBufferedGauges();
    return { ...this.statsState };
  }

  /** 取消待触发的定时器；不 flush，供进程已在退出的路径复用。 */
  stop(): void {
    this.cancelTimer();
  }

  /** Error 级日志走立即冲刷（仍是异步），把「临终日志」窗口压到一次事件循环 tick。 */
  kickNow(): void {
    this.kick(0);
  }

  private kick(delayMs: number): void {
    this.cancelTimer();
    this.timer = this.io.schedule(() => {
      this.timer = undefined;
      void this.drain();
    }, delayMs);
    this.timer.unref?.();
  }

  private kickScheduledIfIdle(): void {
    if (this.timer || this.draining) return;
    this.kick(this.flushIntervalMs);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    const timer = this.timer;
    this.timer = undefined;
    timer.unref?.();
    // 已取消的定时器必须真的清掉，否则退出前仍会被触发一次空 drain。
    this.io.cancelSchedule?.(timer);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.records.length > 0) {
        const now = this.io.now();
        if (now < this.backoffUntil) {
          // 退避期间不再尝试写盘，但日志仍继续入队（受上界约束）。
          this.kick(Math.max(1, this.backoffUntil - now));
          return;
        }
        const batch = this.records.splice(0, this.records.length);
        this.bufferedBytes -= sumBytes(batch);
        this.refreshBufferedGauges();
        this.inFlight = batch;
        try {
          await this.io.ensureDir(this.dir);
          for (const group of groupByFileName(batch)) {
            // flushSync 已经把这批同步接管：剩余分组不再写，否则会整段重复落盘。
            if (this.inFlight !== batch) break;
            await this.io.appendBatch(this.dir, group.fileName, group.payload);
            if (this.inFlight !== batch) break;
            this.statsState.writtenRecords += group.records.length;
            this.statsState.writtenBytes += sumBytes(group.records);
          }
          if (this.inFlight === batch) {
            this.statsState.writes += 1;
            this.inFlight = undefined;
            this.backoffMs = 0;
            this.statsState.consecutiveWriteFailures = 0;
          }
        } catch {
          const takenOverByFlushSync = this.inFlight !== batch;
          this.inFlight = undefined;
          if (takenOverByFlushSync) {
            // 这批的落盘结果已由 flushSync 记账（成功或计入 dropped），不能再回队重写。
            this.statsState.writeFailures += 1;
            this.statsState.consecutiveWriteFailures += 1;
          } else {
            this.handleWriteFailure(batch);
          }
        }
      }
    } finally {
      this.draining = false;
      if (this.records.length > 0 && !this.timer) {
        this.kick(this.backoffMs > 0 ? Math.max(1, this.backoffUntil - this.io.now()) : 0);
      }
      this.refreshBufferedGauges();
    }
  }

  private handleWriteFailure(batch: QueuedRecord[]): void {
    const bytes = sumBytes(batch);
    this.statsState.writeFailures += 1;
    this.statsState.consecutiveWriteFailures += 1;
    if (this.statsState.consecutiveWriteFailures >= this.maxConsecutiveFailures) {
      // 持续失败：丢弃该批次并计数，但不永久关闭日志——后续记录仍会尝试写。
      // 这里是「磁盘一直写不进去」的唯一整批丢证据点，错误证据靠 selfReport 输出到 console 兜住。
      this.statsState.writeFailedRecords += batch.length;
      this.statsState.droppedRecords += batch.length;
      this.statsState.droppedBytes += bytes;
      this.statsState.droppedProtectedRecords += countProtected(batch);
      this.statsState.consecutiveWriteFailures = 0;
      this.backoffMs = 0;
      this.backoffUntil = 0;
      this.reportSelf("write-failed");
      return;
    }
    // 失败批次回到队首，保持 FIFO 顺序；随后按上界裁剪（drop-oldest 会先丢这批最旧的）。
    this.records.unshift(...batch);
    this.bufferedBytes += bytes;
    this.statsState.writeFailedRecords += batch.length;
    this.backoffMs = Math.min(this.backoffMaxMs, this.backoffInitialMs * 2 ** (this.statsState.consecutiveWriteFailures - 1));
    this.backoffUntil = this.io.now() + this.backoffMs;
    this.refreshBufferedGauges();
    this.reportSelf("write-failed");
  }

  /**
   * drop-oldest，但分级：先丢未保护（Debug/Info）记录里最旧的，Warn/Error 的证据留到最后。
   * 两级上界都硬生效——未保护记录不能挤掉受保护证据，受保护记录也不能挤掉普通日志，
   * 受保护部分超过 DEFAULT_PROTECTED_RESERVE_RATIO 时同样被丢，队列永远有界。
   */
  private trimToCap(): void {
    while (this.records.length > this.maxRecords || this.bufferedBytes > this.maxBytes) {
      const dropped = this.records.splice(this.pickDropIndex(), 1)[0];
      if (!dropped) return;
      this.bufferedBytes -= dropped.bytes;
      this.statsState.droppedRecords += 1;
      this.statsState.droppedBytes += dropped.bytes;
      if (dropped.preserve) {
        // 连错误证据都被丢了：这是最高信号的降级，必须单独计数并可被上报看到。
        this.statsState.droppedProtectedRecords += 1;
      }
      this.reportSelf(dropped.preserve ? "queue-full-protected" : "queue-full");
    }
  }

  /** 只在队列满的裁剪循环里做一次线性扫描，避免维护需要多处同步的受保护计数状态。 */
  private pickDropIndex(): number {
    let firstUnprotected = -1;
    let firstProtected = -1;
    let protectedRecords = 0;
    let protectedBytes = 0;
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      if (record.preserve) {
        protectedRecords += 1;
        protectedBytes += record.bytes;
        if (firstProtected < 0) firstProtected = index;
        continue;
      }
      if (firstUnprotected < 0) firstUnprotected = index;
    }
    const protectedOverReserve =
      protectedRecords > this.maxProtectedRecords || protectedBytes > this.maxProtectedBytes;
    if (protectedOverReserve && firstProtected >= 0) return firstProtected;
    return firstUnprotected >= 0 ? firstUnprotected : 0;
  }

  private reportSelf(reason: string): void {
    const now = this.io.now();
    if (now - this.lastSelfReportAt < this.selfReportIntervalMs) return;
    this.lastSelfReportAt = now;
    this.statsState.selfReports += 1;
    this.statsState.reason = reason;
    try {
      this.io.selfReport?.({ ...this.statsState });
    } catch {
      // 上报失败不能影响日志链路本身。
    }
  }

  private refreshBufferedGauges(): void {
    this.statsState.bufferedRecords = this.records.length;
    this.statsState.bufferedBytes = this.bufferedBytes;
    this.statsState.backoffMs = this.backoffMs;
  }
}

function sumBytes(batch: readonly QueuedRecord[]): number {
  let bytes = 0;
  for (const record of batch) bytes += record.bytes;
  return bytes;
}

function countProtected(batch: readonly QueuedRecord[]): number {
  let protectedCount = 0;
  for (const record of batch) if (record.preserve) protectedCount += 1;
  return protectedCount;
}

function groupByFileName(
  batch: readonly QueuedRecord[],
): Array<{ fileName: string; payload: string; records: QueuedRecord[] }> {
  const groups: Array<{ fileName: string; payload: string; records: QueuedRecord[] }> = [];
  for (const record of batch) {
    const last = groups[groups.length - 1];
    if (last && last.fileName === record.fileName) {
      last.payload += `${record.line}\n`;
      last.records.push(record);
      continue;
    }
    groups.push({ fileName: record.fileName, payload: `${record.line}\n`, records: [record] });
  }
  return groups;
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function clampRatio(value: number): number {
  if (value <= 0) return DEFAULT_HIGH_WATER_RATIO;
  return Math.min(1, value);
}
