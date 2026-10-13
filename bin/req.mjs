#!/usr/bin/env node
// The `req` command: short names for the things people do in a terminal.
// install.mjs writes ~/.req-kit/bin/req (and req.cmd on Windows) pointing here.
// Everything it does is also available through the full commands it prints in `req help`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(kitRoot, "package.json"), "utf8")).version;
const tsxCli = path.join(kitRoot, "node_modules", "tsx", "dist", "cli.mjs");
const launcher = path.join(kitRoot, "bin", "start-pipeline.mjs");

const HELP = `req-kit ${version}（${kitRoot}）

在项目目录（或它的工作区）中运行：
  req list                     列出这个项目的所有需求和阶段
  req status [需求]            查看进度；只有一个需求运行过时可以不写
  req stop <需求>              停止流水线（之后可以继续）
  req resume <需求>            从上次中断处继续；需求改过时只处理变化的部分
  req start <需求> [--profile quick|standard] [--at 22:00]
                               启动流水线（通常由 /req 在对话中启动，这里用于终端中手工启动）
  req digest [--notify]        项目的需求总览；--notify 同时发到外部通知（如企业 IM）
  req digest --schedule "0 9 * * 1"
                               让 Paseo 按时间表发送需求总览（例子为每周一 9:00）；取消：req digest --cancel <ID>

本机维护：
  req doctor [--no-project]    体检：安装、配置、daemon、当前项目
  req configure                配置向导：选择 builder 和 reviewer 用的 agent
  req upgrade [版本]           升级到最新版本（或指定版本）；req upgrade --check 只看有没有新版本
  req check                    检查安装状态
  req notify-test [--type blocked|failed|completed|milestone|permission]
                               给配置的外部通知（如企业 IM）发一条测试消息
  req version                  显示版本和安装位置

<需求> 可以写功能目录（docs/features/20261012-sms-login）、目录名，或名称中能唯一确定的一部分（sms-login）。
在对话中的用法见 /req；完整说明见 ${path.join(kitRoot, "docs", "guide")}。`;

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
  case "start":
    code = node([launcher, ...feature(rest, true)]);
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
  case "check":
    code = node([path.join(kitRoot, "install.mjs"), "--check", ...rest]);
    break;
  case "digest":
    code = needTsx() ? node([tsxCli, path.join(kitRoot, "engine", "src", "digest.ts"), ...rest]) : 1;
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
