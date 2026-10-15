// 1.9: external system integrations — a requirement's card kept in step with the pipeline.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { cardFieldsText, type IntegrationConfig, renderArgs, type Runner, statusFor, syncIntegration, validateIntegrations } from "../src/integrations.js";
import type { PipelineState } from "../src/state.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const FEATURE = "docs/features/20261015-sms-login";

/** A stand-in for an ALM command line tool: logs its arguments, prints a card id when creating. */
function fakeAlm(dir: string): string {
  const file = path.join(dir, "fake-alm.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "alm.log"))}, JSON.stringify(args) + "\\n");
if (fs.existsSync(${JSON.stringify(path.join(dir, "alm-down"))})) { console.error("ALM 服务不可用"); process.exit(3); }
if (args[1] === "create") console.log("创建成功：CMASTER-BUSINESS#9787 https://alm.example.com/card/9787");
else console.log("ok");
`,
    { mode: 0o755 },
  );
  return file;
}

function almCalls(dir: string): string[][] {
  const file = path.join(dir, "alm.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

function integration(command: string): IntegrationConfig {
  return {
    name: "ALM",
    command,
    create: {
      args: ["alm-card", "create", "--title", "{title}", "--issue-type", "{field.issueType}", "--project-id", "{field.projectId}", "--priority", "{card.priority}", "-b", "{body}"],
      id: "(?<id>[A-Z][A-Z0-9-]*#\\d+)",
      url: "(https?://\\S+)",
    },
    status: { args: ["alm-card", "edit", "{id}", "--state-detail", "{status}"] },
    statusMap: { started: "开发中", phase_done: "待测试", verify: "测试中", completed: "已完成", not_completed: "已挂起" },
    cardFields: { priority: "优先级：高 / 中 / 低" },
    defaults: { issueType: "用户故事" },
  };
}

test("参数：占位符按需求填写；只有占位符且为空的参数连同前面的选项一起去掉；不认识的占位符报错", () => {
  assert.deepEqual(renderArgs(["create", "--title", "{title}", "--priority", "{card.priority}", "-b", "{body}"], { title: "短信登录", "card.priority": "", body: "## 说明" }), [
    "create",
    "--title",
    "短信登录",
    "-b",
    "## 说明",
  ]);
  assert.throws(() => renderArgs(["--x", "{nope}"], {}), /\{nope\} 没有对应的值/);
  const c = integration("alm");
  assert.equal(statusFor(c, "completed", "completed"), "已完成");
  assert.equal(statusFor(c, "completed", "not_completed"), "已挂起");
  assert.equal(statusFor(c, "completed", "completed_with_issues"), "已完成");
  assert.equal(statusFor(c, "failed", null), null);
});

test("配置检查：写法不对时说明原因；项目配置不能写 integrations，但可以写自己的 integrationDefaults", () => {
  assert.match(validateIntegrations([{ name: "ALM" }]) ?? "", /command/);
  assert.match(validateIntegrations([{ name: "ALM", command: "x", create: { args: ["a"], id: "(" } }]) ?? "", /正则/);
  assert.match(validateIntegrations([{ name: "ALM", command: "x", statusMap: { started: "开发中" } }]) ?? "", /没有 status/);
  assert.match(validateIntegrations([{ name: "ALM", command: "x", status: { args: [] }, statusMap: { coding: "x" } }]) ?? "", /不是流水线事件/);
  assert.equal(validateIntegrations([integration("x")]), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-int-config-"));
  const machine = path.join(dir, "config.json");
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  fs.writeFileSync(machine, JSON.stringify({ ...base, agents: { builder: { provider: "claude/m" }, reviewer: { provider: "codex/m" } }, integrations: [integration("alm")], integrationDefaults: { ALM: { projectId: "100", issueType: "用户故事" } } }));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, ".requirement-pipeline.json"), JSON.stringify({ integrations: [], integrationDefaults: { ALM: { projectId: "200" } } }));
  const loaded = loadConfig(machine, repo);
  assert.equal(loaded.config.integrations.length, 1);
  assert.deepEqual(loaded.config.integrationDefaults.ALM, { projectId: "200", issueType: "用户故事" });
  assert.ok(loaded.ignored.some((i) => i.includes("integrations")));
  assert.match(cardFieldsText(loaded.config.integrations) ?? "", /priority：优先级：高 \/ 中 \/ 低/);
  assert.equal(cardFieldsText([]), null);
});

function stateFor(): PipelineState {
  return { branch: "feature/x", profile: "standard", type: null, outcome: null, external: null } as unknown as PipelineState;
}

test("同步：建卡并记下编号和链接；按事件改状态；失败的调用按顺序记下，下次先补发，不重复建卡", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "req-int-sync-"));
  fs.mkdirSync(path.join(repo, FEATURE), { recursive: true });
  fs.writeFileSync(path.join(repo, FEATURE, "spec.md"), "# 短信验证码登录\n\n- 状态：已确认\n");
  fs.writeFileSync(path.join(repo, FEATURE, "card.json"), JSON.stringify({ fields: { priority: "高" } }));
  const calls: string[][] = [];
  let down = false;
  const run: Runner = async (_command, args) => {
    calls.push(args);
    if (down) return { ok: false, output: "", error: "ALM 服务不可用" };
    return { ok: true, output: args[1] === "create" ? "创建成功：CMASTER-BUSINESS#9787 https://alm.example.com/card/9787" : "ok", error: null };
  };
  const config = integration("alm");
  const state = stateFor();
  const ctx = { repo, featureDir: FEATURE, state, projectDefaults: { projectId: "100" } };
  const log: string[] = [];
  const sync = (event: Parameters<typeof syncIntegration>[0]["event"]) => syncIntegration({ config, ctx, event, run, log: (m) => log.push(m) });

  await sync("started");
  assert.deepEqual(calls.at(0), ["alm-card", "create", "--title", "短信验证码登录", "--issue-type", "用户故事", "--project-id", "100", "--priority", "高", "-b", "# 短信验证码登录\n\n- 状态：已确认\n"]);
  assert.deepEqual(calls.at(1), ["alm-card", "edit", "CMASTER-BUSINESS#9787", "--state-detail", "开发中"]);
  assert.equal(state.external!.ALM.id, "CMASTER-BUSINESS#9787");
  assert.equal(state.external!.ALM.url, "https://alm.example.com/card/9787");
  assert.equal(state.external!.ALM.status, "开发中");

  // The same state again: nothing to do.
  await sync("started");
  assert.equal(calls.length, 2);

  down = true;
  await sync("phase_done");
  await sync("verify");
  assert.deepEqual(
    state.external!.ALM.pending.map((p) => p.status),
    ["测试中"],
    "只留最新的状态",
  );
  assert.match(log.join("\n"), /改为「待测试」失败：ALM 服务不可用/);

  down = false;
  calls.length = 0;
  state.outcome = "not_completed";
  await sync("completed");
  assert.deepEqual(
    calls.map((c) => c.at(-1)),
    ["已挂起"],
  );
  assert.equal(state.external!.ALM.pending.length, 0);
  assert.equal(calls.filter((c) => c[1] === "create").length, 0, "不重复建卡");
});

test("同步：建卡失败时不改状态，最新的状态排在后面；建卡输出里没有编号时如实记下", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "req-int-sync-"));
  fs.mkdirSync(path.join(repo, FEATURE), { recursive: true });
  fs.writeFileSync(path.join(repo, FEATURE, "spec.md"), "# 标题\n");
  const state = stateFor();
  let output = "";
  let ok = false;
  const calls: string[][] = [];
  const run: Runner = async (_c, args) => {
    calls.push(args);
    return ok ? { ok: true, output: args[1] === "create" ? output : "ok", error: null } : { ok: false, output: "", error: "超时" };
  };
  const config = { ...integration("alm"), defaults: { issueType: "用户故事", projectId: "1" } };
  const log: string[] = [];
  await syncIntegration({ config, ctx: { repo, featureDir: FEATURE, state }, event: "started", run, log: (m) => log.push(m) });
  assert.equal(calls.length, 1);
  assert.deepEqual(state.external!.ALM.pending.map((p) => [p.action, p.status]), [["create", null], ["status", "开发中"]]);
  await syncIntegration({ config, ctx: { repo, featureDir: FEATURE, state }, event: "phase_done", run, log: (m) => log.push(m) });
  assert.deepEqual(
    state.external!.ALM.pending.map((p) => [p.action, p.status]),
    [
      ["create", null],
      ["status", "待测试"],
    ],
    "状态排在建卡后面",
  );
  ok = true;
  output = "done";
  await syncIntegration({ config, ctx: { repo, featureDir: FEATURE, state }, event: null, run, log: (m) => log.push(m) });
  assert.match(log.join("\n"), /输出中没有找到卡片编号/);
  assert.equal(state.external!.ALM.id, null);
  output = "CMASTER-BUSINESS#1";
  await syncIntegration({ config, ctx: { repo, featureDir: FEATURE, state }, event: "phase_done", run, log: (m) => log.push(m) });
  assert.equal(state.external!.ALM.id, "CMASTER-BUSINESS#1");
  assert.equal(state.external!.ALM.status, "待测试");
  assert.equal(state.external!.ALM.pending.length, 0);
});

function project(dir: string, integrations: IntegrationConfig[]) {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, FEATURE), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", "-b", "feature/20261015-sms-login"], { cwd: repo });
  fs.writeFileSync(path.join(repo, FEATURE, "spec.md"), "# 短信验证码登录\n\n- 状态：已确认（2026-10-15）\n\n## 5. 功能需求与验收标准\n\n### FR-1 登录\n- **AC-1.1** ...\n");
  fs.writeFileSync(path.join(repo, FEATURE, "card.json"), JSON.stringify({ title: "短信登录（卡片）", fields: { priority: "中" } }));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...base,
      agents: { builder: { provider: "claude/test-model", modeId: "bypassPermissions" }, reviewer: { provider: "codex/test-model", modeId: "full-access" } },
      waitChunkSeconds: 0.05,
      permissionPollSeconds: 0.01,
      notifyMilestones: false,
      reviewAxes: { enabled: false, profiles: ["standard"] },
      integrations,
      integrationDefaults: { ALM: { projectId: "100" } },
    }),
  );
  const scenario = path.join(dir, "scenario.json");
  fs.writeFileSync(scenario, "{}");
  return { repo, configPath, scenario };
}

test("流水线：开始时建卡、改为开发中，完成时改为已完成；报告和 req api 带上卡片；外部系统不可用不影响流水线，之后 req sync 补发", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-int-e2e-"));
  const alm = fakeAlm(dir);
  const p = project(dir, [integration(alm)]);
  const env = { ...process.env, REQ_KIT_HOME: dir, REQ_PIPELINE_FAKE_RUNTIME: path.join(ROOT, "engine", "test", "fake-runtime.ts"), FAKE_SCENARIO: p.scenario, FAKE_EVENTS: `${p.scenario}.events` };
  const r = spawnSync(TSX, [path.join(ROOT, "engine", "src", "main.ts"), "--repo", p.repo, "--feature", FEATURE, "--config", p.configPath], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const calls = almCalls(dir);
  assert.deepEqual(calls.at(0)?.slice(0, 4), ["alm-card", "create", "--title", "短信登录（卡片）"]);
  assert.ok(calls.at(0)!.includes("中"), "card.json 的字段");
  assert.deepEqual(
    calls.slice(1).map((c) => c.at(-1)),
    ["开发中", "测试中", "已完成"],
  );
  const state = JSON.parse(fs.readFileSync(path.join(p.repo, FEATURE, ".pipeline", "state.json"), "utf8"));
  assert.equal(state.external.ALM.id, "CMASTER-BUSINESS#9787");
  assert.equal(state.external.ALM.status, "已完成");
  const events = fs.readFileSync(`${p.scenario}.events`, "utf8");
  assert.match(events, /外部系统 ALM：CMASTER-BUSINESS#9787/, "报告的上下文中有卡片");

  // The tool is down: the run still completes; req sync sends it afterwards.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "req-int-e2e-"));
  const alm2 = fakeAlm(dir2);
  fs.writeFileSync(path.join(dir2, "alm-down"), "");
  const p2 = project(dir2, [integration(alm2)]);
  const env2 = { ...env, REQ_KIT_HOME: dir2, FAKE_SCENARIO: p2.scenario, FAKE_EVENTS: `${p2.scenario}.events` };
  const r2 = spawnSync(TSX, [path.join(ROOT, "engine", "src", "main.ts"), "--repo", p2.repo, "--feature", FEATURE, "--config", p2.configPath], { env: env2, encoding: "utf8", timeout: 60_000 });
  assert.equal(r2.status, 0, `${r2.stdout}${r2.stderr}`);
  const state2 = JSON.parse(fs.readFileSync(path.join(p2.repo, FEATURE, ".pipeline", "state.json"), "utf8"));
  assert.equal(state2.status, "completed");
  assert.equal(state2.external.ALM.id, null);
  assert.ok(state2.external.ALM.pending.length > 0);

  fs.copyFileSync(p2.configPath, path.join(dir2, "config.json"));
  fs.rmSync(path.join(dir2, "alm-down"));
  const status = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "status", "sms-login"], { env: env2, encoding: "utf8", cwd: p2.repo });
  assert.match(status.stdout, /外部系统 ALM：还没有建卡；有 \d+ 次调用没有成功/);
  const real = () => almCalls(dir2).filter((c) => c[0] !== "--help");
  const callsBefore = real().length;
  const test = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "integration", "test", "sms-login"], { env: env2, encoding: "utf8", cwd: p2.repo });
  assert.equal(test.status, 0, test.stderr);
  assert.match(test.stdout, /只显示将要执行的命令/);
  assert.match(test.stdout, /建卡：.* alm-card create --title 短信登录（卡片） --issue-type 用户故事 --project-id 100 --priority 中 -b/);
  assert.match(test.stdout, /完成（未完成）→ 「已挂起」/);
  assert.equal(real().length, callsBefore, "integration test 只检查命令在不在（--help），不真正调用");
  const sync = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "sync", "sms-login"], { env: env2, encoding: "utf8", cwd: p2.repo });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /已建卡 CMASTER-BUSINESS#9787/);
  assert.match(sync.stdout, /ALM：CMASTER-BUSINESS#9787（https:\/\/alm.example.com\/card\/9787），状态「已完成」/);
  const api = JSON.parse(spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "api", "status", "sms-login"], { env: env2, encoding: "utf8", cwd: p2.repo }).stdout);
  assert.deepEqual(api.data.external.map((e: { id: string; status: string; pending: number }) => [e.id, e.status, e.pending]), [["CMASTER-BUSINESS#9787", "已完成", 0]]);

  const fields = spawnSync(process.execPath, [path.join(ROOT, "bin", "start-pipeline.mjs"), "--card-fields", "--repo", p2.repo], { env: env2, encoding: "utf8" });
  assert.match(fields.stdout, /card\.json/);
  assert.match(fields.stdout, /priority：优先级/);
});
