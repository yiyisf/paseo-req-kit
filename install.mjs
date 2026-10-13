#!/usr/bin/env node
// req-kit installer. Run it from the version directory you want to use:
//
//   node install.mjs                         install this version, or switch to it (upgrade / rollback)
//   node install.mjs --check                 report only, change nothing
//   node install.mjs --import-legacy <dir>   first copy config and prompts.local from the old script version
//   node install.mjs --target <dir>          also install into another skills directory (repeatable, remembered)
//   node install.mjs --force                 overwrite same-named skills that req-kit did not install
//   node install.mjs --prune                 list old version directories that can be deleted
//   node install.mjs --uninstall             remove the skills req-kit installed (keeps ~/.req-kit)
//
// Programs live in the version directory (e.g. ~/tools/req-kit/versions/1.0.0); machine
// settings live in ~/.req-kit (REQ_KIT_HOME overrides it) and survive upgrades.
// Skills are copied into each agent's user-level skills directory, so they are available
// in every Paseo chat on this machine. Only plain Node.js is used here: no dependencies.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const KIT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8")).version;
const HOME_DIR = os.homedir();
const KIT_HOME = process.env.REQ_KIT_HOME?.trim() ? path.resolve(process.env.REQ_KIT_HOME.trim()) : path.join(HOME_DIR, ".req-kit");
const CONFIG = path.join(KIT_HOME, "config.json");
const ACTIVE = path.join(KIT_HOME, "active.json");
const LOG_DIR = path.join(KIT_HOME, "install-log");
const MARKER = ".req-kit-install.json";
/** Written by the script version (requirement-pipeline) installer. */
const LEGACY_MARKER = ".installed-by-requirement-pipeline.json";
const LEGACY_DIR = path.join(HOME_DIR, "tools", "requirement-pipeline");
const SKILLS_SOURCE = path.join(KIT_ROOT, "skills");
const slash = (p) => p.split(path.sep).join("/");

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    uninstall: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    prune: { type: "boolean", default: false },
    target: { type: "string", multiple: true, default: [] },
    "import-legacy": { type: "string" },
  },
});

let failures = 0;
let warnings = 0;
const ok = (text) => console.log(`✓ ${text}`);
const warn = (text, fix) => {
  warnings += 1;
  console.log(`⚠ ${text}`);
  if (fix) console.log(`    修复：${fix}`);
};
const fail = (text, fix) => {
  failures += 1;
  console.log(`✗ ${text}`);
  if (fix) console.log(`    修复：${fix}`);
};
const say = (text = "") => {
  if (!values.quiet) console.log(text);
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function writeLog(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, "install.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// ---------------------------------------------------------------------------
// Skills: render from skills/, with absolute paths filled in for this version.
// ---------------------------------------------------------------------------

const PLACEHOLDERS = {
  "{{REQ_KIT_ROOT}}": slash(KIT_ROOT),
  "{{PIPELINE_LAUNCHER}}": slash(path.join(KIT_ROOT, "bin", "start-pipeline.mjs")),
  "{{REQ_KIT_VERSION}}": VERSION,
};

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(slash(path.relative(base, full)));
  }
  return out.sort();
}

/** { skillName: { relativePath: content } } */
function renderSkills() {
  const skills = {};
  for (const name of fs.readdirSync(SKILLS_SOURCE).sort()) {
    const dir = path.join(SKILLS_SOURCE, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = {};
    for (const rel of listFiles(dir)) {
      let text = fs.readFileSync(path.join(dir, rel), "utf8");
      if (rel.endsWith(".md")) {
        for (const [key, value] of Object.entries(PLACEHOLDERS)) text = text.replaceAll(key, value);
        const left = text.match(/\{\{[A-Z_]+\}\}/);
        if (left) throw new Error(`skills/${name}/${rel} 中有未知的占位符 ${left[0]}`);
      }
      files[rel] = text;
    }
    skills[name] = files;
  }
  return skills;
}

function skillRoots(active) {
  const roots = [{ dir: path.join(HOME_DIR, ".agents", "skills"), label: "通用目录 ~/.agents/skills（Codex、Pi、OpenCode 等）" }];
  if (fs.existsSync(path.join(HOME_DIR, ".claude"))) {
    roots.push({ dir: path.join(HOME_DIR, ".claude", "skills"), label: "Claude Code ~/.claude/skills" });
  }
  const extra = new Set([...(active?.targets ?? []), ...values.target.map((t) => path.resolve(t))]);
  for (const dir of extra) {
    if (!roots.some((r) => path.resolve(r.dir) === path.resolve(dir))) roots.push({ dir, label: `自定义目录 ${dir}` });
  }
  return roots;
}

/** "ours" (req-kit marker), "legacy" (script-version marker), "foreign", "symlink" or "absent". */
function ownership(dir) {
  if (!fs.existsSync(dir)) {
    try {
      fs.lstatSync(dir);
      return "symlink"; // dangling link
    } catch {
      return "absent";
    }
  }
  if (fs.lstatSync(dir).isSymbolicLink()) return "symlink";
  if (fs.existsSync(path.join(dir, MARKER))) return "ours";
  if (fs.existsSync(path.join(dir, LEGACY_MARKER))) return "legacy";
  return "foreign";
}

/** Names of req-kit skills present in a skills directory (any version). */
function installedByUs(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir)
    .filter((name) => ["ours", "legacy"].includes(ownership(path.join(rootDir, name))))
    .sort();
}

