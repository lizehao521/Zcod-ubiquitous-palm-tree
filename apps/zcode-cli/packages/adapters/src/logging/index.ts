// ============================================================
// Node logging adapter - JSONL file and optional stderr sink
// 落盘走 AppendQueue：log() 只入队（纯内存），字节由单 writer 异步批量写
// ============================================================

import { mkdirSync, appendFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LogContext, LogEntry, Logger, LoggerFactory, LogRedactor } from "@zcode/contracts";
import { LogLevel, LogLevelName } from "@zcode/contracts";
import { ZCODE_RUNTIME_ENV_KEY, normalizeZCodeRuntimeEnv } from "@zcode/shared";
import {
  formatLocalLogDate,
  scheduleLogRetentionCleanup as scheduleRetentionCleanup,
  type LogRetentionScheduleOptions,
  type LogRetentionTimer,
} from "./retention.js";
import {
  AppendQueue,
  type AppendQueueIo,
  type AppendQueueStats,
} from "./append-queue.js";
import {
  DefaultLogRedactor,
  formatConsoleLine,
  isLogStatus,
  serializeLogError,
  stripReservedContext,
  toSerializableEntry,
} from "./serialize.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";

export {
  LOG_CLEANUP_STARTUP_DELAY_MS,
  LOG_RETENTION_DAYS,
  cleanupLogRetention,
  formatLocalLogDate,
  scheduleLogRetentionCleanup,
} from "./retention.js";
export type {
  LogRetentionCleanupOptions,
  LogRetentionCleanupResult,
  LogRetentionScheduleOptions,
  LogRetentionTimer,
} from "./retention.js";
export { DefaultLogRedactor } from "./serialize.js";
export { AppendQueue } from "./append-queue.js";
export type { AppendQueueIo, AppendQueueStats, AppendQueueTimer } from "./append-queue.js";
export type { SerializableLogEntry, SerializedLogError } from "./serialize.js";

// 落盘边界常量：一处可调，避免在业务路径散落字面量。
const LOG_APPEND_MAX_RECORDS = 2_000;
const LOG_APPEND_MAX_BYTES = 1_024 * 1_024;
const LOG_APPEND_FLUSH_INTERVAL_MS = 200;
const LOG_APPEND_BACKOFF_INITIAL_MS = 100;
const LOG_APPEND_BACKOFF_MAX_MS = 2_000;
const LOG_APPEND_MAX_CONSECUTIVE_FAILURES = 8;
const LOG_APPEND_SELF_REPORT_INTERVAL_MS = 5_000;
const LOG_FILE_PREFIX = "zcode-";
const LOG_FILE_SUFFIX = ".jsonl";

export interface NodeLogAppendQueueOptions {
  maxRecords?: number;
  maxBytes?: number;
  flushIntervalMs?: number;
}

export interface NodeLoggerFactoryOptions {
  env?: NodeJS.ProcessEnv;
  logDir?: string;
  minLevel?: LogLevel;
  console?: boolean | { stream: NodeJS.WritableStream };
  includeErrorStack?: boolean;
  redactor?: LogRedactor;
  /** 异步落盘队列的边界覆盖；默认见 LOG_APPEND_* 常量。 */
  appendQueue?: NodeLogAppendQueueOptions;
}

export type NodeLogRetentionScheduleOptions = Pick<
  LogRetentionScheduleOptions,
  "delayMs" | "logger" | "now" | "retentionDays" | "setTimeout"
>;

export interface NodeLoggerFactory extends LoggerFactory {
  getLogDir(): string;
  /** 同步冲刷未落盘日志：关机与 fatal 路径必须用它，异步写在 process.exit 之后不再执行。 */
  flushSync(): void;
  /** 队列与丢弃计数：观测「日志到底丢了没有」。 */
  getAppendQueueStats(): AppendQueueStats;
  scheduleLogRetentionCleanup(
    options?: NodeLogRetentionScheduleOptions,
  ): LogRetentionTimer | undefined;
}

export class NodeFileLogger implements Logger {
  private readonly category: string;
  private readonly defaultContext: LogContext;
  private readonly getMinLevel: () => LogLevel;
  private readonly logDir: string;
  private readonly consoleStream?: NodeJS.WritableStream;
  private readonly includeErrorStack: boolean;
  private readonly redactor: LogRedactor;
  private readonly appendQueue: AppendQueue;

