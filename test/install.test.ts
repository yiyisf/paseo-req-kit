import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const slash = (p: string) => p.split(path.sep).join("/");

function tempHome(withClaude = true): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-home-"));
  if (withClaude) fs.mkdirSync(path.join(home, ".claude"));
  return home;
}

function run(kitRoot: string, home: string, ...args: string[]) {
  return runWith({}, kitRoot, home, ...args);
}

function runWith(extra: NodeJS.ProcessEnv, kitRoot: string, home: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  delete env.REQ_KIT_HOME;
  const result = spawnSync(process.execPath, [path.join(kitRoot, "install.mjs"), ...args], { encoding: "utf8", env });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** A copy of the parts the installer needs, as a version directory with its own version number. */
function versionDir(base: string, version: string, mutate?: (dir: string) => void): string {
  const dir = path.join(base, "versions", version);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["install.mjs", "config.example.json", "skills", "bin"]) {
    fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...pkg, version }));
  mutate?.(dir);
  return dir;
}

function fillConfig(home: string): void {
  const file = path.join(home, ".req-kit", "config.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("CHANGE-ME", "test-model"));
}

const skillNames = () => fs.readdirSync(path.join(ROOT, "skills")).sort();

test("首次安装：skill 装进 ~/.agents/skills 和 ~/.claude/skills，路径和版本号已填入，生成本机配置", () => {
  const home = tempHome();
  const first = run(ROOT, home);
  assert.match(first.out, /已生成本机配置 .*config\.json，请填写两个 agent 的 provider\/model/);
  assert.ok(fs.existsSync(path.join(home, ".req-kit", "config.json")));
  for (const root of [".agents", ".claude"]) {
    const dir = path.join(home, root, "skills");
    assert.deepEqual(fs.readdirSync(dir).sort(), skillNames());
    const req = fs.readFileSync(path.join(dir, "req", "SKILL.md"), "utf8");
    assert.ok(req.includes(`node "${slash(path.join(ROOT, "bin", "start-pipeline.mjs"))}" --feature`));
    assert.ok(req.includes(slash(path.join(ROOT, "principles", "INDEX.md"))));
    assert.doesNotMatch(req, /\{\{[A-Z_]+\}\}/);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, "req", ".req-kit-install.json"), "utf8"));
    assert.equal(marker.root, ROOT);
    assert.ok(fs.existsSync(path.join(dir, "req", "playbooks", "new.md")));
  }
  assert.ok(!fs.existsSync(path.join(home, ".codex")), "不应安装到 ~/.codex");
  const active = JSON.parse(fs.readFileSync(path.join(home, ".req-kit", "active.json"), "utf8"));
  assert.equal(active.root, ROOT);
});

test("没有 ~/.claude 时只装通用目录；--check 不修改任何文件", () => {
  const home = tempHome(false);
  const check = run(ROOT, home, "--check");
  assert.equal(check.code, 1);
  assert.match(check.out, /还没有本机配置/);
  assert.match(check.out, /还没有启用任何 req-kit 版本/);
  assert.ok(!fs.existsSync(path.join(home, ".req-kit")));
  assert.ok(!fs.existsSync(path.join(home, ".agents")));
  run(ROOT, home);
  assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "req")));
  assert.ok(!fs.existsSync(path.join(home, ".claude")));
});

test("同名但不是 req-kit 装的 skill：默认不覆盖，--force 才覆盖", () => {
  const home = tempHome();
  const mine = path.join(home, ".claude", "skills", "req");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "SKILL.md"), "my own skill");
  const refused = run(ROOT, home);
  assert.match(refused.out, /\.claude\/skills\/req 已存在且不是 req-kit 安装的，未覆盖/);
  assert.equal(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8"), "my own skill");
  run(ROOT, home, "--force");
  assert.match(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8"), /name: req/);
});

