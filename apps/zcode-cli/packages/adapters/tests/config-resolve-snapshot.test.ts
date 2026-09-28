// ============================================================
// config/resolve-snapshot 单测：证明「key→默认值」只剩一条回落路径
// 运行：node --test apps/zcode-cli/packages/adapters/tests/config-resolve-snapshot.test.ts
//
// 为什么能跑：resolve-snapshot.ts 零运行时外部依赖（只有 import type，会被 Node
// type-stripping 擦除），默认值表以参数注入，所以本文件不需要 @zcode/* 的链接。
// 被测的 ConfigPortImpl / config/index.ts 本身在本裁剪检出仍无法加载（value import
// @zcode/contracts → ERR_MODULE_NOT_FOUND），所以那条接缝用「源码静态扫描」用例兜住，
// 见最后一条 C7；这属于未验证边界的替代证据，不当作端到端通过。
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_SNAPSHOT_KEYS,
  assembleConfigSnapshot,
  defaultPathOf,
  documentedDefaultOf,
  resolveConfigValue,
  resolveSnapshot,
} from "../src/config/resolve-snapshot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE_PATH = join(HERE, "..", "src", "config", "index.ts");
const CONTRACTS_SOURCE_PATH = join(HERE, "..", "..", "contracts", "src", "config", "index.ts");

/** 没有默认值的键：RuntimeConfig 里是可选字符串，装配结果里必须保持 undefined。 */
const NO_DEFAULT_KEYS = ["network.httpProxy", "network.noProxy", "network.caCertFile"];

/** 改造前在 getAll() 里被硬编码成 `?? true` / `?? "info"` 的键（本次收口的目标）。 */
const FORMERLY_HARDCODED_KEYS = [
  "features.compact",
  "features.rewind",
  "features.subagent",
  "features.memory",
  "features.skill",
  "features.mcp",
  "skills.enabled",
  "skills.includeInstructions",
  "logging.level",
];

