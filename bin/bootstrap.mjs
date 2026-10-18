#!/usr/bin/env node
// `req install` (1.13): the whole one-step install in Node.js, so a machine that can reach an
// npm registry (the public one or a company mirror) needs nothing else:
//
//   npx -y paseo-req-kit@latest install
//   npx -y --registry=https://npm.example.internal/ paseo-req-kit@latest install
//
// Steps: check Node.js, npm and git; use (and save) the npm registry; npm install -g this
// version; check Paseo (install the matching Paseo CLI when there is neither a paseo command
// nor a running daemon, turn on its web UI, start the daemon); req setup; req configure --auto;
// offer the Paseo plugin. Running it again upgrades in place. install.sh and install.ps1 only
// pick the version and run this.
//
// Tests: REQ_KIT_NPM (a script standing in for npm), REQ_KIT_PASEO_BIN (the paseo command; empty:
// none), REQ_KIT_PASEO_URL (the daemon), REQ_KIT_PASEO_WAIT (seconds to wait for it to start).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8"));
const WINDOWS = process.platform === "win32";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

const HELP = `用法：npx -y [--registry=<npm 源>] paseo-req-kit@latest install [选项]
      （已安装时也可以运行 req install）

  --registry <地址>    从这个 npm 源安装（例如公司的 npm 镜像），并保存为本机的 npm 源，
                       以后 req upgrade 也用它
  --no-save-registry   只在这次安装中使用 --registry，不保存
  --no-configure       不运行选择 agent 的配置向导
  --skip-paseo         不检查、不安装、不启动 Paseo
  --with-plugin        不询问，直接安装 Paseo 的 req-kit 插件（会打开 Paseo 的插件总开关）
  --no-plugin          不安装、也不询问 Paseo 插件
  -h, --help           显示这段说明

安装 beta 版：npx -y paseo-req-kit@beta install；指定版本：npx -y paseo-req-kit@1.13.0 install`;

const say = (text = "") => console.log(text);
const step = (text) => console.log(`\n\x1b[1m==> ${text}\x1b[0m`);
const ok = (text) => console.log(`  \x1b[32m✓\x1b[0m ${text}`);
const warn = (text) => console.log(`  \x1b[33m!\x1b[0m ${text}`);
class Abort extends Error {}
const die = (text) => {
  throw new Abort(text);
};

// ---------------------------------------------------------------------------
// Options

export function parseArgs(argv) {
  const opts = { registry: null, saveRegistry: true, configure: true, paseo: true, plugin: "ask", spec: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name) => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) die(`${name} 后面要写地址，例如 ${name} https://npm.example.internal/`);
      return argv[++i];
    };
    if (a === "--registry") opts.registry = value("--registry");
    else if (a.startsWith("--registry=")) opts.registry = a.slice("--registry=".length);
    else if (a === "--spec") opts.spec = value("--spec");
    else if (a.startsWith("--spec=")) opts.spec = a.slice("--spec=".length);
    else if (a === "--no-save-registry") opts.saveRegistry = false;
    else if (a === "--no-configure") opts.configure = false;
    else if (a === "--skip-paseo") opts.paseo = false;
    else if (a === "--with-plugin") opts.plugin = "yes";
    else if (a === "--no-plugin") opts.plugin = "no";
    else if (a === "-h" || a === "--help") opts.help = true;
    else die(`不认识的选项：${a}（--help 查看用法）`);
  }
  if (opts.registry !== null && !/^https?:\/\/\S+$/.test(opts.registry)) die(`--registry 要写完整的地址，例如 https://npm.example.internal/（现在是 ${opts.registry || "空"}）`);
  return opts;
}

/** Registry addresses compare equal with or without the trailing slash. */
export function sameRegistry(a, b) {
  const norm = (u) => String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Running things

/**
 * The environment for child commands. Running under npx adds settings meant for npx itself
 * (which package to run, "yes"); they are dropped. The registry is set explicitly.
 */
function childEnv(registry) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const k = key.toLowerCase();
    if (["npm_config_package", "npm_config_yes", "npm_config_call", "npm_config_local_prefix", "npm_command", "npm_package_json"].includes(k) || k.startsWith("npm_lifecycle_")) delete env[key];
    if (k === "npm_config_registry") delete env[key];
  }
  if (registry) env.npm_config_registry = registry;
  return env;
}

