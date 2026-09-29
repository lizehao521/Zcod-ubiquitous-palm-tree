// ============================================================
// AppendQueue 单测（一）：有界队列语义 —— 上限 / 分级 drop / 退避重试 / 自我上报 / 热路径零 syscall
// 运行：node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue.test.ts
//
// 为什么拆成两个文件（gen5 / MAIN-04）：本文件原为 logging-append-queue.test.ts（447 行），
// gen1-b 建 15 例、gen2-b 增到 18 例后越过 CLI AGENTS.md 的 ≤400 行上限。按内聚拆分：
// 队列上界与丢弃/退避/自我上报留在此文件；轮转分组、并发写者与 flushSync 接管竞态
// 移到 logging-append-queue-rotation.test.ts。用例总数不变（本文件 12 例 + 轮转文件 6 例 = 18 例），
// 断言逐条原样搬移，未做任何削弱。两个文件各自持有一份注入 harness——测试边界只允许
// `logging-append-queue*.test.ts` 命名，无法抽出非 .test.ts 的共享 harness helper。
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppendQueue, type AppendQueueIo, type AppendQueueStats } from "../src/logging/append-queue.ts";

interface HarnessOptions {
  maxRecords?: number;
  maxBytes?: number;
  flushIntervalMs?: number;
  highWaterRatio?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  maxConsecutiveFailures?: number;
  selfReportIntervalMs?: number;
  /** 返回错误对象则该次写失败；按已发生的写次数注入。 */
  failWrite?: (writeIndex: number) => Error | undefined;
  /** 返回 pending promise 模拟慢盘/在飞写，由测试自己 resolve。 */
  gateWrite?: (writeIndex: number) => Promise<void> | undefined;
}

interface FakeWrite {
  fileName: string;
  payload: string;
}

interface Harness {
  queue: AppendQueue;
  asyncWrites: FakeWrite[];
  syncWrites: FakeWrite[];
  selfReported: AppendQueueStats[];
  scheduled: Array<{ id: number; delayMs: number; cancelled: boolean }>;
  maxConcurrentWriters: number;
  clock: number;
  /** 推进假时钟并执行到期定时器。 */
  advance(ms: number): Promise<void>;
  /** 只执行已经到期的定时器，不移动时钟。 */
  runDue(): Promise<void>;
  /** 把时钟跳到最早的待触发定时器并执行，直到没有待触发定时器（有界）。 */
  drainAll(): Promise<void>;
  /** 触发下一个定时器一次（含把时钟跳过去），用于制造「写在飞」状态。 */
  fireNextTimer(): Promise<boolean>;
}

/** 假定时器句柄：带 id，cancelSchedule 才能真的撤掉到期项。 */
interface FakeTimerHandle {
  id: number;
  unref(): void;
}