function checkRoot(root, skills) {
  const problems = [];
  for (const [name, files] of Object.entries(skills)) {
    const dir = path.join(root.dir, name);
    const owner = ownership(dir);
    if (owner === "absent") {
      problems.push(`${name} 未安装`);
      continue;
    }
    if (owner === "symlink" || owner === "foreign") {
      problems.push(`${name} 已存在但不是 req-kit 安装的`);
      continue;
    }
    if (owner === "legacy") {
      problems.push(`${name} 是旧的脚本版安装的`);
      continue;
    }
    const marker = readJson(path.join(dir, MARKER));
    if (marker?.version !== VERSION || path.resolve(marker?.root ?? "") !== path.resolve(KIT_ROOT)) {
      problems.push(`${name} 来自 ${marker?.version ?? "未知版本"}（${marker?.root ?? "未知目录"}）`);
      continue;
    }
    const changed = Object.entries(files).some(([rel, text]) => {
      const file = path.join(dir, rel);
      return !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text;
    });
    if (changed) problems.push(`${name} 的文件与本版本不一致`);
  }
  const stale = installedByUs(root.dir).filter((name) => !(name in skills));
  if (problems.length === 0 && stale.length === 0) {
    ok(`${root.label}：${Object.keys(skills).length} 个 skill 已是 ${VERSION}`);
    return;
  }
  for (const problem of problems) fail(`${root.label}：${problem}`, `在 ${KIT_ROOT} 中运行 node install.mjs`);
  for (const name of stale) warn(`${root.label}：${name} 是旧版本 req-kit 留下的，本版本已不再使用`, `在 ${KIT_ROOT} 中运行 node install.mjs 会删除它`);
}