let ENV = childEnv(null);

function quoteForCmd(args) {
  return args.map((a) => (/[\s&()^|<>"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
}

/** Runs a command; on Windows .cmd shims (npm, paseo) need the shell. */
function run(command, args, { inherit = false, env = ENV, timeout = 900_000, input } = {}) {
  const shell = WINDOWS && !/\.exe$/i.test(command);
  const result = spawnSync(command, shell ? quoteForCmd(args) : args, {
    encoding: "utf8",
    windowsHide: true,
    shell,
    env,
    timeout,
    input,
    stdio: inherit ? "inherit" : input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function npm(args, options = {}) {
  const fake = process.env.REQ_KIT_NPM?.trim();
  if (fake) return run(process.execPath, [fake, ...args], options);
  return run(WINDOWS ? "npm.cmd" : "npm", args, options);
}

const node = (args, options = {}) => run(process.execPath, args, { inherit: true, ...options });

/**
 * The first `name` on PATH (with PATHEXT on Windows), skipping copies inside `skipRoot`: under
 * npx, PATH starts with npx's own folder, which has this temporary copy's req.
 */
export function which(name, env = process.env, skipRoot = null) {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = WINDOWS ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())] : [""];
  const skip = skipRoot ? safeRealpath(skipRoot) : null;
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (!WINDOWS) fs.accessSync(file, fs.constants.X_OK);
      } catch {
        continue;
      }
      if (skip) {
        const real = safeRealpath(file);
        if (real === skip || real.startsWith(skip + path.sep) || dir.split(/[\\/]/).includes("_npx")) continue;
      }
      return file;
    }
  }
  return null;
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function daemonStatus(url) {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(3000) });
    let version = "";
    try {
      version = (await response.json())?.version ?? "";
    } catch {
      /* any answer means a daemon is listening (even 401 with a password set) */
    }
    return { up: true, version: String(version) };
  } catch {
    return { up: false, version: "" };
  }
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } catch {
    return "n";
  } finally {
    rl.close();
  }
}

const interactive = () => Boolean(process.stdin.isTTY) && process.env.REQ_KIT_NO_TTY !== "1";

