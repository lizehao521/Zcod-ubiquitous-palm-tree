// Env Config Adapter - Parse the intentionally small ZCODE_* environment surface.
//
// 契约见 specs/runtime-env-config/spec.md §4：数值 key 按 D-B 裁决的**有序**判据短路，
// 非法 env 值一律「忽略该 key + 产出诊断」，由 ConfigPort.getAll() 回落到 contracts DefaultConfig；
// 本层不自建第二份默认值、也不抛错（MAIN-08）。
// 唯一的放行例外是 `network.timeout` 的字面 0 = 显式关闭请求超时（D-B），`maxConcurrency` 的 0 保持非法。

import type { RuntimeConfigPatch } from "@zcode/contracts";

interface EnvConfigOptions {
  prefix?: string;
}

const DEFAULT_PREFIX = "ZCODE_";

// 与 contracts/src/config/index.ts:306 的 DefaultConfig.network.timeout 同源（见 §5.4/MAIN-09 漂移断言）：
// 本层不持有第二份默认值语义，这个名字只用于诊断文案与回落说明，不参与判定。
const DEFAULT_NETWORK_TIMEOUT_MS = 180000;

// 与 contracts/src/config/index.ts:342-344 的 DefaultConfig.toolConcurrency.maxConcurrency 同源：
// getToolConcurrencyConfig 是绕过 ConfigPort 的直读入口，只能复用同一个数字，不能再各写一份。
// 漂移由 adapters/tests/env-config-timeout-zero.test.ts 的源码扫描断言看守（不许改成 import 真实表，
// 那会让本模块失去「仅 import type」的可加载性，gen1 的 21 条 env 用例全部退化成 WARN）。
const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

/**
 * MAIN-07 上界：Node 的 setTimeout 把延时当 32-bit 有符号整数，`> 2_147_483_647` 会打出
 * TimeoutOverflowWarning 并**把延时钳成 1ms**（实测），即"配了个大超时"换来每个请求约 1ms 就失败。
 * 这是有限值路径上的 D1b（Infinity）同一终态，`Number.isFinite` 挡不住它，必须单独判。
 * 上限属于**消费方**（计时器），不是所有数值键的公共属性：`maxConcurrency` 不受这条约束（MAIN-10），
 * 它的合理上界是运营/产品数，本轮不替产品拍板，因此不发明一个数字塞进去。
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 数值键的判据参数：0 是否合法 + 是否有消费方天花板。 */
interface EnvNumberRule {
  readonly allowZero: boolean;
  readonly maxMs: number | undefined;
}

const NETWORK_TIMEOUT_RULE: EnvNumberRule = { allowZero: true, maxMs: MAX_TIMER_DELAY_MS };
const TOOL_CONCURRENCY_RULE: EnvNumberRule = { allowZero: false, maxMs: undefined };

const NETWORK_TIMEOUT_PATH = "network.timeout";
const TOOL_CONCURRENCY_PATH = "toolConcurrency.maxConcurrency";
const LOG_FORMAT_PATH = "logging.format";

const NETWORK_TIMEOUT_FALLBACK = `DefaultConfig.network.timeout (${DEFAULT_NETWORK_TIMEOUT_MS}ms via ConfigPort.getAll)`;
const TOOL_CONCURRENCY_FALLBACK = `DefaultConfig.toolConcurrency.maxConcurrency (${DEFAULT_MAX_TOOL_CONCURRENCY} via ConfigPort.getAll)`;
const LOG_FORMAT_FALLBACK = "text";

/**
 * Diagnostic emitted for an env var that was present but unusable.
 * Field names (code/message/path/severity) mirror `ConfigDiagnostic` in ./schema.js so
 * `logConfigDiagnostics` in config-factory.ts reports it through the same logger channel and
 * structured fields. It is intentionally NOT assignable to `ConfigDiagnostic`:
 * `env_config_invalid` is not a member of `ConfigDiagnosticCode` (file-path-only codes) and
 * this type carries env-specific `envKey/value/reason/fallback` instead of `filePath`.
 */
export interface EnvConfigDiagnostic {
  code: "env_config_invalid";
  /** Full env var name as provided, e.g. `ZCODE_HTTP_TIMEOUT`. */
  envKey: string;
  /** Normalized RuntimeConfigPatch path, e.g. `network.timeout`. */
  path: string;
  /**
   * Raw value; env values here are scalars and carry no credentials.
   * 非字符串输入（MAIN-08 的可达面）以 `String()`/类型名渲染后放入，字段类型仍是 `string`，
   * 避免让 logger 的消费者去做类型分支。
   */
  value: string;
  reason: EnvConfigInvalidReason;
  severity: "warning";
  message: string;
  /** Which default owns the value that now applies. */
  fallback: string;
}

