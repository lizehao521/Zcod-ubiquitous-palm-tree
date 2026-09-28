// Config Port Implementation - Scoped configuration with change notification

import {
  ConfigKey,
  type ConfigValue,
  type ConfigSource,
  type RuntimeConfig,
  type RuntimeConfigPatch,
  type Unsubscribe,
  type ConfigObserver,
  type ConfigPort,
  ConfigScope,
  DefaultRuntimeConfig as DefaultConfig,
} from "@zcode/contracts";
// 键清单、默认值路径与 ?? 回落统一由 resolve-snapshot.ts 持有（本文件不再各写一份）。
import {
  assembleConfigSnapshot,
  documentedDefaultOf,
  resolveConfigValue,
  type ConfigLookup,
} from "./resolve-snapshot.js";

type Handler<K extends ConfigKey> = (value: ConfigValue<K>, prev: ConfigValue<K>) => void;
type AllHandler = (key: ConfigKey, value: unknown, prev: unknown) => void;

// ============================================================
// Config Store - Internal state
// ============================================================

interface ConfigEntry {
  value: unknown;
  sources: ConfigSource[];
}

class ConfigStore {
  private store = new Map<ConfigKey, ConfigEntry>();
  private observers: Map<ConfigKey, Set<Handler<any>>> = new Map();
  private allHandlers: Set<AllHandler> = new Set();

  constructor(initial?: RuntimeConfigPatch) {
    if (initial) {
      this.merge(initial, ConfigScope.System);
    }
  }

  get<K extends ConfigKey>(key: K): ConfigValue<K> | undefined {
    const entry = this.store.get(key);
    return entry?.value as ConfigValue<K>;
  }

  /**
   * 暴露成快照解析器需要的读取器：只回答「已存值或 undefined」，不掺任何缺省逻辑，
   * 回落由 resolve-snapshot.ts 单点负责，避免这里长成第二条回落路径。
   */
  lookup(): ConfigLookup {
    return (key: string) => this.get(key as ConfigKey);
  }

  has(key: ConfigKey): boolean {
    return this.store.has(key);
  }

  set<K extends ConfigKey>(
    key: K,
    value: ConfigValue<K>,
    scope: ConfigScope,
    source?: string,
  ): void {
    const prev = this.get(key);
    const entry: ConfigEntry = {
      value,
      sources: [{ scope, key, value, path: source }],
    };
    this.store.set(key, entry);

    // Notify observers
    const handlers = this.observers.get(key);
    if (handlers) {
      handlers.forEach((handler) => handler(value, prev as ConfigValue<K>));
    }

    // Notify all-handlers
    this.allHandlers.forEach((handler) => handler(key, value, prev));
  }

