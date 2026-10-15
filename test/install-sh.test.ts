// The one-step installer (install.sh), with a stand-in for npm (test/fake-npm.mjs).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION: string = PKG.version;

/** A fake registry holding this package as VERSION, with the given dist-tags. */
function registry(tags: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-registry-"));
  const dest = path.join(dir, VERSION);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of PKG.files as string[]) {
    const from = path.join(ROOT, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, entry), { recursive: true });
  }
  fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify(PKG));
  fs.writeFileSync(path.join(dir, "dist-tags.json"), JSON.stringify(tags));
  return dir;
}

/** Runs install.sh without the Paseo step (see the Paseo tests below for it). */
function run(home: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return runWithPaseo(home, env, "--skip-paseo", ...args);
}

function runWithPaseo(home: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const full: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    REQ_KIT_NPM: path.join(ROOT, "test", "fake-npm.mjs"),
    FAKE_NPM_LOG: path.join(home, "npm.log"),
    ...env,
  };
  delete full.REQ_KIT_HOME;
  delete full.REQ_KIT_VERSIONS_DIR;
  delete full.PASEO_AGENT_CWD;
  // Piped like `curl … | sh`: stdin is not a terminal.
  return spawnSync("sh", [path.join(ROOT, "install.sh"), ...args], { encoding: "utf8", env: full, cwd: home, input: "" });
}

function npmCalls(home: string): string[][] {
  return fs.readFileSync(path.join(home, "npm.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

function installedVersion(home: string): string {
  return JSON.parse(fs.readFileSync(path.join(home, ".req-kit", "active.json"), "utf8")).version;
}

test("一键安装：从 npm 安装、req setup 启用、装好 skill；没有终端时跳过配置向导并提示", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-sh-home-"));
  const prefix = path.join(home, "npm-global");
  fs.mkdirSync(prefix);
  const r = run(home, { FAKE_NPM_REGISTRY: registry({ beta: VERSION }), FAKE_NPM_PREFIX: prefix }, "--beta");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`npm 上的 paseo-req-kit@${VERSION.replace(/\./g, "\\.")}`));
  assert.ok(npmCalls(home).some((c) => c[0] === "install" && c.includes("-g") && c.at(-1) === `paseo-req-kit@${VERSION}`));
  assert.ok(fs.existsSync(path.join(prefix, "lib", "node_modules", "paseo-req-kit", "bin", "req.mjs")));
  assert.equal(installedVersion(home), VERSION);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "req", "SKILL.md")) || fs.existsSync(path.join(home, ".agents", "skills", "req", "SKILL.md")));
  assert.match(r.stdout, /没有可交互的终端，跳过配置向导/);
  assert.match(r.stdout, /req 命令还不在 PATH 中[\s\S]*npm-global\/bin/);
  assert.match(r.stdout, /下一步/);

  // Running it again upgrades in place (same version: nothing breaks).
  const again = run(home, { FAKE_NPM_REGISTRY: registry({ beta: VERSION }), FAKE_NPM_PREFIX: prefix }, "--beta");
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