export type EnvConfigInvalidReason =
  | "empty"
  | "invalid_number"
  | "negative"
  | "zero_not_allowed"
  | "too_large"
  | "non_string_value"
  | "unsupported_value"
  /** 主键与别名同时给出且生效值不同：不忽略任何一侧，只说明哪条键被作废（用户裁决 D-B 续）。 */
  | "alias_conflict";

export interface ParsedEnvConfig {
  config: RuntimeConfigPatch;
  diagnostics: EnvConfigDiagnostic[];
}

type EnvNumberResult = { ok: true; value: number } | { ok: false; reason: EnvConfigInvalidReason };

/**
 * D-B 裁决的有序判据（顺序即契约，短路返回；spec §4 有同款表）。
 * `rule.allowZero` 只有 `network.timeout` 为 true：0 = 显式关闭请求超时；
 * `maxConcurrency` 的 0 必须是非法值——`createWorkflowRunSeatGate({ limit: 0 })` 是挂死而不是"关闭并发"，
 * 不许被"统一两个键的规则"顺手抹平。
 */
function parseEnvNumberValue(value: unknown, rule: EnvNumberRule): EnvNumberResult {
  // MAIN-08：process.env 只放字符串，但 config-factory.ts:192 走的是可注入的 options.env，
  // 类型只靠 TS 兜着；非字符串若直接 .trim() 会让本层抛 TypeError，违反"非法输入不得打断启动"。
  // null 保留 `?? ""` 的既有口径（实测落为 empty），不在这次收口的射程内。
  if (value !== null && value !== undefined && typeof value !== "string") {
    return { ok: false, reason: "non_string_value" };
  }
  // Number("") === 0，空值必须挡在转换之前，否则 ZCODE_HTTP_TIMEOUT= 会静默关掉超时（D-B 的决定性陷阱）。
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  // 与文件层 config/schema.ts 的 `.finite()` 对齐：NaN（"30s"、"1,000"）与 ±Infinity 拒绝。
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return { ok: false, reason: "invalid_number" };
  // D-B 第 3 步：负数对两个键都非法，语义单独成 reason，不再和 0 混在 not_positive 里。
  if (num < 0) return { ok: false, reason: "negative" };
  if (num === 0) {
    // 第 4 步：只有字面 0（已排除空串）在 network.timeout 上合法 = 显式关闭；
    // 归一 -0 → 0，避免 store 里出现 -0 这种第二表示（实测 -0 与 0 行为等同，spec §9 已表态）。
    return rule.allowZero ? { ok: true, value: 0 } : { ok: false, reason: "zero_not_allowed" };
  }
  // 第 5 步（MAIN-07）：超过 32-bit 有符号延时的"有限正数"会被 Node 钳成 1ms，必须拒绝而不是放行。
  // 只对挂了计时器的键生效（见 MAX_TIMER_DELAY_MS 的注释）。
  if (rule.maxMs !== undefined && num > rule.maxMs) return { ok: false, reason: "too_large" };
  return { ok: true, value: num };
}

/**
 * Parse ZCODE_* environment variables into config, with diagnostics for rejected values.
 */
