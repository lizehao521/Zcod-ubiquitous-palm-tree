// MAIN-07 文件门 .max(MAX_TIMER_DELAY_MS) 的**执行断言**（specs/runtime-env-config/spec.md §3 / §12.2）。
//
// 与同目录 config-timeout-ceiling-drift.test.ts（文本比对，4 例）的分工：
// 那个文件抓"两侧数值分叉 / .max() 被换走"的**源码形态**漂移；本文件把
// schema.ts 真正**装载并执行**（gen6 台架：adapters/node_modules/zod 从本机 pnpm store
// 离线重建后，schema.ts 可被 node --test 直接装载），对 network.timeout 的
// 上界 / 非负 / 有限 判据做运行时断言，并自包含地复现两个变异：
//   M1 天花板常量 +1（2^31-1 → 2^31）⇒ 上界漏拦 2^31，本文件红；
//   M2 摘掉 .max() ⇒ 1e20 / 2^31 放行，本文件红。
// 两个变异都在测试内用本地源码改写 + 独立副本 schema 实现，不碰真实源文件。
//
// 诚实边界（与 spec §12.2 同口径）：
// - 本文件走 ESM 条件入口（node --test + Node 24 类型擦除 = ESM）。
//   CJS 条件入口（index.cjs 闭包）已同步重建但未被本文件覆盖 —— 记为未验证边界。
// - parseConfigFileToRuntimePatchWithDiagnostics 对网络组是 fail-loud（schema.parse 抛
//   ZodError），不是 env 门的 fail-open + 诊断。两条门的错误形态不同是设计而非缺陷。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SRC_PATH = join(HERE, "..", "src", "config", "schema.ts");
const SCHEMA_SRC = readFileSync(SCHEMA_SRC_PATH, "utf8");
const NODE_TIMER_CEILING = 2 ** 31 - 1;

// 真实 schema 模块（ESM 条件）：
const realSchema = await import(pathToFileURL(join(dirname(SCHEMA_SRC_PATH), "schema.ts")).toString());
const { ZCodeConfigFileSchema, parseConfigFileToRuntimePatchWithDiagnostics } = realSchema;

/** 在 os.tmpdir 写一份 schema.ts 改写副本并动态 import。
 *  变异必须真正改变源码，否则 assert 直接失败（变异空转 ⇒ 断言无意义）。 */
async function importMutatedSchema(mutate, label) {
  // 变异副本必须放在能解析到 node_modules/zod 的目录（adapters 包内），
  // 放 os.tmpdir 会走出包边界导致 ERR_MODULE_NOT_FOUND（zod 不是全局包）。
  const dir = mkdtempSync(pathResolve(HERE, "..", ".schema-mut-tmp"));
  const mutated = mutate(SCHEMA_SRC);
  assert.notEqual(mutated, SCHEMA_SRC, label + ": 变异未改变源码（变异是空转，断言无意义）");
  const file = join(dir, "schema-mutated.ts");
  writeFileSync(file, mutated, "utf8");
  try {
    return await import(pathToFileURL(file).toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function networkTimeoutResult(value) {
  return ZCodeConfigFileSchema.safeParse({ network: { timeout: value } });
}

describe("MAIN-07 文件门 .max() 执行断言（gen6 A1）", () => {
  it("装载即生效：schema.ts 现在可以被 node --test 直接 import（gen5 WARN-unverifiable 边界的闭合证据）", () => {
    assert.equal(typeof ZCodeConfigFileSchema.safeParse, "function");
    assert.equal(typeof parseConfigFileToRuntimePatchWithDiagnostics, "function");
  });

  it("边界值 2^31-1（MAX_TIMER_DELAY_MS）通过文件门", () => {
    const r = networkTimeoutResult(NODE_TIMER_CEILING);
    assert.equal(r.success, true, "2^31-1 必须合法，实测 " + JSON.stringify(r.success ? undefined : r.error?.issues?.slice(0, 2)));
  });

  it("越界值 2^31（2147483648）被文件门拒绝", () => {
    const r = networkTimeoutResult(2 ** 31);
    assert.equal(r.success, false, "2^31 越过 .max(2^31-1)，必须拒绝");
    assert.ok(r.error?.issues?.length, "拒绝必须带 issue（不是静默丢弃）");
  });

  it("1e20 被拒绝（MAIN-07 原始症状：1e20 穿到 setTimeout 被钳成 1ms）", () => {
    assert.equal(networkTimeoutResult(1e20).success, false, "1e20 必须被文件门拦下");
  });

  it("0 通过（D-B 裁决：0 = 显式关闭超时，文件门与 env 门同语义）", () => {
    assert.equal(networkTimeoutResult(0).success, true, "0 必须合法（显式关闭）");
  });

  it("负数被拒绝（nonNegativeFiniteNumberSchema 基础判据）", () => {
    assert.equal(networkTimeoutResult(-1).success, false);
  });

  it("Infinity / NaN 被拒绝（finite 判据）", () => {
    assert.equal(networkTimeoutResult(Infinity).success, false);
    assert.equal(networkTimeoutResult(NaN).success, false);
  });

  it("合法值经 parseConfigFileToRuntimePatchWithDiagnostics 原样透传（不丢 0）", () => {
    const { config } = parseConfigFileToRuntimePatchWithDiagnostics({ network: { timeout: 0 } });
    assert.equal(config.network?.timeout, 0, "0 必须原样进 patch（§9 回落语义的前提）");
    const { config: c2 } = parseConfigFileToRuntimePatchWithDiagnostics({ network: { timeout: NODE_TIMER_CEILING } });
    assert.equal(c2.network?.timeout, NODE_TIMER_CEILING);
  });

  it("变异 M1（天花板 +1）被本文件抓到：2^31 在变异体上放行 ⇒ 证明断言不是空转", async () => {
    const mutM1 = await importMutatedSchema(
      (s) => s.replace("const MAX_TIMER_DELAY_MS = 2_147_483_647;", "const MAX_TIMER_DELAY_MS = 2_147_483_648;"),
      "M1",
    );
    // 变异体上 2^31 恰好等于新天花板 ⇒ 通过（而真实 schema 拒绝它）——
    // 这条对比就是"文本守卫抓不到、执行断言抓得到"的那类漂移的最小复现。
    const m1 = mutM1.ZCodeConfigFileSchema.safeParse({ network: { timeout: 2 ** 31 } });
    assert.equal(m1.success, true, "变异 M1 上 2^31 应放行（若此处红，说明变异或断言本体坏了）");
    const real = ZCodeConfigFileSchema.safeParse({ network: { timeout: 2 ** 31 } });
    assert.equal(real.success, false, "真实 schema 上 2^31 必须拒绝（M1 两侧读数不对称即证执行面有判别力）");
  });

  it("变异 M2（摘 .max()）被本文件抓到：1e20 在变异体上放行 ⇒ 证明 .max() 是拦截来源", async () => {
    const mutM2 = await importMutatedSchema(
      (s) => s.replace("timeout: nonNegativeFiniteNumberSchema.max(MAX_TIMER_DELAY_MS).optional(),",
                      "timeout: nonNegativeFiniteNumberSchema.optional(),"),
      "M2",
    );
    const m2 = mutM2.ZCodeConfigFileSchema.safeParse({ network: { timeout: 1e20 } });
    assert.equal(m2.success, true, "变异 M2（无 .max）上 1e20 应放行");
    const real = ZCodeConfigFileSchema.safeParse({ network: { timeout: 1e20 } });
    assert.equal(real.success, false, "真实 schema 上 1e20 必须拒绝（M2 两侧读数不对称即证 .max() 在起作用）");
  });
});
