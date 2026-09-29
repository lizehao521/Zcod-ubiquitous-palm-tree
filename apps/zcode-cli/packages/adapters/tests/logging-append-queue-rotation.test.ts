// ============================================================
// AppendQueue 单测（二）：轮转分组 / 单一写者 / flushSync 接管竞态 / 顺序倒置防护
// 运行：node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue-rotation.test.ts
//
// 为什么拆成两个文件（gen5 / MAIN-04）：见 logging-append-queue.test.ts 顶部说明——原 447 行文件
// 按内聚拆分，队列上界/丢弃留那边，轮转与竞态在此。用例总数不变（本文件 6 例搬移 + 1 例新增 M7 =
// 与 12 例的 bounds 文件合计保住原 18 例，并钉住 MAIN-06 证明可观测的 M7 变异体）。
//
// M7 用例新增原因（gen5 / MAIN-06，主代理实测推翻 stage-2「被吸收」结论）：
// drain 里 `await this.io.ensureDir` 之前、`this.inFlight = batch` 之后有第一个
// `if (this.inFlight !== batch) break;`（append-queue.ts:241），它覆盖的是「flushSync 在 ensureDir
// 这段 await 期间接管」这一窗口——与 await appendBatch 之后的第二个同类检查（:243）覆盖的是不同窗口。
// 本文件的 A12/A15 只把写门控在 appendBatch 上，测的是 :243；ensureDir 窗口此前无人断言，故 M7 存活。
// M7 用例改用 io.ensureDir 门控，正好落进 :241 的保护窗口。
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
  /** 返回 pending promise 则该次异步 mkdir 挂起，由测试自己 resolve —— 制造「drain 卡在 ensureDir」。 */
  gateEnsureDir?: (ensureDirIndex: number) => Promise<void> | undefined;
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
/** 释放门控后泵送的事件循环轮数，足够让挂起的 await 链跑到底（主代理实测用 6 次 setImmediate）。 */
const PUMP_TICKS = 6;

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
  let ensureDirIndex = 0;
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
      // 异步 mkdir：真实实现走 fs.mkdir(recursive)。注入门控时可挂起，制造「drain 卡在 await ensureDir」。
      const gate = options.gateEnsureDir?.(ensureDirIndex);
      ensureDirIndex += 1;
      await (gate ?? Promise.resolve());
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

test("A5 flushSync 把 pending 行按顺序同步落盘", async () => {
  const harness = createHarness({ flushIntervalMs: 10_000 });
  harness.queue.enqueue(DAY_1, "a");
  harness.queue.enqueue(DAY_1, "b");
  harness.queue.flushSync();
  const stats = harness.queue.stats();
  assert.equal(stats.flushSyncCalls, 1);
  assert.equal(stats.bufferedRecords, 0);
  assert.deepEqual(harness.syncWrites.map((w) => w.payload), ["a\nb\n"]);
  assert.equal(harness.asyncWrites.length, 0, "flushSync 之后不该再有异步写落到本批");
});

test("A6 排空过程中跨午夜轮转：各行落到入队时对应的文件", async () => {
  const gate = deferred();
  const harness = createHarness({ gateWrite: (index) => (index === 0 ? gate.promise : undefined) });
  harness.queue.enqueue(DAY_1, "old-1");
  harness.queue.enqueue(DAY_1, "old-2");
  assert.equal(await harness.fireNextTimer(), true, "第一次写应在飞");
  // 写在飞时进入新的一天：文件名在入队时确定，不被迟到的 drain 改写。
  harness.queue.enqueue(DAY_2, "new-1");
  gate.resolve();
  await harness.drainAll();

  const byFile = new Map<string, string[]>();
  for (const write of harness.asyncWrites) {
    byFile.set(write.fileName, [...(byFile.get(write.fileName) ?? []), ...lines(write.payload)]);
  }
  assert.deepEqual(byFile.get(DAY_1), ["old-1", "old-2"]);
  assert.deepEqual(byFile.get(DAY_2), ["new-1"]);
  assert.equal(harness.queue.stats().droppedRecords, 0);
});

test("A6b 同一批次内混合文件名：按连续分组写，顺序与归属都正确", async () => {
  const harness = createHarness({ flushIntervalMs: 10_000 });
  harness.queue.enqueue(DAY_1, "d1-a");
  harness.queue.enqueue(DAY_1, "d1-b");
  harness.queue.enqueue(DAY_2, "d2-a");
  harness.queue.enqueue(DAY_1, "d1-c");
  harness.queue.flushSync();
  assert.deepEqual(
    harness.syncWrites.map((w) => ({ fileName: w.fileName, payload: w.payload })),
    [
      { fileName: DAY_1, payload: "d1-a\nd1-b\n" },
      { fileName: DAY_2, payload: "d2-a\n" },
      { fileName: DAY_1, payload: "d1-c\n" },
    ],
  );
});

test("A7 只有一个写者：并发 kick 不会同时对同一文件写", async () => {
  const gate = deferred();
  const harness = createHarness({ gateWrite: (index) => (index === 0 ? gate.promise : undefined) });
  harness.queue.enqueue(DAY_1, "slow");
  assert.equal(await harness.fireNextTimer(), true);
  harness.queue.enqueue(DAY_1, "more");
  harness.queue.kickNow();
  harness.queue.kickNow();
  assert.equal(harness.maxConcurrentWriters, 1, "在飞期间不得有第二个写者启动");
  gate.resolve();
  await harness.drainAll();
  assert.equal(harness.maxConcurrentWriters, 1, "同一时刻必须只有一个写者");
  assert.deepEqual(allWritten(harness), ["slow", "more"]);
});

