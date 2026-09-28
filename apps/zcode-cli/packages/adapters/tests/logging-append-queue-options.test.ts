// ============================================================
// AppendQueue 选项归一化 / 定时器 unref / 失败批次恢复顺序 单测
// 运行：node --test apps/zcode-cli/packages/adapters/tests/logging-append-queue-options.test.ts
//
// 为什么单独成文件（gen4 / stage-2 §3）：这三条对应 gen1 变异测试里存活的 M8/M9/M10 三个
// 无效守卫变异体。旧测试文件 logging-append-queue.test.ts 已经 447 行，超过 CLI AGENTS.md
// 的 400 行上限，只能另开一文件；本文件不改 append-queue.ts 源码（399 行墙 + 无需新增守卫），
// 只把注入面收窄到能被观测的形状：假调度器记录 unref 调用次数、写盘钩子可在队列为空时入队。
// M9 之所以在旧测试里观测不到，是因为假句柄的 unref() 是空实现；这里改成计数器后就可证伪。
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppendQueue,
  type AppendQueueIo,
  type AppendQueueTimer,
} from "../src/logging/append-queue.ts";

const FILE = "zcode-2026-09-28.jsonl";
/** 与 append-queue.ts 的私有默认值对齐（这里只作断言预言，不参与被测实现）。 */
const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_MAX_BYTES = 1_024 * 1_024;
const DEFAULT_FLUSH_INTERVAL_MS = 200;
/** 定时器假时钟的起始值，避开「初值 0 会把自我上报窗口吞掉」的既有陷阱。 */
const START_CLOCK = 1_000;
const MACROTASK_MS = 0;
/** 假调度器一轮最多推进的次数，防止退避重排造成无界泵送。 */
const MAX_PUMP_PASSES = 40;

interface HandleRecord extends AppendQueueTimer {
  id: number;
  unrefCalls: number;
}

interface HarnessOptions {
  maxRecords?: number;
  maxBytes?: number;
  flushIntervalMs?: number;
  highWaterRatio?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  maxConsecutiveFailures?: number;
  selfReportIntervalMs?: number;
  /** 每次异步写盘前调用：可在队列为空时入队（观察恢复顺序），返回错误则本次写失败。 */
  onWrite?: (writeIndex: number, queue: AppendQueue) => Error | undefined;
  /** 返回 promise 则该次写盘挂起，由测试自己 resolve —— 用于制造「写在飞」时调用 flushSync。 */
  gateWrite?: (writeIndex: number) => Promise<void> | undefined;
}

interface Harness {
  queue: AppendQueue;
  written: string[];
  /** 假调度器交出去过的全部句柄，含各自 unref 调用次数。 */
  handles: HandleRecord[];
  /** 每次 schedule 看到的延时，按发生顺序记录。 */
  delays: number[];
  cancelledIds: number[];
  clock: number;
  advance(ms: number): Promise<void>;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MACROTASK_MS));
}

function createHarness(options: HarnessOptions = {}): Harness {
  const due: Array<{ id: number; at: number; callback: () => void; cancelled: boolean }> = [];
  const handles: HandleRecord[] = [];
  let timerId = 0;
  let writeIndex = 0;

  const harness: Harness = {
    queue: undefined as unknown as AppendQueue,
    written: [],
    handles,
    delays: [],
    cancelledIds: [],
    clock: START_CLOCK,
    advance: async (ms: number) => {
      harness.clock += ms;
      for (let pass = 0; pass < MAX_PUMP_PASSES; pass += 1) {
        const next = due
          .filter((timer) => !timer.cancelled && timer.at <= harness.clock)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        next.cancelled = true;
        next.callback();
        await tick();
      }
    },
  };

  const io: AppendQueueIo = {
    async ensureDir() {},
    async appendBatch(_dir, _fileName, payload) {
      const index = writeIndex++;
      await options.gateWrite?.(index);
      const failure = options.onWrite?.(index, harness.queue);
      if (failure) throw failure;
      harness.written.push(...payload.split("\n").filter((line) => line.length > 0));
    },
    ensureDirSync() {},
    appendBatchSync(_dir, _fileName, payload) {
      harness.written.push(...payload.split("\n").filter((line) => line.length > 0));
    },
    now: () => harness.clock,
    schedule(callback, delayMs) {
      timerId += 1;
      due.push({ id: timerId, at: harness.clock + delayMs, callback, cancelled: false });
      harness.delays.push(delayMs);
      const handle: HandleRecord = {
        id: timerId,
        unrefCalls: 0,
        unref() {
          handle.unrefCalls += 1;
        },
      };
      handles.push(handle);
      return handle;
    },
    cancelSchedule(timer) {
      const id = (timer as unknown as HandleRecord).id;
      const found = due.find((entry) => entry.id === id);
      if (found) found.cancelled = true;
      harness.cancelledIds.push(id);
    },
  };

  harness.queue = new AppendQueue({ dir: "/logs", io, ...options });
  return harness;
}