  getSources(key: ConfigKey): ConfigSource[] {
    const entry = this.store.get(key);
    return entry?.sources ?? [];
  }

  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    if (config.modelStream?.idleTimeoutMs !== undefined) {
      this.set(ConfigKey.ModelStreamIdleTimeout, config.modelStream.idleTimeoutMs, scope);
    }
    if (config.permission) {
      if (config.permission.mode) this.set(ConfigKey.PermissionMode, config.permission.mode, scope);
      if (config.permission.allowedTools)
        this.set(ConfigKey.PermissionAllowedTools, config.permission.allowedTools, scope);
      if (config.permission.disallowedTools)
        this.set(ConfigKey.PermissionDisallowedTools, config.permission.disallowedTools, scope);
      if (config.permission.autoApproveHighRisk !== undefined) {
        this.set(
          ConfigKey.PermissionAutoApproveHighRisk,
          config.permission.autoApproveHighRisk,
          scope,
        );
      }
      if (config.permission.allowMediumRiskInAuto !== undefined) {
        this.set(
          ConfigKey.PermissionAllowMediumRiskInAuto,
          config.permission.allowMediumRiskInAuto,
          scope,
        );
      }
    }
    if (config.storage) {
      if (config.storage.dir) this.set(ConfigKey.StorageDir, config.storage.dir, scope);
      if (config.storage.sessionDbPath)
        this.set(ConfigKey.StorageSessionDbPath, config.storage.sessionDbPath, scope);
    }
    if (config.network) {
      if (config.network.httpProxy !== undefined)
        this.set(ConfigKey.HttpProxy, config.network.httpProxy, scope);
      if (config.network.noProxy !== undefined)
        this.set(ConfigKey.NoProxy, config.network.noProxy, scope);
      if (config.network.caCertFile !== undefined)
        this.set(ConfigKey.CaCertFile, config.network.caCertFile, scope);
      if (config.network.timeout !== undefined)
        this.set(ConfigKey.HttpTimeout, config.network.timeout, scope);
    }
    if (config.features) {
      if (config.features.compact !== undefined)
        this.set(ConfigKey.FeatureCompact, config.features.compact, scope);
      if (config.features.rewind !== undefined)
        this.set(ConfigKey.FeatureRewind, config.features.rewind, scope);
      if (config.features.subagent !== undefined)
        this.set(ConfigKey.FeatureSubagent, config.features.subagent, scope);
      if (config.features.memory !== undefined)
        this.set(ConfigKey.FeatureMemory, config.features.memory, scope);
      if (config.features.skill !== undefined)
        this.set(ConfigKey.FeatureSkill, config.features.skill, scope);
      if (config.features.mcp !== undefined)
        this.set(ConfigKey.FeatureMcp, config.features.mcp, scope);
    }
    if (config.memory) {
      if (config.memory.use !== undefined) this.set(ConfigKey.MemoryUse, config.memory.use, scope);
    }
    if (config.mcp) {
      if (config.mcp.servers !== undefined)
        this.set(ConfigKey.McpServers, config.mcp.servers, scope);
    }
    if (config.plugins) {
      if (config.plugins.enabled !== undefined)
        this.set(ConfigKey.PluginsEnabled, config.plugins.enabled, scope);
      if (config.plugins.dirs !== undefined)
        this.set(ConfigKey.PluginsDirs, config.plugins.dirs, scope);
      if (config.plugins.enabledPlugins !== undefined) {
        this.set(ConfigKey.PluginsEnabledPlugins, config.plugins.enabledPlugins, scope);
      }
      if (config.plugins.extraKnownMarketplaces !== undefined) {
        this.set(
          ConfigKey.PluginsExtraKnownMarketplaces,
          config.plugins.extraKnownMarketplaces,
          scope,
        );
      }
      if (config.plugins.options !== undefined) {
        this.set(ConfigKey.PluginsOptions, config.plugins.options, scope);
      }
      if (config.plugins.suppressedBuiltins !== undefined) {
        this.set(ConfigKey.PluginsSuppressedBuiltins, config.plugins.suppressedBuiltins, scope);
      }
    }
    if (config.skills) {
      if (config.skills.enabled !== undefined)
        this.set(ConfigKey.SkillsEnabled, config.skills.enabled, scope);
      if (config.skills.includeInstructions !== undefined) {
        this.set(ConfigKey.SkillsIncludeInstructions, config.skills.includeInstructions, scope);
      }
      if (config.skills.metadataBudget !== undefined) {
        this.set(ConfigKey.SkillsMetadataBudget, config.skills.metadataBudget, scope);
      }
      if (config.skills.roots !== undefined)
        this.set(ConfigKey.SkillsRoots, config.skills.roots, scope);
    }
    if (config.skillOverrides !== undefined) {
      this.set(ConfigKey.SkillOverrides, config.skillOverrides, scope);
    }
    if (config.commandOverrides !== undefined) {
      this.set(ConfigKey.CommandOverrides, config.commandOverrides, scope);
    }
    if (config.logging) {
      if (config.logging.level) this.set(ConfigKey.LogLevel, config.logging.level, scope);
      if (config.logging.format !== undefined)
        this.set(ConfigKey.LogFormat, config.logging.format, scope);
    }
    if (config.toolConcurrency) {
      if (config.toolConcurrency.maxConcurrency !== undefined)
        this.set(ConfigKey.ToolConcurrencyMax, config.toolConcurrency.maxConcurrency, scope);
    }
    if (config.modelAnomalyGuard) {
      // 深合并的缺省同样走唯一回落点（原先这里另写了一份 `?? DefaultConfig.modelAnomalyGuard`）。
      const previous = resolveConfigValue(
        ConfigKey.ModelAnomalyGuard,
        this.lookup(),
        DefaultConfig,
      ) as RuntimeConfig["modelAnomalyGuard"];
      this.set(
        ConfigKey.ModelAnomalyGuard,
        {
          ...previous,
          ...config.modelAnomalyGuard,
        },
        scope,
      );
    }
    if (config.hooks) {
      const previous = resolveConfigValue(ConfigKey.Hooks, this.lookup(), DefaultConfig) as RuntimeConfig["hooks"];
      this.set(
        ConfigKey.Hooks,
        {
          ...previous,
          ...config.hooks,
          events: config.hooks.events ?? previous.events,
        },
        scope,
      );
    }
    if (config.ui?.locale !== undefined) {
      this.set(ConfigKey.UiLocale, config.ui.locale, scope);
    }
    if (config.ui?.theme !== undefined) {
      this.set(ConfigKey.UiTheme, config.ui.theme, scope);
    }
  }

  subscribe<K extends ConfigKey>(key: K, handler: Handler<K>): Unsubscribe {
    if (!this.observers.has(key)) {
      this.observers.set(key, new Set());
    }
    this.observers.get(key)!.add(handler);

    return () => {
      this.observers.get(key)?.delete(handler);
    };
  }

  subscribeAll(handler: AllHandler): Unsubscribe {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }
}

