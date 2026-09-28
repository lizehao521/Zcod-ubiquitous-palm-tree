// D-B 有序判据 + MAIN-07/08/09 的专用测试（specs/runtime-env-config/spec.md §4、§9、§13）。
//
// 只用相对路径导入被测模块：该模块的唯一外部依赖是 `import type`，Node 24 type stripping 会擦除它，
// 因此 `node --test` 无需 node_modules 即可装载（MAIN-09 的修法约束就在这里，见漂移断言）。
// 断言只读 code/reason/path/value，不依赖错误文本。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getToolConcurrencyConfig,
  MAX_TIMER_DELAY_MS,
  parseEnvConfigWithDiagnostics,
  type EnvConfigDiagnostic,
} from "../src/config/env-config.adapter.ts";

/** 宿主注入的 options.env 可以绕过 TS 类型（process.env 才是字符串 only），MAIN-08 的可达面。 */
type HostileEnv = Record<string, string | undefined>;
const hostile = (env: Record<string, unknown>): HostileEnv => env as unknown as HostileEnv;

function readOutcome(
  key: "ZCODE_HTTP_TIMEOUT" | "ZCODE_MAX_TOOL_CONCURRENCY",
  value: unknown,
): { accepted: number | undefined; reason: string | undefined; count: number } {
  const { config, diagnostics } = parseEnvConfigWithDiagnostics(hostile({ [key]: value }));
  const node = key === "ZCODE_HTTP_TIMEOUT" ? config.network : config.toolConcurrency;
  const accepted = key === "ZCODE_HTTP_TIMEOUT" ? node?.timeout : node?.maxConcurrency;
  return {
    accepted,
    reason: diagnostics[0]?.reason,
    count: diagnostics.length,
  };
}

const ZERO_SHAPES = ["0", "0.0", "0e0", " 0", "0x0", "00", "-0", "0.00", "+0", "0E0", " 0 "];