test("一键安装：npm 上没有时改用 GitHub Release 的安装包；只有 beta 时说明", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-sh-home-"));
  const prefix = path.join(home, "npm-global");
  fs.mkdirSync(prefix);
  // The .tgz the fake npm understands: a pointer to a package directory.
  const reg = registry({});
  const tgz = path.join(home, `paseo-req-kit-${VERSION}.tgz`);
  fs.writeFileSync(tgz, JSON.stringify({ dir: path.join(reg, VERSION) }));
  const releases = path.join(home, "releases.json");
  fs.writeFileSync(
    releases,
    JSON.stringify([
      { tag_name: VERSION, prerelease: true, draft: false, assets: [{ name: path.basename(tgz), browser_download_url: tgz }] },
      { tag_name: "1.0.0-beta.1", prerelease: true, draft: false, assets: [] },
    ]),
  );
  const r = run(home, { FAKE_NPM_REGISTRY: reg, FAKE_NPM_PREFIX: prefix, REQ_KIT_RELEASES_JSON: releases });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /npm 上没有找到 paseo-req-kit@latest，改用 GitHub Release/);
  assert.match(r.stdout, /还没有正式版，安装最新的 beta 版/);
  assert.ok(npmCalls(home).some((c) => c[0] === "install" && c.at(-1) === tgz));
  assert.equal(installedVersion(home), VERSION);

  const missing = run(home, { FAKE_NPM_REGISTRY: reg, FAKE_NPM_PREFIX: prefix, REQ_KIT_RELEASES_JSON: releases }, "--version", "9.9.9");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /没有找到 9\.9\.9 的安装包/);
  const npmOnly = run(home, { FAKE_NPM_REGISTRY: reg, FAKE_NPM_PREFIX: prefix }, "--from", "npm");
  assert.equal(npmOnly.status, 1);
  assert.match(npmOnly.stderr, /npm 上没有找到/);
});

test("一键安装：--beta 时 beta 标签落后于正式版（1.8.0-beta.3 < 1.8.0），装正式版", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-sh-home-"));
  const prefix = path.join(home, "npm-global");
  fs.mkdirSync(prefix);
  const r = run(home, { FAKE_NPM_REGISTRY: registry({ beta: "0.0.1-beta.1", latest: VERSION }), FAKE_NPM_PREFIX: prefix }, "--beta");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(npmCalls(home).some((c) => c[0] === "install" && c.at(-1) === `paseo-req-kit@${VERSION}`));
});

test("一键安装：npm 的全局目录不可用时装到 ~/.req-kit/npm；选项写错时给出说明", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-sh-home-"));
  const r = run(home, { FAKE_NPM_REGISTRY: registry({ latest: VERSION }), FAKE_NPM_PREFIX: "" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /改装到 .*\.req-kit\/npm/);
  assert.ok(fs.existsSync(path.join(home, ".req-kit", "npm", "lib", "node_modules", "paseo-req-kit", "bin", "req.mjs")));
  assert.equal(installedVersion(home), VERSION);

  const bad = run(home, {}, "--frm", "npm");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /不认识的选项：--frm/);
  const help = run(home, {}, "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--from npm\|release/);
});

/** Lines the fake paseo was called with. */
function paseoCalls(home: string): string[][] {
  const file = path.join(home, "paseo.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

function paseoEnv(home: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    FAKE_PASEO_LOG: path.join(home, "paseo.log"),
    FAKE_PASEO_CONFIG: path.join(home, "paseo-config.json"),
    // Nothing listens here, unless a test starts a fake daemon on it.
    REQ_KIT_PASEO_URL: "http://127.0.0.1:9",
    REQ_KIT_PASEO_WAIT: "0",
    ...extra,
  };
}

test("一键安装：没有 Paseo 时安装与 req-kit 匹配的 Paseo 命令行，开启网页界面并启动 daemon", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-sh-home-"));
  const prefix = path.join(home, "npm-global");
  fs.mkdirSync(prefix);
  const env = paseoEnv(home, { FAKE_NPM_REGISTRY: registry({ latest: VERSION }), FAKE_NPM_PREFIX: prefix, REQ_KIT_PASEO_BIN: "" });
  const r = runWithPaseo(home, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const minor = /(\d+\.\d+)/.exec(PKG.reqKit.paseo)![1];
  assert.ok(npmCalls(home).some((c) => c[0] === "install" && c.includes("-g") && c.at(-1) === `@getpaseo/cli@~${minor}.0`), JSON.stringify(npmCalls(home)));
  assert.match(r.stdout, /已安装 Paseo/);
  assert.match(r.stdout, /已开启 Paseo 自带的网页界面/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "paseo-config.json"), "utf8"))["features.webUi.enabled"], true);
  assert.ok(paseoCalls(home).some((c) => c.join(" ") === "daemon start"));
  assert.match(r.stdout, /已启动 Paseo daemon/);
  assert.match(r.stdout, /Paseo 网页界面：http:\/\/127\.0\.0\.1:9\//);
  // The Paseo step comes before setup (the wizard needs the daemon).
  assert.ok(r.stdout.indexOf("检查 Paseo") < r.stdout.indexOf("启用这个版本"));
  assert.equal(installedVersion(home), VERSION);
});