test("从脚本版迁移：替换旧的 requirement-kickoff，导入旧配置和提示词覆盖", () => {
  const home = tempHome();
  const legacyDir = path.join(home, "tools", "requirement-pipeline");
  fs.mkdirSync(path.join(legacyDir, "prompts.local"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "pipeline.config.json"), JSON.stringify({ agents: { builder: { provider: "claude/old" } } }));
  fs.writeFileSync(path.join(legacyDir, "prompts.local", "03-design.md"), "团队版");
  const oldSkill = path.join(home, ".agents", "skills", "requirement-kickoff");
  fs.mkdirSync(oldSkill, { recursive: true });
  fs.writeFileSync(path.join(oldSkill, "SKILL.md"), "old");
  fs.writeFileSync(path.join(oldSkill, ".installed-by-requirement-pipeline.json"), "{}");

  const hinted = run(ROOT, home);
  assert.match(hinted.out, /发现了旧脚本版的配置[\s\S]*--import-legacy/);
  assert.ok(!fs.existsSync(path.join(home, ".req-kit", "config.json")), "发现旧配置时不应生成示例配置");

  const imported = run(ROOT, home, "--import-legacy", legacyDir);
  assert.match(imported.out, /已导入旧配置/);
  assert.match(imported.out, /已导入提示词覆盖：03-design\.md/);
  assert.match(fs.readFileSync(path.join(home, ".req-kit", "config.json"), "utf8"), /claude\/old/);
  assert.equal(fs.readFileSync(path.join(home, ".req-kit", "prompts.local", "03-design.md"), "utf8"), "团队版");
  const kickoff = fs.readFileSync(path.join(oldSkill, "SKILL.md"), "utf8");
  assert.match(kickoff, /已经改名为 `\/req`/);
  assert.ok(fs.existsSync(path.join(oldSkill, ".req-kit-install.json")));
  assert.match(imported.out, /发现旧脚本版目录/);

  fs.writeFileSync(path.join(home, ".req-kit", "config.json"), "{}");
  const again = run(ROOT, home, "--import-legacy", legacyDir);
  assert.match(again.out, /config\.json 已存在，未覆盖/);
  assert.equal(fs.readFileSync(path.join(home, ".req-kit", "config.json"), "utf8"), "{}");
});

test("升级与回滚：切换版本只换 skill 和启用记录，配置不动；旧版本留下的 skill 被清理", () => {
  const home = tempHome();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-tools-"));
  const v1 = versionDir(base, "1.0.0", (dir) => {
    fs.mkdirSync(path.join(dir, "skills", "retired-skill"));
    fs.writeFileSync(path.join(dir, "skills", "retired-skill", "SKILL.md"), "---\nname: retired-skill\n---\n");
  });
  const v2 = versionDir(base, "1.1.0");

  run(v1, home);
  fillConfig(home);
  const config = fs.readFileSync(path.join(home, ".req-kit", "config.json"), "utf8");
  assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "retired-skill")));

  const upgrade = run(v2, home);
  assert.match(upgrade.out, /已从 1\.0\.0 切换到 1\.1\.0/);
  assert.match(upgrade.out, /删除了旧版本留下的 retired-skill/);
  assert.ok(!fs.existsSync(path.join(home, ".agents", "skills", "retired-skill")));
  const req = fs.readFileSync(path.join(home, ".claude", "skills", "req", "SKILL.md"), "utf8");
  assert.ok(req.includes(slash(path.join(v2, "bin", "start-pipeline.mjs"))));
  assert.match(req, /req-kit 需求开发入口（1\.1\.0）/);
  assert.equal(fs.readFileSync(path.join(home, ".req-kit", "config.json"), "utf8"), config);

  const fromOld = run(v1, home, "--check");
  assert.match(fromOld.out, /当前启用的是 1\.1\.0/);
  assert.match(fromOld.out, /req 来自 1\.1\.0/);

  const rollback = run(v1, home);
  assert.match(rollback.out, /已从 1\.1\.0 切换到 1\.0\.0/);
  assert.ok(fs.readFileSync(path.join(home, ".claude", "skills", "req", "SKILL.md"), "utf8").includes(slash(v1)));
  const log = fs.readFileSync(path.join(home, ".req-kit", "install-log", "install.jsonl"), "utf8").trim().split("\n");
  assert.equal(log.filter((l) => JSON.parse(l).action === "activate").length, 3);

  versionDir(base, "0.9.0");
  const pruned = run(v1, home, "--prune");
  assert.match(pruned.out, /可以删除的旧版本[\s\S]*0\.9\.0/);
  assert.doesNotMatch(pruned.out, /可以删除的旧版本[\s\S]*1\.1\.0/);
});

test("--target 追加的目录会被记住，之后的升级也会更新它；--uninstall 只删 req-kit 装的", () => {
  const home = tempHome();
  const extra = path.join(home, "custom-skills");
  run(ROOT, home, "--target", extra);
  assert.ok(fs.existsSync(path.join(extra, "req", "SKILL.md")));
  fs.rmSync(path.join(extra, "req"), { recursive: true });
  run(ROOT, home);
  assert.ok(fs.existsSync(path.join(extra, "req", "SKILL.md")), "记住的目录应在下次安装时更新");

  fs.mkdirSync(path.join(home, ".agents", "skills", "mine"), { recursive: true });
  const removed = run(ROOT, home, "--uninstall");
  assert.equal(removed.code, 0);
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills", "req")));
  assert.ok(!fs.existsSync(path.join(extra, "req")));
  assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "mine")));
  assert.ok(fs.existsSync(path.join(home, ".req-kit", "config.json")), "卸载保留本机配置");
});

