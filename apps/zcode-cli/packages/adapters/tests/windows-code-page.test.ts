// ============================================================
// Windows 活动代码页解析单测（T-C2 修复：同步 chcp → 异步，且禁止跨 run 缓存）
//
// 运行：node --test apps/zcode-cli/packages/adapters/tests/windows-code-page.test.ts
// 为什么测的是 windows-code-page 而不是 outputEncoding：后者 value-import iconv-lite，
// 裁剪检出里 `node --test` 加载即 ERR_MODULE_NOT_FOUND；本模块零运行时 import，
// 命令执行器与 iconv 判定都由测试注入。真实子进程那一条用 process.execPath 起进程，
// 所以「异步不阻塞事件循环」在 Windows/macOS/Linux 上都能验；
// iconv-lite 的真实解码路径仍不在本文件覆盖范围（见 specs/windows-code-page/spec.md §6）。
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  codePageToEncoding,
  parseActiveCodePage,
  readWindowsActiveCodePageEncoding,
  resolveCodePage,
  resolveWindowsOutputEncoding,
  type WindowsCodePageProbe,
} from "../src/exec/windows-code-page.ts";

/** 测试用的「已安装编码」集合，替代 iconv-lite 的存在性判定。 */
const KNOWN_ENCODINGS = new Set(["cp936", "cp950", "cp437", "gb18030", "utf8"]);
const encodingExists = (encoding: string): boolean => KNOWN_ENCODINGS.has(encoding);

/** chcp 的样本输出，以及它应当被解析成的编码名。 */
const CHCP_STDOUT_SAMPLE = "Active code page: 936";
const EXPECTED_ENCODING_FROM_SAMPLE = "cp936";
/** 真实子进程测试里「慢」的前提：延迟要明显大于一个事件循环 turn。 */
const REAL_CHILD_DELAY_MS = 40;
const REAL_CHILD_TIMEOUT_MS = 5_000;

interface ProbeRecord {
  probe: WindowsCodePageProbe;
  calls: number;
  envs: NodeJS.ProcessEnv[];
  comSpecs: string[];
}

/** 按队列依次返回 stdout；队列耗尽后重复最后一项。返回被调用次数用于「无缓存」断言。 */
function recordingProbe(stdoutSequence: string[]): ProbeRecord {
  const record: ProbeRecord = { calls: 0, envs: [], comSpecs: [], probe: async () => "" };
  record.probe = async ({ comSpec, env }) => {
    const index = record.calls;
    record.calls += 1;
    record.comSpecs.push(comSpec);
    record.envs.push(env);
    return stdoutSequence[Math.min(index, stdoutSequence.length - 1)]!;
  };
  return record;
}

type ResolverDeps = Parameters<typeof resolveWindowsOutputEncoding>[0];

function baseDeps(overrides: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    env: { ComSpec: "cmd.exe" } as NodeJS.ProcessEnv,
    comSpec: "cmd.exe",
    overrideEncoding: undefined,
    localeLegacyEncoding: () => "cp437",
    encodingExists,
    probe: recordingProbe([CHCP_STDOUT_SAMPLE]).probe,
    ...overrides,
  };
}

// ---------- (d) 控制组：解析与映射本身 ----------

test("S7a: Active code page: 936 在编码存在时解析为 cp936", async () => {
  assert.equal(parseActiveCodePage("Active code page: 936"), "936");
  assert.equal(codePageToEncoding("936", encodingExists), "cp936");
  assert.equal(
    await resolveCodePageAsync("Active code page: 936"),
    "cp936",
  );
});

test("S7b: 65001 走 utf8 路径，不是 legacy 编码", async () => {
  assert.equal(codePageToEncoding("65001", encodingExists), "utf8");
  assert.equal(await resolveCodePageAsync("Active code page: 65001"), "utf8");
  // 决策链：活动代码页为 utf8 时返回 locale 回退值（与旧同步实现逐字一致）。
  const result = await resolveWindowsOutputEncoding(baseDeps({
    probe: async () => "Active code page: 65001",
  }));
  assert.equal(result, "cp437");
});

test("S7c: 乱码输出解析为 null，决策链落 locale 回退", async () => {
  assert.equal(parseActiveCodePage("code page unreadable"), null);
  assert.equal(resolveCodePage(null, { encodingExists }), null);
  assert.equal(resolveCodePage("no digits here", { encodingExists }), null);
  const result = await resolveWindowsOutputEncoding(baseDeps({
    probe: async () => "chcp: command not found",
  }));
  assert.equal(result, "cp437");
});

test("S1: 覆盖 env 存在时完全不 spawn，且 locale 回退不求值", async () => {
  const probe = recordingProbe(["Active code page: 936"]);
  let localeEvaluations = 0;
  const result = await resolveWindowsOutputEncoding(baseDeps({
    probe: probe.probe,
    overrideEncoding: "  cp950  ",
    localeLegacyEncoding: () => {
      localeEvaluations += 1;
      return "cp437";
    },
  }));
  assert.equal(result, "cp950");
  assert.equal(probe.calls, 0, "覆盖 env 必须短路，不能起子进程");
  assert.equal(localeEvaluations, 0, "回退值必须惰性求值");
});

test("覆盖 env 写了不存在的编码：返回 null，不回退（保持原语义）", async () => {
  const probe = recordingProbe(["Active code page: 936"]);
  const result = await resolveWindowsOutputEncoding(baseDeps({
    probe: probe.probe,
    overrideEncoding: "cp737",
  }));
  assert.equal(result, null);
  assert.equal(probe.calls, 0);
});

// ---------- 失败回退 ----------