describe("D-B 有序判据：每一步一条 case（短路顺序即契约）", () => {
  it("第 1 步 empty：空串/空白在 Number() 之前就被挡住，绝不落为 0", () => {
    for (const value of ["", "  ", "\t\t", " \n "]) {
      for (const key of ["ZCODE_HTTP_TIMEOUT", "ZCODE_MAX_TOOL_CONCURRENCY"] as const) {
        const out = readOutcome(key, value);
        assert.equal(out.reason, "empty", `${key} <- ${JSON.stringify(value)}`);
        assert.equal(out.accepted, undefined, `${key} 不得因为 Number("")===0 写出任何值`);
        assert.equal(out.count, 1);
      }
    }
  });

  it("第 2 步 invalid_number：NaN 与 ±Infinity（含 1e999 上溢）非法", () => {
    for (const value of ["30s", "NaN", "Infinity", "-Infinity", "1e999", "1,000", "abc"]) {
      const t = readOutcome("ZCODE_HTTP_TIMEOUT", value);
      assert.equal(t.reason, "invalid_number", `timeout <- ${JSON.stringify(value)}`);
      assert.equal(t.accepted, undefined);
      assert.equal(readOutcome("ZCODE_MAX_TOOL_CONCURRENCY", value).reason, "invalid_number");
    }
  });

  it("第 3 步 negative：负数对两个键都非法，reason 从 not_positive 收窄为 negative", () => {
    for (const value of ["-5", "-1", "-45000", "-1e20"]) {
      assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", value).reason, "negative");
      assert.equal(readOutcome("ZCODE_MAX_TOOL_CONCURRENCY", value).reason, "negative");
      assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", value).accepted, undefined);
    }
  });

  it("第 4 步：字面 0 对 network.timeout 合法 = 显式关闭请求超时", () => {
    for (const value of ZERO_SHAPES) {
      const out = readOutcome("ZCODE_HTTP_TIMEOUT", value);
      assert.equal(out.accepted, 0, `timeout <- ${JSON.stringify(value)} 应被接受为 0`);
      assert.equal(out.count, 0, `合法的 0 不该产出诊断：${out.reason}`);
    }
    // -0 归一为 +0：store 里不许出现第二种表示（spec §9 的表态）。
    assert.equal(Object.is(readOutcome("ZCODE_HTTP_TIMEOUT", "-0").accepted, -0), false);
  });

  it("第 4 步不对称：maxConcurrency 的 0 继续非法（seatGate({limit:0}) 是挂死，不是关闭并发）", () => {
    for (const value of ZERO_SHAPES) {
      const out = readOutcome("ZCODE_MAX_TOOL_CONCURRENCY", value);
      assert.equal(out.reason, "zero_not_allowed", `maxConcurrency <- ${JSON.stringify(value)}`);
      assert.equal(out.accepted, undefined);
    }
    // 直读入口同判据，不许比 ConfigPort 更宽。
    for (const value of ["0", "-0", "0x0"]) {
      assert.equal(getToolConcurrencyConfig({ ZCODE_MAX_TOOL_CONCURRENCY: value }).maxConcurrency, 10);
    }
  });

  it("第 5 步（MAIN-07）：超过 32-bit 有符号延时的有限正数必须拒绝", () => {
    for (const value of ["2147483648", "4294967296", "1e20", "99999999999999999999", "3e9"]) {
      const out = readOutcome("ZCODE_HTTP_TIMEOUT", value);
      assert.equal(out.reason, "too_large", `timeout <- ${JSON.stringify(value)}`);
      assert.equal(out.accepted, undefined, "超过计时器上限的值不得进入 ConfigPort");
      assert.equal(out.count, 1);
    }
  });

  it("第 5 步只约束挂了计时器的键：maxConcurrency 不被搬用 timer 天花板（MAIN-10 待产品数）", () => {
    // 并发键的合理上界是运营/产品数，本轮不替产品拍板，所以这里断言"没有数值天花板"这一事实，
    // 防止有人把 2^31-1 当成"所有数值键的公共上限"顺手推广（那也是 D1 的形态）。
    for (const value of ["2147483648", "4294967296", "1e20"]) {
      const out = readOutcome("ZCODE_MAX_TOOL_CONCURRENCY", value);
      assert.equal(out.reason, undefined, `maxConcurrency <- ${JSON.stringify(value)} 本轮不设上界`);
      assert.equal(out.accepted, Number(value));
    }
  });

  it("第 5 步边界：上限本身合法（不是 off-by-one）", () => {
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", String(MAX_TIMER_DELAY_MS)).accepted, MAX_TIMER_DELAY_MS);
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "2147483647").accepted, 2147483647);
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "2147483647.5").reason, "too_large");
  });

  it("第 6 步 control：其它正数照常放行（防「一律忽略」式假修复）", () => {
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "45000").accepted, 45000);
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "1e3").accepted, 1000);
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "10.5").accepted, 10.5);
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "007").accepted, 7);
    assert.equal(readOutcome("ZCODE_MAX_TOOL_CONCURRENCY", "45000").accepted, 45000);
    assert.equal(readOutcome("ZCODE_MAX_TOOL_CONCURRENCY", "2.5").accepted, 2.5);
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "45000").count, 0);
  });

  it("别名 ZCODE_TIMEOUT 带同一套判据与同一个 path", () => {
    const zero = parseEnvConfigWithDiagnostics({ ZCODE_TIMEOUT: "0" });
    assert.equal(zero.config.network?.timeout, 0);
    assert.deepEqual(zero.diagnostics, []);
    const big = parseEnvConfigWithDiagnostics({ ZCODE_TIMEOUT: "4294967296" });
    assert.equal(big.config.network, undefined);
    const d = big.diagnostics[0] as EnvConfigDiagnostic;
    assert.equal(d.reason, "too_large");
    assert.equal(d.path, "network.timeout");
    assert.equal(d.envKey, "ZCODE_TIMEOUT");
  });

  // 用户裁决 2026-09-28（覆盖本轮先前记录的"后出现者写胜"）：主键 ZCODE_HTTP_TIMEOUT 优先于别名
  // ZCODE_TIMEOUT，且两键都合法但取值不同时必须留一条 alias_conflict 诊断。
  // 原规则下 ZCODE_TIMEOUT=0 能在用户写出 9000 之后静默把超时关掉，那是 §4.1 第 5 步守住的 D1 终态换了一道门。
  it("别名优先级：主键赢，两个顺序都测，不一致必出诊断", () => {
    const mainFirst = parseEnvConfigWithDiagnostics({
      ZCODE_HTTP_TIMEOUT: "9000",
      ZCODE_TIMEOUT: "5000",
    });
    assert.equal(mainFirst.config.network?.timeout, 9000, "主键在前 ⇒ 主键赢");
    assert.equal(mainFirst.diagnostics.length, 1, "被作废的别名必须留痕");
    assert.equal((mainFirst.diagnostics[0] as EnvConfigDiagnostic).reason, "alias_conflict");
    assert.equal(mainFirst.diagnostics[0].envKey, "ZCODE_TIMEOUT", "诊断点名被作废的那条键");

    const aliasFirst = parseEnvConfigWithDiagnostics({
      ZCODE_TIMEOUT: "5000",
      ZCODE_HTTP_TIMEOUT: "9000",
    });
    assert.equal(aliasFirst.config.network?.timeout, 9000, "别名在前 ⇒ 主键仍赢，不依赖插入顺序");
    assert.equal((aliasFirst.diagnostics[0] as EnvConfigDiagnostic).reason, "alias_conflict");

    const zeroAlias = parseEnvConfigWithDiagnostics({
      ZCODE_HTTP_TIMEOUT: "9000",
      ZCODE_TIMEOUT: "0",
    });
    assert.equal(zeroAlias.config.network?.timeout, 9000, "别名 0 不得顶掉显式超时");
    assert.equal((zeroAlias.diagnostics[0] as EnvConfigDiagnostic).reason, "alias_conflict");

    const sameValue = parseEnvConfigWithDiagnostics({
      ZCODE_HTTP_TIMEOUT: "9000",
      ZCODE_TIMEOUT: "9000",
    });
    assert.equal(sameValue.config.network?.timeout, 9000);
    assert.deepEqual(sameValue.diagnostics, [], "两键同值不是冲突 ⇒ 零诊断");

    const aliasOnly = parseEnvConfigWithDiagnostics({ ZCODE_TIMEOUT: "9000" });
    assert.equal(aliasOnly.config.network?.timeout, 9000, "只给别名时仍然可用");
    assert.deepEqual(aliasOnly.diagnostics, [], "无竞争 ⇒ 零诊断");
  });

  it("别名优先级 control：非法的后来者不覆盖先出现的合法值（缺席分支不写）", () => {
    const bigLast = parseEnvConfigWithDiagnostics({
      ZCODE_HTTP_TIMEOUT: "9000",
      ZCODE_TIMEOUT: "2147483648",
    });
    assert.equal(bigLast.config.network?.timeout, 9000, "被拒的值走缺席分支，不得清空已写入的合法值");
    const d = bigLast.diagnostics[0] as EnvConfigDiagnostic;
    assert.equal(d.reason, "too_large");
    assert.equal(d.envKey, "ZCODE_TIMEOUT");
    assert.equal(bigLast.diagnostics.length, 1);

    const emptyLast = parseEnvConfigWithDiagnostics({
      ZCODE_HTTP_TIMEOUT: "9000",
      ZCODE_TIMEOUT: "",
    });
    assert.equal(emptyLast.config.network?.timeout, 9000);
    assert.equal(emptyLast.diagnostics[0]?.reason, "empty");
  });
});