  constructor(options: {
    category: string;
    defaultContext?: LogContext;
    getMinLevel: () => LogLevel;
    logDir: string;
    consoleStream?: NodeJS.WritableStream;
    includeErrorStack?: boolean;
    redactor: LogRedactor;
    appendQueue: AppendQueue;
  }) {
    this.category = options.category;
    this.defaultContext = options.defaultContext ?? {};
    this.getMinLevel = options.getMinLevel;
    this.logDir = options.logDir;
    this.consoleStream = options.consoleStream;
    this.includeErrorStack = options.includeErrorStack ?? false;
    this.redactor = options.redactor;
    this.appendQueue = options.appendQueue;
  }

  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.Debug, message, undefined, context);
  }

  info(message: string, context?: LogContext): void {
    this.log(LogLevel.Info, message, undefined, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.Warn, message, undefined, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.log(LogLevel.Error, message, error, context);
  }

  child(context: LogContext): Logger {
    return new NodeFileLogger({
      category: this.category,
      defaultContext: { ...this.defaultContext, ...context },
      getMinLevel: this.getMinLevel,
      logDir: this.logDir,
      consoleStream: this.consoleStream,
      includeErrorStack: this.includeErrorStack,
      redactor: this.redactor,
      // 同一个工厂共用一个队列 = 唯一写入者，child 不能另起一条落盘链路。
      appendQueue: this.appendQueue,
    });
  }

  private log(level: LogLevel, message: string, error?: Error, context?: LogContext): void {
    if (level < this.getMinLevel()) {
      return;
    }

    const mergedContext = { ...this.defaultContext, ...context };
    const entry = this.createEntry(level, message, mergedContext, error);
    // 脱敏必须在入队前完成：批量写只搬运已序列化好的整行，不允许绕过 redactor。
    const serialized = toSerializableEntry(entry, this.redactor);
    const line = JSON.stringify(serialized);

    try {
      // 文件名按 entry 自身时间戳确定：跨午夜时迟到的 drain 也不会把旧日志写进新文件。
      this.appendQueue.enqueue(getLogFileName(entry.timestamp), line, level >= LogLevel.Warn);
      if (level === LogLevel.Error) {
        // Error 级是「临终日志」，立即冲刷（仍是异步），把丢失窗口压到一个事件循环 tick。
        this.appendQueue.kickNow();
      }
    } catch {
      // Logging must never break the agent execution path.
    }

    if (this.consoleStream) {
      this.consoleStream.write(`${formatConsoleLine(entry)}\n`);
    }
  }

  private createEntry(
    level: LogLevel,
    message: string,
    context: LogContext,
    error?: Error,
  ): LogEntry {
    return {
      timestamp: new Date(),
      level,
      levelName: LogLevelName[level],
      event: typeof context.event === "string" ? context.event : undefined,
      module: typeof context.module === "string" ? context.module : this.category,
      message,
      traceId: context.traceId,
      sessionId: typeof context.sessionId === "string" ? context.sessionId : undefined,
      turnId: typeof context.turnId === "string" ? context.turnId : undefined,
      spanId: typeof context.spanId === "string" ? context.spanId : undefined,
      parentSpanId: typeof context.parentSpanId === "string" ? context.parentSpanId : undefined,
      toolCallId: typeof context.toolCallId === "string" ? context.toolCallId : undefined,
      durationMs: typeof context.durationMs === "number" ? context.durationMs : undefined,
      status: isLogStatus(context.status) ? context.status : undefined,
      context: stripReservedContext(context),
      error: error ? serializeLogError(error, this.includeErrorStack) : undefined,
    };
  }
}

export function createNodeLoggerFactory(options: NodeLoggerFactoryOptions = {}): NodeLoggerFactory {
  let currentLevel = options.minLevel ?? getDefaultMinLevel(options.env);
  let retentionCleanupScheduled = false;
  const logDir = options.logDir ?? options.env?.ZCODE_LOG_DIR ?? getDefaultLogDir();
  const consoleStream =
    typeof options.console === "object"
      ? options.console.stream
      : options.console === true || options.env?.ZCODE_LOG_CONSOLE === "1"
        ? process.stderr
        : undefined;
  const redactor = options.redactor ?? new DefaultLogRedactor();
  const appendQueue = createLogAppendQueue(logDir, consoleStream, redactor, options.appendQueue);

  const create = (category: string, defaultContext: LogContext = {}) =>
    new NodeFileLogger({
      category,
      defaultContext,
      getMinLevel: () => currentLevel,
      logDir,
      consoleStream,
      includeErrorStack: options.includeErrorStack,
      redactor,
      appendQueue,
    });

  return {
    createLogger(category: string): Logger {
      return create(category);
    },
    withContext(context: LogContext): Logger {
      return create("root", context);
    },
    setLevel(level: LogLevel): void {
      currentLevel = level;
    },
    getLogDir(): string {
      return logDir;
    },
    flushSync(): void {
      appendQueue.flushSync();
    },
    getAppendQueueStats(): AppendQueueStats {
      return appendQueue.stats();
    },
    scheduleLogRetentionCleanup(scheduleOptions = {}): LogRetentionTimer | undefined {
      if (retentionCleanupScheduled) return undefined;
      retentionCleanupScheduled = true;
      return scheduleRetentionCleanup({
        ...scheduleOptions,
        logDir,
        logger:
          scheduleOptions.logger ??
          create("zcode", {
            module: "adapters.logging",
          }),
      });
    },
  };
}

export function getDefaultLogDir(): string {
  return join(homedir(), ".zcode", "cli", "log");
}

function getDefaultMinLevel(env: NodeJS.ProcessEnv | undefined): LogLevel {
  return isDevelopmentMode(env ?? process.env) ? LogLevel.Debug : LogLevel.Info;
}