test("S2: chcp 失败（reject/超时）→ 不抛错，落 locale 回退", async () => {
  const observed: unknown[] = [];
  const result = await resolveWindowsOutputEncoding(baseDeps({
    probe: async () => {
      throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    },
    observeFailure: (error) => observed.push(error),
    localeLegacyEncoding: () => "gb18030",
  }));
  assert.equal(result, "gb18030");
  assert.equal(observed.length, 1, "降级必须可被观测口看到，而不是静默吞掉");
});

test("S3: 代码页被 iconv 判为不存在 → locale 回退", async () => {
  const result = await resolveWindowsOutputEncoding(baseDeps({
    probe: async () => "Active code page: 12345",
    localeLegacyEncoding: () => "cp437",
  }));
  assert.equal(result, "cp437");
});

// ---------- (a)(b) 无跨 run 缓存 ----------

test("S4: 连续两次解析 → 注入 runner 恰好被调用 2 次（证明没有跨 run 缓存）", async () => {
  const probe = recordingProbe(["Active code page: 936"]);
  const first = await resolveWindowsOutputEncoding(baseDeps({ probe: probe.probe }));
  const second = await resolveWindowsOutputEncoding(baseDeps({ probe: probe.probe }));
  assert.equal(probe.calls, 2, "每次 run 都必须真的重读活动代码页");
  assert.equal(first, "cp936");
  assert.equal(second, "cp936");
  assert.deepEqual(probe.comSpecs, ["cmd.exe", "cmd.exe"]);
});

test("S5: 第二次返回不同代码页 → 结果翻转（用户中途 chcp 65001 会被下一次 run 读到）", async () => {
  const probe = recordingProbe(["Active code page: 936", "Active code page: 65001"]);
  const first = await resolveWindowsOutputEncoding(baseDeps({ probe: probe.probe }));
  const second = await resolveWindowsOutputEncoding(baseDeps({ probe: probe.probe }));
  assert.equal(first, "cp936");
  assert.equal(second, "cp437", "65001 不再是 legacy 编码，应落 locale 回退而不是继续贴 cp936");
  assert.equal(probe.calls, 2);

  const reverse = recordingProbe(["Active code page: 65001", "Active code page: 950"]);
  const reverseFirst = await resolveWindowsOutputEncoding(baseDeps({ probe: reverse.probe }));
  const reverseSecond = await resolveWindowsOutputEncoding(baseDeps({ probe: reverse.probe }));
  assert.equal(reverseFirst, "cp437");
  assert.equal(reverseSecond, "cp950");
});

test("env 原样传给注入 runner，且每次解析都重新读取 env", async () => {
  const env: NodeJS.ProcessEnv = { ComSpec: "cmd.exe", ZCODE_WINDOWS_OUTPUT_ENCODING: "" };
  const probe = recordingProbe(["Active code page: 936"]);
  await readWindowsActiveCodePageEncoding({
    env,
    comSpec: "cmd.exe",
    probe: probe.probe,
    encodingExists,
  });
  assert.equal(probe.envs.length, 1);
  assert.equal(probe.envs[0], env);
  assert.equal(await resolveCodePageAsync("Active code page: 936"), "cp936");
});

// ---------- (c) 非阻塞证明 ----------

test("S6: 解析期间事件循环未被冻结——先排队的 setImmediate 回调先于 resolution settle 执行", async () => {
  const order: string[] = [];
  // 关键：tick 必须在「发起解析之前」入队，才能比较宏任务先后顺序。
  setImmediate(() => order.push("tick"));
  const pending = resolveWindowsOutputEncoding(baseDeps({
    probe: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return "Active code page: 936";
    },
  }));
  void pending.then((encoding) => order.push(`resolved:${String(encoding)}`));
  const encoding = await pending;
  assert.equal(encoding, "cp936");
  assert.deepEqual(order, ["tick", "resolved:cp936"], "同步实现下 tick 会排在 resolved 之后（见反向证据）");
});

test("真实异步子进程读取代码页不阻塞事件循环（跨平台：起一个带真实延迟的子进程）", async () => {
  const order: string[] = [];
  setImmediate(() => order.push("tick"));
  const encoding = await resolveWindowsOutputEncoding(baseDeps({
    comSpec: process.execPath,
    probe: ({ comSpec }) =>
      new Promise<string>((resolve, reject) => {
        // 「等待期间事件循环仍可服务回调」这条断言要求子进程比一个 loop turn 慢。
        // 原先直接起 cmd.exe：Windows 上进程启动本身 >1 turn，所以 order[0] === "tick" 成立；
        // Linux CI 上 cmd.exe 不存在，spawn 立刻以 ENOENT 失败，rejection 的微任务排在
        // setImmediate（宏任务）之前 ⇒ order[0] 变成 resolved，实测 104/105、fail 1。
        // 改用 process.execPath（三平台都有）并显式等待，把「慢」变成测试保证的前提而不是运气。
        execFile(
          comSpec,
          ["-e", `setTimeout(() => process.stdout.write(${JSON.stringify(CHCP_STDOUT_SAMPLE)}), ${REAL_CHILD_DELAY_MS})`],
          { encoding: "utf8", env: process.env, timeout: REAL_CHILD_TIMEOUT_MS, windowsHide: true },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      }),
  }));
  assert.equal(order[0], "tick", "真实子进程等待期间事件循环必须仍可服务回调");
  assert.equal(encoding, EXPECTED_ENCODING_FROM_SAMPLE, "注入的编码集合应把样本解析成该编码");
});

/** 走异步读取入口，确认 readWindowsActiveCodePageEncoding 与决策链的解析结果一致。 */
async function resolveCodePageAsync(stdout: string): Promise<string | null> {
  return readWindowsActiveCodePageEncoding({
    env: {},
    comSpec: "cmd.exe",
    probe: async () => stdout,
    encodingExists,
  });
}
