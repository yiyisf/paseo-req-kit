#!/usr/bin/env node
// The `req` command: short names for the things people do in a terminal.
// install.mjs writes ~/.req-kit/bin/req (and req.cmd on Windows) pointing here.
// Everything it does is also available through the full commands it prints in `req help`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findTsxCli, layoutOf } from "./locate.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(kitRoot, "package.json"), "utf8")).version;
const tsxCli = findTsxCli(kitRoot) ?? path.join(kitRoot, "node_modules", "tsx", "dist", "cli.mjs");
const launcher = path.join(kitRoot, "bin", "start-pipeline.mjs");

const HELP = `req-kit ${version}（${kitRoot}）

在项目目录（或它的工作区）中运行：
  req list                     列出这个项目的所有需求和阶段
  req status [需求]            查看进度；只有一个需求运行过时可以不写
  req stop <需求>              停止流水线（之后可以继续）
  req resume <需求>            从上次中断处继续；需求改过时只处理变化的部分
  req approve <需求>           需求方确认了方案（方案确认点，见 preview.md），继续开发
  req verify <需求> [--verify-env local|deployed] [--defects fix|handback|report]
                               研发完成后开始测试验证（分阶段执行时）
  req start <需求> [--profile quick|standard] [--phases gated] [--at 22:00]
                               启动流水线（通常由 /req 在对话中启动，这里用于终端中手工启动）
  req digest [--notify]        项目的需求总览；--notify 同时发到外部通知（如企业 IM）
  req digest --schedule "0 9 * * 1"
                               让 Paseo 按时间表发送需求总览（例子为每周一 9:00）；取消：req digest --cancel <ID>
  req sync <需求>              把需求同步到对接的外部系统（补发失败的调用、补建卡片、更新状态）
  req integration test [需求]  只显示对接外部系统时会执行的命令，不真正调用
  req start --from <系统>:<卡号>  从需求管理系统中的一张卡片开始需求（没有人开着对话也可以）
  req card check [<卡号>|--all]  读取需求方在卡片中的回复，转给需求的会话
  req card publish <卡号>      把需求会话写的 card-ai.md 写进卡片的 AI 区
  req card list                本机从卡片开始的需求
  req card route               本机接收卡片的仓库和子系统（--add <仓库> 登记）
  req factory start|stop|status  接单器：定时为标题带 [AI] 的新卡片开始需求、转达回复（once 检查一次）

使用情况（可以在任何目录运行）：
  req stats [--since 30d] [--month 2026-10]
                               本机的使用统计：需求数、交付周期、返工、等待、各步骤用时、用量
  req stats --report [--out 目录]
                               生成汇报用的汇总（.md）和每个需求一行的表格（.csv）
  req stats --export [文件]    导出本机的运行记录；汇总多台机器：req stats --merge <文件…> --report
  req index [--rebuild [目录…]] [--prune]
                               本机记录的需求（Paseo 插件据此找到所有需求）；1.9 之前运行过的用 --rebuild 补登
  req api <命令> …             给程序用的 JSON 输出（见 contracts/cli-json.md）

Paseo 插件（在 Paseo 中查看和管理需求）：
  req plugin install [--yes]   安装或更新插件；需要时会询问是否打开 Paseo 的插件总开关
  req plugin status            插件是否在运行
  req plugin remove            从 Paseo 移除插件

本机维护：
  req doctor [--no-project]    体检：安装、配置、daemon、当前项目
  req configure                配置向导：选择 builder 和 reviewer 用的 agent
  req configure --auto         不提问，按推荐选好 builder、reviewer 和备用模型
  req upgrade [版本] [--beta]  升级到最新版本（或指定版本），自动选能支持本机 Paseo 的版本；
                               req upgrade --check 只看有没有新版本
  req versions                 已安装的版本和 npm 上的版本
  req use <版本>               切换到已安装的另一个版本（回滚）
  req check                    检查安装状态
  req notify-test [--type blocked|failed|completed|milestone|permission]
                               给配置的外部通知（如企业 IM）发一条测试消息
  req version                  显示版本和安装位置

<需求> 可以写功能目录（docs/features/20261012-sms-login）、目录名，或名称中能唯一确定的一部分（sms-login）。
在对话中的用法见 /req；完整说明见 ${path.join(kitRoot, "docs", "guide")}。`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function node(args) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", windowsHide: true });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function needTsx() {
  if (fs.existsSync(tsxCli)) return true;
  console.error(`依赖未安装：在 ${kitRoot} 中执行 npm install，然后运行 node install.mjs`);
  return false;
}

/** Takes the first argument as the requirement, unless it is an option. */
function feature(rest, required) {
  if (rest[0] && !rest[0].startsWith("-")) return ["--feature", rest[0], ...rest.slice(1)];
  if (required) {
    console.error(`请写出是哪个需求，例如：req ${command} sms-login（用 req list 查看全部需求）`);
    process.exit(2);
  }
  return rest;
}

