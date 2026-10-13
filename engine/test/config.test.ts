import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, PROJECT_CONFIG_FILE } from "../src/config.js";
import { satisfies } from "../src/daemon-check.js";

const agents = {
  builder: { provider: "claude/m", modeId: "bypassPermissions" },
  reviewer: { provider: "codex/m", modeId: "full-access" },
};

function files(machine: object, team?: object, project?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-config-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  if (team) {
    fs.mkdirSync(path.join(dir, "team"));
    fs.writeFileSync(path.join(dir, "team", "req-kit.json"), JSON.stringify(team));
  }
  if (project) fs.writeFileSync(path.join(repo, PROJECT_CONFIG_FILE), JSON.stringify(project));
  const machinePath = path.join(dir, "config.json");
  fs.writeFileSync(machinePath, JSON.stringify(machine));
  return { machinePath, repo };
}

test("配置分层：本机 → 团队 → 项目，后者覆盖前者；teamConfig 可用相对本机配置的路径", () => {
  const { machinePath, repo } = files(
    { agents, defaultProfile: "standard", teamConfig: "team/req-kit.json", daemonUrl: "ws://machine" },
    { defaultProfile: "quick", stepTimeoutMinutes: { implement: 300 }, requiredVersion: ">=1.0.0" },
    { stepTimeoutMinutes: { implement: 360 } },
  );
  const { config, sources, ignored } = loadConfig(machinePath, repo);
  assert.equal(config.defaultProfile, "quick");
  assert.equal(config.stepTimeoutMinutes.implement, 360);
  assert.equal(config.stepTimeoutMinutes.design, 60);
  assert.equal(config.requiredVersion, ">=1.0.0");
  assert.equal(config.daemonUrl, "ws://machine");
  assert.equal(sources.length, 3);
  assert.match(sources[1], /team[\\/]req-kit\.json$/);
  assert.deepEqual(ignored, []);
});

test("团队和项目配置不能改本机相关的项，也不能再指向别的团队配置", () => {
  const { machinePath, repo } = files(
    { agents, teamConfig: "team/req-kit.json" },
    { daemonUrl: "ws://evil", teamConfig: "other.json" },
    { daemonPasswordEnv: "X", teamConfig: "x.json" },
  );
  const { config, ignored } = loadConfig(machinePath, repo);
  assert.equal(config.daemonUrl, "ws://127.0.0.1:6767/ws");
  assert.equal(config.daemonPasswordEnv, "PASEO_DAEMON_PASSWORD");
  assert.match(config.teamConfig ?? "", /team\/req-kit\.json/);
  assert.deepEqual(ignored, ["团队配置中的 daemonUrl", "团队配置中的 teamConfig", "项目配置中的 daemonPasswordEnv", "项目配置中的 teamConfig"]);
});

test("teamConfig 指向的文件不存在时明确报错", () => {
  const { machinePath } = files({ agents, teamConfig: "missing/team.json" });
  assert.throws(() => loadConfig(machinePath), /找不到本机配置中 teamConfig 指向的团队配置文件/);
});

test("版本范围判断", () => {
  assert.ok(satisfies("1.2.0", ">=1.2.0 <2"));
  assert.ok(satisfies("1.2.0-beta.1", ">=1.2.0 <2"), "预发布版本按其主次修订号比较");
  assert.ok(!satisfies("1.1.9", ">=1.2.0 <2"));
  assert.ok(!satisfies("2.0.0", ">=1.2.0 <2"));
  assert.ok(satisfies("0.11.2", ">=0.11.0 <0.12.0"));
  assert.ok(satisfies("1.0.0", "1.0.0"));
});

test("通知模块：路径相对声明它的配置文件，\"~/\" 为用户目录；项目配置不能设置", () => {
  const { machinePath, repo } = files(
    { agents, notifiers: [{ module: "notifiers/im.mjs" }, { module: "~/im2.mjs", events: ["failed"] }] },
    undefined,
    { notifiers: [{ module: "evil.mjs" }] },
  );
  const { config, ignored } = loadConfig(machinePath, repo);
  assert.equal(config.notifiers[0].module, path.join(path.dirname(machinePath), "notifiers", "im.mjs"));
  assert.equal(config.notifiers[1].module, path.join(os.homedir(), "im2.mjs"));
  assert.deepEqual(ignored, ["项目配置中的 notifiers"]);
  const bad = files({ agents, notifiers: [{ module: "x.mjs", events: ["sometimes"] }] });
  assert.throws(() => loadConfig(bad.machinePath), /notifiers\[0\]\.events 只能包含/);
});