export function parseEnvConfigWithDiagnostics(
  env: Record<string, string | undefined> = process.env,
  options: EnvConfigOptions = {},
): ParsedEnvConfig {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const config: RuntimeConfigPatch = {};
  const diagnostics: EnvConfigDiagnostic[] = [];
  // 别名优先级状态（用户裁决 2026-09-28：主键赢、不一致必留痕）。
  // timeoutSource 记当前生效值的来源键，timeoutValue 记该值，用来判断另一侧是否构成冲突。
  let timeoutSource: "primary" | "alias" | undefined;
  let timeoutValue: number | undefined;
  const ZCODE_HTTP_TIMEOUT_KEY = `${prefix}HTTP_TIMEOUT`;
  const ZCODE_TIMEOUT_KEY = `${prefix}TIMEOUT`;
  void ZCODE_TIMEOUT_KEY; // 别名键仅用于诊断文案的对侧引用，先占位避免未使用告警
  const timeoutKeyOf = (source: "primary" | "alias"): string =>
    source === "primary" ? ZCODE_HTTP_TIMEOUT_KEY : ZCODE_TIMEOUT_KEY;
  // 冲突诊断不改写生效值，只说明哪条键被作废：静默丢弃会让"超时被关掉"无人知晓。
  const timeoutConflictDiagnostic = (
    winningKey: string,
    winningValue: number,
    losingKey: string,
    losingValue: number,
  ): EnvConfigDiagnostic => ({
    code: "env_config_invalid",
    envKey: losingKey,
    path: NETWORK_TIMEOUT_PATH,
    value: renderEnvValue(losingValue),
    reason: "alias_conflict",
    severity: "warning",
    message: `${losingKey}="${losingValue}" is ignored for ${NETWORK_TIMEOUT_PATH}: ${winningKey}="${winningValue}" wins (primary key takes precedence over its alias).`,
    fallback: `${winningKey}=${winningValue}`,
  });

  for (const [key, value] of Object.entries(env ?? {})) {
    if (!key.startsWith(prefix) || value === undefined) continue;

    const configKey = key.slice(prefix.length);
    // Storage config
    if (configKey === "STORAGE_DIR") {
      if (!config.storage) config.storage = {};
      config.storage.dir = value;
    } else if (configKey === "SESSION_DB_PATH" || configKey === "SESSION_DB") {
      if (!config.storage) config.storage = {};
      config.storage.sessionDbPath = value;
    }

    // Network config
    else if (configKey === "HTTP_PROXY") {
      if (!config.network) config.network = {};
      config.network.httpProxy = value;
    } else if (configKey === "NO_PROXY") {
      if (!config.network) config.network = {};
      config.network.noProxy = value;
    } else if (configKey === "AGENT_CA_CERT") {
      if (!config.network) config.network = {};
      config.network.caCertFile = value;
    } else if (configKey === "HTTP_TIMEOUT" || configKey === "TIMEOUT") {
      // 用户裁决（2026-09-28）：主键 ZCODE_HTTP_TIMEOUT 优先于别名 ZCODE_TIMEOUT，且两者不一致时必须留痕。
      // 原实现是"Object.entries 插入序后来者写胜"，于是 ZCODE_TIMEOUT=0 能在用户写出 9000 之后
      // 静默把超时关掉（= 不设防），那正是 D1 的终态换了一道门；只靠文档说明不解决"谁赢"不可陈述的问题。
      const isPrimaryKey = configKey === "HTTP_TIMEOUT";
      const parsed = parseEnvNumberValue(value, NETWORK_TIMEOUT_RULE);
      if (!parsed.ok) {
        // 非法值必须"缺席"而不是取某个数，缺席才会让 ConfigPort.getAll() 回落默认超时。
        // 非法的一侧绝不覆盖另一侧已生效的合法值；唯一放行的"看起来非法"是字面 0（D-B，走 ok 分支）。
        diagnostics.push(
          invalidEnvDiagnostic(key, NETWORK_TIMEOUT_PATH, value, parsed.reason, NETWORK_TIMEOUT_FALLBACK),
        );
      } else if (isPrimaryKey) {
        // TS 不会把 "timeoutSource 已定义" 与 "timeoutValue 已定义" 关联起来，
        // 所以这里显式收窄成局部常量，避免把 number|undefined 传进诊断签名。
        const currentValue = timeoutValue;
        if (timeoutSource !== undefined && currentValue !== undefined && currentValue !== parsed.value) {
          diagnostics.push(timeoutConflictDiagnostic(key, parsed.value, timeoutKeyOf(timeoutSource), currentValue));
        }
        if (!config.network) config.network = {};
        config.network.timeout = parsed.value;
        timeoutSource = "primary";
        timeoutValue = parsed.value;
      } else if (timeoutSource === undefined) {
        // 只给了别名：别名可用，但要在诊断里标明生效来源是别名。
        if (!config.network) config.network = {};
        config.network.timeout = parsed.value;
        timeoutSource = "alias";
        timeoutValue = parsed.value;
      } else if (timeoutValue !== undefined && timeoutValue !== parsed.value) {
        diagnostics.push(timeoutConflictDiagnostic(ZCODE_HTTP_TIMEOUT_KEY, timeoutValue, key, parsed.value));
      }
    }

    // Logging config
    else if (configKey === "LOG_FORMAT") {
      // MAIN-08：normalizeLogFormat/isSupportedLogFormat 都调 .toLowerCase()，
      // 实测注入 null/number/boolean/object 时本层直接抛 TypeError，同样要收进类型化诊断。
      // 与数值键不同：这里不写 "text"，让 key 整体缺席，避免为一坨垃圾输入造出 Env 覆盖层。
      if (value === null || typeof value !== "string") {
        diagnostics.push(
          invalidEnvDiagnostic(key, LOG_FORMAT_PATH, value, "non_string_value", LOG_FORMAT_FALLBACK),
        );
      } else {
        if (!config.logging) config.logging = {};
        config.logging.format = normalizeLogFormat(value);
        if (!isSupportedLogFormat(value)) {
          // 值语义保持现状（不改变 Env 覆盖项目配置的既有行为），但要让降级可见，不再静默。
          diagnostics.push(
            invalidEnvDiagnostic(key, LOG_FORMAT_PATH, value, "unsupported_value", LOG_FORMAT_FALLBACK),
          );
        }
      }
    }

    // Tool Concurrency config
    else if (configKey === "MAX_TOOL_CONCURRENCY") {
      // allowZero=false：0 会被 core/src/tool/scheduler.ts:56 的 `??` 当合法值写进并发上界，
      // 再被 bootstrap/src/app/dynamic-workflow-run-launch.ts:163 的 seatGate({limit:0}) 挂死。
      const parsed = parseEnvNumberValue(value, TOOL_CONCURRENCY_RULE);
      if (parsed.ok) {
        if (!config.toolConcurrency) config.toolConcurrency = {};
        config.toolConcurrency.maxConcurrency = parsed.value;
      } else {
        // 同理：maxConcurrency=0 会让 scheduler 的并发判据恒真，把并行工具串行化甚至饿死。
        diagnostics.push(
          invalidEnvDiagnostic(
            key,
            TOOL_CONCURRENCY_PATH,
            value,
            parsed.reason,
            TOOL_CONCURRENCY_FALLBACK,
          ),
        );
      }
    }
  }

  return { config, diagnostics };
}