// ============================================================
// Config Port Implementation
// ============================================================

export class ConfigPortImpl implements ConfigPort {
  private store: ConfigStore;

  constructor(initial?: RuntimeConfigPatch) {
    this.store = new ConfigStore(initial ?? DefaultConfig);
  }

  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    // 回落只有一处（resolveConfigValue）；本方法不再自己 switch 一遍默认值。
    const value = resolveConfigValue(key, this.store.lookup(), DefaultConfig) as
      | ConfigValue<K>
      | undefined;
    if (value !== undefined) return value;

    throw new Error(`Config key not found: ${key}`);
  }

  getAll(): RuntimeConfig {
    // 快照形状与缺省全部来自 resolve-snapshot.ts 的键清单：
    // 原实现在这里逐字段写 `?? DefaultConfig.x`，并对 features.* / skills.enabled /
    // logging.level 硬编码 `?? true` / `?? "info"`（MAIN-03 的第二条回落路径）。
    return assembleConfigSnapshot(this.store.lookup(), DefaultConfig);
  }

  has(key: ConfigKey): boolean {
    return this.store.has(key) || documentedDefaultOf(DefaultConfig, key) !== undefined;
  }

  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    // Runtime changes are always session scope
    this.store.set(key, value, ConfigScope.Session);
  }

  observe(): ConfigObserver {
    return {
      subscribe: <K extends ConfigKey>(key: K, handler: Handler<K>) =>
        this.store.subscribe(key, handler),
      subscribeAll: (handler: AllHandler) => this.store.subscribeAll(handler),
    };
  }

  getSources(key: ConfigKey): ConfigSource[] {
    return this.store.getSources(key);
  }

  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    this.store.merge(config, scope);
  }
}

// ============================================================
// Helpers
// ============================================================

// 原本的 getDefaultValue()/hasDefaultValue() 是一张 40 路 switch 的 key→默认值表，
// 与 getAll() 的逐字段回落、merge() 的两处 ?? DefaultConfig 是同一份映射写三遍
// （违反根 AGENTS.md「避免重复状态和多条写入路径」）。现在统一由
// resolve-snapshot.ts 的 CONFIG_SNAPSHOT_KEYS + resolveConfigValue() 单点持有。

// ============================================================
// Factory
// ============================================================

export function createConfigPort(initial?: RuntimeConfigPatch): ConfigPort {
  return new ConfigPortImpl(initial);
}

// Re-export adapters and factory
export {
  loadFileConfig,
  getDefaultConfigPath,
  hasDefaultConfigFile,
  resolvePath,
  updatePluginEnabledInFileConfig,
  enablePluginsByDefaultInFileConfig,
  removePluginEnabledFromFileConfig,
  updatePluginOptionsInFileConfig,
  removePluginFromFileConfig,
  addSuppressedBuiltinInFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updateUiLocaleInFileConfig,
  type PluginEnabledPatchResult,
  type PluginOptionsPatchResult,
  type PluginRemovePatchResult,
  type SuppressedBuiltinPatchResult,
  type UiLocalePatchResult,
} from "./file-config.adapter.js";
// 补齐诊断入口的桶导出：只导出兼容名会让包外消费者拿不到 parseEnvConfigWithDiagnostics，
// 无法观测「非法 env 被忽略」这条降级。
export {
  getToolConcurrencyConfig,
  parseEnvConfig,
  parseEnvConfigWithDiagnostics,
  type EnvConfigDiagnostic,
  type EnvConfigInvalidReason,
  type ParsedEnvConfig,
} from "./env-config.adapter.js";
export { ZCodeConfigFileSchema, type ZCodeConfigFile } from "./schema.js";
export { mergeConfigs, createPrioritizedConfig, getScopePriority } from "./config-merger.js";
export {
  createConfig,
  resolveWorkspaceStorageDir,
  type ConfigFactoryOptions,
  type ConfigResult,
} from "./config-factory.js";