const DAY_1 = "zcode-2026-09-27.jsonl";
const DAY_2 = "zcode-2026-09-28.jsonl";
const MACROTASK_MS = 0;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const due: Array<{ id: number; at: number; callback: () => void; cancelled: boolean }> = [];
  let timerId = 0;
  let writeIndex = 0;
  let concurrentWriters = 0;

  const tick = () => new Promise((resolve) => setTimeout(resolve, MACROTASK_MS));

  const harness: Harness = {
    queue: undefined as unknown as AppendQueue,
    asyncWrites: [],
    syncWrites: [],
    selfReported: [],
    scheduled: [],
    maxConcurrentWriters: 0,
    clock: 1_000,
    advance: async (ms: number) => {
      harness.clock += ms;
      await harness.runDue();
    },
    runDue: async () => {
      // 一次失败会再排一次退避定时器，因此这里循环执行直到没有到期项（有界防死循环）。
      for (let pass = 0; pass < 40; pass += 1) {
        const next = due
          .filter((t) => !t.cancelled && t.at <= harness.clock)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        next.cancelled = true;
        next.callback();
        await tick();
      }
    },
    drainAll: async () => {
      for (let pass = 0; pass < 40; pass += 1) {
        const fired = await harness.fireNextTimer();
        if (!fired) break;
      }
      await tick();
    },
    fireNextTimer: async () => {
      const pending = due
        .filter((t) => !t.cancelled)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!pending) return false;
      pending.cancelled = true;
      harness.clock = Math.max(harness.clock, pending.at);
      pending.callback();
      await tick();
      return true;
    },
  };

  const io: AppendQueueIo = {
    async ensureDir() {
      // 异步 mkdir：真实实现走 fs.mkdir(recursive)，这里不产生副作用。
    },
    async appendBatch(_dir, fileName, payload) {
      const index = writeIndex++;
      concurrentWriters += 1;
      harness.maxConcurrentWriters = Math.max(harness.maxConcurrentWriters, concurrentWriters);
      try {
        await (options.gateWrite?.(index) ?? Promise.resolve());
        const failure = options.failWrite?.(index);
        if (failure) throw failure;
        harness.asyncWrites.push({ fileName, payload });
      } finally {
        concurrentWriters -= 1;
      }
    },
    ensureDirSync() {},
    appendBatchSync(_dir, fileName, payload) {
      const failure = options.failWrite?.(writeIndex++);
      if (failure) throw failure;
      harness.syncWrites.push({ fileName, payload });
    },
    now: () => harness.clock,
    schedule(callback, delayMs) {
      timerId += 1;
      const timer = { id: timerId, at: harness.clock + delayMs, callback, cancelled: false };
      due.push(timer);
      harness.scheduled.push({ id: timer.id, delayMs, cancelled: false });
      const handle: FakeTimerHandle = {
        id: timer.id,
        unref(): void {},
      };
      return handle;
    },
    cancelSchedule(timer) {
      const id = (timer as unknown as FakeTimerHandle).id;
      const found = due.find((t) => t.id === id);
      if (found) found.cancelled = true;
      const entry = harness.scheduled.find((t) => t.id === id);
      if (entry) entry.cancelled = true;
    },
    selfReport(summary) {
      harness.selfReported.push(summary);
    },
  };

  harness.queue = new AppendQueue({ dir: "/logs", io, ...options });
  return harness;
}

function lines(payload: string): string[] {
  return payload.split("\n").filter((line) => line.length > 0);
}

function allWritten(harness: Harness): string[] {
  return [...harness.asyncWrites, ...harness.syncWrites].flatMap((write) => lines(write.payload));
}

test("A1 控制组：happy path 顺序与完整性正确，且批次写次数远小于记录数", async () => {
  const harness = createHarness({ maxRecords: 1_000, maxBytes: 64 * 1024, flushIntervalMs: 200 });
  const expected: string[] = [];
  for (let i = 0; i < 500; i += 1) {
    expected.push(`line-${i}`);
    harness.queue.enqueue(DAY_1, `line-${i}`);
    assert.ok(harness.queue.stats().bufferedBytes <= 64 * 1024, "缓冲区不得超过字节上界");
    if (i % 20 === 19) await harness.advance(200);
  }
  await harness.drainAll();
  harness.queue.flushSync();

  const stats = harness.queue.stats();
  assert.equal(stats.writtenRecords, 500);
  assert.equal(stats.droppedRecords, 0);
  assert.equal(stats.rejectedOversizedRecords, 0);
  assert.equal(stats.writeFailures, 0);
  assert.deepEqual(allWritten(harness), expected, "顺序与完整性必须与入队完全一致");
  assert.ok(stats.writes < 60, `批次写次数应远小于记录数，实际 writes=${stats.writes}`);
  assert.equal(harness.asyncWrites[0]?.fileName, DAY_1);
});