test("体检（离线）：报告配置、项目分支和卡住或格式更新的流水线", () => {
  const home = tempHome();
  run(ROOT, home);
  fillConfig(home);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-doctor-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const feature = (name: string, state: object) => {
    const dir = path.join(repo, "docs", "features", name, ".pipeline");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  };
  feature("20261012-stuck", { version: 1, status: "running", pid: 2 ** 22 + 12345 });
  feature("20261013-future", { version: 99, status: "failed" });
  feature("20261014-done", { status: "completed" });

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.REQ_KIT_HOME;
  delete env.PASEO_AGENT_CWD;
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "req-doctor.mjs"), "--offline", "--repo", repo], {
    encoding: "utf8",
    env,
  });
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /## 安装[\s\S]*## 配置[\s\S]*## Paseo daemon[\s\S]*## 项目/);
  assert.match(out, /✓ builder：claude\/test-model（bypassPermissions）/);
  assert.match(out, /⚠ 当前在默认分支 main 上/);
  assert.match(out, /⚠ docs\/features\/20261012-stuck：状态为运行中，但进程已不在/);
  assert.match(out, /✗ 20261013-future：状态文件由更新版本的 req-kit 写入（第 99 版）/);
  assert.match(out, /✓ docs\/features\/20261014-done：已完成/);
  assert.match(out, /结论：\d+ 项必须处理/);
  assert.equal(result.status, 1);
});

test("体检：验证方法缺失、未提交、可能过时、正常四种情况", () => {
  const home = tempHome();
  run(ROOT, home);
  fillConfig(home);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-doctor-verify-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "feature/x");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.REQ_KIT_HOME;
  delete env.PASEO_AGENT_CWD;
  const doctor = () =>
    spawnSync(process.execPath, [path.join(ROOT, "bin", "req-doctor.mjs"), "--offline", "--repo", repo], { encoding: "utf8", env }).stdout;

  assert.match(doctor(), /⚠ 没有验证方法说明[\s\S]*运行 \/req-setup/);

  fs.mkdirSync(path.join(repo, ".requirement-pipeline"));
  fs.writeFileSync(path.join(repo, ".requirement-pipeline", "verify.md"), "# 验证方法\n");
  assert.match(doctor(), /⚠ 验证方法 \.requirement-pipeline\/verify\.md 还没有提交/);

  fs.writeFileSync(path.join(repo, "package.json"), "{}");
  git("add", "-A");
  git("commit", "-q", "-m", "setup", "--date", "2026-10-01T10:00:00");
  const committed = doctor();
  assert.match(committed, /✓ 验证方法：\.requirement-pipeline\/verify\.md/);

  fs.writeFileSync(path.join(repo, "package.json"), '{"scripts":{"test":"vitest"}}');
  git("commit", "-q", "-am", "change scripts");
  // Commit dates are second-resolution; make sure the build change is strictly later.
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--amend", "--no-edit", "--date", "2030-01-01T00:00:00"], {
    cwd: repo,
    env: { ...process.env, GIT_COMMITTER_DATE: "2030-01-01T00:00:00" },
  });
  assert.match(doctor(), /⚠ 验证方法可能过时：构建文件在 .* 改过/);
});

test("req 命令：安装时写入 ~/.req-kit/bin，指向启用的版本；--check 检查它；卸载时删除", () => {
  const home = tempHome();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-tools-"));
  const v1 = versionDir(base, "1.0.0");
  const v2 = versionDir(base, "1.1.0");
  const first = run(v1, home);
  assert.match(first.out, /req 命令：/);
  assert.match(first.out, /加入 PATH/);
  const shim = path.join(home, ".req-kit", "bin", "req");
  assert.ok(fs.readFileSync(shim, "utf8").includes(slash(path.join(v1, "bin", "req.mjs"))));
  assert.ok(fs.readFileSync(`${shim}.cmd`, "utf8").includes(path.join(v1, "bin", "req.mjs")));
  if (process.platform !== "win32") {
    const version = spawnSync(shim, ["version"], { encoding: "utf8" });
    assert.match(version.stdout, /req-kit 1\.0\.0/);
  }
  run(v2, home);
  assert.ok(fs.readFileSync(shim, "utf8").includes(slash(path.join(v2, "bin", "req.mjs"))), "切换版本后 req 指向新版本");
  assert.match(run(v2, home, "--check").out, /✓ req 命令/);
  fs.writeFileSync(shim, "#!/bin/sh\nexec node /elsewhere/bin/req.mjs\n");
  assert.match(run(v2, home, "--check").out, /req 命令指向的不是当前启用的版本/);
  run(v2, home, "--uninstall");
  assert.ok(!fs.existsSync(shim));
});

/** A git repository that publishes the given versions as tags, like the GitHub one. */
function publishedRepo(versions: string[]): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-origin-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  for (const name of ["install.mjs", "config.example.json", "skills", "bin"]) {
    fs.cpSync(path.join(ROOT, name), path.join(repo, name), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const version of versions) {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ ...pkg, version }));
    git("add", "-A");
    git("commit", "-q", "-m", version);
    git("tag", version);
  }
  return repo;
}