function bufferedWithinCap(harness: Harness, cap: number): void {
  assert.ok(
    harness.queue.stats().bufferedRecords <= cap,
    `缓冲条数必须受上界约束，实际 ${harness.queue.stats().bufferedRecords}`,
  );
}

test("O1 敌意 maxRecords（0 / 负数 / 小于 1 的小数）：归一到下界 1，队列既不丢光也不越界", () => {
  for (const hostile of [0, -5, 0.5]) {
    const harness = createHarness({ maxRecords: hostile, selfReportIntervalMs: 0 });
    for (let i = 0; i < 5; i += 1) assert.equal(harness.queue.enqueue(FILE, `m${i}`), true);
    const stats = harness.queue.stats();
    // 守卫存在 → 有效上界是 1（留最新一条）；守卫被删 → maxRecords<=1 的判据会把每条都裁掉。
    assert.equal(stats.bufferedRecords, 1, `maxRecords=${hostile} 时应保留 1 条`);
    assert.equal(stats.droppedRecords, 4, `maxRecords=${hostile} 时应只丢 4 条`);
    assert.deepEqual(harness.written, [], "未触发定时器前不该有写盘");
    harness.queue.enqueue(FILE, "m9");
    bufferedWithinCap(harness, 1);
    assert.equal(stats.droppedProtectedRecords, 0);
  }
});

test("O2 maxRecords 为 NaN / Infinity：回落到默认条数上界，队列仍完全有界", () => {
  for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const harness = createHarness({ maxRecords: hostile, flushIntervalMs: 10 });
    for (let i = 0; i < DEFAULT_MAX_RECORDS + 300; i += 1) harness.queue.enqueue(FILE, `m${i}`);
    const stats = harness.queue.stats();
    assert.ok(
      stats.bufferedRecords <= DEFAULT_MAX_RECORDS,
      `maxRecords=${hostile} 应回落默认 ${DEFAULT_MAX_RECORDS}，实际 ${stats.bufferedRecords}`,
    );
    assert.equal(
      stats.droppedRecords,
      300,
      `必须有精确的丢弃计数（无界队列在慢盘上就是 OOM），实际 ${stats.droppedRecords}`,
    );
  }
});

test("O3 maxBytes 为 NaN：回落到默认字节上界（条数远未触顶时字节仍要生效）", () => {
  const harness = createHarness({ maxBytes: Number.NaN, flushIntervalMs: 10 });
  const bigLine = "x".repeat(400_000);
  for (let i = 0; i < 6; i += 1) assert.equal(harness.queue.enqueue(FILE, bigLine), true);
  const stats = harness.queue.stats();
  assert.ok(
    stats.bufferedBytes <= DEFAULT_MAX_BYTES,
    `maxBytes=NaN 必须回落 1 MiB，实际 bufferedBytes=${stats.bufferedBytes}`,
  );
  assert.ok(stats.droppedRecords > 0, "字节上界生效时必须计数");
  assert.ok(stats.bufferedRecords < 6, "被裁掉的记录必须少於入队数");
});

test("O4 flushIntervalMs 为 NaN / 0 / 负数：冲刷延时仍是可用的正数默认值", async () => {
  for (const hostile of [Number.NaN, 0, -1000]) {
    const harness = createHarness({ flushIntervalMs: hostile });
    assert.equal(harness.queue.enqueue(FILE, "one"), true);
    const expectedDelay = hostile === 0 || hostile < 0 ? 1 : DEFAULT_FLUSH_INTERVAL_MS;
    assert.deepEqual(
      harness.delays,
      [expectedDelay],
      `flushIntervalMs=${hostile} 的有效延时应归一为 ${expectedDelay}`,
    );
    assert.ok(
      Number.isFinite(harness.delays[0]) && harness.delays[0] >= 1,
      `延时必须是有界正数，实际 ${harness.delays[0]}`,
    );
    await harness.advance(DEFAULT_FLUSH_INTERVAL_MS + 1);
    assert.deepEqual(harness.written, ["one"], "归一后定时器必须真的能把日志冲出去");
  }
});

