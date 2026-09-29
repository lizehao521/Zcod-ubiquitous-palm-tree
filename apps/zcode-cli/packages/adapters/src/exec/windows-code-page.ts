// ============================================================
// Windows 活动代码页解析（纯决策 + 注入执行器）
//
// 拆成独立模块的原因：`outputEncoding.ts` value-import 了 `iconv-lite`，在裁剪检出里
// `node --test` 无法加载它（ERR_MODULE_NOT_FOUND）。本模块**零运行时 import**
// （只有会被整句擦除的类型），iconv 的编码存在性判定与 `chcp` 命令执行都由调用方注入，
// 因此「无跨 run 缓存」「非阻塞」这类语义可被 node --test 直接证明。
// 语义与验收场景见 `specs/windows-code-page/spec.md`。
// ============================================================

/** Windows UTF-8 活动代码页；命中它就不再是 legacy 编码。 */
export const WINDOWS_UTF8_CODE_PAGE = "65001";
/** iconv 的代码页编码命名前缀。 */
export const CODE_PAGE_ENCODING_PREFIX = "cp";
/** iconv 使用的 UTF-8 编码名。 */
export const UTF8_ENCODING = "utf8";
/** chcp 输出形如 `Active code page: 936`；只接受 3–5 位数字，避免匹配到无关文本。 */
const CODE_PAGE_PATTERN = /(\d{3,5})/;

export type WindowsCodePageProbeInput = {
  comSpec: string;
  env: NodeJS.ProcessEnv;
};

/** 注入的命令执行器：返回 `chcp` 的 stdout；失败时 reject（由本模块归一为 null）。 */
export type WindowsCodePageProbe = (input: WindowsCodePageProbeInput) => Promise<string>;

export type EncodingExistsPredicate = (encoding: string) => boolean;

export interface WindowsCodePageDeps {
  env: NodeJS.ProcessEnv;
  comSpec: string;
  probe: WindowsCodePageProbe;
  encodingExists: EncodingExistsPredicate;
  /** 观测口：`chcp` 失败被降级为回退之前先交出来，供调用方记日志；不改变返回值语义。 */
  observeFailure?: (error: unknown) => void;
}

/**
 * 每次 run 的完整决策链（覆盖 env → 活动代码页 → locale 回退），纯逻辑、依赖全注入。
 * 放在本模块是为了让 spec §5 的验收场景（含「不 spawn」「回退」「无缓存」）都能被
 * `node --test` 加载执行；`outputEncoding.ts` 只负责提供 env/iconv/child_process 这些真实依赖。
 */
export interface WindowsOutputEncodingDeps extends WindowsCodePageDeps {
  /** 调用方按 Windows 大小写不敏感规则读出的 `ZCODE_WINDOWS_OUTPUT_ENCODING` 原始值。 */
  overrideEncoding: string | undefined;
  /**
   * locale legacy 回退值。故意做成**惰性函数**：覆盖 env 命中或代码页已可用时不该付
   * `Intl.DateTimeFormat().resolvedOptions()` 的开销，保持与旧实现相同的求值顺序。
   */
  localeLegacyEncoding: () => string;
}

/** 从 `chcp` 输出取出活动代码页号；无数字则 null（调用方据此回退，不抛错）。 */
export function parseActiveCodePage(chcpStdout: string): string | null {
  return chcpStdout.match(CODE_PAGE_PATTERN)?.[1] ?? null;
}

/** 代码页号 → iconv 编码名；65001 走 utf8，未知/不存在代码页返回 null。 */
export function codePageToEncoding(
  codePage: string,
  encodingExists: EncodingExistsPredicate,
): string | null {
  if (codePage === WINDOWS_UTF8_CODE_PAGE) return UTF8_ENCODING;
  const encoding = `${CODE_PAGE_ENCODING_PREFIX}${codePage}`;
  return encodingExists(encoding) ? encoding : null;
}

/** 纯解析入口：把 `chcp` 文本（或 null，表示读取失败）映射为 legacy 编码或 null。 */
export function resolveCodePage(
  chcpStdout: string | null,
  deps: { encodingExists: EncodingExistsPredicate },
): string | null {
  if (chcpStdout === null) return null;
  const codePage = parseActiveCodePage(chcpStdout);
  if (!codePage) return null;
  return codePageToEncoding(codePage, deps.encodingExists);
}

/**
 * 读取当前活动代码页。每次调用都真的跑一次 `chcp`：**故意不做跨 run 缓存**——
 * 它测的是活控制台状态，用户中途 `chcp 65001` 就会变，而 env 指纹感知不到（spec §3）。
 * 永不 reject：命令缺失/超时/输出无法解析都归一为 null，让上层走 locale 回退。
 */
export async function readWindowsActiveCodePageEncoding(
  deps: WindowsCodePageDeps,
): Promise<string | null> {
  try {
    const stdout = await deps.probe({ comSpec: deps.comSpec, env: deps.env });
    return resolveCodePage(stdout, { encodingExists: deps.encodingExists });
  } catch (error) {
    deps.observeFailure?.(error);
    return null;
  }
}

/**
 * 每次 run 的编码决策链。顺序与旧同步实现逐字一致：
 * 覆盖 env（写了不存在的编码 → 直接 null，不再回退）→ 活动代码页（`utf8` 不算 legacy）→ locale 回退。
 * 无缓存：`chcp` 测的是会被 `chcp 65001` 当场改掉的活控制台状态，env 快照覆盖不到（spec §3）。
 */
export async function resolveWindowsOutputEncoding(
  deps: WindowsOutputEncodingDeps,
): Promise<string | null> {
  const override = deps.overrideEncoding?.trim();
  if (override) {
    return deps.encodingExists(override) ? override : null;
  }
  const activeEncoding = await readWindowsActiveCodePageEncoding(deps);
  if (activeEncoding && activeEncoding !== UTF8_ENCODING) {
    return activeEncoding;
  }
  return deps.localeLegacyEncoding();
}