describe("顺序不可交换：D-B 记录的决定性陷阱", () => {
  it("empty 先于 zero，所以 ZCODE_HTTP_TIMEOUT= 不会静默关闭超时", () => {
    const out = readOutcome("ZCODE_HTTP_TIMEOUT", "");
    assert.equal(out.reason, "empty");
    assert.notEqual(out.accepted, 0, "第 1 步一旦排在第 4 步之后，导出脚本里的误设就会关掉超时");
  });

  it("下溢成 0 的极正值（1e-999）按第 4 步落为「关闭」，这是按值判定的已知后果", () => {
    // spec §9 表态：第 4 步用 Number(value) === 0 判定，不看字面语法；1e-999 与 0 同值即同意关闭。
    assert.equal(Number("1e-999"), 0);
    assert.equal(readOutcome("ZCODE_HTTP_TIMEOUT", "1e-999").accepted, 0);
    // 同一个输入对 maxConcurrency 仍是非法值，说明放行范围没有外溢。
    assert.equal(readOutcome("ZCODE_MAX_TOOL_CONCURRENCY", "1e-999").reason, "zero_not_allowed");
  });

  it("合法的 0 与非法的 0 用同一个诊断形状，字段齐全且 fallback 指回默认值所有者", () => {
    const d = parseEnvConfigWithDiagnostics({ ZCODE_MAX_TOOL_CONCURRENCY: "0" }).diagnostics[0] as EnvConfigDiagnostic;
    assert.equal(d.code, "env_config_invalid");
    assert.equal(d.severity, "warning");
    assert.equal(d.value, "0");
    assert.equal(d.path, "toolConcurrency.maxConcurrency");
    assert.match(d.fallback, /DefaultConfig\.toolConcurrency\.maxConcurrency \(10 via ConfigPort\.getAll\)/);
    const t = parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "2147483648" }).diagnostics[0] as EnvConfigDiagnostic;
    assert.match(t.fallback, /DefaultConfig\.network\.timeout \(180000ms via ConfigPort\.getAll\)/);
    assert.match(t.message, /2147483648/);
  });
});

