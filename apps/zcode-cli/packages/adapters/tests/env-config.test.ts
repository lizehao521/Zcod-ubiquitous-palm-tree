// Env Config Adapter tests - contract per specs/runtime-env-config/spec.md §8.
//
// 只用相对路径导入被测模块：本模块的外部依赖是 `import type`，Node 24 type stripping 会擦除它，
// 因此 `node --test` 无需 node_modules 即可装载。断言不依赖错误文本，只读 code/reason/path。

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getToolConcurrencyConfig,
  parseEnvConfig,
  parseEnvConfigWithDiagnostics,
  type EnvConfigDiagnostic,
} from "../src/config/env-config.adapter.ts";

function only(diags: EnvConfigDiagnostic[]): EnvConfigDiagnostic {
  assert.equal(diags.length, 1, `expected exactly one diagnostic, got ${diags.length}`);
  return diags[0] as EnvConfigDiagnostic;
}

describe("parseEnvConfigWithDiagnostics - numeric env keys", () => {
  it("AC-4 control: valid input still yields the same number (guards an 'always ignore' fix)", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({
      ZCODE_HTTP_TIMEOUT: "45000",
      ZCODE_MAX_TOOL_CONCURRENCY: "4",
      ZCODE_LOG_FORMAT: "json",
      ZCODE_HTTP_PROXY: "http://example.invalid",
    });
    assert.deepEqual(diagnostics, []);
    assert.equal(config.network?.timeout, 45000);
    assert.equal(config.toolConcurrency?.maxConcurrency, 4);
    assert.equal(config.logging?.format, "json");
    assert.equal(config.network?.httpProxy, "http://example.invalid");
  });

  it("AC-1: unparsable timeout is omitted (not 0) and reported", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "30s" });
    // 缺席而非 0：config/index.ts:113 只在 !== undefined 时写 ConfigPort，缺席才回落默认超时。
    assert.equal(config.network, undefined);
    assert.equal(config.network?.timeout, undefined);
    const d = only(diagnostics);
    assert.equal(d.code, "env_config_invalid");
    assert.equal(d.envKey, "ZCODE_HTTP_TIMEOUT");
    assert.equal(d.path, "network.timeout");
    assert.equal(d.reason, "invalid_number");
    assert.equal(d.severity, "warning");
    assert.equal(d.value, "30s");
  });

  it("AC-2 (D-B revised): literal 0 timeout is legal and means 'explicitly disable request timeout'", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "0" });
    // 0 是裁决放行的显式值，必须真的写进 patch（缺席会被 ConfigPort 回落成 180000）。
    assert.equal(config.network?.timeout, 0);
    assert.deepEqual(diagnostics, []);
    // 空串仍不是 0：见 spec §4 第 1 步，ZCODE_HTTP_TIMEOUT= 依旧是 empty。
    const empty = parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "" });
    assert.equal(empty.config.network, undefined);
    assert.equal(only(empty.diagnostics).reason, "empty");
  });

  it("AC-5: empty value is rejected before Number('') === 0 can disable the timeout", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "" });
    assert.equal(config.network, undefined);
    assert.equal(only(diagnostics).reason, "empty");
    assert.equal(parseEnvConfig({ ZCODE_HTTP_TIMEOUT: "   " }).network, undefined);
  });

  it("negative and infinity timeouts are rejected", () => {
    assert.equal(only(parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "-1" }).diagnostics).reason, "negative");
    assert.equal(
      only(parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "Infinity" }).diagnostics).reason,
      "invalid_number",
    );
    assert.equal(
      only(parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: "1,000" }).diagnostics).reason,
      "invalid_number",
    );
  });

  it("AC-6: the ZCODE_TIMEOUT alias carries the same contract and path", () => {
    const ok = parseEnvConfigWithDiagnostics({ ZCODE_TIMEOUT: "2000" });
    assert.equal(ok.config.network?.timeout, 2000);
    assert.deepEqual(ok.diagnostics, []);
    const bad = parseEnvConfigWithDiagnostics({ ZCODE_TIMEOUT: "30s" });
    assert.equal(bad.config.network, undefined);
    assert.equal(only(bad.diagnostics).path, "network.timeout");
    assert.equal(only(bad.diagnostics).envKey, "ZCODE_TIMEOUT");
  });

  it("AC-3: unparsable max concurrency is omitted (not 0) and reported", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({ ZCODE_MAX_TOOL_CONCURRENCY: "abc" });
    assert.equal(config.toolConcurrency, undefined);
    const d = only(diagnostics);
    assert.equal(d.path, "toolConcurrency.maxConcurrency");
    assert.equal(d.reason, "invalid_number");
  });

  it("max concurrency keeps its documented contract parity with the file schema (non-integer allowed)", () => {
    // config/schema.ts:217-219 对 maxConcurrency 用 positiveNumberSchema（非 int），env 层不得更严。
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({ ZCODE_MAX_TOOL_CONCURRENCY: "2.5" });
    assert.equal(config.toolConcurrency?.maxConcurrency, 2.5);
    assert.deepEqual(diagnostics, []);
  });

  it("a rejected numeric key does not shadow sibling keys that are valid", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({
      ZCODE_HTTP_TIMEOUT: "30s",
      ZCODE_HTTP_PROXY: "http://example.invalid",
      ZCODE_NO_PROXY: "localhost",
    });
    assert.equal(config.network?.timeout, undefined);
    assert.equal(config.network?.httpProxy, "http://example.invalid");
    assert.equal(config.network?.noProxy, "localhost");
    assert.equal(diagnostics.length, 1);
  });
});