function installRoot(root, skills) {
  fs.mkdirSync(root.dir, { recursive: true });
  const blocked = [];
  for (const [name, files] of Object.entries(skills)) {
    const dir = path.join(root.dir, name);
    const owner = ownership(dir);
    if (owner === "symlink") {
      blocked.push(name);
      fail(`${root.label}：${dir} 是符号链接，未改动`, "删除它后重新运行，或用 --target 安装到其他目录");
      continue;
    }
    if (owner === "foreign" && !values.force) {
      blocked.push(name);
      fail(`${root.label}：${dir} 已存在且不是 req-kit 安装的，未覆盖`, "确认可以覆盖时加 --force");
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    const hashes = {};
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      hashes[rel] = sha256(text);
    }
    const marker = { name: "req-kit", skill: name, version: VERSION, root: KIT_ROOT, installedAt: new Date().toISOString(), files: hashes };
    fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  }
  const removed = [];
  for (const name of installedByUs(root.dir)) {
    if (name in skills) continue;
    fs.rmSync(path.join(root.dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  const count = Object.keys(skills).length - blocked.length;
  ok(`${root.label}：已安装 ${count} 个 skill${removed.length ? `，删除了旧版本留下的 ${removed.join("、")}` : ""}`);
}

function uninstallRoot(root) {
  const names = installedByUs(root.dir);
  for (const name of names) fs.rmSync(path.join(root.dir, name), { recursive: true, force: true });
  if (names.length) ok(`${root.label}：已删除 ${names.join("、")}`);
  else ok(`${root.label}：没有 req-kit 安装的 skill`);
}

// ---------------------------------------------------------------------------
// Environment and configuration
// ---------------------------------------------------------------------------

function checkRuntime() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) fail(`需要 Node.js 22 或更新版本，当前为 ${process.versions.node}`, "升级 Node.js");
  else ok(`Node.js ${process.versions.node}`);
  const missing = ["tsx", path.join("@getpaseo", "client")].filter((m) => !fs.existsSync(path.join(KIT_ROOT, "node_modules", m)));
  if (missing.length) fail(`依赖未安装（${missing.join("、")}）`, `在 ${KIT_ROOT} 中执行 npm install`);
  else ok("依赖已安装");
}

function importLegacy(from) {
  const dir = path.resolve(from);
  const config = path.join(dir, "pipeline.config.json");
  if (!fs.existsSync(config)) {
    fail(`在 ${dir} 中没有找到 pipeline.config.json`, "确认旧脚本版的安装目录（默认 ~/tools/requirement-pipeline）");
    return;
  }
  fs.mkdirSync(KIT_HOME, { recursive: true });
  if (fs.existsSync(CONFIG) && !values.force) {
    warn(`${CONFIG} 已存在，未覆盖`, "确认要用旧配置覆盖时加 --force（原文件会备份）");
  } else {
    if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, `${CONFIG}.bak-${Date.now()}`);
    fs.copyFileSync(config, CONFIG);
    ok(`已导入旧配置：${config} → ${CONFIG}`);
  }
  const prompts = path.join(dir, "prompts.local");
  if (fs.existsSync(prompts)) {
    const dest = path.join(KIT_HOME, "prompts.local");
    fs.mkdirSync(dest, { recursive: true });
    const copied = [];
    for (const name of fs.readdirSync(prompts)) {
      const target = path.join(dest, name);
      if (fs.existsSync(target) && !values.force) {
        warn(`prompts.local/${name} 已存在，未覆盖`);
        continue;
      }
      fs.copyFileSync(path.join(prompts, name), target);
      copied.push(name);
    }
    if (copied.length) ok(`已导入提示词覆盖：${copied.join("、")} → ${dest}`);
  }
  writeLog({ action: "import-legacy", from: dir });
}

function checkConfig() {
  if (!fs.existsSync(CONFIG)) {
    const legacy = fs.existsSync(path.join(LEGACY_DIR, "pipeline.config.json"));
    if (values.check) {
      fail(`还没有本机配置 ${CONFIG}`, legacy ? `从旧脚本版导入：node install.mjs --import-legacy "${LEGACY_DIR}"` : "运行 node install.mjs 生成");
      return;
    }
    if (legacy) {
      fail(`还没有本机配置 ${CONFIG}，但发现了旧脚本版的配置`, `运行 node install.mjs --import-legacy "${LEGACY_DIR}" 导入`);
      return;
    }
    fs.mkdirSync(KIT_HOME, { recursive: true });
    fs.copyFileSync(path.join(KIT_ROOT, "config.example.json"), CONFIG);
    fail(`已生成本机配置 ${CONFIG}，请填写两个 agent 的 provider/model`, "写法见 docs/guide/安装与升级.md 第 4 节；可用的值用 npm run smoke -- check 查看");
    return;
  }
  const text = fs.readFileSync(CONFIG, "utf8");
  if (readJson(CONFIG) === null) fail(`${CONFIG} 不是合法的 JSON`, "修正格式");
  else if (text.includes("CHANGE-ME")) fail(`${CONFIG} 中的 provider 还是示例值`, "填写真实的 provider/model（npm run smoke -- check 会列出可用的值）");
  else ok(`本机配置 ${CONFIG}`);
}

function checkLegacyLeftovers(roots) {
  if (fs.existsSync(LEGACY_DIR) && path.resolve(LEGACY_DIR) !== path.resolve(KIT_ROOT)) {
    warn(`发现旧脚本版目录 ${LEGACY_DIR}`, "确认它启动的流水线都已结束、配置已导入后，可以删除它");
  }
  for (const root of roots) {
    for (const dep of ["grilling", "domain-modeling"]) {
      if (fs.existsSync(path.join(root.dir, dep, "SKILL.md"))) {
        say(`  ${root.label}：${dep} 是旧版本依赖的外部 skill，req-kit 已不再需要，可以保留或自行卸载。`);
      }
    }
  }
}

