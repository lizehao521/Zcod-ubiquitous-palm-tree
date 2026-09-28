// MAIN-07 上界的**双门漂移守卫**（specs/runtime-env-config/spec.md §3 / §4.1 第 6 步 / §12.2）。
//
// 背景：`network.timeout` 有两道手写校验门 —— env 门（env-config.adapter.ts 的
// `MAX_TIMER_DELAY_MS` + `NETWORK_TIMEOUT_RULE.maxMs`）与文件门（schema.ts 的
// `MAX_TIMER_DELAY_MS` + `timeout` 字段上的 `.max()`）。此前只有 env 门有天花板，
// 文件门放 `1e20`/`2147483648` 过去，终态是 Node 把 setTimeout 延时钳成 **1ms**
// （实测 TimeoutOverflowWarning），"配了个大超时"= 每个请求约 1ms 就失败。
//
// 本文件是什么：**源码文本比对守卫，不是共享常量**。
// 它抓得到的是"两侧数值分叉"（改一处忘另一处 ⇒ 红）。
// 它抓不到的是"同一数值被语义不同地应用"（例如把 `.max()` 换成自定义 refine、
// 把比较改成 `>=`、或把常量接到别的键上）—— 那些只能靠 §4.1 的行为用例和人来判。
// 之所以不做真正的运行时共享：schema.ts 有 `zod` 的 value import（本裁剪环境未安装，
// 文件根本装载不了），而两个 adapter 文件之间的相对 value import（NodeNext 的 `./x.js`）
// 在 Node 24 type stripping 下不会改写说明符，会把可测的那个文件一起拖死。
// 代价写在这里，别把它读成"一处修改两边生效"。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ENV_ADAPTER_SRC = readFileSync(
  new URL("../src/config/env-config.adapter.ts", import.meta.url),
  "utf8",
);
const SCHEMA_SRC = readFileSync(new URL("../src/config/schema.ts", import.meta.url), "utf8");

/** 提取恰好一处的数字字面量（允许 `2_147_483_647` 这种下划线分隔），并返回归一后的数值。 */
function singleNumericLiteral(source: string, pattern: RegExp, label: string): number {
  const matches = [...source.matchAll(new RegExp(pattern.source, "gu"))];
  assert.equal(matches.length, 1, `${label}：期望恰好 1 处，实测 ${matches.length} 处`);
  const raw = matches[0]?.[1] as string;
  assert.match(raw, /^[0-9_]+$/u, `${label}：期望纯数字字面量，实测 ${JSON.stringify(raw)}`);
  return Number(raw.replace(/_/gu, ""));
}

const NODE_TIMER_CEILING = 2 ** 31 - 1;

describe("MAIN-07 双门天花板漂移守卫（文本比对，非运行时共享）", () => {
  it("env 门与文件门的 MAX_TIMER_DELAY_MS 是同一个数值，且等于 Node 的 32-bit 有符号上限", () => {
    const envCeiling = singleNumericLiteral(
      ENV_ADAPTER_SRC,
      /MAX_TIMER_DELAY_MS\s*=\s*([0-9_]+)/u,
      "env-config.adapter.ts 的 MAX_TIMER_DELAY_MS",
    );
    const fileCeiling = singleNumericLiteral(
      SCHEMA_SRC,
      /MAX_TIMER_DELAY_MS\s*=\s*([0-9_]+)/u,
      "schema.ts 的 MAX_TIMER_DELAY_MS",
    );
    assert.equal(envCeiling, fileCeiling, "两扇门的天花板分叉了：一处被改而另一处没跟上");
    assert.equal(fileCeiling, NODE_TIMER_CEILING, "天花板必须等于 2^31-1，否则不是在拦 setTimeout 钳位");
  });

  it("天花板在两侧都真的挂在 network.timeout 上（应用点也是文本断言）", () => {
    // env 侧：具名规则引用常量，而不是把数字抄进判据函数。
    assert.match(
      ENV_ADAPTER_SRC,
      /NETWORK_TIMEOUT_RULE[^;\n]*maxMs:\s*MAX_TIMER_DELAY_MS/u,
      "env 侧 NETWORK_TIMEOUT_RULE 的 maxMs 必须引用 MAX_TIMER_DELAY_MS",
    );
    // 文件侧：timeout 字段上的 `.max()` 必须带常量名（不是魔数，也不是别的键）。
    assert.match(
      SCHEMA_SRC,
      /timeout:\s*nonNegativeFiniteNumberSchema\.max\(MAX_TIMER_DELAY_MS\)/u,
      "文件侧 timeout 字段必须在 nonNegativeFiniteNumberSchema 链上加 .max(MAX_TIMER_DELAY_MS)",
    );
  });

  it("天花板只作用于 timeout：全仓 schema.ts 只有 1 处 .max()，兄弟键未被顺手收窄", () => {
    // D-B / MAIN-10 的裁决：上界属于**计时器消费方**，不是所有数值键的公共属性。
    // maxConcurrency 的合理上界是运营/产品数，本轮不替产品拍板 ⇒ 它必须仍未被封顶。
    // 这条断言在"有人把 .max() 推广到兄弟键"时变红（计数 1 → 2）。
    assert.equal(
      [...SCHEMA_SRC.matchAll(/\.max\(/gu)].length,
      1,
      "schema.ts 里 .max() 应恰好 1 处（只给 network.timeout）；多出来的就是未经裁决的外溢",
    );
    assert.match(SCHEMA_SRC, /maxConcurrency:\s*positiveNumberSchema\.optional\(\)/u);
    assert.match(ENV_ADAPTER_SRC, /TOOL_CONCURRENCY_RULE[^;\n]*maxMs:\s*undefined/u);
  });

  it("文件侧的判据链仍以非负有限数为基础（0 = 显式关闭这条裁决没被 .max() 顺手改掉）", () => {
    assert.match(
      SCHEMA_SRC,
      /const nonNegativeFiniteNumberSchema = z\.number\(\)\.finite\(\)\.nonnegative\(\)/u,
      "nonNegativeFiniteNumberSchema 的基础判据（finite + nonnegative）不得改动",
    );
  });
});