test("A2 磁盘写失败不抛给调用方，计数可见且恢复后继续写", async () => {
  const harness = createHarness({
    backoffInitialMs: 10,
    failWrite: (index) => (index < 2 ? new Error("ENOSPC simulated") : undefined),
  });
  assert.equal(harness.queue.enqueue(DAY_1, "first"), true, "写失败不得影响入队");
  await harness.drainAll();
  const afterFailure = harness.queue.stats();
  assert.ok(afterFailure.writeFailures >= 2, `两次注入故障都应计数，实际 ${afterFailure.writeFailures}`);
  assert.equal(afterFailure.droppedRecords, 0, "退避重试成功时不该丢日志");
  assert.deepEqual(allWritten(harness), ["first"], "重试成功后日志仍要落盘");
  assert.equal(harness.selfReported.at(-1)?.reason, "write-failed", "写失败必须自我上报");

  harness.queue.enqueue(DAY_1, "second");
  await harness.drainAll();
  const stats = harness.queue.stats();
  assert.deepEqual(allWritten(harness), ["first", "second"]);
  assert.equal(stats.bufferedRecords, 0);
  assert.equal(stats.consecutiveWriteFailures, 0, "成功后退避计数必须归零");
});

test("A3 队列满：drop-oldest、计数正确、内存不增长", async () => {
  const harness = createHarness({ maxRecords: 3, maxBytes: 1_000_000, flushIntervalMs: 10_000 });
  for (let i = 0; i < 10; i += 1) {
    harness.queue.enqueue(DAY_1, `m${i}`);
    const stats = harness.queue.stats();
    assert.ok(stats.bufferedRecords <= 3, `bufferedRecords 越界: ${stats.bufferedRecords}`);
  }
  const stats = harness.queue.stats();
  assert.equal(stats.droppedRecords, 7);
  assert.equal(stats.droppedBytes, 21, "7 条 x 3 字节必须计入 droppedBytes");
  harness.queue.flushSync();
  assert.deepEqual(allWritten(harness), ["m7", "m8", "m9"], "必须丢最旧、留最新");
});

test("A3b 字节上界：drop-oldest 同样受 maxBytes 约束", async () => {
  const harness = createHarness({ maxRecords: 1_000, maxBytes: 100, flushIntervalMs: 10_000 });
  for (let i = 0; i < 10; i += 1) harness.queue.enqueue(DAY_1, "x".repeat(40));
  const stats = harness.queue.stats();
  assert.ok(stats.bufferedBytes <= 100, `bufferedBytes 越界: ${stats.bufferedBytes}`);
  assert.ok(stats.droppedRecords >= 1);
});

test("A4 单条超过 maxBytes：拒绝入队并计数，其余记录不受影响", async () => {
  const harness = createHarness({ maxBytes: 20, flushIntervalMs: 10_000 });
  assert.equal(harness.queue.enqueue(DAY_1, "y".repeat(100)), false);
  harness.queue.enqueue(DAY_1, "small");
  const stats = harness.queue.stats();
  assert.equal(stats.rejectedOversizedRecords, 1);
  assert.equal(stats.bufferedRecords, 1);
  harness.queue.flushSync();
  assert.deepEqual(allWritten(harness), ["small"]);
});

test("A8 连续失败到达上限：丢批次并计数，但不永久禁用日志", async () => {
  const harness = createHarness({
    maxConsecutiveFailures: 2,
    backoffInitialMs: 10,
    backoffMaxMs: 10,
    failWrite: () => new Error("disk gone"),
  });
  harness.queue.enqueue(DAY_1, "never-lands");
  await harness.drainAll();
  const stats = harness.queue.stats();
  assert.ok(stats.writeFailures >= 2, `writeFailures=${stats.writeFailures}`);
  assert.ok(stats.droppedRecords >= 1, "持续失败的批次必须计入 droppedRecords");
  assert.ok(stats.selfReports >= 1, "必须有自我上报");
  assert.equal(harness.selfReported.at(-1)?.reason, "write-failed");

  // 关键：持续失败后队列仍能接收新日志，日志链路没有被永久禁用。
  assert.equal(harness.queue.enqueue(DAY_1, "still-accepted"), true);
  assert.ok(harness.queue.stats().bufferedRecords >= 1);
});