describe("MAIN-07：上界是命名常量而不是魔数", () => {
  it("MAX_TIMER_DELAY_MS === 2^31-1，等于 Node 定时器的 32-bit 有符号上限", () => {
    assert.equal(MAX_TIMER_DELAY_MS, 2_147_483_647);
    assert.equal(MAX_TIMER_DELAY_MS, 2 ** 31 - 1);
  });
});

describe("MAIN-08：非字符串 env 值不得抛错（fail-open 承诺的可执行版本）", () => {
  const nonStrings: Array<[string, unknown]> = [
    ["object", {}],
    ["array", []],
    ["array-of-number", [7]],
    ["number", 10],
    ["float", 45.5],
    ["boolean", true],
    ["nan-number", Number.NaN],
    ["symbol", Symbol("ZCODE_TEST")],
    ["function", () => 1],
  ];

  for (const [label, value] of nonStrings) {
    it(`${label} 走类型化诊断而不是 TypeError，且不写入任何 key`, () => {
      for (const key of ["ZCODE_HTTP_TIMEOUT", "ZCODE_TIMEOUT", "ZCODE_MAX_TOOL_CONCURRENCY"] as const) {
        const parsed = parseEnvConfigWithDiagnostics(hostile({ [key]: value }));
        assert.equal(parsed.config.network, undefined);
        assert.equal(parsed.config.toolConcurrency, undefined);
        assert.equal(parsed.diagnostics.length, 1);
        assert.equal(parsed.diagnostics[0]?.reason, "non_string_value");
      }
      assert.equal(getToolConcurrencyConfig(hostile({ ZCODE_MAX_TOOL_CONCURRENCY: value })).maxConcurrency, 10);
    });
  }

  it("logging.format 的非字符串（含 null）同样不再抛错，且整体缺席", () => {
    for (const value of [{}, [], 10, true, null, () => 1] as unknown[]) {
      const parsed = parseEnvConfigWithDiagnostics(hostile({ ZCODE_LOG_FORMAT: value }));
      assert.equal(parsed.config.logging, undefined);
      assert.equal(parsed.diagnostics.length, 1);
      assert.equal(parsed.diagnostics[0]?.reason, "non_string_value");
      assert.equal(parsed.diagnostics[0]?.path, "logging.format");
    }
  });

  it("null 的既有行为保持不动：数值键仍按 `?? \"\"` 落为 empty（实测过，不顺手改）", () => {
    for (const key of ["ZCODE_HTTP_TIMEOUT", "ZCODE_MAX_TOOL_CONCURRENCY"] as const) {
      const parsed = parseEnvConfigWithDiagnostics(hostile({ [key]: null }));
      assert.equal(parsed.diagnostics[0]?.reason, "empty");
      assert.equal(parsed.diagnostics[0]?.value, "null");
    }
  });

  it("诊断的 value 字段仍是 string：对象渲染成类型名，标量渲染成 String()", () => {
    const cases: Array<[unknown, string]> = [[{}, "object"], [[1, 2], "array"], [10, "10"], [true, "true"], [null, "null"]];
    for (const [value, expected] of cases) {
      const d = parseEnvConfigWithDiagnostics(hostile({ ZCODE_HTTP_TIMEOUT: value })).diagnostics[0] as EnvConfigDiagnostic;
      assert.equal(typeof d.value, "string");
      assert.equal(d.value, expected);
    }
  });

  it("混合输入：一个非法类型不影响兄弟 key 的正常装载", () => {
    const parsed = parseEnvConfigWithDiagnostics(
      hostile({ ZCODE_HTTP_TIMEOUT: {}, ZCODE_MAX_TOOL_CONCURRENCY: "4", ZCODE_LOG_FORMAT: "json" }),
    );
    assert.equal(parsed.config.toolConcurrency?.maxConcurrency, 4);
    assert.equal(parsed.config.logging?.format, "json");
    assert.equal(parsed.config.network, undefined);
    assert.equal(parsed.diagnostics.length, 1);
  });
});

