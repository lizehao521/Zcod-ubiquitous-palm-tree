// 基线快照器：验证 Agent 先拍基线再验改动（hermes M4/M5 的"跳过基线"反模式防线）。
// 输出写入 .hermess-snapshots/baseline-*.json（gitignored），并打印人类可读摘要。
// 用法：node docs/evolution/baseline.mjs snap <名字>   # 记录当前状态
//       node docs/evolution/baseline.mjs diff <名字>   # 与该基线比较，列出真实变化
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { spawnSync } from "node:child_process";

const ROOT = cwd();
const DIR = join(ROOT, ".hermess-snapshots");
const AREAS = [
  "apps/zcode-cli/packages/adapters/src/config",
  "apps/zcode-cli/packages/adapters/src/logging",
  "apps/zcode-cli/packages/adapters/src/exec",
  "apps/zcode-cli/packages/adapters/src/network",
  "apps/zcode-cli/packages/adapters/src/storage",
  "apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows",
  "apps/zcode-cli/packages/adapters/tests",
  "specs",
  "docs/evolution",
];
const SKIP = new Set(["node_modules", ".git", "dist", ".hermess-snapshots"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name)) walk(join(dir, e.name), out);
    else if (e.isFile() && /\.(ts|tsx|mjs|json|md)$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

function fingerprint() {
  const files = {};
  for (const area of AREAS) {
    for (const f of walk(join(ROOT, area))) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      files[rel] = createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
    }
  }
  const verify = spawnSync(process.execPath, ["docs/evolution/verify.mjs"], { cwd: ROOT, encoding: "utf8" });
  const summary = `${verify.stdout ?? ""}`.match(/SUMMARY .*/)?.[0] ?? "SUMMARY 缺失";
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return {
    at: new Date().toISOString(),
    files,
    verify_summary: summary.trim(),
    verify_exit: verify.status,
    git_porcelain: `${status.stdout ?? ""}`.trim().split("\n").filter(Boolean),
  };
}

const cmd = argv[2];
const name = argv[3] ?? "default";
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const path = join(DIR, `baseline-${name}.json`);

if (cmd === "snap") {
  const snap = fingerprint();
  writeFileSync(path, JSON.stringify(snap, null, 2) + "\n");
  stdout.write(`SNAP ${name}: files=${Object.keys(snap.files).length} ${snap.verify_summary}\n`);
  exit(0);
}

if (cmd === "diff") {
  if (!existsSync(path)) {
    stdout.write(`无基线 ${name} —— 先跑 snap，不许跳过基线\n`);
    exit(1);
  }
  const base = JSON.parse(readFileSync(path, "utf8"));
  const now = fingerprint();
  const added = [], changed = [], removed = [];
  for (const [f, h] of Object.entries(now.files)) {
    if (!(f in base.files)) added.push(f);
    else if (base.files[f] !== h) changed.push(f);
  }
  for (const f of Object.keys(base.files)) if (!(f in now.files)) removed.push(f);
  stdout.write(`DIFF vs ${name} (baseline ${base.at})\n`);
  stdout.write(`  新增 ${added.length}\n`);
  for (const f of added) stdout.write(`    + ${f}\n`);
  stdout.write(`  改动 ${changed.length}\n`);
  for (const f of changed) stdout.write(`    ~ ${f}\n`);
  stdout.write(`  删除 ${removed.length}\n`);
  for (const f of removed) stdout.write(`    - ${f}\n`);
  stdout.write(`  基线验证: ${base.verify_summary}\n  当前验证: ${now.verify_summary}\n`);
  if (added.length + changed.length + removed.length === 0) {
    stdout.write("  ⚠ 零改动：所谓修复未落到文件，必须视为未发生\n");
    exit(1);
  }
  exit(0);
}

stdout.write("用法：snap <名字> | diff <名字>\n");
exit(1);
