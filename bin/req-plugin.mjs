// `req plugin`: the req-kit plugin for Paseo (1.9, ADR 0027).
//
//   req plugin install [--yes]   copy the plugin to <kit home>/paseo-plugin and install it in Paseo
//   req plugin status            whether it is installed and running
//   req plugin remove            remove it from Paseo
//
// The plugin ships inside this package (paseo-plugin/). It is installed from a fixed copy under
// the kit home, so upgrading or switching req-kit versions only refreshes that copy and reloads
// the plugin (refreshPlugin, called by install.mjs); the plugin always matches the active version.
// Turning on Paseo's plugin switch (pluginsEnabled) needs the person's consent: plugins run
// unsandboxed on this machine.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "req-kit";
const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function kitHome(env = process.env) {
  const override = env.REQ_KIT_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".req-kit");
}

export function stagedDir(home = kitHome()) {
  return path.join(home, "paseo-plugin");
}

/** Copies this version's plugin to the fixed directory Paseo installs from. */
export function stagePlugin(kitRoot = KIT_ROOT, home = kitHome()) {
  const from = path.join(kitRoot, "paseo-plugin");
  if (!fs.existsSync(path.join(from, "paseo-plugin.json"))) throw new Error(`这个版本的 req-kit 没有附带 Paseo 插件（${from}）`);
  const to = stagedDir(home);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !path.relative(from, src).split(path.sep).includes("node_modules"),
  });
  return to;
}

/** The paseo command: REQ_KIT_PASEO_BIN (tests; empty means none), else paseo on PATH. */
function paseoCommand(env = process.env) {
  if (env.REQ_KIT_PASEO_BIN !== undefined) return env.REQ_KIT_PASEO_BIN || null;
  const cmd = process.platform === "win32" ? "paseo.cmd" : "paseo";
  return run(cmd, ["--version"], 30_000, env).status === 0 ? cmd : null;
}

// A .cmd shim on Windows only runs through the shell; quote what the shell would split.
const WINDOWS = process.platform === "win32";
const quote = (a) => (WINDOWS && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function run(cmd, args, timeout, env = process.env) {
  return spawnSync(WINDOWS ? quote(cmd) : cmd, WINDOWS ? args.map(quote) : args, { encoding: "utf8", windowsHide: true, timeout, shell: WINDOWS, env });
}

function paseo(cmd, args, env = process.env) {
  const r = run(cmd, args, 180_000, env);
  let json = null;
  try {
    json = JSON.parse((r.stdout ?? "").trim());
  } catch {
    json = null;
  }
  return { ok: r.status === 0, json, text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function pluginEntry(cmd, env = process.env) {
  const r = paseo(cmd, ["plugin", "ls", "--json"], env);
  if (!r.ok) return { error: r.text };
  const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.data) ? r.json.data : [];
  return { entry: list.find((p) => p.id === PLUGIN_ID) ?? null };
}

function pluginsEnabled(cmd, env = process.env) {
  const r = paseo(cmd, ["daemon", "config", "get", "pluginsEnabled", "--json"], env);
  const value = r.json?.value ?? r.json?.data?.value;
  return value === true;
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(y|yes|是|好|可以)$/i.test(answer.trim()));
    }),
  );
}

const say = (s) => console.log(s);

function manualSteps(dir) {
  say("也可以在 Paseo 中手动安装：");
  say("  1. 设置 → Plugins → 打开 Enable plugins（插件是不受限制的代码，可以访问这台机器上的文件和进程）");
  say(`  2. 在 Plugin source 中填：${dir}`);
}