test("一键升级：--latest 查最新版本，--upgrade 下载到 versions/ 并切换；正式版只升到正式版，可以指定版本", () => {
  const home = tempHome();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-tools-"));
  const v1 = versionDir(base, "1.0.0");
  const origin = publishedRepo(["1.0.0", "1.1.0", "1.2.0-beta.1", "1.2.0-beta.10", "1.2.0-beta.2"]);
  const env = { REQ_KIT_REPO_URL: origin, REQ_KIT_SKIP_NPM: "1" };
  run(v1, home);

  assert.equal(runWith(env, v1, home, "--latest", "--quiet").out.trim(), "1.1.0", "正式版只提示正式版");
  assert.match(runWith(env, v1, home, "--latest").out, /有新版本 1\.1\.0（当前 1\.0\.0）/);

  const up = runWith(env, v1, home, "--upgrade");
  assert.match(up.out, /已升级到 1\.1\.0/);
  const v2 = path.join(base, "versions", "1.1.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".req-kit", "active.json"), "utf8")).root, v2);
  assert.ok(fs.readFileSync(path.join(home, ".claude", "skills", "req", "SKILL.md"), "utf8").includes(slash(v2)));
  assert.ok(!fs.readdirSync(path.join(base, "versions")).some((n) => n.includes("partial")));

  assert.match(runWith(env, v2, home, "--upgrade").out, /已是最新版本 1\.1\.0/);
  const beta = runWith(env, v2, home, "--upgrade", "1.2.0-beta.2");
  assert.match(beta.out, /已升级到 1\.2\.0-beta\.2/);
  // From a prerelease, prereleases count, in numeric order (beta.10 after beta.2).
  const v3 = path.join(base, "versions", "1.2.0-beta.2");
  assert.equal(runWith(env, v3, home, "--latest", "--quiet").out.trim(), "1.2.0-beta.10");

  const missing = runWith(env, v3, home, "--upgrade", "9.9.9");
  assert.equal(missing.code, 1);
  assert.match(missing.out, /没有找到版本 9\.9\.9/);
  const offline = runWith({ ...env, REQ_KIT_REPO_URL: path.join(base, "no-such-repo") }, v3, home, "--upgrade");
  assert.equal(offline.code, 1);
  assert.match(offline.out, /无法读取 .* 的版本列表/);
});

test("req：帮助、版本、未知命令；status 在没有需求的目录中列出需求", () => {
  const req = path.join(ROOT, "bin", "req.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-empty-"));
  const env = { ...process.env };
  delete env.PASEO_AGENT_CWD;
  const call = (...args: string[]) => spawnSync(process.execPath, [req, ...args], { encoding: "utf8", cwd: dir, env });
  assert.match(call().stdout, /req status \[需求\]/);
  assert.match(call("version").stdout, /req-kit \d+\.\d+\.\d+/);
  const unknown = call("frobnicate");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /没有 "frobnicate" 这个命令/);
  assert.match(call("status").stdout, /还没有需求/);
  const stop = call("stop");
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /请写出是哪个需求/);
});

test("req notify-test：给配置的通知模块发一条示例事件；没有配置时说明怎么配", () => {
  const home = tempHome();
  run(ROOT, home);
  fillConfig(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.REQ_KIT_HOME;
  const notify = (...args: string[]) =>
    spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "notify-test", ...args], { encoding: "utf8", env, cwd: home });
  const none = notify();
  assert.equal(none.status, 1);
  assert.match(none.stdout, /没有配置外部通知/);

  const configFile = path.join(home, ".req-kit", "config.json");
  const out = path.join(home, "event.json");
  fs.mkdirSync(path.join(home, ".req-kit", "notifiers"));
  fs.writeFileSync(
    path.join(home, ".req-kit", "notifiers", "capture.mjs"),
    `import fs from "node:fs";\nexport default (event, options) => fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ event, options }));\n`,
  );
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.notifiers = [{ module: "notifiers/capture.mjs", events: ["blocked"], options: { group: "dev" } }];
  fs.writeFileSync(configFile, JSON.stringify(config));
  const sent = notify("--type", "blocked");
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  assert.match(sent.stdout, /外部通知已发送（blocked）/);
  const { event, options } = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(event.schema, 1);
  assert.equal(event.type, "blocked");
  assert.match(event.text, /^【测试】/);
  assert.ok(Array.isArray(event.details.questions));
  assert.deepEqual(options, { group: "dev" });
  assert.match(notify("--type", "failed").stdout, /没有订阅 failed 事件/);
  assert.equal(notify("--type", "nonsense").status, 2);
});
