// 进化树读写器：节点只能由本脚本追加，禁止任何子代理手改 tree.json（判据归主代理）。
// 用法：
//   node docs/evolution/tree.mjs render
//   node docs/evolution/tree.mjs add --id gen2-a --label "..." --parent gen1-a --cases 12/12 \
//        [--branch frontier-grow|graft:AxB|prune-recover|seed] [--unverified "hop1;;hop2"] [--note "..."]
//   node docs/evolution/tree.mjs note --id gen2-a --last-run "files=3 cases=48/48"
import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit, stdout } from "node:process";

const TREE = new URL("./tree.json", import.meta.url).pathname.replace(/^\/(\w:)/i, "$1");

function load() {
  return JSON.parse(readFileSync(TREE, "utf8"));
}
function save(t) {
  writeFileSync(TREE, JSON.stringify(t, null, 2) + "\n");
}
function args() {
  const out = { _: [] };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
// fit 定义：本机真实执行用例的通过率；有失败用例直接按比例扣（失败权重 2），无数据为 null。
function computeFit(cases) {
  const m = /^(\d+)\/(\d+)$/.exec(cases ?? "");
  if (!m) return null;
  const pass = Number(m[1]);
  const total = Number(m[2]);
  if (total === 0) return null;
  const fail = total - pass;
  return Math.max(0, Math.min(100, Math.round(((pass - fail * 2) / total) * 100)));
}
function render(t) {
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const childrenOf = (id) => t.nodes.filter((n) => n.parent === id);
  const lines = [];
  function walk(node, prefix, isLast, rootCall) {
    const conn = rootCall ? "" : prefix + (isLast ? "└─ " : "├─ ");
    const frontier = t.frontier?.includes(node.id) ? "  ← FRONTIER" : "";
    const fit = node.fit === null || node.fit === undefined ? "n/a" : node.fit;
    lines.push(
      `${conn}${node.id} (${node.branch ?? "?"}, fit=${fit}${node.cases ? `, cases=${node.cases}` : ""}) ${node.label ?? ""}${frontier}`,
    );
    const kids = childrenOf(node.id);
    const childPrefix = rootCall ? "" : prefix + (isLast ? "   " : "│  ");
    kids.forEach((k, i) => walk(k, childPrefix, i === kids.length - 1, false));
  }
  const roots = t.nodes.filter((n) => !n.parent || !byId.has(n.parent));
  roots.forEach((r, i) => walk(r, "", i === roots.length - 1, true));
  stdout.write(lines.join("\n") + "\n");
  stdout.write(
    `\nnodes=${t.nodes.length} frontier=[${(t.frontier ?? []).join(", ")}] stale=${t.stale_count ?? 0}\n`,
  );
  for (const n of t.nodes) {
    if (n.unverified?.length) stdout.write(`  ${n.id} 未验证边界: ${n.unverified.join(" | ")}\n`);
  }
}

const cmd = argv[2];
const a = args();
const t = load();

if (cmd === "render") {
  render(t);
  exit(0);
}

if (cmd === "add") {
  if (!a.id || !a.label) {
    stdout.write("add 需要 --id 与 --label\n");
    exit(1);
  }
  if (t.nodes.some((n) => n.id === a.id)) {
    stdout.write(`节点已存在：${a.id}（要改请用 note）\n`);
    exit(1);
  }
  const node = {
    id: a.id,
    label: a.label,
    fit: computeFit(a.cases),
    cases: a.cases ?? null,
    branch: a.branch ?? (a.parent ? "frontier-grow" : "seed"),
    parent: a.parent ?? null,
  };
  if (a.unverified) node.unverified = String(a.unverified).split(";;").map((s) => s.trim()).filter(Boolean);
  if (a.note) node.note = a.note;
  node.fit_definition = "fit=(pass-2*fail)/total*100，仅计本机 node --test 真实执行用例；未验证边界单列不计入 fit";
  t.nodes.push(node);
  if (node.parent) t.edges.push({ from: node.parent, to: node.id });
  // frontier = 所有没有子节点的叶子；不能写成"只剩新节点"，否则双分支并行时另一条支会被抹掉。
  t.frontier = t.nodes.filter((n) => !t.nodes.some((c) => c.parent === n.id)).map((n) => n.id);
  save(t);
  stdout.write(`added ${node.id} fit=${node.fit ?? "n/a"} parent=${node.parent ?? "-"}\n`);
  exit(0);
}

if (cmd === "note") {
  const node = t.nodes.find((n) => n.id === a.id);
  if (!node) {
    stdout.write(`无此节点：${a.id}\n`);
    exit(1);
  }
  if (a.label) node.label = a.label; // 允许就地更正错标（例：把凭印象写的 500 行改成 git 实测的 491）
  if (a.cases) {
    node.cases = a.cases;
    node.fit = computeFit(a.cases);
  }
  if (a.unverified) node.unverified = String(a.unverified).split(";;").map((s) => s.trim()).filter(Boolean);
  if (a.note) node.note = a.note;
  if (a["last-run"]) t.last_run = { at: new Date().toISOString(), value: a["last-run"] };
  save(t);
  stdout.write(`noted ${node.id} fit=${node.fit ?? "n/a"}\n`);
  exit(0);
}

stdout.write("用法：render | add | note（见文件头注释）\n");
exit(1);