test("一键安装：已有 Paseo 时不重装；版本不匹配时提醒；daemon 在运行时只提示重启，不自动重启", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-sh-home-"));
  const prefix = path.join(home, "npm-global");
  fs.mkdirSync(prefix);
  const bin = path.join(home, "paseo");
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${path.join(ROOT, "test", "fake-paseo.mjs")}" "$@"\n`, { mode: 0o755 });
  // A fake daemon in its own process (spawnSync below blocks this one).
  const daemon = spawn(process.execPath, [
    "-e",
    "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({version:'0.11.2'}))}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
  ]);
  try {
    const port = await new Promise<string>((resolve) => daemon.stdout.once("data", (d) => resolve(String(d).trim())));
    const base = { FAKE_NPM_REGISTRY: registry({ latest: VERSION }), FAKE_NPM_PREFIX: prefix, REQ_KIT_PASEO_URL: `http://127.0.0.1:${port}` };
    const r = runWithPaseo(home, paseoEnv(home, { ...base, REQ_KIT_PASEO_BIN: bin, FAKE_PASEO_VERSION: "0.10.4" }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!npmCalls(home).some((c) => c.at(-1)?.startsWith("@getpaseo/cli")));
    assert.match(r.stdout, /Paseo 是 0\.10\.4，这个版本的 req-kit 支持/);
    assert.match(r.stdout, /网页界面要在重启后生效：paseo daemon restart/);
    assert.ok(!paseoCalls(home).some((c) => c[0] === "daemon" && (c[1] === "start" || c[1] === "restart")));

    // No terminal: the plugin is offered but not installed.
    assert.match(r.stdout, /==> Paseo 插件[\s\S]*没有可交互的终端，跳过。之后运行：req plugin install/);

    // Second run: already on, daemon running, nothing to do; --with-plugin installs the plugin.
    const again = runWithPaseo(home, paseoEnv(home, { ...base, REQ_KIT_PASEO_BIN: bin }), "--with-plugin");
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /Paseo 0\.11\.2/);
    assert.match(again.stdout, /Paseo 网页界面已开启/);
    assert.match(again.stdout, /Paseo daemon 正在运行/);
    assert.match(again.stdout, /req-kit 插件已安装，正在运行/);
    const paseoState = JSON.parse(fs.readFileSync(path.join(home, "paseo-config.json"), "utf8"));
    assert.equal(paseoState.pluginsEnabled, true);
    assert.deepEqual(paseoState.plugins.map((p: { id: string }) => p.id), ["req-kit"]);
    assert.ok(fs.existsSync(path.join(home, ".req-kit", "paseo-plugin", "paseo-plugin.json")));
    // Installed already: not offered again (req setup keeps it up to date).
    const third = runWithPaseo(home, paseoEnv(home, { ...base, REQ_KIT_PASEO_BIN: bin }));
    assert.doesNotMatch(third.stdout, /==> Paseo 插件/);
    assert.match(third.stdout, /Paseo 插件已更新到这个版本/);

    // No paseo command, but a daemon answers: the desktop app's. Nothing is installed.
    const desktop = runWithPaseo(home, paseoEnv(home, { ...base, REQ_KIT_PASEO_BIN: "" }));
    assert.equal(desktop.status, 0, desktop.stdout + desktop.stderr);
    assert.match(desktop.stdout, /Paseo daemon 已在运行（0\.11\.2），没有 paseo 命令/);
    assert.ok(!npmCalls(home).some((c) => c.at(-1)?.startsWith("@getpaseo/cli")));
  } finally {
    daemon.kill();
  }
});