describe("parseEnvConfigWithDiagnostics - non-numeric and unknown keys", () => {
  it("AC-4: valid log format is accepted without diagnostics", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({ ZCODE_LOG_FORMAT: "JSON" });
    assert.equal(config.logging?.format, "json");
    assert.deepEqual(diagnostics, []);
  });

  it("unsupported log format keeps the existing fallback value but is no longer silent", () => {
    // 见 spec §5.3：改值语义会连带改变 Env 覆盖项目配置的行为，属无关变更，这里只补上报。
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({ ZCODE_LOG_FORMAT: "xml" });
    assert.equal(config.logging?.format, "text");
    assert.equal(only(diagnostics).reason, "unsupported_value");
    assert.equal(only(diagnostics).path, "logging.format");
  });

  it("string keys are passed through unchanged (spec §7: out of scope)", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({
      ZCODE_STORAGE_DIR: "/tmp/example",
      ZCODE_SESSION_DB_PATH: "/tmp/example/db.sqlite",
      ZCODE_AGENT_CA_CERT: "/tmp/example/ca.pem",
    });
    assert.equal(config.storage?.dir, "/tmp/example");
    assert.equal(config.storage?.sessionDbPath, "/tmp/example/db.sqlite");
    assert.equal(config.network?.caCertFile, "/tmp/example/ca.pem");
    assert.deepEqual(diagnostics, []);
  });

  it("AC-7: unknown and non-prefixed variables are ignored and produce nothing", () => {
    const { config, diagnostics } = parseEnvConfigWithDiagnostics({
      PATH: "/usr/bin",
      HOME: "/home/example",
      ZCODE_UNDECLARED_KEY: "whatever",
      ZCODE: "bare-prefix",
    });
    assert.deepEqual(config, {});
    assert.deepEqual(diagnostics, []);
  });

  it("honours a custom prefix", () => {
    const { config } = parseEnvConfigWithDiagnostics(
      { MYAPP_HTTP_TIMEOUT: "9000", ZCODE_HTTP_TIMEOUT: "30s" },
      { prefix: "MYAPP_" },
    );
    assert.equal(config.network?.timeout, 9000);
  });
});

