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
//   node install.mjs --configure             configuration wizard: pick the agents from what Paseo offers
//   node install.mjs --upgrade [version]     download a version (default: the newest) next to this one,
//                                            install its dependencies and switch to it
//   node install.mjs --latest                print the newest published version
//
// Programs live in the version directory (e.g. ~/tools/req-kit/versions/1.0.0); machine
// settings live in ~/.req-kit (REQ_KIT_HOME overrides it) and survive upgrades.
// Skills are copied into each agent's user-level skills directory, so they are available
// in every Paseo chat on this machine. Installing also writes the `req` command into
// ~/.req-kit/bin. Only plain Node.js (and git for --upgrade) is used here: no dependencies.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findDependency, findTsxCli, layoutOf } from "./bin/locate.mjs";

const KIT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;
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

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    configure: { type: "boolean", default: false },
    upgrade: { type: "boolean", default: false },
    latest: { type: "boolean", default: false },
    from: { type: "string" },
    beta: { type: "boolean", default: false },
    setup: { type: "boolean", default: false },
    use: { type: "boolean", default: false },
    versions: { type: "boolean", default: false },
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
  const missing = ["tsx", "@getpaseo/client"].filter((m) => !findDependency(KIT_ROOT, m));
  if (missing.length) {
    const fix =
      LAYOUT.kind === "npm"
        ? `重新安装这个版本：删除 ${path.join(LAYOUT.versionsDir, VERSION)} 后运行 req upgrade ${VERSION}`
        : LAYOUT.kind === "manager"
          ? `重新安装管理器：npm i -g ${PACKAGE_NAME}`
          : `在 ${KIT_ROOT} 中执行 npm install`;
    fail(`依赖未安装（${missing.join("、")}）`, fix);
  }
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
    fail(`已生成本机配置 ${CONFIG}，请填写两个 agent 的 provider/model`, "运行配置向导 node install.mjs --configure，按提示选择即可（也可以手工编辑，写法见 docs/guide/安装与升级.md）");
    return;
  }
  const text = fs.readFileSync(CONFIG, "utf8");
  if (readJson(CONFIG) === null) fail(`${CONFIG} 不是合法的 JSON`, "修正格式");
  else if (text.includes("CHANGE-ME")) fail(`${CONFIG} 中的 provider 还是示例值`, "运行配置向导 node install.mjs --configure（或手工填写真实的 provider/model）");
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
  const versionsDir = LAYOUT.versionsDir;
  if (!versionsDir || !fs.existsSync(versionsDir)) {
    say(`这个安装目录不在 versions/ 下（${KIT_ROOT}），没有可以整理的旧版本。`);
    return;
  }
  const history = fs.existsSync(path.join(LOG_DIR, "install.jsonl"))
    ? fs.readFileSync(path.join(LOG_DIR, "install.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => readJson2(l)).filter(Boolean)
    : [];
  // A version's directory is versions/<version>, whichever layout its program has inside.
  const versionDirOf = (root) => {
    const rel = path.relative(versionsDir, path.resolve(root));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(versionsDir, rel.split(path.sep)[0]) : path.resolve(root);
  };
  const activeDir = versionDirOf(active?.root ?? KIT_ROOT);
  const previous = [...history].reverse().find((e) => e.action === "activate" && e.root && versionDirOf(e.root) !== activeDir);
  const keep = new Set([activeDir, previous ? versionDirOf(previous.root) : null].filter(Boolean));
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
// The `req` command
// ---------------------------------------------------------------------------

const SHIM_DIR = path.join(KIT_HOME, "bin");
const SHIMS = {
  req: (entry) => `#!/bin/sh\n# Written by req-kit install.mjs; points at the active version.\nexec node "${slash(entry)}" "$@"\n`,
  "req.cmd": (entry) => `@echo off\r\nrem Written by req-kit install.mjs; points at the active version.\r\nnode "${entry}" %*\r\n`,
};

function onPath(dir) {
  const want = path.resolve(dir).toLowerCase();
  return (process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((p) => path.resolve(p).toLowerCase() === want);
}

function pathHint() {
  if (onPath(SHIM_DIR)) return;
  say(`  要在任何位置直接输入 req，把 ${SHIM_DIR} 加入 PATH（只需一次，之后新开的终端生效）：`);
  if (process.platform === "win32") {
    say(`    PowerShell：[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${SHIM_DIR}", "User")`);
  } else {
    say(`    echo 'export PATH="${SHIM_DIR}:$PATH"' >> ~/.bashrc   （zsh 用 ~/.zshrc）`);
  }
  say(`  不加也可以：用完整路径运行 ${path.join(SHIM_DIR, process.platform === "win32" ? "req.cmd" : "req")}`);
}

function writeShims() {
  const entry = path.join(KIT_ROOT, "bin", "req.mjs");
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  for (const [name, render] of Object.entries(SHIMS)) {
    const file = path.join(SHIM_DIR, name);
    fs.writeFileSync(file, render(entry));
    if (name === "req") fs.chmodSync(file, 0o755);
  }
  ok(`req 命令：${SHIM_DIR}`);
  // Installed through the npm manager, `req` is already on PATH.
  if (LAYOUT.kind !== "npm") pathHint();
}

function checkShims(active) {
  const file = path.join(SHIM_DIR, "req");
  if (!fs.existsSync(file)) {
    warn(`还没有 req 命令（${SHIM_DIR}）`, `在 ${KIT_ROOT} 中运行 node install.mjs`);
    return;
  }
  const entry = path.join(active?.root ?? KIT_ROOT, "bin", "req.mjs");
  if (fs.readFileSync(file, "utf8").includes(slash(entry))) ok(`req 命令：${SHIM_DIR}`);
  else warn("req 命令指向的不是当前启用的版本", `在当前启用版本的目录中运行 node install.mjs`);
}

// ---------------------------------------------------------------------------
// Versions: where they live, which to install, installing and switching
// ---------------------------------------------------------------------------

const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8")).name;
const LAYOUT = layoutOf(KIT_ROOT);
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver order; a prerelease (1.3.0-beta.1) comes before its release (1.3.0). */
function compareVersions(a, b) {
  const pa = RELEASE.exec(a);
  const pb = RELEASE.exec(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) - (pb[4] ? -1 : 0);
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

/** "0.11.2" satisfies ">=0.11.0 <0.12.0" (the ranges req-kit declares; prerelease tags ignored). */
function satisfies(version, range) {
  const parse = (v) => v.replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => Number(n) || 0);
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const v = parse(version);
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
      if (!m) return false;
      const c = cmp(v, parse(m[2]));
      return { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
    });
}

/** The program directory of an installed version, in either layout; null when not installed. */
function versionRoot(versionsDir, version) {
  const dir = path.join(versionsDir, version);
  for (const root of [dir, path.join(dir, "node_modules", PACKAGE_NAME)]) {
    if (readJson(path.join(root, "package.json"))?.version === version && fs.existsSync(path.join(root, "install.mjs"))) return root;
  }
  return null;
}

function installedVersions(versionsDir) {
  if (!versionsDir || !fs.existsSync(versionsDir)) return [];
  return fs
    .readdirSync(versionsDir)
    .filter((name) => RELEASE.test(name) && versionRoot(versionsDir, name))
    .sort((a, b) => compareVersions(b, a));
}

/** The version the machine uses now (the manager's own version does not count). */
function currentVersion() {
  return readJson(ACTIVE)?.version ?? VERSION;
}

/** Runs npm (REQ_KIT_NPM: a script standing in for npm, for tests). */
function npm(args, options = {}) {
  const fake = process.env.REQ_KIT_NPM?.trim();
  const windows = process.platform === "win32" && !fake;
  const quoted = windows ? args.map((a) => (/[\s&()^]/.test(a) ? `"${a}"` : a)) : args;
  return spawnSync(fake ? process.execPath : windows ? "npm.cmd" : "npm", fake ? [fake, ...args] : quoted, {
    encoding: "utf8",
    windowsHide: true,
    shell: windows,
    cwd: options.cwd,
    timeout: options.timeout ?? 900_000,
    stdio: options.inherit ? "inherit" : "pipe",
  });
}

function npmJson(args) {
  const result = npm([...args, "--json"], { timeout: 60_000 });
  if (result.error) throw new Error(`无法运行 npm：${result.error.message}`);
  if (result.status !== 0) {
    const lines = `${result.stderr ?? ""}`.trim().split("\n").filter(Boolean);
    throw new Error(lines.find((l) => /npm (ERR|error)/.test(l)) ?? lines.at(-1) ?? `npm 退出码 ${result.status}`);
  }
  return JSON.parse(result.stdout.trim() || "null");
}

function npmInstall(spec, prefix) {
  const result = npm(["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", "--no-save", spec], { inherit: true });
  if (result.error) throw new Error(`无法运行 npm：${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm install ${spec} 失败（退出码 ${result.status}）。请检查网络或 npm 镜像设置（npm config get registry）。`);
}

/** Installs a version into versions/<version> through npm; the directory appears only when complete. */
function installWithNpm(versionsDir, version, spec) {
  const existing = versionRoot(versionsDir, version);
  if (existing) {
    console.log(`${version} 已经装过（${existing}），直接使用。`);
    return existing;
  }
  const dest = path.join(versionsDir, version);
  if (fs.existsSync(dest)) throw new Error(`${dest} 已存在但不是完整的 ${version}。确认没有用处后删除它，再重新运行。`);
  fs.mkdirSync(versionsDir, { recursive: true });
  const partial = `${dest}.partial-${Date.now()}`;
  fs.mkdirSync(partial);
  try {
    console.log(`安装 ${version}（npm）→ ${dest}`);
    npmInstall(spec, partial);
    fs.renameSync(partial, dest);
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
  }
  const root = versionRoot(versionsDir, version);
  if (!root) throw new Error(`npm 安装完成，但 ${dest} 中没有找到 ${PACKAGE_NAME} ${version}`);
  return root;
}

/** Version of the local Paseo daemon, read through this copy's engine; null when unknown. */
function localDaemonVersion() {
  const override = process.env.REQ_KIT_DAEMON_VERSION?.trim();
  if (override) return override === "none" ? null : override;
  const tsx = findTsxCli(KIT_ROOT);
  if (!tsx) return null;
  const result = spawnSync(process.execPath, [tsx, path.join(KIT_ROOT, "engine", "src", "daemon-version.ts"), "--config", CONFIG], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] || null : null;
}

/**
 * The newest published version worth installing: releases only unless the current one is a
 * prerelease (or --beta), and one whose reqKit.paseo range accepts the local daemon.
 */
function chooseNpmVersion(current) {
  const raw = npmJson(["view", PACKAGE_NAME, "versions"]);
  const published = (Array.isArray(raw) ? raw : [raw]).filter((v) => typeof v === "string" && RELEASE.test(v)).sort((a, b) => compareVersions(b, a));
  const wanted = positionals[0]?.replace(/^v/, "");
  if (wanted) {
    if (!published.includes(wanted)) throw new Error(`npm 上没有 ${PACKAGE_NAME} ${wanted}。已发布的版本：${published.slice(0, 8).join("、") || "无"}`);
    return { version: wanted, notes: [], daemon: null };
  }
  const prerelease = current.includes("-") || values.beta;
  const candidates = published.filter((v) => (prerelease || !v.includes("-")) && compareVersions(v, current) > 0);
  if (candidates.length === 0) return { version: null, notes: [], daemon: null };
  const daemon = localDaemonVersion();
  if (!daemon) {
    return { version: candidates[0], notes: ["没能读到本机 Paseo 的版本（daemon 没有运行？），没有按 Paseo 版本筛选，升级后请运行 req doctor"], daemon };
  }
  const notes = [];
  for (const version of candidates.slice(0, 10)) {
    let range = null;
    try {
      range = npmJson(["view", `${PACKAGE_NAME}@${version}`, "reqKit.paseo"]);
    } catch {
      // The registry did not say; treat it as compatible.
    }
    if (typeof range !== "string" || satisfies(daemon, range)) return { version, notes, daemon };
    notes.push(`${version} 需要 Paseo ${range}，本机是 ${daemon}`);
  }
  return { version: null, notes, daemon };
}

function repoUrl() {
  if (values.from && values.from !== "git" && values.from !== "npm") return values.from;
  if (process.env.REQ_KIT_REPO_URL?.trim()) return process.env.REQ_KIT_REPO_URL.trim();
  const repo = typeof PKG.repository === "string" ? PKG.repository : PKG.repository?.url;
  const github = /^github:(.+)$/.exec(repo ?? "");
  return github ? `https://github.com/${github[1]}.git` : repo;
}

/** Git tags as published versions, newest first. Throws with a readable message. */
function publishedTags(url) {
  const result = spawnSync("git", ["ls-remote", "--tags", "--refs", url], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) throw new Error(`无法运行 git：${result.error.message}。从 git 升级需要安装 git。`);
  if (result.status !== 0) {
    const lines = (result.stderr || "").trim().split("\n").filter(Boolean);
    const reason = (lines.find((l) => l.startsWith("fatal:")) ?? lines[0] ?? `git 退出码 ${result.status}`).replace(/^fatal:\s*/, "");
    throw new Error(`无法读取 ${url} 的版本列表：${reason}。请检查网络（公司网络可能需要代理），或用 --from <地址> 指定内网镜像。`);
  }
  return result.stdout
    .split("\n")
    .map((line) => /refs\/tags\/(.+)$/.exec(line.trim())?.[1])
    .filter((tag) => tag && RELEASE.test(tag))
    .sort((a, b) => compareVersions(b, a));
}

/** Where upgrades come from: npm for npm installs and the manager, git for git installs; --from overrides. */
function upgradeSource() {
  if (values.from === "npm") return "npm";
  if (values.from) return "git";
  return LAYOUT.kind === "git" ? "git" : "npm";
}

/** Picks the version to install from git tags. */
function chooseGitVersion(current) {
  const tags = publishedTags(repoUrl());
  const wanted = positionals[0]?.replace(/^v/, "");
  if (wanted) {
    const tag = tags.find((t) => t.replace(/^v/, "") === wanted);
    if (!tag) throw new Error(`没有找到版本 ${wanted}。已发布的版本：${tags.slice(0, 8).join("、") || "无"}`);
    return { version: wanted, tag, notes: [] };
  }
  const prerelease = current.includes("-") || values.beta;
  const tag = tags.find((t) => (prerelease || !t.includes("-")) && compareVersions(t.replace(/^v/, ""), current) > 0) ?? null;
  return { version: tag ? tag.replace(/^v/, "") : null, tag, notes: [] };
}

function installWithGit(versionsDir, version, tag) {
  const url = repoUrl();
  const dest = path.join(versionsDir, version);
  if (versionRoot(versionsDir, version)) {
    console.log(`${dest} 已经下载过，直接使用。`);
  } else {
    if (fs.existsSync(dest)) throw new Error(`${dest} 已存在但不是完整的 ${version}。确认没有用处后删除它，再重新运行。`);
    console.log(`下载 ${version}：${url} → ${dest}`);
    const partial = `${dest}.partial-${Date.now()}`;
    try {
      const clone = spawnSync("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", tag, url, partial], {
        stdio: "inherit",
        windowsHide: true,
      });
      if (clone.status !== 0) throw new Error(`git clone 失败（退出码 ${clone.status}）`);
      fs.renameSync(partial, dest);
    } finally {
      fs.rmSync(partial, { recursive: true, force: true });
    }
  }
  if (process.env.REQ_KIT_SKIP_NPM === "1") {
    console.log("跳过 npm install（REQ_KIT_SKIP_NPM=1）。");
  } else if (!findTsxCli(dest)) {
    console.log("安装依赖（npm install）……");
    const result = npm(["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: dest, inherit: true });
    if (result.status !== 0) throw new Error(`npm install 失败（退出码 ${result.status}）`);
  }
  return dest;
}

/** Runs a version's own installer, which installs its skills and records it as active. */
function activate(root) {
  return spawnSync(process.execPath, [path.join(root, "install.mjs"), ...values.target.flatMap((t) => ["--target", t])], {
    stdio: "inherit",
    windowsHide: true,
  }).status ?? 1;
}

function latestCommand() {
  if (!LAYOUT.versionsDir && upgradeSource() === "npm") {
    console.error(`这个目录（${KIT_ROOT}）是开发用的检出，不能自动升级。`);
    return 1;
  }
  const current = currentVersion();
  let choice;
  try {
    choice = upgradeSource() === "npm" ? chooseNpmVersion(current) : chooseGitVersion(current);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  if (values.quiet) {
    if (choice.version) console.log(choice.version);
    else console.log(current);
    return 0;
  }
  for (const note of choice.notes) console.log(`· ${note}`);
  if (choice.version) console.log(`有新版本 ${choice.version}（当前 ${current}）。升级：req upgrade`);
  else console.log(`已是最新版本 ${current}${choice.notes.length ? "（能支持本机 Paseo 的版本中）" : ""}。`);
  return 0;
}

function upgradeCommand() {
  const versionsDir = LAYOUT.versionsDir;
  if (!versionsDir) {
    console.error(`这个安装目录不在 versions/ 下（${KIT_ROOT}），无法自动升级。请按 docs/guide/安装与升级.md 安装。`);
    return 1;
  }
  const current = currentVersion();
  const source = upgradeSource();
  let root;
  let target;
  try {
    const choice = source === "npm" ? chooseNpmVersion(current) : chooseGitVersion(current);
    for (const note of choice.notes) console.log(`· ${note}`);
    if (!choice.version) {
      console.log(`已是最新版本 ${current}${choice.notes.length ? "（能支持本机 Paseo 的版本中）" : ""}，不需要升级。`);
      return 0;
    }
    target = choice.version;
    root =
      source === "npm"
        ? installWithNpm(versionsDir, target, `${PACKAGE_NAME}@${target}`)
        : versionRoot(versionsDir, target) ?? installWithGit(versionsDir, target, choice.tag);
    if (source === "git") root = versionRoot(versionsDir, target) ?? root;
  } catch (error) {
    console.error(`升级没有完成：${error.message}`);
    console.error(`当前版本 ${current} 仍然可用，没有任何改动。`);
    return 1;
  }
  console.log(`\n切换到 ${target}：`);
  const status = activate(root);
  const now = readJson(ACTIVE);
  if (now?.version === target && path.resolve(now.root) === path.resolve(root)) {
    console.log(`\n已升级到 ${target}${status === 0 ? "" : "，但还有需要处理的项（见上面的 ✗）"}。正在运行的流水线不受影响，继续用启动它的版本；之后启动的用新版本。`);
    console.log(`更新内容见 ${path.join(root, "CHANGELOG.md")}。要回到 ${current}：req use ${current}`);
  } else {
    console.log(`\n没有切换到 ${target}（见上面的输出），仍在使用 ${current}。`);
  }
  return status;
}

/** npm i -g, then `req setup`: installs this package's own version under versions/ and switches to it. */
function setupCommand() {
  if (LAYOUT.kind !== "manager") {
    return activate(KIT_ROOT);
  }
  let root;
  try {
    root = versionRoot(LAYOUT.versionsDir, VERSION);
    if (!root) {
      // Install from this very package (no download of req-kit itself; its dependencies come from npm).
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-pack-"));
      try {
        const packed = npmJson(["pack", KIT_ROOT, "--pack-destination", tmp]);
        const file = Array.isArray(packed) ? packed[0]?.filename : null;
        if (!file) throw new Error("npm pack 没有生成安装包");
        root = installWithNpm(LAYOUT.versionsDir, VERSION, path.join(tmp, path.basename(file)));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.error(`安装没有完成：${error.message}`);
    return 1;
  }
  console.log(`\n启用 ${VERSION}：`);
  const status = activate(root);
  const config = readJson(CONFIG);
  if (config && JSON.stringify(config).includes("CHANGE-ME")) {
    console.log("\n下一步：运行 req configure，按提示为 builder 和 reviewer 选择 agent。");
  }
  return status;
}

function useCommand() {
  const version = positionals[0]?.replace(/^v/, "");
  const versionsDir = LAYOUT.versionsDir;
  if (!version || !versionsDir) {
    console.error("用法：req use <版本>。已安装的版本见 req versions。");
    return 2;
  }
  const root = versionRoot(versionsDir, version);
  if (!root) {
    console.error(`没有安装 ${version}。已安装：${installedVersions(versionsDir).join("、") || "无"}。要安装它：req upgrade ${version}`);
    return 1;
  }
  return activate(root);
}

function versionsCommand() {
  const versionsDir = LAYOUT.versionsDir;
  const active = readJson(ACTIVE);
  const installed = installedVersions(versionsDir);
  console.log(`安装目录：${versionsDir ?? KIT_ROOT}`);
  if (installed.length === 0) console.log("还没有安装任何版本。运行 req setup。");
  for (const v of installed) {
    const root = versionRoot(versionsDir, v);
    const mark = active && path.resolve(active.root) === path.resolve(root) ? "  ← 当前启用" : "";
    console.log(`  ${v}${root.includes(`${path.sep}node_modules${path.sep}`) ? "（npm）" : "（git）"}${mark}`);
  }
  if (LAYOUT.kind === "manager") console.log(`管理器（req 命令）：${VERSION}，${KIT_ROOT}`);
  try {
    const tags = npmJson(["view", PACKAGE_NAME, "dist-tags"]);
    const shown = Object.entries(tags ?? {}).map(([tag, v]) => `${tag} ${v}`);
    if (shown.length) console.log(`npm 上的版本：${shown.join("，")}`);
  } catch {
    // Offline or not published: nothing to add.
  }
  return 0;
}

function configureCommand() {
  const tsx = findTsxCli(KIT_ROOT);
  if (!tsx) {
    console.error(`依赖未安装：在 ${KIT_ROOT} 中执行 npm install 后再运行配置向导。`);
    return 1;
  }
  const result = spawnSync(process.execPath, [tsx, path.join(KIT_ROOT, "engine", "src", "configure.ts"), "--config", CONFIG], {
    stdio: "inherit",
    windowsHide: true,
  });
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------

if (values.latest) process.exit(latestCommand());
if (values.upgrade) process.exit(upgradeCommand());
if (values.configure) process.exit(configureCommand());
if (values.setup) process.exit(setupCommand());
if (values.use) process.exit(useCommand());
if (values.versions) process.exit(versionsCommand());

// The npm-installed manager is not a version itself: plain installs go through setup,
// and checks or removal concern the version it manages.
if (LAYOUT.kind === "manager") {
  if (values.check || values.uninstall || values.prune) {
    const activeRoot = readJson(ACTIVE)?.root;
    if (!activeRoot || !fs.existsSync(path.join(activeRoot, "install.mjs"))) {
      console.log("✗ 还没有启用任何 req-kit 版本\n    修复：运行 req setup");
      process.exit(1);
    }
    process.exit(spawnSync(process.execPath, [path.join(activeRoot, "install.mjs"), ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true }).status ?? 1);
  }
  process.exit(setupCommand());
}

const active = readJson(ACTIVE);
const roots = skillRoots(active);

if (values.uninstall) {
  for (const root of roots) uninstallRoot(root);
  if (fs.existsSync(ACTIVE)) fs.rmSync(ACTIVE);
  for (const name of Object.keys(SHIMS)) fs.rmSync(path.join(SHIM_DIR, name), { force: true });
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
  checkShims(active);
} else {
  for (const root of roots) installRoot(root, skills);
  const targets = roots.filter((r) => !r.label.startsWith("通用目录") && !r.label.startsWith("Claude Code")).map((r) => r.dir);
  fs.mkdirSync(KIT_HOME, { recursive: true });
  const record = { version: VERSION, root: KIT_ROOT, targets, activatedAt: new Date().toISOString() };
  fs.writeFileSync(ACTIVE, `${JSON.stringify(record, null, 2)}\n`);
  writeLog({ action: "activate", version: VERSION, root: KIT_ROOT, previous: active ? { version: active.version, root: active.root } : null });
  if (active && path.resolve(active.root) !== path.resolve(KIT_ROOT)) ok(`已从 ${active.version} 切换到 ${VERSION}`);
  else ok(`已启用 ${VERSION}`);
  writeShims();
  // The Paseo plugin, when installed, follows the active version (bin/req-plugin.mjs).
  const { refreshPlugin } = await import("./bin/req-plugin.mjs");
  refreshPlugin({ kitRoot: KIT_ROOT, log: (message) => ok(message) });
}
checkLegacyLeftovers(roots);

say("");
say(`启动命令：node "${PLACEHOLDERS["{{PIPELINE_LAUNCHER}}"]}"；终端中查看进度等：req help`);
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