function isDevelopmentMode(env: NodeJS.ProcessEnv): boolean {
  const runtimeEnv = normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]);
  if (runtimeEnv === "development") return true;
  if (runtimeEnv === "production" || runtimeEnv === "test") return false;

  // The local dev script runs `tsx src/main.ts`; packaged CLI entrypoints run from dist.
  const entrypoint = process.argv[1] ?? "";
  return entrypoint.endsWith(".ts") && entrypoint.includes(`${join("packages", "cli", "src")}`);
}

function ensureLogDirSync(logDir: string): void {
  maybeThrowStorageFsFault({ operation: "mkdir", path: logDir });
  // recursive mkdir 对已存在目录是幂等的，不需要额外的 existsSync syscall。
  mkdirSync(logDir, { recursive: true });
}

function getLogFileName(date: Date): string {
  return `${LOG_FILE_PREFIX}${formatLocalLogDate(date)}${LOG_FILE_SUFFIX}`;
}

function createLogAppendQueue(
  logDir: string,
  consoleStream: NodeJS.WritableStream | undefined,
  redactor: LogRedactor,
  overrides: NodeLogAppendQueueOptions | undefined,
): AppendQueue {
  // 目录只需建一次；写失败时复位，这样外部删掉日志目录后仍能自愈，而不是永久静默。
  let dirReady = false;
  const io: AppendQueueIo = {
    async ensureDir(dir) {
      if (dirReady) return;
      maybeThrowStorageFsFault({ operation: "mkdir", path: dir });
      await mkdir(dir, { recursive: true });
      dirReady = true;
    },
    async appendBatch(dir, fileName, payload) {
      const logPath = join(dir, fileName);
      try {
        maybeThrowStorageFsFault({ operation: "appendFile", path: logPath });
        await appendFile(logPath, payload, "utf8");
      } catch (error) {
        // 追加失败可能正是目录被删导致的：复位后下一次 drain 会重新 mkdir，避免静默永久失效。
        dirReady = false;
        throw error;
      }
    },
    ensureDirSync(dir) {
      ensureLogDirSync(dir);
    },
    appendBatchSync(dir, fileName, payload) {
      const logPath = join(dir, fileName);
      maybeThrowStorageFsFault({ operation: "appendFile", path: logPath });
      appendFileSync(logPath, payload, "utf8");
    },
    now: () => Date.now(),
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      // 定时器必须 unref：否则「等下一次冲刷」会把已经空转的进程拖住不退出。
      timer.unref?.();
      return timer;
    },
    cancelSchedule(timer) {
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    },
    selfReport(summary) {
      const text =
        `[zcode:log] append queue degraded reason=${summary.reason ?? "unknown"} ` +
        `dropped=${summary.droppedRecords} bytes=${summary.droppedBytes} ` +
        `writeFailures=${summary.writeFailures} rejectedOversized=${summary.rejectedOversizedRecords}\n`;
      if (consoleStream) {
        // 上报只走 console，不回流队列，避免「上报失败 → 再入队 → 再失败」的递归放大。
        consoleStream.write(text);
        return;
      }
      // console 关闭时把同一条摘要作为一行日志入队；上报本身按 5s 窗口限速，量有界。
      // 根因：这里原来手写 JSON 字面量，level 写成枚举数字、status 写成 "degraded"，
      // 与 toSerializableEntry 产出的「level 为小写名、status 受 isLogStatus 白名单约束」
      // 不是同一个 schema，同一文件里混两种行会让 debug/server 的解析器丢行。
      // 修法：统一走同一个序列化入口，脱敏与字段形态一处定义。
      const now = new Date();
      queue.enqueue(
        getLogFileName(now),
        JSON.stringify(
          toSerializableEntry(
            {
              timestamp: now,
              level: LogLevel.Warn,
              levelName: LogLevelName[LogLevel.Warn],
              event: "log.append.queue.degraded",
              module: "adapters.logging",
              message: "Log append queue degraded",
              context: { ...summary },
            },
            redactor,
          ),
        ),
        true,
      );
    },
  };

  const queue = new AppendQueue({
    dir: logDir,
    io,
    maxRecords: overrides?.maxRecords ?? LOG_APPEND_MAX_RECORDS,
    maxBytes: overrides?.maxBytes ?? LOG_APPEND_MAX_BYTES,
    flushIntervalMs: overrides?.flushIntervalMs ?? LOG_APPEND_FLUSH_INTERVAL_MS,
    backoffInitialMs: LOG_APPEND_BACKOFF_INITIAL_MS,
    backoffMaxMs: LOG_APPEND_BACKOFF_MAX_MS,
    maxConsecutiveFailures: LOG_APPEND_MAX_CONSECUTIVE_FAILURES,
    selfReportIntervalMs: LOG_APPEND_SELF_REPORT_INTERVAL_MS,
  });

  // 复用 Node 的 exit 事件而不是新造 shutdown 编排器：现有 CLI 生命周期最终以
  // process.exit() 收尾，exit 回调是同步的，之后异步 IO 不再执行，只有这里能保证临终日志落盘。
  process.once("exit", () => {
    queue.flushSync();
  });
  return queue;
}

