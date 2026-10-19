// The Paseo plugin (paseo-plugin/): its daemon side runs `req api`, and `req plugin` installs it.
// Its app side (React Native) is typechecked in CI (.github/workflows/ci.yml) and checked by hand.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PLUGIN = path.join(ROOT, "paseo-plugin");

// The plugin is compiled by Paseo (bundler-style imports, its SDK as a dev dependency), so the
// repository's own typecheck does not follow into it: load its daemon side at run time.
type ReqError = Error & { code: string };
type Runner = (args: string[], options?: { timeoutMs?: number }) => Promise<unknown>;
interface ReqModule {
  activeReq(kitHome: string): string;
  coalesce<T>(ms: number, run: () => Promise<T>): () => Promise<T>;
  kitHomeOf(configured: string): string;
  reqApi(kitHome: () => string): Runner;
}
interface HandlersModule {
  createHandlers(input: { req: Runner; kitHome: () => string; readOnly: () => Promise<boolean> }): {
    list(): Promise<unknown[]>;
    run(input: { action: string; repo: string; featureDir: string; verifyEnv?: string }): Promise<{ ok: boolean; message: string }>;
    setAgents(input: { builder: object; reviewer: object; fallback: object | null }): Promise<{ ok: boolean; message: string }>;
  };
}
interface PluginCli {
  refreshPlugin(input: { kitRoot?: string; env?: NodeJS.ProcessEnv; log?: (message: string) => void }): boolean;
}
const load = <T>(file: string): Promise<T> => import(pathToFileURL(path.join(ROOT, file)).href) as Promise<T>;
const { activeReq, coalesce, kitHomeOf, reqApi } = await load<ReqModule>("paseo-plugin/server/req.ts");
const { createHandlers } = await load<HandlersModule>("paseo-plugin/server/handlers.ts");

function kitHomeWith(root: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-plugin-home-"));
  if (root) fs.writeFileSync(path.join(home, "active.json"), JSON.stringify({ version: PKG.version, root }));
  return home;
}

test("插件的清单与 req-kit 一致：同一个版本、同样的 Paseo 范围；代码只在 client/server/shared 中", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, "paseo-plugin.json"), "utf8"));
  assert.equal(manifest.id, "req-kit");
  assert.equal(manifest.requirements.paseo, PKG.reqKit.paseo);
  assert.equal(JSON.parse(fs.readFileSync(path.join(PLUGIN, "package.json"), "utf8")).version, PKG.version);
  assert.ok(PKG.files.includes("paseo-plugin/"));
  const rootCode = fs.readdirSync(PLUGIN).filter((f) => /\.(ts|tsx)$/.test(f));
  assert.deepEqual(rootCode.sort(), ["index.client.tsx", "index.server.ts"]);
  for (const dir of ["client", "shared"]) {
    for (const f of fs.readdirSync(path.join(PLUGIN, dir))) {
      const text = fs.readFileSync(path.join(PLUGIN, dir, f), "utf8");
      assert.doesNotMatch(text, /from "node:|from "\.\.\/server/, `${dir}/${f} 不能用 Node 或 server 的代码`);
      assert.doesNotMatch(text, /\b(document|window|localStorage|navigator)\.|className=|onClick=/, `${dir}/${f} 不能用 DOM`);
    }
  }
  // Paseo refuses the whole plugin when an RPC name breaks its rule (packages/plugin/src/rpc.ts).
  const contracts = fs.readFileSync(path.join(PLUGIN, "shared", "contracts.ts"), "utf8");
  const names = [...contracts.matchAll(/defineRpc\(\{\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 9);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9._-]*$/, `RPC 名称 ${name} 不符合 Paseo 的规则（只能用小写字母、数字、. _ -）`);
  assert.equal(new Set(names).size, names.length, "RPC 名称不能重复");
  for (const f of fs.readdirSync(path.join(PLUGIN, "server"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(PLUGIN, "server", f), "utf8"), /from "\.\.\/client|from "react/, `server/${f} 不能用 client 的代码`);
  }
});

test("插件后台：用本机启用的 req-kit 运行 req api；找不到 req-kit、需求不存在时给出说明", async () => {
  const home = kitHomeWith(ROOT);
  const req = reqApi(() => home);
  const info = (await req(["version"])) as { kitVersion: string; apiSchema: number };
  assert.equal(info.kitVersion, PKG.version);
  assert.equal(info.apiSchema, 1);
  await assert.rejects(req(["status", "nope", "--repo", os.tmpdir()]), (e: ReqError) => e.code === "not_found");

  const none = reqApi(() => kitHomeWith(null));
  await assert.rejects(none(["version"]), (e: ReqError) => e.code === "no_kit" && /没有找到 req-kit/.test(e.message));
  assert.throws(() => activeReq(kitHomeWith("/no/such/dir")), /当前启用的版本不在了/);
  assert.equal(kitHomeOf("~/x"), path.join(os.homedir(), "x"));
});