function checkActive(active) {
  if (!active) {
    if (values.check) fail("还没有启用任何 req-kit 版本", `在 ${KIT_ROOT} 中运行 node install.mjs`);
    return;
  }
  if (path.resolve(active.root) === path.resolve(KIT_ROOT)) ok(`当前启用的版本：${active.version}（${active.root}）`);
  else warn(`当前启用的是 ${active.version}（${active.root}），不是这个目录（${VERSION}）`, `要改用这个版本，在 ${KIT_ROOT} 中运行 node install.mjs`);
}

function prune(active) {
  const versionsDir = path.dirname(KIT_ROOT);
  if (path.basename(versionsDir) !== "versions") {
    say(`这个安装目录不在 versions/ 下（${KIT_ROOT}），没有可以整理的旧版本。`);
    return;
  }
  const history = fs.existsSync(path.join(LOG_DIR, "install.jsonl"))
    ? fs.readFileSync(path.join(LOG_DIR, "install.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => readJson2(l)).filter(Boolean)
    : [];
  const activeRoot = path.resolve(active?.root ?? KIT_ROOT);
  const previous = [...history].reverse().find((e) => e.action === "activate" && e.root && path.resolve(e.root) !== activeRoot);
  const keep = new Set([activeRoot, previous ? path.resolve(previous.root) : null].filter(Boolean));
  const candidates = fs
    .readdirSync(versionsDir)
    .map((name) => path.join(versionsDir, name))
    .filter((dir) => fs.statSync(dir).isDirectory() && !keep.has(path.resolve(dir)));
  say(`保留：${[...keep].join("、")}`);
  if (candidates.length === 0) {
    say("没有可以删除的旧版本。");
    return;
  }
  say("可以删除的旧版本（请先确认没有由它们启动、仍在运行的流水线）：");
  for (const dir of candidates) say(`  ${dir}`);
}

function readJson2(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

const active = readJson(ACTIVE);
const roots = skillRoots(active);

if (values.uninstall) {
  for (const root of roots) uninstallRoot(root);
  if (fs.existsSync(ACTIVE)) fs.rmSync(ACTIVE);
  writeLog({ action: "uninstall", version: VERSION, root: KIT_ROOT });
  say(`\n已卸载 skill。本机配置保留在 ${KIT_HOME}；不再使用时可以手工删除它和安装目录。`);
  process.exit(failures === 0 ? 0 : 1);
}

if (values.prune) {
  prune(active);
  process.exit(0);
}

say(values.check ? `检查 req-kit ${VERSION}（${KIT_ROOT}）：\n` : `安装 req-kit ${VERSION}（${KIT_ROOT}）：\n`);
if (values["import-legacy"] && !values.check) importLegacy(values["import-legacy"]);
checkRuntime();
checkConfig();

const skills = renderSkills();
if (values.check) {
  checkActive(active);
  for (const root of roots) checkRoot(root, skills);
} else {
  for (const root of roots) installRoot(root, skills);
  const targets = roots.filter((r) => !r.label.startsWith("通用目录") && !r.label.startsWith("Claude Code")).map((r) => r.dir);
  fs.mkdirSync(KIT_HOME, { recursive: true });
  const record = { version: VERSION, root: KIT_ROOT, targets, activatedAt: new Date().toISOString() };
  fs.writeFileSync(ACTIVE, `${JSON.stringify(record, null, 2)}\n`);
  writeLog({ action: "activate", version: VERSION, root: KIT_ROOT, previous: active ? { version: active.version, root: active.root } : null });
  if (active && path.resolve(active.root) !== path.resolve(KIT_ROOT)) ok(`已从 ${active.version} 切换到 ${VERSION}`);
  else ok(`已启用 ${VERSION}`);
}
checkLegacyLeftovers(roots);

say("");
say(`启动命令：node "${PLACEHOLDERS["{{PIPELINE_LAUNCHER}}"]}"`);
if (failures === 0) {
  say(
    values.check
      ? "一切就绪。"
      : "完成。新开的 Paseo 对话中即可使用 /req（Pi 中为 /skill:req）；已经打开的对话需要新开一个才能看到。建议接着运行 node bin/req-doctor.mjs --no-project 检查 daemon 和 agent。",
  );
} else {
  say(`有 ${failures} 项需要处理，见上面的 ✗。处理后重新运行 node install.mjs${values.check ? " --check" : ""}。`);
}
process.exit(failures === 0 ? 0 : 1);