describe("fail-open (project law)", () => {
  it("AC-7: hostile env input never throws and never aborts startup", () => {
    const hostile: Record<string, string | undefined> = {
      ZCODE_HTTP_TIMEOUT: "NaN",
      ZCODE_MAX_TOOL_CONCURRENCY: "-0",
      ZCODE_LOG_FORMAT: "",
      ZCODE_TIMEOUT: "\t\t",
    };
    assert.doesNotThrow(() => parseEnvConfigWithDiagnostics(hostile));
    const { config, diagnostics } = parseEnvConfigWithDiagnostics(hostile);
    assert.equal(config.network, undefined);
    assert.equal(config.toolConcurrency, undefined);
    // 每个非法值都有对应上报，不存在静默降级。
    assert.equal(diagnostics.length, 4);
    assert.ok(diagnostics.every((d) => d.code === "env_config_invalid" && d.severity === "warning"));
  });

  it("undefined env argument falls back to process.env without crashing", () => {
    const original = process.env.ZCODE_HTTP_TIMEOUT;
    process.env.ZCODE_HTTP_TIMEOUT = "31000";
    try {
      assert.equal(parseEnvConfig().network?.timeout, 31000);
    } finally {
      if (original === undefined) delete process.env.ZCODE_HTTP_TIMEOUT;
      else process.env.ZCODE_HTTP_TIMEOUT = original;
    }
  });

  it("no existing safety bound is removed: an illegal value never yields a 0 timeout", () => {
    // D-B 之后"0 不出现"不再是判据（0 本身合法），判据收窄成"非法输入不得变成 0"：
    // 任何被拒绝的输入都必须整体缺席，让 ConfigPort 回落 180000，而不是悄悄关掉超时。
    for (const value of ["30s", "", "   ", "-1", "abc", "Infinity", "NaN", "2147483648", "1e20"]) {
      const { config } = parseEnvConfigWithDiagnostics({ ZCODE_HTTP_TIMEOUT: value });
      assert.notEqual(config.network?.timeout, 0, `value ${JSON.stringify(value)} must not become 0`);
    }
    for (const value of ["abc", "", "0", "-3"]) {
      const { config } = parseEnvConfigWithDiagnostics({ ZCODE_MAX_TOOL_CONCURRENCY: value });
      assert.notEqual(config.toolConcurrency?.maxConcurrency, 0);
    }
  });
});

describe("parseEnvConfig compatibility wrapper", () => {
  it("returns the same config shape as before the fix (no signature change for importers)", () => {
    assert.deepEqual(parseEnvConfig({ ZCODE_HTTP_TIMEOUT: "30s" }), {});
    assert.deepEqual(parseEnvConfig({ ZCODE_HTTP_TIMEOUT: "1200" }), { network: { timeout: 1200 } });
    assert.deepEqual(parseEnvConfig({}), {});
  });
});

describe("getToolConcurrencyConfig direct reader", () => {
  it("AC-8: falls back to the documented default instead of 0", () => {
    assert.equal(getToolConcurrencyConfig({}).maxConcurrency, 10);
    assert.equal(getToolConcurrencyConfig({ ZCODE_MAX_TOOL_CONCURRENCY: "abc" }).maxConcurrency, 10);
    assert.equal(getToolConcurrencyConfig({ ZCODE_MAX_TOOL_CONCURRENCY: "0" }).maxConcurrency, 10);
    assert.equal(getToolConcurrencyConfig({ ZCODE_MAX_TOOL_CONCURRENCY: "" }).maxConcurrency, 10);
  });

  it("AC-8 control: a valid value is still honoured", () => {
    assert.equal(getToolConcurrencyConfig({ ZCODE_MAX_TOOL_CONCURRENCY: "3" }).maxConcurrency, 3);
  });

  it("defaults to process.env when no env is injected", () => {
    const original = process.env.ZCODE_MAX_TOOL_CONCURRENCY;
    process.env.ZCODE_MAX_TOOL_CONCURRENCY = "7";
    try {
      assert.equal(getToolConcurrencyConfig().maxConcurrency, 7);
    } finally {
      if (original === undefined) delete process.env.ZCODE_MAX_TOOL_CONCURRENCY;
      else process.env.ZCODE_MAX_TOOL_CONCURRENCY = original;
    }
  });
});