test("插件后台：只读时拒绝管理操作；操作转成 req api run；列表在短时间内共用一次查询", async () => {
  const calls: string[][] = [];
  let readOnly = true;
  const handlers = createHandlers({
    req: async (args) => {
      calls.push(args);
      return args[0] === "run" ? { ok: true, message: "已在后台启动", command: args[1] } : [];
    },
    kitHome: () => "/kit",
    readOnly: async () => readOnly,
  });
  const refused = await handlers.run({ action: "approve", repo: "/repo", featureDir: "docs/features/a" });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /只读/);
  assert.equal(calls.length, 0);
  readOnly = false;
  assert.deepEqual(await handlers.run({ action: "verify", repo: "/repo", featureDir: "docs/features/a", verifyEnv: "deployed" }), { ok: true, message: "已在后台启动" });
  assert.deepEqual(calls.at(-1), ["run", "verify", "docs/features/a", "--repo", "/repo", "--verify-env", "deployed"]);

  // 1.12: the inbox's answers become req api run reply with the text; an empty one is refused.
  await handlers.run({ action: "reply", repo: "/repo", featureDir: "docs/features/a", text: " 1. 只有新订单 " } as never);
  assert.deepEqual(calls.at(-1), ["run", "reply", "docs/features/a", "--repo", "/repo", "1. 只有新订单"]);
  assert.equal((await handlers.run({ action: "reply", repo: "/repo", featureDir: "docs/features/a", text: "  " } as never)).ok, false);

  // 1.12: the model settings page writes through req api set-agents; read-only refuses it too.
  const agents = { builder: { provider: "claude/x" }, reviewer: { provider: "codex/y" }, fallback: null };
  readOnly = true;
  assert.equal((await handlers.setAgents(agents)).ok, false);
  readOnly = false;
  await handlers.setAgents(agents);
  assert.deepEqual(calls.at(-1), ["set-agents", "--json", JSON.stringify(agents)]);

  await Promise.all([handlers.list(), handlers.list(), handlers.list()]);
  assert.equal(calls.filter((c) => c[0] === "list").length, 1);

  let n = 0;
  const shared = coalesce(1_000, async () => ++n);
  assert.equal(await shared(), 1);
  assert.equal(await shared(), 1);
});

function reqPlugin(home: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(ROOT, "bin", "req-plugin.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, REQ_KIT_HOME: home, ...env },
    input: "",
  });
}

test("req plugin：经同意才打开 Paseo 的插件总开关；安装、再次运行即更新、启用新版本时跟着更新、移除", { skip: process.platform === "win32" ? "用 sh 写的假 paseo 命令" : false }, async () => {
  const home = kitHomeWith(ROOT);
  const bin = path.join(home, "paseo");
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${path.join(ROOT, "test", "fake-paseo.mjs")}" "$@"\n`, { mode: 0o755 });
  const state = path.join(home, "paseo-state.json");
  const env = { REQ_KIT_PASEO_BIN: bin, FAKE_PASEO_CONFIG: state, FAKE_PASEO_LOG: path.join(home, "paseo.log") };
  const paseoState = () => JSON.parse(fs.readFileSync(state, "utf8"));

  // No terminal and no --yes: nothing is switched on.
  const declined = reqPlugin(home, env, "install");
  assert.equal(declined.status, 1, declined.stdout + declined.stderr);
  assert.match(declined.stdout, /插件总开关（pluginsEnabled）是关着的/);
  assert.match(declined.stdout, /没有安装/);
  assert.ok(!fs.existsSync(state) || paseoState().pluginsEnabled !== true);

  const installed = reqPlugin(home, env, "install", "--yes");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(installed.stdout, /已打开 Paseo 的插件总开关/);
  assert.match(installed.stdout, /req-kit 插件已安装，正在运行/);
  const staged = path.join(home, "paseo-plugin");
  assert.ok(fs.existsSync(path.join(staged, "index.client.tsx")));
  assert.deepEqual(paseoState().plugins.map((p: { id: string; path: string }) => [p.id, p.path]), [["req-kit", staged]]);

  const again = reqPlugin(home, env, "install");
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /已更新/);
  assert.equal(reqPlugin(home, env, "status").status, 0);

  // Activating a version refreshes the staged files and reloads the plugin.
  fs.rmSync(path.join(staged, "OVERVIEW.md"));
  const { refreshPlugin } = await load<PluginCli>("bin/req-plugin.mjs");
  const notes: string[] = [];
  assert.equal(refreshPlugin({ kitRoot: ROOT, env: { ...process.env, REQ_KIT_HOME: home, ...env }, log: (m: string) => notes.push(m) }), true);
  assert.ok(fs.existsSync(path.join(staged, "OVERVIEW.md")));
  assert.match(notes.join("\n"), /已更新到这个版本/);
  const log = fs.readFileSync(path.join(home, "paseo.log"), "utf8");
  assert.equal((log.match(/"reload","req-kit"/g) ?? []).length, 2);

  const removed = reqPlugin(home, env, "remove");
  assert.equal(removed.status, 0, removed.stdout);
  assert.deepEqual(paseoState().plugins, []);
  assert.equal(paseoState().pluginsEnabled, true, "移除插件不动总开关");
  assert.ok(!fs.existsSync(staged));
  assert.equal(refreshPlugin({ kitRoot: ROOT, env: { ...process.env, REQ_KIT_HOME: home, ...env } }), false, "没装过插件时不做任何事");

  // No paseo command (the desktop app's daemon): manual steps.
  const manual = reqPlugin(home, { ...env, REQ_KIT_PASEO_BIN: "" }, "install");
  assert.equal(manual.status, 1);
  assert.match(manual.stdout, /Plugin source 中填/);
});