/**
 * Parse ZCODE_* environment variables into config.
 * Compatibility entry point: signature is unchanged so existing callers
 * (`config-factory.ts`) keep compiling. Use `parseEnvConfigWithDiagnostics` when the
 * rejected-value report is needed.
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  options: EnvConfigOptions = {},
): RuntimeConfigPatch {
  return parseEnvConfigWithDiagnostics(env, options).config;
}

/**
 * Get tool concurrency config from environment.
 * Direct reader without a diagnostic channel; `ConfigPort` owns the default, so this entry
 * point is expected to be consolidated into it.
 */
export function getToolConcurrencyConfig(
  env: Record<string, string | undefined> = process.env,
): { maxConcurrency: number } {
  const raw = (env ?? {}).ZCODE_MAX_TOOL_CONCURRENCY;
  if (raw === undefined) return { maxConcurrency: DEFAULT_MAX_TOOL_CONCURRENCY };
  // allowZero=false 与 MAX_TOOL_CONCURRENCY 的 env 分支同判据：这个直读入口不许比 ConfigPort 更宽。
  const parsed = parseEnvNumberValue(raw, TOOL_CONCURRENCY_RULE);
  // 非法值回落到与 DefaultConfig 同一个默认值，而不是 0（0 等于取消并发上界语义）。
  return { maxConcurrency: parsed.ok ? parsed.value : DEFAULT_MAX_TOOL_CONCURRENCY };
}

// ============================================================
// Helpers
// ============================================================

function isSupportedLogFormat(value: string): boolean {
  const format = value.toLowerCase();
  return format === "text" || format === "json";
}

function invalidEnvDiagnostic(
  envKey: string,
  path: string,
  value: unknown,
  reason: EnvConfigInvalidReason,
  fallback: string,
): EnvConfigDiagnostic {
  const rendered = renderEnvValue(value);
  return {
    code: "env_config_invalid",
    envKey,
    path,
    value: rendered,
    reason,
    severity: "warning",
    message: `${envKey}="${rendered}" is not a usable value for ${path}; ignoring it and using ${fallback}.`,
    fallback,
  };
}

/** 非字符串输入不能拼进模板就完事：对象渲染成类型名，既稳定又不泄露内容（Symbol 也不能隐式转字符串）。 */
function renderEnvValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return Array.isArray(value) ? "array" : "object";
  return String(value);
}

function normalizeLogFormat(value: string): "text" | "json" {
  const format = value.toLowerCase();
  if (format === "text" || format === "json") {
    return format;
  }
  return "text";
}
