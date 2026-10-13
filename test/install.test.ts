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
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
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