test("A12 flushSync 撞在飞批次：在飞批次被同步接管，不丢日志", async () => {
  const gate = deferred();
  const harness = createHarness({ gateWrite: (index) => (index === 0 ? gate.promise : undefined) });
  harness.queue.enqueue(DAY_1, "in-flight");
  assert.equal(await harness.fireNextTimer(), true, "第一批必须仍在飞");
  harness.queue.enqueue(DAY_1, "pending-sync");
  harness.queue.flushSync();
  const stats = harness.queue.stats();
  assert.equal(stats.flushSyncRaces, 1);
  assert.equal(stats.flushSyncRescuedRecords, 1, "在飞批次必须计入救回数");
  assert.equal(stats.bufferedRecords, 0);
  // 关键：真实 process.exit 不会等异步写完成，同步冲刷必须已经把两行都落盘。
  // 原实现只冲未取走的记录，在飞那一行会在 exit 路径整批消失，而规格却写着「丢 0 条」。
  assert.deepEqual(harness.syncWrites.map((w) => w.payload), ["in-flight\npending-sync\n"]);
  gate.resolve();
  await harness.drainAll();
  const written = allWritten(harness);
  assert.ok(written.includes("in-flight") && written.includes("pending-sync"), "不得丢行");
  assert.equal(
    new Set(written).size,
    2,
    `每行最多重复一次（异步写真的完成时才会重复），实际 ${written.join(",")}`,
  );
});

test("A15 flushSync 接管后 drain 必须停手：剩余分组只落一次", async () => {
  const gate = deferred();
  const harness = createHarness({ gateWrite: (index) => (index === 0 ? gate.promise : undefined) });
  harness.queue.enqueue(DAY_1, "g1");
  harness.queue.enqueue(DAY_2, "g2");
  assert.equal(await harness.fireNextTimer(), true, "g1 分组必须在飞，g2 分组尚未开始");
  harness.queue.flushSync();
  assert.deepEqual(
    harness.syncWrites.map((w) => `${w.fileName}:${w.payload}`),
    [`${DAY_1}:g1\n`, `${DAY_2}:g2\n`],
    "接管的同步写必须覆盖整批",
  );
  gate.resolve();
  await harness.drainAll();
  const g2Writes = [...harness.asyncWrites, ...harness.syncWrites].filter(
    (write) => write.fileName === DAY_2,
  );
  assert.equal(g2Writes.length, 1, "g2 只能落盘一次：接管后不得继续写剩余分组");
});

test("M7 flushSync 在 await ensureDir 期间接管：该批不得再交给异步 appendBatch（钉死 :241 await 前接管检查）", async () => {
  const gate = deferred();
  let gatedFirst = false;
  // 只门控第一次 ensureDir（唯一一次 drain），后续 drain 不挂起，避免用例本身悬挂。
  const harness = createHarness({
    flushIntervalMs: 200,
    gateEnsureDir: (index) => {
      if (index === 0 && !gatedFirst) {
        gatedFirst = true;
        return gate.promise;
      }
      return undefined;
    },
  });
  harness.queue.enqueue(DAY_1, "R0");
  harness.queue.enqueue(DAY_1, "R1");
  assert.equal(await harness.fireNextTimer(), true, "drain 触发：inFlight=batch 后卡在 await ensureDir");
  assert.equal(harness.queue.stats().bufferedRecords, 0, "整批已被 splice 取走，处于在飞状态");
  assert.equal(harness.asyncWrites.length, 0, "此刻尚未调用 appendBatch");

  // 接管窗口：异步 drain 停在 ensureDir 里，flushSync 走同步 appendBatchSync 把整批救回。
  harness.queue.flushSync();
  const atSync = harness.queue.stats();
  assert.equal(atSync.flushSyncRescuedRecords, 2, "两条记录都必须计入救回数");
  assert.equal(atSync.flushSyncRaces, 1);

  // 释放 ensureDir，泵送若干轮让异步路径走完。
  gate.resolve();
  for (let i = 0; i < PUMP_TICKS; i += 1) await new Promise((resolve) => setTimeout(resolve, MACROTASK_MS));

  const delivered = allWritten(harness);
  const unique = new Set(delivered);
  // 关键判据只看注入 sink 的实收，不看队列自报计数：
  // 在变异体里 writeFailures 仍是 0——重复写对任何自报计数器都是隐形的，
  // 只有数 sink 真正收到的批次/行才能抓到这次整组重复。
  assert.equal(harness.asyncWrites.length, 0, "asyncBatchCalls：await 前接管检查必须让 drain 停手，一次都不该异步落盘");
  assert.equal(
    delivered.length - unique.size,
    0,
    `落盘行集不得有重复，实际重复 ${delivered.length - unique.size} 行：${delivered.join(",")}`,
  );
  assert.equal(atSync.flushSyncRescuedRecords, 2, "最终救回数仍必须是 2");
});
