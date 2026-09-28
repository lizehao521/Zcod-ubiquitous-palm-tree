// ============================================================
// 配置快照的唯一默认值回落点：键清单 + 键→默认值路径 + ?? 回落 + 快照装配
//
// 拆出原因（gen4 / stage-2 T-缝2 / MAIN-03）：同一个 key→默认值映射原先在
// config/index.ts 里写了三遍——`getDefaultValue()` 的 40 路 switch、`getAll()` 的逐字段
// `?? DefaultConfig.x`、`merge()` 里 `?? DefaultConfig.modelAnomalyGuard` / `?? DefaultConfig.hooks`；
// 而且 `getAll()` 对 features.*（6 个键）、skills.enabled、skills.includeInstructions、
// logging.level 用的是硬编码字面量 `?? true` / `?? "info"`，等于第二条会自己漂移的回落路径。
// 今天这些字面量与 contracts 的默认值恰好相等（主代理已核对），所以危害是漂移风险而不是错值，
// 但「一处修改、统一维护」是 CLI AGENTS.md 的成文要求，根 AGENTS.md 也禁止多条写入路径。
//
// 本模块零运行时外部依赖（只有 `import type`，会被 Node type-stripping 整句擦除），
// 默认值对象以参数注入，因此可被 `node --test` 直接加载并证明「回落只有一处」。
// ============================================================

import type { RuntimeConfig } from "@zcode/contracts";

/**
 * 注入的默认值表：生产传 contracts 的 `DefaultRuntimeConfig`，测试传形状相同的字面量。
 * 显式并入 `RuntimeConfig`：它是有命名属性的接口、没有字符串索引签名，
 * 不能隐式赋给 `Record<string, unknown>`（apps/zcode-cli 的 build 以 TS2345 拒掉过）。
 * 遍历本身只把入参当 unknown 逐级取值，因此放宽类型不改变任何运行时行为。
 */
export type ConfigDefaults = Record<string, unknown> | RuntimeConfig;

/** 已存值读取器：返回 undefined 表示该键在此 scope 缺席（与「显式 0 / false / 空串」严格区分）。 */
export type ConfigLookup = (key: string) => unknown;

/**
 * 快照键清单的唯一所有者：`ConfigPort.getAll()` 输出哪些键、`get()`/`has()` 对哪些键有默认值，
 * 都由这张表决定。键就是 `ConfigKey` 的点号字符串值（contracts/src/config/index.ts:12-82），
 * 顺序保持与改造前 `getAll()` 的字面量一致，避免任何可读性/序列化差异。
 */
export const CONFIG_SNAPSHOT_KEYS: readonly string[] = [
  "modelStream.idleTimeoutMs",
  "permission.mode",
  "permission.allowedTools",
  "permission.disallowedTools",
  "permission.autoApproveHighRisk",
  "permission.allowMediumRiskInAuto",
  "storage.dir",
  "storage.sessionDbPath",
  "network.httpProxy",
  "network.noProxy",
  "network.caCertFile",
  "network.timeout",
  "features.compact",
  "features.rewind",
  "features.subagent",
  "features.memory",
  "features.skill",
  "features.mcp",
  "memory.use",
  "mcp.servers",
  "plugins.enabled",
  "plugins.dirs",
  "plugins.enabledPlugins",
  "plugins.extraKnownMarketplaces",
  "plugins.options",
  "plugins.suppressedBuiltins",
  "skills.enabled",
  "skills.includeInstructions",
  "skills.metadataBudget",
  "skills.roots",
  "skill",
  "command",
  "logging.level",
  "logging.format",
  "toolConcurrency.maxConcurrency",
  "modelAnomalyGuard",
  "hooks",
  "ui.locale",
  "ui.theme",
];

/**
 * 默认值路径与键名不同的两个例外：`ConfigKey.SkillOverrides === "skill"`，
 * 但在 `RuntimeConfig` 里落在 `skillOverrides`（命令覆盖同理）。
 * 改造前 `getDefaultValue()` 的 switch 根本没有这两个 case，所以 `get("skill")` 会抛
 * 「Config key not found」，而 `getAll()` 却回落成 `{}`——本表把这条不一致一并收成一处；
 * 实测本检出内没有任何调用方使用 `get`/`has` 读这两个键（消费方只读 `getAll()` 结果）。
 */
const CONFIG_PATH_OVERRIDES: Readonly<Record<string, string>> = {
  skill: "skillOverrides",
  command: "commandOverrides",
};

/** 点号路径分隔符（键与默认值表的层级都用它）。 */
const PATH_SEPARATOR = ".";

/** 键在默认值表中的路径。 */
export function defaultPathOf(key: string): string {
  return CONFIG_PATH_OVERRIDES[key] ?? key;
}

/**
 * 读取某个键的 documented default；默认值表里没有该路径时返回 undefined，
 * 表示「该键没有默认值」——调用方据此决定 `get()` 抛错、`has()` 返回 false（与改造前一致）。
 */
export function documentedDefaultOf(defaults: ConfigDefaults, key: string): unknown {
  let cursor: unknown = defaults;
  for (const segment of defaultPathOf(key).split(PATH_SEPARATOR)) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/**
 * 唯一的回落表达式。`??` 语义在此显式写成 `=== undefined`：
 * 只把「缺席」当缺省，显式 0 / false / 空串都是已存值（specs/runtime-env-config §9 的口径）。
 */
export function resolveConfigValue(
  key: string,
  lookup: ConfigLookup,
  defaults: ConfigDefaults,
): unknown {
  const stored = lookup(key);
  return stored === undefined ? documentedDefaultOf(defaults, key) : stored;
}

/** 扁平快照：键 → 终值（已存值优先，缺省走唯一的回落表达式）。 */
export function resolveSnapshot(
  lookup: ConfigLookup,
  defaults: ConfigDefaults,
  keys: readonly string[] = CONFIG_SNAPSHOT_KEYS,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) snapshot[key] = resolveConfigValue(key, lookup, defaults);
  return snapshot;
}

/**
 * 装配成 `RuntimeConfig` 形状：结构由键的点号路径生成，因此新增键只需要动
 * `CONFIG_SNAPSHOT_KEYS`（必要时加一条路径覆盖），不可能再出现「装配处另写一份字面量缺省」。
 */
export function assembleConfigSnapshot(
  lookup: ConfigLookup,
  defaults: ConfigDefaults,
): RuntimeConfig {
  const snapshot: Record<string, unknown> = {};
  for (const key of CONFIG_SNAPSHOT_KEYS) {
    assignAtPath(snapshot, defaultPathOf(key).split(PATH_SEPARATOR), resolveConfigValue(key, lookup, defaults));
  }
  return snapshot as unknown as RuntimeConfig;
}

function assignAtPath(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = cursor[segment];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
      continue;
    }
    const created: Record<string, unknown> = {};
    cursor[segment] = created;
    cursor = created;
  }
  cursor[segments[segments.length - 1] as string] = value;
}