test("A9 定时器冲刷：到 flushIntervalMs 后 pending 记录写出", async () => {
  const harness = createHarness({ flushIntervalMs: 200 });
  harness.queue.enqueue(DAY_1, "timed");
  assert.equal(harness.queue.stats().writtenRecords, 0, "未到定时器不得写盘");
  await harness.advance(200);
  assert.deepEqual(allWritten(harness), ["timed"]);
});

test("A10 自我上报按窗口去重，且不回流队列", async () => {
  const harness = createHarness({
    maxRecords: 1,
    selfReportIntervalMs: 5_000,
    flushIntervalMs: 10_000,
  });
  harness.queue.enqueue(DAY_1, "one");
  harness.queue.enqueue(DAY_1, "two");
  harness.queue.enqueue(DAY_1, "three");
  assert.equal(harness.queue.stats().selfReports, 1, "同一窗口只上报一次");
  assert.equal(harness.selfReported.length, 1);
  assert.equal(harness.selfReported[0]?.reason, "queue-full");
  assert.equal(harness.queue.stats().bufferedRecords, 1, "上报不得往队列里加记录");
  await harness.advance(6_000);
  harness.queue.enqueue(DAY_1, "four");
  assert.equal(harness.queue.stats().selfReports, 2, "窗口过期后允许再次上报");
});

test("A11 高水位立即冲刷：不必等 flushInterval", async () => {
  const harness = createHarness({ maxBytes: 100, highWaterRatio: 0.5, flushIntervalMs: 10_000 });
  harness.queue.enqueue(DAY_1, "z".repeat(60));
  const immediate = harness.scheduled.find((t) => !t.cancelled && t.delayMs === 0);
  assert.ok(immediate, "超过高水位必须以 delay=0 冲刷");
});

test("A14 队列满：Warn/Error 记录最后才被丢，普通日志先丢", async () => {
  const harness = createHarness({ maxRecords: 4, maxBytes: 1_000_000, flushIntervalMs: 10_000 });
  harness.queue.enqueue(DAY_1, "e1", true);
  harness.queue.enqueue(DAY_1, "i1");
  harness.queue.enqueue(DAY_1, "i2");
  harness.queue.enqueue(DAY_1, "i3");
  harness.queue.enqueue(DAY_1, "i4");
  harness.queue.enqueue(DAY_1, "e2", true);
  harness.queue.flushSync();
  const written = allWritten(harness);
  assert.ok(written.includes("e1") && written.includes("e2"), "错误证据必须优先保住");
  assert.ok(!written.includes("i1") && !written.includes("i2"), "必须先从普通日志里丢");
  assert.equal(harness.queue.stats().droppedProtectedRecords, 0, "没丢受保护记录时不该计数");
});

test("A16 受保护记录有独立上界：错误风暴不能把普通日志挤死", async () => {
  const harness = createHarness({ maxRecords: 4, maxBytes: 1_000_000, flushIntervalMs: 10_000 });
  for (const name of ["e1", "e2", "e3", "e4", "e5"]) harness.queue.enqueue(DAY_1, name, true);
  harness.queue.enqueue(DAY_1, "info");
  const stats = harness.queue.stats();
  assert.ok(stats.droppedProtectedRecords >= 1, "超过受保护配额必须丢错误并单独计数");
  assert.ok(stats.bufferedRecords <= 4, "两级上界仍须成立");
  harness.queue.flushSync();
  assert.ok(allWritten(harness).includes("info"), "受保护记录不得独占整个队列");
});

test("A13 入队路径零 syscall：fake fs 未被调用时不产生任何写", async () => {
  const harness = createHarness({ flushIntervalMs: 60_000 });
  for (let i = 0; i < 200; i += 1) harness.queue.enqueue(DAY_1, `hot-${i}`);
  assert.equal(harness.asyncWrites.length, 0);
  assert.equal(harness.syncWrites.length, 0);
  assert.equal(harness.queue.stats().bufferedRecords, 200, "热路径只进内存队列");
});
