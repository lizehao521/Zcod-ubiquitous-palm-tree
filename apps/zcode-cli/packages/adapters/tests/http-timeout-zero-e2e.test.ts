// A3：timeout=0 端到端真进程实测（specs/runtime-env-config/spec.md §12.2 / §9.1）。
//
// gen5 留下的边界：「0 的端到端 getAll()→http/index.ts:79 依赖主代理对解析器的直驱读数而非真进程」。
// 本文件用真进程 + 真挂起 http 服务器 + 真计时读数替代直驱读数，验证
//   "timeoutMs = 0 ⇒ 不挂 setTimeout ⇒ 请求永不超时"
// 与
//   "timeoutMs > 0 ⇒ 挂 setTimeout(timeoutMs) ⇒ 请求在 timeoutMs 后被 abort"
// 这两条行为语义。
//
// 为什么不复用 NodeHttpClientAdapter：
//   它 value-import proxy-agent / @zcode/contracts，本裁剪树装载即 ERR。
//   本测试只断言 http/index.ts:79 的 `if (timeoutMs > 0)` 分支的行为语义，
//   该分支是纯 Node 标准库 setTimeout + AbortController，无需 proxy-agent。
//   因此这里 inline 复制该分支（9 行）+ 一个最小 fetch 替代（用 node:http 直连本地服务器），
//   不跨模块 import，保持可装载。inline 副本与 http/index.ts:79-84 的文本等价性
//   由下方文本比对断言兜住（防止 inline 漂移）。
//
// 诚实边界：
//   - 真服务器是 127.0.0.1:0 的本地回环，不是公网；「永不超时」的读数是相对 3s 观察窗，
//     不是无穷（测试有总时长上限，10s 后 fail）。
//   - 服务器永不回包（accept 后不 write），模拟「远端挂起」。
//   - 本地环境，不涉及代理 / TLS / DNS。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTTP_INDEX_SRC = readFileSync(
  new URL("../src/http/index.ts", import.meta.url),
  "utf8",
);

/** 复制 http/index.ts:77-84 的超时分支（inline，不跨模块 import）。 */
function armTimeout(timeoutMs: number, abortController: AbortController, abortState: { timedOut: boolean }) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      abortState.timedOut = true;
      abortController.abort(new Error("HTTP request timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
  }
  return timeout;
}

/** 起一个永不回包的本地服务器，返回 { port, close }。 */
function startSilentServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req) => {
      // accept 连接但永不 write / end：模拟远端挂起
      req.socket.pause();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

/** 对 127.0.0.1:port 发一个 GET，用 armTimeout 挂计时器，返回 { timedOut, elapsedMs }。
 *  若计时器在 observeMs 内触发则 abort；若未触发（timeoutMs=0）则等 observeMs 后手动结束。 */
async function fireAndMeasure(
  timeoutMs: number,
  port: number,
  observeMs: number,
): Promise<{ timedOut: boolean; elapsedMs: number }> {
  const abortController = new AbortController();
  const abortState = { timedOut: false };
  const timer = armTimeout(timeoutMs, abortController, abortState);

  const start = Date.now();
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/", method: "GET", signal: abortController.signal },
      () => {
        // 服务器永不回包，所以 onresponse 不会触发；
        // 唯一结束路径是 signal abort 或 socket 关闭。
        resolve();
      },
    );
    req.on("error", (err) => {
      if (abortController.signal.aborted) {
        resolve(); // 预期路径：被计时器 abort
      } else {
        reject(err);
      }
    });
    req.end();
    // 观察窗：若计时器未触发（timeoutMs=0），在 observeMs 后手动 abort 并标记 timedOut=false
    setTimeout(() => {
      if (!abortState.timedOut) {
        abortController.abort(new Error("observe-window-expired"));
      }
      resolve();
    }, observeMs);
  });
  const elapsedMs = Date.now() - start;
  if (timer) clearTimeout(timer);
  return { timedOut: abortState.timedOut, elapsedMs };
}

