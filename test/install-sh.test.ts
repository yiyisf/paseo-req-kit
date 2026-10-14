// The one-step installer (install.sh), with a stand-in for npm (test/fake-npm.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function run(home: string, env: NodeJS.ProcessEnv, ...args: string[]) {
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
