// Hermes 进化闭环唯一验收器（主代理持有所有权）。
// 零依赖：只用 node 内置模块 + Node 24 原生类型擦除跑 node:test。
// 子代理不得修改本文件来让结果变绿；判据在 docs/evolution/review-checklist.md。
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { argv, exit, stdout } from "node:process";

const ROOT = process.cwd();
const SEARCH_ROOTS = ["apps/zcode-cli/packages", "."];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".hermess-snapshots"]);
const TEST_SUFFIXES = [".test.ts", ".test.mjs", ".test.js"];

function isTestFile(name) {
  return TEST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && isTestFile(entry.name)) {
      const full = join(dir, entry.name);
      if (!out.includes(full)) out.push(full);
    }
  }
  return out;
}

function collectTestFiles() {
  const found = [];
  for (const root of SEARCH_ROOTS) {
    walk(join(ROOT, root), found);
  }
  return found.sort();
}

function runOne(file) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const pass = Number(text.match(/^#\s*pass\s+(\d+)$/mu)?.[1] ?? NaN);
  const failed = Number(text.match(/^#\s*fail\s+(\d+)$/mu)?.[1] ?? NaN);
  const loadBroken = /ERR_MODULE_NOT_FOUND|Cannot find module|Unknown file extension/.test(text);
  return {
    file: relative(ROOT, file).replace(/\\/g, "/"),
    exitCode: result.status ?? 1,
    pass: Number.isFinite(pass) ? pass : 0,
    fail: Number.isFinite(failed) ? failed : 0,
    // skip/todo 也算"执行过的绿灯"是假象：用例根本没跑。必须单列成 WARN，
    // 否则一个 30 例里 29 例被 skip 的文件会报成 PASS 30/30 之外的漂亮数字。
    skipped: Number(text.match(/^#\s*skipped\s+(\d+)$/mu)?.[1] ?? 0),
    todo: Number(text.match(/^#\s*todo\s+(\d+)$/mu)?.[1] ?? 0),
    loadBroken,
    unparseable: !Number.isFinite(pass) || !Number.isFinite(failed),
    output: text,
  };
}

function classify(row) {
  // 模块根本加载不了（缺第三方依赖）≠ 断言失败：记 WARN（未验证），不许算成 FAIL 也不算成 PASS。
  if (row.loadBroken && row.pass === 0) return "WARN";
  if (row.fail > 0 || (row.exitCode !== 0 && !row.loadBroken)) return "FAIL";
  if (row.unparseable && row.exitCode !== 0) return "FAIL";
  // 有未执行的用例时，整份文件不许算 PASS：判据要求"跑过"而不是"没红"。
  if (row.skipped > 0 || row.todo > 0) return "WARN";
  if (row.pass === 0) return "WARN";
  return "PASS";
}

const files = collectTestFiles();
const rows = files.map(runOne);
const counts = { PASS: 0, FAIL: 0, WARN: 0 };
let totalPass = 0;
let totalFail = 0;
let totalNotRun = 0;

for (const row of rows) {
  const state = classify(row);
  counts[state] += 1;
  totalPass += row.pass;
  totalFail += row.fail;
  totalNotRun += row.skipped + row.todo;
  const notRun = row.skipped + row.todo;
  stdout.write(
    `${state.padEnd(4)} pass=${String(row.pass).padStart(3)} fail=${String(row.fail).padStart(3)}` +
      `${notRun > 0 ? ` skip=${row.skipped} todo=${row.todo}` : ""} exit=${row.exitCode}  ${row.file}` +
      `${row.loadBroken ? "  [load-broken: 依赖不可用，未验证]" : ""}\n`,
  );
}

if (rows.length === 0) {
  stdout.write("WARN   没有任何 *.test.ts 文件 —— 本轮没有可执行证据\n");
}

const fit =
  rows.length === 0 ? null : Math.max(0, Math.min(100, Math.round(((totalPass - totalFail * 2) / Math.max(1, totalPass)) * 100)));

stdout.write(
  `\nSUMMARY files=${rows.length} PASS=${counts.PASS} FAIL=${counts.FAIL} WARN=${counts.WARN} cases=${totalPass}/${totalPass + totalFail} notRun=${totalNotRun} fit=${fit ?? "n/a"}\n`,
);
stdout.write(
  `环境限制（如实记录）：本机无 oxlint/tsc/vitest 且未安装第三方依赖，pnpm lint/typecheck 无法执行；本表只代表 node --test 结果。\n`,
);

// FAIL / 无用例 / 有未执行用例（skip、todo）都要让门禁红；
// 仅 load-broken 的 WARN 不拦（那是本 checkout 的固有环境限制，不是有人把用例调绿）。
exit(counts.FAIL > 0 || rows.length === 0 || totalNotRun > 0 ? 1 : 0);