const [command = "help", ...rest] = process.argv.slice(2);
const installer = path.join(kitRoot, "install.mjs");
const MANAGED = { setup: ["--setup"], upgrade: ["--upgrade"], use: ["--use"], versions: ["--versions"] };

// Installed with `npm i -g`: this copy manages the versions under ~/tools/req-kit/versions
// and hands every other command to the version in use.
if (layoutOf(kitRoot).kind === "manager") {
  if (command in MANAGED) {
    const flags = command === "upgrade" && rest.includes("--check") ? ["--latest"] : MANAGED[command];
    process.exit(node([installer, ...flags, ...rest.filter((a) => a !== "--check")]));
  }
  const kitHome = process.env.REQ_KIT_HOME?.trim() ? path.resolve(process.env.REQ_KIT_HOME.trim()) : path.join(os.homedir(), ".req-kit");
  const active = readJson(path.join(kitHome, "active.json"));
  const activeReq = active?.root ? path.join(active.root, "bin", "req.mjs") : null;
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`req-kit 管理器 ${version}（${kitRoot}）`);
    console.log(active ? `当前启用的版本：${active.version}（${active.root}）` : "还没有启用任何版本：运行 req setup");
    process.exit(0);
  }
  if (!activeReq || !fs.existsSync(activeReq)) {
    if (["help", "--help", "-h"].includes(command)) {
      console.log(`req-kit 管理器 ${version}\n\n还没有安装任何版本。先运行：req setup\n\n其他命令：req versions、req upgrade、req use <版本>`);
      process.exit(0);
    }
    console.error(active ? `当前启用的版本 ${active.version} 不在了（${active.root}）。运行 req versions 查看已安装的版本，再 req use <版本>。` : "还没有安装任何 req-kit 版本。先运行：req setup");
    process.exit(1);
  }
  process.exit(node([activeReq, command, ...rest]));
}

let code;
switch (command) {
  case "list":
  case "ls":
    code = node([launcher, "--list", ...rest]);
    break;
  case "status":
  case "st":
    code = node([launcher, "--status", ...feature(rest, false)]);
    break;
  case "stop":
    code = node([launcher, "--stop", ...feature(rest, true)]);
    break;
  case "resume":
    code = node([launcher, "--resume", ...feature(rest, true)]);
    break;
  case "verify":
    code = node([launcher, "--phase", "verify", ...feature(rest, true)]);
    break;
  case "approve":
    code = node([launcher, "--approve", ...feature(rest, true)]);
    break;
  case "start":
    // From a card in the requirement management system (1.10): no chat needed to begin.
    if (rest.some((a) => a === "--from" || a.startsWith("--from="))) code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "card-cmd.ts"), "start", ...rest]) : 1;
    else code = node([launcher, ...feature(rest, true)]);
    break;
  case "card":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "card-cmd.ts"), ...rest]) : 1;
    break;
  case "factory":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "factory.ts"), ...rest]) : 1;
    break;
  case "doctor":
    code = node([path.join(kitRoot, "bin", "req-doctor.mjs"), ...rest]);
    break;
  case "configure":
  case "config":
    code = node([path.join(kitRoot, "install.mjs"), "--configure", ...rest]);
    break;
  case "upgrade":
    code = rest.includes("--check")
      ? node([path.join(kitRoot, "install.mjs"), "--latest", ...rest.filter((a) => a !== "--check")])
      : node([path.join(kitRoot, "install.mjs"), "--upgrade", ...rest]);
    break;
  case "setup":
  case "use":
  case "versions":
    code = node([installer, ...MANAGED[command], ...rest]);
    break;
  case "check":
    code = node([path.join(kitRoot, "install.mjs"), "--check", ...rest]);
    break;
  case "digest":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "digest.ts"), ...rest]) : 1;
    break;
  case "stats":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "stats.ts"), ...rest]) : 1;
    break;
  case "index":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "index-cmd.ts"), ...rest]) : 1;
    break;
  case "api":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "api.ts"), ...rest]) : 1;
    break;
  case "sync":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "integration-cmd.ts"), "sync", ...rest]) : 1;
    break;
  case "integration":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "integration-cmd.ts"), ...rest]) : 1;
    break;
  case "plugin":
    code = node([path.join(kitRoot, "bin", "req-plugin.mjs"), ...rest]);
    break;
  case "notify-test":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "notify-test.ts"), ...rest]) : 1;
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(`req-kit ${version}（${kitRoot}）`);
    code = 0;
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    code = 0;
    break;
  default:
    console.error(`没有 "${command}" 这个命令。\n`);
    console.error(HELP);
    code = 2;
}
process.exit(code);
