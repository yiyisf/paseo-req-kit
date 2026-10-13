#!/usr/bin/env node
// Makes /requirement-kickoff (steps 1–2) and the pipeline it launches (steps 3–11)
// available in every Paseo chat on this machine, whatever the project.
//
//   node install.mjs                 install or update
//   node install.mjs --check         report only, change nothing
//   node install.mjs --uninstall     remove what this script installed
//   node install.mjs --target <dir>  also install into another skills directory (repeatable)
//
// Paseo runs each agent's own CLI with its normal user configuration, so a skill in
// the agent's user-level skills directory is available in all of its chats.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SKILL = "requirement-kickoff";
const MARKER = ".installed-by-requirement-pipeline.json";
const DEPENDENCIES = ["grilling", "domain-modeling"];
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    uninstall: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    target: { type: "string", multiple: true, default: [] },
  },
});

let problems = 0;
const ok = (text) => console.log(`✓ ${text}`);
const bad = (text) => {
  problems += 1;
  console.log(`✗ ${text}`);
};
const info = (text) => console.log(`  ${text}`);

/** User-level skills directories of the agents Paseo can run. */
function skillRoots() {
  const roots = [
    // Open agent-skills location, used by Codex and other agents that follow it.
    { dir: path.join(home, ".agents", "skills"), agent: "通用（.agents，含 Codex）", always: true },
    { dir: path.join(home, ".claude", "skills"), agent: "Claude Code", parent: path.join(home, ".claude") },
  ];
  const chosen = roots.filter((r) => r.always || fs.existsSync(r.parent));
  for (const extra of values.target) chosen.push({ dir: path.resolve(extra), agent: "自定义" });
  return chosen;
}

function checkTool() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) bad(`需要 Node.js 22 或更新版本，当前为 ${process.versions.node}`);
  else ok(`Node.js ${process.versions.node}`);

  const missing = ["tsx", path.join("@getpaseo", "client")].filter(
    (m) => !fs.existsSync(path.join(toolDir, "node_modules", m)),
  );
  if (missing.length) bad(`依赖未安装（${missing.join("、")}）。请在 ${toolDir} 中执行 npm install`);
  else ok("依赖已安装");

  const config = path.join(toolDir, "pipeline.config.json");
  if (!fs.existsSync(config)) {
    if (!values.check) fs.copyFileSync(path.join(toolDir, "pipeline.config.example.json"), config);
    bad(`还没有配置文件。${values.check ? "" : "已从示例复制一份，"}请在 ${config} 中填写两个 agent 的 provider/model`);
  } else if (fs.readFileSync(config, "utf8").includes("CHANGE-ME")) {
    bad(`${config} 中的 provider 还是示例值，请填写真实的 provider/model（npm run smoke -- check 会列出可用的值）`);
  } else {
    ok(`配置文件 ${config}`);
  }
}

function renderSkill() {
  const source = path.join(toolDir, "skill", SKILL);
  // Forward slashes work for node on every platform and need no escaping in bash.
  const launcher = path.join(toolDir, "bin", "start-pipeline.mjs").split(path.sep).join("/");
  const files = {};
  for (const name of fs.readdirSync(source)) {
    let text = fs.readFileSync(path.join(source, name), "utf8");
    if (name === "SKILL.md") {
      if (!text.includes("{{PIPELINE_LAUNCHER}}")) throw new Error("SKILL.md 中缺少 {{PIPELINE_LAUNCHER}} 占位符");
      text = text.replaceAll("{{PIPELINE_LAUNCHER}}", launcher);
    }
    files[name] = text;
  }
  return { files, launcher };
}

function ownedByUs(dir) {
  return fs.existsSync(path.join(dir, MARKER));
}

function install(root, rendered) {
  const dir = path.join(root.dir, SKILL);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
    bad(`${root.agent}：${dir} 是一个符号链接，未改动。请删除它后重新运行，或用 --target 指定其他目录`);
    return;
  }
  if (fs.existsSync(dir) && !ownedByUs(dir) && !values.force) {
    bad(`${root.agent}：${dir} 已存在且不是本工具安装的，未覆盖。确认可以覆盖时加 --force`);
    return;
  }
  if (values.check) {
    const current = fs.existsSync(path.join(dir, "SKILL.md")) ? fs.readFileSync(path.join(dir, "SKILL.md"), "utf8") : null;
    if (current === null) bad(`${root.agent}：未安装（${dir}）`);
    else if (current !== rendered.files["SKILL.md"]) bad(`${root.agent}：已安装但不是最新版本，请重新运行 node install.mjs`);
    else ok(`${root.agent}：已安装（${dir}）`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(rendered.files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(
    path.join(dir, MARKER),
    JSON.stringify({ toolDir, launcher: rendered.launcher, installedAt: new Date().toISOString() }, null, 2),
  );
  ok(`${root.agent}：已安装到 ${dir}`);
}

function checkDependencies(root) {
  const missing = DEPENDENCIES.filter((name) => !fs.existsSync(path.join(root.dir, name, "SKILL.md")));
  if (missing.length === 0) {
    ok(`${root.agent}：依赖的 skill（${DEPENDENCIES.join("、")}）已安装`);
    return true;
  }
  bad(`${root.agent}：缺少依赖的 skill：${missing.join("、")}`);
  return false;
}

function uninstall(root) {
  const dir = path.join(root.dir, SKILL);
  if (!fs.existsSync(dir)) return;
  if (!ownedByUs(dir)) {
    info(`${dir} 不是本工具安装的，未删除`);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  ok(`已删除 ${dir}`);
}

const roots = skillRoots();

if (values.uninstall) {
  for (const root of roots) uninstall(root);
  process.exit(0);
}

console.log(values.check ? "检查安装情况：\n" : "安装需求开发工作流：\n");
checkTool();
console.log("");
const rendered = renderSkill();
let depsMissing = false;
for (const root of roots) {
  install(root, rendered);
  if (!checkDependencies(root)) depsMissing = true;
}

console.log("");
if (depsMissing) {
  info("安装依赖的 skill（全局安装，会提示选择 agent；Windows 上建议加 --copy）：");
  info("  npx skills add mattpocock/skills -g --copy");
  info("装好后重新运行 node install.mjs 检查。");
  console.log("");
}
info(`流水线启动命令：node "${rendered.launcher}"`);
if (problems === 0) {
  info(values.check ? "一切就绪。" : "完成。新开的 Paseo 对话中即可使用 /requirement-kickoff；已经打开的对话需要新开一个才能看到。");
} else {
  info(`有 ${problems} 项需要处理，见上面的 ✗。`);
}
process.exit(problems === 0 ? 0 : 1);