test("O5 backoffMaxMs 为 0 / 负数：退避仍有正下界，失败批次不会被 0 延时排空", async () => {
  const harness = createHarness({
    backoffInitialMs: 100,
    backoffMaxMs: 0,
    onWrite: (index) => (index === 0 ? new Error("ENOSPC simulated") : undefined),
  });
  harness.queue.enqueue(FILE, "boom");
  await harness.advance(1_000); // 第一次写：注入失败
  const stats = harness.queue.stats();
  assert.equal(stats.writeFailures, 1);
  assert.ok(stats.backoffMs >= 1, `backoffMaxMs=0 时退避下界必须是 1ms，实际 ${stats.backoffMs}`);
  assert.equal(harness.queue.enqueue(FILE, "second"), true);
  await harness.advance(10_000);
  assert.ok(harness.written.length > 0, "退避后必须重试成功");
});

test("O6 巨大 maxBytes：没有上界钳制（设计事实），但条数上界仍独立生效", () => {
  const harness = createHarness({ maxBytes: 1e15 });
  for (let i = 0; i < DEFAULT_MAX_RECORDS + 50; i += 1) harness.queue.enqueue(FILE, "line");
  const stats = harness.queue.stats();
  assert.ok(
    stats.bufferedRecords <= DEFAULT_MAX_RECORDS,
    `字节预算被放到极大时，条数上界必须仍然兜住，实际 ${stats.bufferedRecords}`,
  );
  assert.equal(stats.droppedRecords, 50);
});

test("U1 定时器句柄一律被 unref：日志队列不得拖住进程退出", async () => {
  const harness = createHarness({ flushIntervalMs: 50 });
  harness.queue.enqueue(FILE, "a");
  harness.queue.enqueue(FILE, "b");
  assert.ok(harness.handles.length >= 1, "调度器必须被调用过，否则本断言是空转");
  harness.queue.kickNow();
  await harness.advance(100);
  harness.queue.enqueue(FILE, "c");
  harness.queue.stop();

  assert.ok(harness.handles.length >= 3, `应观测到多个句柄，实际 ${harness.handles.length}`);
  for (const handle of harness.handles) {
    assert.ok(
      handle.unrefCalls >= 1,
      `句柄 ${handle.id} 从未被 unref（M9 变异体）：保留的 timer 会阻止进程退出`,
    );
  }
  assert.ok(harness.cancelledIds.length >= 1, "stop() 必须把待触发的调度撤销");
});

test("F1 写失败后批次按原 FIFO 顺序回到队首（不是 push 到队尾）", async () => {
  const harness = createHarness({
    backoffInitialMs: 10,
    onWrite: (index, queue) => {
      if (index === 0) {
        // 失败发生在 await 期间，此刻队列已被 splice 清空；
        // 这里新入队的记录必须排在恢复批次之后，才能区分 unshift 与 push。
        queue.enqueue(FILE, "late");
        return new Error("ENOSPC simulated");
      }
      return undefined;
    },
  });
  harness.queue.enqueue(FILE, "r1");
  harness.queue.enqueue(FILE, "r2");
  await harness.advance(200);
  const afterFailure = harness.queue.stats();
  assert.equal(afterFailure.writeFailures, 1);
  assert.equal(afterFailure.droppedRecords, 0, "单次失败不得丢日志");
  assert.deepEqual(harness.written, [], "失败的那一次没有落盘");

  await harness.advance(50);
  assert.deepEqual(harness.written, ["r1", "r2", "late"], "恢复顺序必须与入队顺序一致");
  assert.equal(harness.queue.stats().consecutiveWriteFailures, 0);
});

test("D1 flushSync 撞上在飞分组：重复范围是整个在飞分组（spec §4 修正后的口径），且一条不丢", async () => {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const harness = createHarness({ gateWrite: (index) => (index === 0 ? gate : undefined) });
  harness.queue.enqueue(FILE, "A0");
  harness.queue.enqueue(FILE, "A1");
  harness.queue.enqueue(FILE, "A2");
  await harness.advance(200);
  assert.equal(harness.queue.stats().bufferedRecords, 0, "3 条应已被 drain 取走，处于在飞状态");
  harness.queue.enqueue(FILE, "B0");
  harness.queue.enqueue(FILE, "B1");

  harness.queue.flushSync();
  const atFlushSync = harness.queue.stats();
  releaseGate();
  await tick();

  const delivered = harness.written;
  const unique = new Set(delivered);
  assert.deepEqual([...unique].sort(), ["A0", "A1", "A2", "B0", "B1"], "5 条记录一条不少");
  assert.equal(delivered.length, 8, "在飞分组同步接管后，异步写仍会把它再投一次");
  assert.equal(
    delivered.length - unique.size,
    3,
    "重复量必须等于在飞分组大小（上界由 maxRecords/maxBytes 决定），而不是「最多一行」",
  );
  assert.equal(atFlushSync.flushSyncRescuedRecords, 3);
  assert.equal(atFlushSync.flushSyncRaces, 1);
  assert.equal(atFlushSync.bufferedRecords, 0);
});