function pickByPath(source: unknown, key: string): unknown {
  let cursor: unknown = source;
  for (const segment of defaultPathOf(key).split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * 独立 oracle：直接从 contracts 源码里取出 DefaultRuntimeConfig 字面量，
 * 而不是用我在测试里手写的常量（review-checklist A.4 的「测自己写的常量」风险）。
 * 该字面量只含字符串/数字/布尔/对象/数组，且唯一的标识符引用是超时常量，故可安全求值。
 */
function readProductionDefaults(): Record<string, unknown> {
  const source = readFileSync(CONTRACTS_SOURCE_PATH, "utf8");
  const start = source.indexOf("export const DefaultRuntimeConfig: RuntimeConfig = {");
  assert.ok(start >= 0, "contracts 里必须能定位 DefaultRuntimeConfig 字面量");
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let bodyEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }
  assert.ok(bodyEnd > bodyStart, "DefaultRuntimeConfig 字面量必须括号配平");
  const idleMatch = source.match(
    /export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/,
  );
  assert.ok(idleMatch, "modelStream 默认值常量必须可定位");
  const idleTimeoutMs = Number(idleMatch[1].replace(/_/g, ""));
  const body = source.slice(bodyStart, bodyEnd + 1);
  return new Function("DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS", `return ${body};`)(
    idleTimeoutMs,
  ) as Record<string, unknown>;
}

/** 每个键的默认值替换成可识别的哨兵字符串，任何硬编码字面量在这里都会露形。 */
function sentinelDefaults(): Record<string, unknown> {
  const table: Record<string, unknown> = {};
  for (const key of CONFIG_SNAPSHOT_KEYS) {
    if (NO_DEFAULT_KEYS.includes(key)) continue;
    const segments = defaultPathOf(key).split(".");
    let cursor = table;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      const next = cursor[segment];
      if (next && typeof next === "object" && !Array.isArray(next)) {
        cursor = next as Record<string, unknown>;
        continue;
      }
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
    cursor[segments[segments.length - 1]] = `D<${key}>`;
  }
  return table;
}

/** 手写的期望装配形状（结构侧的独立预言，不复用被测模块的生成逻辑）。 */
function expectedAssembledShape(leaf: (key: string) => unknown): Record<string, unknown> {
  return {
    modelStream: { idleTimeoutMs: leaf("modelStream.idleTimeoutMs") },
    permission: {
      mode: leaf("permission.mode"),
      allowedTools: leaf("permission.allowedTools"),
      disallowedTools: leaf("permission.disallowedTools"),
      autoApproveHighRisk: leaf("permission.autoApproveHighRisk"),
      allowMediumRiskInAuto: leaf("permission.allowMediumRiskInAuto"),
    },
    storage: { dir: leaf("storage.dir"), sessionDbPath: leaf("storage.sessionDbPath") },
    network: {
      httpProxy: leaf("network.httpProxy"),
      noProxy: leaf("network.noProxy"),
      caCertFile: leaf("network.caCertFile"),
      timeout: leaf("network.timeout"),
    },
    features: {
      compact: leaf("features.compact"),
      rewind: leaf("features.rewind"),
      subagent: leaf("features.subagent"),
      memory: leaf("features.memory"),
      skill: leaf("features.skill"),
      mcp: leaf("features.mcp"),
    },
    memory: { use: leaf("memory.use") },
    mcp: { servers: leaf("mcp.servers") },
    plugins: {
      enabled: leaf("plugins.enabled"),
      dirs: leaf("plugins.dirs"),
      enabledPlugins: leaf("plugins.enabledPlugins"),
      extraKnownMarketplaces: leaf("plugins.extraKnownMarketplaces"),
      options: leaf("plugins.options"),
      suppressedBuiltins: leaf("plugins.suppressedBuiltins"),
    },
    skills: {
      enabled: leaf("skills.enabled"),
      includeInstructions: leaf("skills.includeInstructions"),
      metadataBudget: leaf("skills.metadataBudget"),
      roots: leaf("skills.roots"),
    },
    skillOverrides: leaf("skill"),
    commandOverrides: leaf("command"),
    logging: { level: leaf("logging.level"), format: leaf("logging.format") },
    toolConcurrency: { maxConcurrency: leaf("toolConcurrency.maxConcurrency") },
    modelAnomalyGuard: leaf("modelAnomalyGuard"),
    hooks: leaf("hooks"),
    ui: { locale: leaf("ui.locale"), theme: leaf("ui.theme") },
  };
}

/** 全部键都缺席的读取器：用来观测纯回落结果。 */
const ABSENT = () => undefined;

test("C1 表里每个键的回落值 === 注入表里该键的 documented default（无缺席值）", () => {
  const defaults = sentinelDefaults();
  const snapshot = resolveSnapshot(ABSENT, defaults);
  for (const key of CONFIG_SNAPSHOT_KEYS) {
    if (NO_DEFAULT_KEYS.includes(key)) {
      assert.equal(snapshot[key], undefined, `${key} 本就没有 documented default`);
      continue;
    }
    assert.equal(
      snapshot[key],
      `D<${key}>`,
      `${key} 的回落值必须来自注入表本身，不能是别处硬编码的字面量`,
    );
  }
});

test("C2 装配形状逐键取自同一张表（哨兵值：任何 ?? true / ?? \"info\" 都会在这里失败）", () => {
  const defaults = sentinelDefaults();
  const assembled = assembleConfigSnapshot(ABSENT, defaults) as unknown as Record<string, unknown>;
  const expected = expectedAssembledShape((key) =>
    NO_DEFAULT_KEYS.includes(key) ? undefined : `D<${key}>`,
  );
  assert.deepStrictEqual(assembled, expected, "装配结果必须与逐键表来源一一对应，且不多不少");
  for (const key of FORMERLY_HARDCODED_KEYS) {
    assert.notEqual(pickByPath(assembled, key), true, `${key} 仍是硬编码 true 的话会命中这条`);
    assert.notEqual(pickByPath(assembled, key), "info", `${key} 仍是硬编码 "info" 的话会命中这条`);
  }
});

test("C3 漂移用例：翻转表里的默认值，解析结果必须跟着表走（证明没有第二条回落）", () => {
  const base = sentinelDefaults();
  const drifted = {
    ...base,
    features: { ...(base.features as Record<string, unknown>), compact: false, mcp: false },
    logging: { ...(base.logging as Record<string, unknown>), level: "warn" },
    skills: { ...(base.skills as Record<string, unknown>), enabled: false },
    network: { ...(base.network as Record<string, unknown>), timeout: 7 },
  };
  const snapshot = resolveSnapshot(ABSENT, drifted);
  assert.equal(snapshot["features.compact"], false);
  assert.equal(snapshot["features.mcp"], false);
  assert.equal(snapshot["logging.level"], "warn");
  assert.equal(snapshot["skills.enabled"], false);
  assert.equal(snapshot["network.timeout"], 7);
  const assembled = assembleConfigSnapshot(ABSENT, drifted) as unknown as Record<string, unknown>;
  assert.equal((assembled.features as Record<string, unknown>).compact, false);
  assert.equal((assembled.logging as Record<string, unknown>).level, "warn");
});

test("C4 已存值优先：显式 0 / false / 空串都不被当缺席（?? 语义口径）", () => {
  const defaults = sentinelDefaults();
  const stored: Record<string, unknown> = {
    "network.timeout": 0,
    "features.compact": false,
    "logging.level": "debug",
    "storage.dir": "",
    "skills.metadataBudget": 0,
  };
  const lookup = (key: string) => stored[key];
  assert.equal(resolveConfigValue("network.timeout", lookup, defaults), 0);
  assert.equal(resolveConfigValue("features.compact", lookup, defaults), false);
  assert.equal(resolveConfigValue("storage.dir", lookup, defaults), "");
  const assembled = assembleConfigSnapshot(lookup, defaults) as unknown as Record<string, unknown>;
  assert.equal((assembled.network as Record<string, unknown>).timeout, 0, "存进去的 0 必须保留");
  assert.equal((assembled.features as Record<string, unknown>).compact, false);
});

test("C5 没有默认值的键：回落到 undefined（ConfigPort.get 仍按原口径抛错）", () => {
  const defaults = sentinelDefaults();
  for (const key of NO_DEFAULT_KEYS) {
    assert.equal(documentedDefaultOf(defaults, key), undefined);
    assert.equal(resolveConfigValue(key, ABSENT, defaults), undefined);
  }
  assert.equal(documentedDefaultOf(defaults, "no.such.key"), undefined);
  assert.equal(resolveConfigValue("no.such.key", ABSENT, defaults), undefined);
});

test("C6 路径覆盖：skill/command 落到 skillOverrides/commandOverrides，不产生同名的顶层键", () => {
  const defaults = sentinelDefaults();
  const assembled = assembleConfigSnapshot(ABSENT, defaults) as unknown as Record<string, unknown>;
  assert.equal(assembled["skillOverrides"], "D<skill>");
  assert.equal(assembled["commandOverrides"], "D<command>");
  assert.ok(!("skill" in assembled), "装配结果不应出现 ConfigKey 字面量键 skill");
  assert.ok(!("command" in assembled), "装配结果不应出现 ConfigKey 字面量键 command");
  assert.equal(Object.keys(defaults).includes("skill"), false, "覆盖表里不该再出现 skill 键");
  assert.equal(assembled["skill"], undefined);
  assert.equal(assembled["command"], undefined);
});

test("C7 接缝静态校验：index.ts 不再自己写回落，且默认值来自唯一入口", () => {
  const raw = readFileSync(INDEX_SOURCE_PATH, "utf8");
  // 注释里会解释旧写法，必须先剥掉注释再扫描，否则扫描结果没有意义。
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.match(source, /from "\.\/resolve-snapshot\.js"/, "index.ts 必须走 resolve-snapshot 接缝");
  assert.match(source, /assembleConfigSnapshot\(this\.store\.lookup\(\), DefaultConfig\)/);
  assert.match(source, /resolveConfigValue\(key, this\.store\.lookup\(\), DefaultConfig\)/);
  for (const pattern of [
    /\?\?\s*true\b/g,
    /\?\?\s*false\b/g,
    /\?\?\s*"info"/g,
    /\?\?\s*"text"/g,
    /\?\?\s*DefaultConfig\.[A-Za-z]/g,
  ]) {
    assert.equal(
      source.match(pattern)?.[0],
      undefined,
      `index.ts 里残留了第二条回落路径：${pattern.source}`,
    );
  }
  assert.equal(/function (getDefaultValue|hasDefaultValue)\b/.test(source), false);
});

test("C8 与生产默认表对齐：曾经硬编码的键，回落值 === contracts 的 documented default", () => {
  const defaults = readProductionDefaults();
  const snapshot = resolveSnapshot(ABSENT, defaults);
  // 表本身必须覆盖 getAll() 的每一个字段（39 个），否则装配会缺字段。
  assert.equal(CONFIG_SNAPSHOT_KEYS.length, 39);
  assert.equal(new Set(CONFIG_SNAPSHOT_KEYS).size, CONFIG_SNAPSHOT_KEYS.length, "键不得重复");
  for (const key of CONFIG_SNAPSHOT_KEYS) {
    if (NO_DEFAULT_KEYS.includes(key)) continue;
    assert.notEqual(
      snapshot[key],
      undefined,
      `${key} 在 contracts 的 DefaultRuntimeConfig 里必须有值，否则 getAll() 会回落成 undefined`,
    );
  }
  assert.equal(snapshot["network.timeout"], 180000);
  assert.equal(snapshot["toolConcurrency.maxConcurrency"], 10);
  assert.equal(snapshot["modelStream.idleTimeoutMs"], 600_000);

  // get() 口径（逐键回落）与 getAll() 口径（装配回落）在生产默认表上必须逐键相等，
  // 这正是改造前 features.* / logging.level 走字面量、其余走 DefaultConfig 时的分裂点。
  const assembled = assembleConfigSnapshot(ABSENT, defaults) as unknown as Record<string, unknown>;
  for (const key of CONFIG_SNAPSHOT_KEYS) {
    assert.equal(
      pickByPath(assembled, key),
      snapshot[key],
      `${key}: getAll() 结果必须 === get() 结果 === documented default`,
    );
    assert.equal(pickByPath(assembled, key), pickByPath(defaults, key), `${key} 必须等于文档默认值`);
  }

  assert.deepStrictEqual(
    {
      features: FORMERLY_HARDCODED_KEYS.filter((key) => key.startsWith("features.")).map(
        (key) => snapshot[key],
      ),
      level: snapshot["logging.level"],
      skillsEnabled: snapshot["skills.enabled"],
      skillsIncludeInstructions: snapshot["skills.includeInstructions"],
    },
    {
      features: [true, true, true, true, true, true],
      level: "info",
      skillsEnabled: true,
      skillsIncludeInstructions: true,
    },
    "features.* / logging.level / skills.* 的回落必须等于文档默认值（MAIN-03 的一致性由断言保证，不再靠人读源码）",
  );
});