describe("MAIN-09 漂移断言（源码扫描，不是共享常量）", () => {
  // 这里读的是源文本而不是 import 真实表：contracts/src/config/index.ts 有 value import 依赖，
  // 一旦被本模块 import 就会让 21 条 env 用例整体退化成 WARN。代价：文本比对，不保证运行时同源。
  const adapterSrc = readFileSync(new URL("../src/config/env-config.adapter.ts", import.meta.url), "utf8");
  const defaultTableSrc = readFileSync(
    new URL("../../contracts/src/config/index.ts", import.meta.url),
    "utf8",
  );

  function singleLiteral(source: string, label: RegExp): string {
    // matchAll 要求 global 标志；计数用来保证「这一处字面量在两个文件里都只有一份」，
    // 出现第二处持有者时这条断言会先红在计数上。
    const matches = [...source.matchAll(new RegExp(label.source, "gu"))];
    assert.equal(matches.length, 1, `期望恰好 1 处 ${label.source}，实测 ${matches.length} 处`);
    return matches[0]?.[1] as string;
  }

  it("adapter 的 DEFAULT_MAX_TOOL_CONCURRENCY 仍等于 DefaultConfig.toolConcurrency.maxConcurrency", () => {
    assert.equal(
      singleLiteral(adapterSrc, /DEFAULT_MAX_TOOL_CONCURRENCY\s*=\s*([0-9_]+)/u),
      singleLiteral(defaultTableSrc, /maxConcurrency:\s*([0-9_]+)/u),
    );
  });

  it("adapter 的 DEFAULT_NETWORK_TIMEOUT_MS 仍等于 DefaultConfig.network.timeout", () => {
    assert.equal(
      singleLiteral(adapterSrc, /DEFAULT_NETWORK_TIMEOUT_MS\s*=\s*([0-9_]+)/u),
      singleLiteral(defaultTableSrc, /timeout:\s*([0-9_]+)/u),
    );
  });

  it("fallback 文案里的默认值数字来自常量而不是第二处手写（诊断措辞漂移也会红）", () => {
    assert.match(adapterSrc, /NETWORK_TIMEOUT_FALLBACK\s*=\s*`[^`]*\$\{DEFAULT_NETWORK_TIMEOUT_MS\}ms/u);
    assert.match(adapterSrc, /TOOL_CONCURRENCY_FALLBACK\s*=\s*`[^`]*\$\{DEFAULT_MAX_TOOL_CONCURRENCY\}/u);
  });
});