export async function installPlugin({ yes = false, env = process.env, kitRoot = KIT_ROOT } = {}) {
  const dir = stagePlugin(kitRoot, kitHome(env));
  say(`插件文件：${dir}`);
  const cmd = paseoCommand(env);
  if (!cmd) {
    say("没有找到 paseo 命令（桌面版 Paseo 管理的 daemon 通常没有）。");
    manualSteps(dir);
    return 1;
  }
  if (!pluginsEnabled(cmd, env)) {
    say("");
    say("Paseo 的插件总开关（pluginsEnabled）是关着的。");
    say("插件是受信任、不受沙箱限制的代码：它的后台部分可以访问这台机器上的文件、进程和网络。");
    say("req-kit 插件只运行本机的 req 命令，不连接任何外部服务。");
    const agreed = yes || (await ask("打开 Paseo 的插件总开关并安装 req-kit 插件？[y/N] "));
    if (!agreed) {
      say("没有安装。之后可以运行 req plugin install（或加 --yes）。");
      manualSteps(dir);
      return 1;
    }
    const set = paseo(cmd, ["daemon", "config", "set", "pluginsEnabled", "true", "--json"], env);
    if (!set.ok) {
      say(`没能打开插件总开关：${set.text}`);
      manualSteps(dir);
      return 1;
    }
    say("✓ 已打开 Paseo 的插件总开关");
  }
  const found = pluginEntry(cmd, env);
  if (found.error) {
    say(`读取不了 Paseo 的插件列表：${found.error}`);
    say("请确认 Paseo daemon 在运行（paseo daemon status）。");
    return 1;
  }
  const r = found.entry ? paseo(cmd, ["plugin", "reload", PLUGIN_ID, "--json"], env) : paseo(cmd, ["plugin", "install", dir, "--json"], env);
  if (!r.ok) {
    say(`${found.entry ? "重新加载" : "安装"}失败：${r.text}`);
    say(`查看插件输出：paseo plugin logs ${PLUGIN_ID}`);
    return 1;
  }
  const after = pluginEntry(cmd, env).entry;
  if (after?.status === "running") {
    say(`✓ req-kit 插件${found.entry ? "已更新" : "已安装"}，正在运行。在 Paseo 侧边栏中点"需求"打开。`);
    return 0;
  }
  say(`插件状态：${after?.status ?? "未知"}${after?.error ? `（${after.error}）` : ""}。查看输出：paseo plugin logs ${PLUGIN_ID}`);
  return 1;
}

export function pluginStatus({ env = process.env } = {}) {
  const dir = stagedDir(kitHome(env));
  const staged = fs.existsSync(path.join(dir, "package.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version : null;
  say(staged ? `插件文件：${dir}（版本 ${staged}）` : "还没有准备插件文件：运行 req plugin install");
  const cmd = paseoCommand(env);
  if (!cmd) {
    say("没有找到 paseo 命令，无法查看 Paseo 中的状态（在 Paseo 的 设置 → Plugins 中查看）。");
    return staged ? 0 : 1;
  }
  const found = pluginEntry(cmd, env);
  if (found.error) {
    say(`读取不了 Paseo 的插件列表：${found.error}`);
    return 1;
  }
  if (!found.entry) {
    say("Paseo 中没有安装 req-kit 插件：运行 req plugin install");
    return 1;
  }
  say(`Paseo 中的 req-kit 插件：${found.entry.status}${found.entry.error ? `（${found.entry.error}）` : ""}`);
  if (!pluginsEnabled(cmd, env)) say("注意：Paseo 的插件总开关是关着的（设置 → Plugins → Enable plugins）。");
  return found.entry.status === "running" ? 0 : 1;
}

export function removePlugin({ env = process.env } = {}) {
  const cmd = paseoCommand(env);
  if (cmd) {
    const found = pluginEntry(cmd, env);
    if (found.entry) {
      const r = paseo(cmd, ["plugin", "remove", PLUGIN_ID, "--json"], env);
      if (!r.ok) {
        say(`移除失败：${r.text}`);
        return 1;
      }
      say("✓ 已从 Paseo 移除 req-kit 插件（Paseo 的插件总开关保持原样）");
    } else say("Paseo 中没有安装 req-kit 插件");
  } else say("没有找到 paseo 命令：请在 Paseo 的 设置 → Plugins 中移除 req-kit。");
  fs.rmSync(stagedDir(kitHome(env)), { recursive: true, force: true });
  return 0;
}

/**
 * After a version becomes active (req setup, upgrade, use): if the plugin was installed,
 * refresh its files from that version and reload it. Quiet and best effort.
 */
export function refreshPlugin({ kitRoot = KIT_ROOT, env = process.env, log = () => {} } = {}) {
  const home = kitHome(env);
  if (!fs.existsSync(path.join(stagedDir(home), "paseo-plugin.json"))) return false;
  try {
    stagePlugin(kitRoot, home);
  } catch (error) {
    log(`没能更新 Paseo 插件的文件：${error.message}`);
    return false;
  }
  const cmd = paseoCommand(env);
  const r = cmd ? paseo(cmd, ["plugin", "reload", PLUGIN_ID, "--json"], env) : null;
  log(r?.ok ? "Paseo 插件已更新到这个版本" : `Paseo 插件的文件已更新；在 Paseo 中重新加载它：paseo plugin reload ${PLUGIN_ID}（或 设置 → Plugins）`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sub = "status", ...rest] = process.argv.slice(2);
  let code;
  try {
    if (sub === "install") code = await installPlugin({ yes: rest.includes("--yes") || rest.includes("-y") });
    else if (sub === "status") code = pluginStatus();
    else if (sub === "remove" || sub === "uninstall") code = removePlugin();
    else {
      console.error(`没有 "${sub}" 这个子命令。可用：req plugin install [--yes]、req plugin status、req plugin remove`);
      code = 2;
    }
  } catch (error) {
    console.error(error.message);
    code = 1;
  }
  process.exit(code);
}