// ---------------------------------------------------------------------------
// The install

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    say(HELP);
    return 0;
  }
  const spec = opts.spec ?? process.env.REQ_KIT_INSTALL_SPEC?.trim() ?? `${PKG.name}@${PKG.version}`;
  say(`安装 req-kit ${PKG.version}：Paseo 上的需求开发体系`);

  // -------------------------------------------------------------------------
  step("检查环境");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) die(`需要 Node.js 22 或更新版本，当前是 ${process.version}。请升级 Node.js 后重新运行`);
  ok(`Node.js ${process.version}`);
  const npmVersion = npm(["--version"], { timeout: 60_000 });
  if (npmVersion.status !== 0) die("没有找到 npm（通常随 Node.js 一起安装）");
  ok(`npm ${npmVersion.stdout.trim() || "?"}`);
  const git = run(WINDOWS ? "git.exe" : "git", ["--version"], { timeout: 30_000 });
  if (git.status === 0) ok(`git ${git.stdout.trim().replace(/^git version /, "")}`);
  else warn("没有找到 git：流水线需要在 git 仓库中工作，请稍后安装");

  // -------------------------------------------------------------------------
  step("npm 源");
  // `npx --registry=…` passes it on as npm_config_registry; --registry says it explicitly.
  const wanted = opts.registry ?? process.env.npm_config_registry?.trim() ?? process.env.NPM_CONFIG_REGISTRY?.trim() ?? null;
  const savedResult = npm(["config", "get", "registry"], { env: childEnv(null), timeout: 60_000 });
  const saved = savedResult.status === 0 ? savedResult.stdout.trim() || DEFAULT_REGISTRY : DEFAULT_REGISTRY;
  let registry = saved;
  if (wanted && !sameRegistry(wanted, saved)) {
    registry = wanted;
    if (opts.saveRegistry) {
      const set = npm(["config", "set", "registry", wanted], { env: childEnv(null), timeout: 60_000 });
      if (set.status === 0) ok(`已把本机的 npm 源设为 ${wanted}（原来是 ${saved}）。以后 req upgrade 也从这里取`);
      else warn(`没能保存 npm 源（${(set.stderr || set.stdout).trim().split("\n").at(-1) ?? ""}），这次安装照常使用 ${wanted}。之后可以运行：npm config set registry ${wanted}`);
    } else {
      ok(`这次安装使用 ${wanted}（没有保存，本机的 npm 源仍是 ${saved}）`);
    }
  } else {
    ok(`npm 源：${saved}`);
  }
  ENV = childEnv(registry);
  if (sameRegistry(registry, DEFAULT_REGISTRY)) say("  公司内网请改用镜像：npx -y --registry=<镜像地址> paseo-req-kit@latest install");

  // -------------------------------------------------------------------------
  step(`安装 ${PKG.name} ${PKG.version}`);
  if (/^[@a-z0-9][^\s]*@[^/\\\s]+$/i.test(spec) && !/^[a-z]+:/i.test(spec)) {
    const found = npm(["view", spec, "version"], { timeout: 120_000 });
    if (found.status !== 0 || !found.stdout.trim()) {
      die(`npm 源 ${registry} 上找不到 ${spec}。镜像可能还没有同步这个版本，稍后再试；或用 --registry 换一个 npm 源`);
    }
  }
  let prefix = npm(["prefix", "-g"], { timeout: 60_000 }).stdout.trim();
  let ownPrefix = false;
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (!prefix || (!root && !writable(prefix))) {
    // A system Node.js (e.g. /usr/local) needs sudo for global installs; use a directory of our own.
    prefix = path.join(os.homedir(), ".req-kit", "npm");
    ownPrefix = true;
    fs.mkdirSync(prefix, { recursive: true });
    warn(`npm 的全局目录不可写，改装到 ${prefix}（不需要 sudo）`);
  }
  const prefixArgs = ownPrefix ? ["--prefix", prefix] : [];
  const installed = npm(["install", "-g", ...prefixArgs, spec], { inherit: true });
  if (installed.status !== 0) die("npm 安装失败（见上面的输出）。公司内网请确认 npm 源是镜像地址（--registry）");
  const npmRoot = npm(["root", "-g", ...prefixArgs], { timeout: 60_000 }).stdout.trim();
  const reqMjs = path.join(npmRoot, PKG.name, "bin", "req.mjs");
  if (!fs.existsSync(reqMjs)) die(`安装后没有找到 ${reqMjs}`);
  ok(`已安装到 ${path.join(npmRoot, PKG.name)}`);
  const binDir = WINDOWS ? prefix : path.join(prefix, "bin");
  const installedPkg = JSON.parse(fs.readFileSync(path.join(npmRoot, PKG.name, "package.json"), "utf8"));
  const req = (args, options = {}) => node([reqMjs, ...args], options);

  // -------------------------------------------------------------------------
  // Paseo: req-kit runs on a Paseo daemon on this machine.
  const daemonUrl = process.env.REQ_KIT_PASEO_URL?.trim() || "http://127.0.0.1:6767";
  let paseoCmd = null;
  if (opts.paseo) {
    step("检查 Paseo");
    const range = installedPkg.reqKit?.paseo ?? "";
    const minor = /(\d+\.\d+)/.exec(range)?.[1] ?? "";
    if ("REQ_KIT_PASEO_BIN" in process.env) {
      const bin = process.env.REQ_KIT_PASEO_BIN;
      if (bin && fs.existsSync(bin)) paseoCmd = bin;
    } else {
      paseoCmd = which("paseo", ENV);
    }
    const paseo = (args, options) => run(paseoCmd, args, { timeout: 120_000, ...options });

    const status = await daemonStatus(daemonUrl);
    if (!paseoCmd && status.up) {
      // The desktop app runs its own daemon and does not put the paseo command on PATH.
      ok(`Paseo daemon 已在运行${status.version ? `（${status.version}）` : ""}，没有 paseo 命令（通常是桌面版 Paseo 管理的 daemon）`);
      warn("需要网页界面时，在桌面版的设置中开启，或安装 Paseo 命令行后运行 paseo daemon config set features.webUi.enabled true");
    } else {
      if (!paseoCmd) {
        say(`  没有找到 Paseo，安装 Paseo ${minor} 系列的最新版（@getpaseo/cli@~${minor}.0，这个版本的 req-kit 支持 ${range}）`);
        const result = npm(["install", "-g", ...prefixArgs, `@getpaseo/cli@~${minor}.0`], { inherit: true });
        if (result.status !== 0) die("Paseo 安装失败（见上面的输出）。也可以自己安装 Paseo 后重新运行");
        const candidates = WINDOWS ? [path.join(binDir, "paseo.cmd"), path.join(binDir, "paseo")] : [path.join(binDir, "paseo")];
        paseoCmd = candidates.find((c) => fs.existsSync(c)) ?? which("paseo", ENV) ?? candidates[0];
        ok("已安装 Paseo");
      }
      const v = /(\d+\.\d+\.\d+)/.exec(paseo(["--version"]).stdout)?.[1];
      if (v) {
        if (v.startsWith(`${minor}.`)) ok(`Paseo ${v}`);
        else warn(`Paseo 是 ${v}，这个版本的 req-kit 支持 ${range}。请换成匹配的 Paseo，或用 req upgrade 选择支持它的 req-kit`);
      }
      let changed = false;
      if (/"value":\s*true/.test(paseo(["daemon", "config", "get", "features.webUi.enabled"]).stdout)) ok("Paseo 网页界面已开启");
      else if (paseo(["daemon", "config", "set", "features.webUi.enabled", "true"]).status === 0) {
        ok("已开启 Paseo 自带的网页界面（features.webUi.enabled）");
        changed = true;
      } else warn("没能开启 Paseo 的网页界面，之后可以运行：paseo daemon config set features.webUi.enabled true");

      if ((await daemonStatus(daemonUrl)).up) {
        if (changed) warn("Paseo daemon 正在运行，网页界面要在重启后生效：paseo daemon restart（会中断正在运行的 agent，方便时再重启）");
        else ok("Paseo daemon 正在运行");
      } else if (paseo(["daemon", "start"]).status === 0) {
        // Wait for it to answer: the wizard below asks the daemon for the agents.
        const wait = Number(process.env.REQ_KIT_PASEO_WAIT ?? 15);
        for (let i = 0; i < wait && !(await daemonStatus(daemonUrl)).up; i++) await new Promise((r) => setTimeout(r, 1000));
        ok("已启动 Paseo daemon");
      } else warn("没能启动 Paseo daemon，请运行 paseo daemon start 查看原因");
      say(`  Paseo 网页界面：${daemonUrl}/`);
    }

    const agents = ["claude", "codex", "opencode", "pi", "copilot"].filter((a) => which(a, ENV));
    if (agents.length > 0) ok(`agent 命令行：${agents.join(" ")}`);
    else warn("没有找到任何 agent 命令行（Claude Code、Codex、OpenCode、Pi、Copilot）。Paseo 要用它们干活：至少装一个并登录，再运行 req configure");
  }
  const reqEnv = paseoCmd ? { ...ENV, REQ_KIT_PASEO_BIN: paseoCmd } : ENV;

  // -------------------------------------------------------------------------
  step("启用这个版本，安装 /req 等 skill");
  const kitHome = process.env.REQ_KIT_HOME?.trim() ? path.resolve(process.env.REQ_KIT_HOME.trim()) : path.join(os.homedir(), ".req-kit");
  const config = path.join(kitHome, "config.json");
  const unfilled = () => {
    try {
      return fs.readFileSync(config, "utf8").includes("CHANGE-ME");
    } catch {
      return false;
    }
  };
  // On a new machine setup ends with "fill in the agents" (✗), which the wizard below does.
  if (req(["setup"], { env: reqEnv }).status !== 0 && !unfilled()) die("req setup 没有完成（见上面的输出）。修复后可以重新运行安装命令");

  // -------------------------------------------------------------------------
  if (opts.configure && unfilled()) {
    step("选择 agent");
    // No questions: the logged-in agents are picked as recommended; change them later with
    // req configure or in Paseo (Settings → Plugins → req-kit).
    if (req(["configure", "--auto"], { env: reqEnv }).status === 0) req(["check"], { env: reqEnv });
    else if (interactive()) {
      warn("没能自动选好 agent，改为逐项选择");
      if (req(["configure"], { env: reqEnv }).status === 0) req(["check"], { env: reqEnv });
      else warn("配置向导没有完成，之后可以运行 req configure");
    } else warn("没能自动选好 agent（Paseo 在运行、至少登录一种 agent 后再试）。之后运行：req configure --auto");
  }

  // -------------------------------------------------------------------------
  // The req-kit plugin for Paseo. Already installed: req setup above refreshed it.
  const pluginDir = path.join(kitHome, "paseo-plugin");
  if (opts.plugin !== "no" && !fs.existsSync(path.join(pluginDir, "paseo-plugin.json")) && (paseoCmd || opts.plugin === "yes")) {
    step("Paseo 插件");
    say("  req-kit 插件在 Paseo（网页端、桌面版、手机）中显示需求总览、进度和文档，并可以确认方案、停止、继续。");
    const fail = () => warn("插件没有装好（见上面的输出），之后可以运行 req plugin install");
    if (opts.plugin === "yes") {
      if (req(["plugin", "install", "--yes"], { env: reqEnv }).status !== 0) fail();
    } else if (interactive()) {
      const answer = await ask("  安装 req-kit 插件？[Y/n] ");
      if (/^n(o)?$/i.test(answer)) say("  跳过。之后可以运行 req plugin install");
      else if (req(["plugin", "install"], { env: reqEnv }).status !== 0) fail();
    } else say("  没有可交互的终端，跳过。之后运行：req plugin install");
  }

  // -------------------------------------------------------------------------
  step("完成");
  const found = which("req", ENV, KIT_ROOT === path.join(npmRoot, PKG.name) ? null : KIT_ROOT);
  const expected = [path.join(binDir, "req"), path.join(binDir, "req.cmd")].map(safeRealpath);
  if (found && expected.includes(safeRealpath(found))) ok(`req 命令可用：${found}`);
  else if (!found) {
    if (WINDOWS) warn(`req 命令还不在 PATH 中。把 ${binDir} 加到用户环境变量 Path 中，然后重新打开终端`);
    else {
      warn("req 命令还不在 PATH 中。把下面这行加到 ~/.bashrc 或 ~/.zshrc，然后重新打开终端：");
      say(`      export PATH="${binDir}:$PATH"`);
    }
  } else warn(`PATH 中的 req 是 ${found}，不是刚装的这个；可以改用同名命令 req-kit，或把 ${binDir} 放到 PATH 的前面`);
  req(["version"], { env: reqEnv });

  say("");
  say("下一步：");
  say(`  1. 运行 req doctor 检查 Paseo daemon 和 agent 是否就绪；在浏览器打开 ${daemonUrl}/ 就是 Paseo 的网页界面`);
  say("  2. 在项目的 Paseo 对话中运行 /req-setup 接入项目（每个项目一次）");
  say("  3. 在 Paseo 对话中输入 /req 和一句话需求，例如：/req 登录页增加短信验证码登录");
  say("文档：运行 req docs 在本机打开（和装的版本一致，不需要外网）");
  return 0;
}

const isMain = process.argv[1] && safeRealpath(process.argv[1]) === safeRealpath(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof Abort) {
        console.error(`\n\x1b[31m✗\x1b[0m ${error.message}`);
        process.exit(1);
      }
      console.error(error?.stack ?? String(error));
      process.exit(1);
    },
  );
}