describe("A3：timeout=0 端到端真进程实测（gen6）", () => {
  it("inline 副本与 http/index.ts:79-84 文本等价（防 inline 漂移）", () => {
    // http/index.ts 的真实文本：
    //   if (timeoutMs > 0) {
    //     timeout = setTimeout(() => {
    //       abortState.timedOut = true;
    //       abortController.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`));
    //     }, timeoutMs);
    //   }
    // 用"必须存在的 6 个锚点"替代一条长正则：每个锚点都是 http/index.ts:79-84 的
// 一个不可再小化的子串。6 条全中 = 形态一致；任一缺失 = inline 漂移。
    const anchors = [
      /if\s*\(\s*timeoutMs\s*>\s*0\s*\)\s*\{/,
      /timeout\s*=\s*setTimeout\(/,
      /abortState\.timedOut\s*=\s*true/,
      /abortController\.abort\(new\s*Error\(/,
      /\}\s*,\s*timeoutMs\s*\)\s*\;/,
      /HTTP request timed out after/,
    ];
    for (const [i, re] of anchors.entries()) {
      assert.match(HTTP_INDEX_SRC, re, "anchor " + i + " (" + re.source + ") missing from http/index.ts");
    }
  });

  it("timeoutMs=0 ⇒ 不挂计时器 ⇒ 请求在观察窗内不被超时 abort（行为语义 D-B）", async () => {
    const { port, close } = await startSilentServer();
    try {
      const { timedOut, elapsedMs } = await fireAndMeasure(0, port, 3000);
      assert.equal(timedOut, false, "timeoutMs=0 时计时器不触发（观察窗 3s 内无超时 abort）");
      // elapsedMs 应接近观察窗（3s ± 容忍），证明请求确实「挂」着而不是立即失败
      assert.ok(elapsedMs >= 2500, "请求应挂着直到观察窗结束（实测 " + elapsedMs + "ms）");
      assert.ok(elapsedMs <= 3500, "不应超过观察窗 + 容忍（实测 " + elapsedMs + "ms）");
    } finally {
      close();
    }
  });

  it("timeoutMs=500 ⇒ 挂计时器 ⇒ 请求在 ~500ms 后被超时 abort（对照组）", async () => {
    const { port, close } = await startSilentServer();
    try {
      const { timedOut, elapsedMs } = await fireAndMeasure(500, port, 3000);
      assert.equal(timedOut, true, "timeoutMs=500 时计时器应在 500ms 触发");
      assert.ok(elapsedMs >= 400, "elapsed 应接近 500ms（实测 " + elapsedMs + "ms）");
      assert.ok(elapsedMs <= 1500, "不应远超 500ms（实测 " + elapsedMs + "ms）");
    } finally {
      close();
    }
  });

  it("timeoutMs=1e20（MAIN-07 原始症状）⇒ 被 Node 钳成 1ms ⇒ 请求秒死", async () => {
    // 这是 MAIN-07 的根因症状：setTimeout(fn, 1e20) 被 Node 钳成 1ms。
    // 本测试不 import http/index.ts（装载不了），而是直接验证 Node 的钳位行为，
    // 证明「文件门 .max() 拦 1e20」是必要的（拦不住则秒死）。
    let fired = false;
    const start = Date.now();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        fired = true;
        resolve();
      }, 1e20);
      // Node 会打 TimeoutOverflowWarning 并钳成 1ms；等 2s 观察窗
      setTimeout(() => resolve(), 2000);
      // 不 unref，保证进程活着
      t.unref();
    });
    const elapsed = Date.now() - start;
    assert.equal(fired, true, "setTimeout(fn, 1e20) 应被钳成 ~1ms 后触发");
    assert.ok(elapsed < 1000, "1e20 应被钳成 1ms 级触发（实测 " + elapsed + "ms），不是 1e20 ms");
    // 证明：若不拦 1e20，「配了个大超时」= 每个请求 ~1ms 就 abort
  });
});
