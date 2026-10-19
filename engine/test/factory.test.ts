// 1.11: the intake process — new cards with the title tag start requirements; replies are passed on.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IntegrationConfig } from "../src/integrations.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FAKE_ALM = path.join(ROOT, "engine", "test", "fake-alm-cards.mjs");

function alm(): IntegrationConfig {
  return {
    name: "ALM",
    command: FAKE_ALM,
    query: {
      args: ["alm-card", "view", "{id}", "--fields", "globalId,name,state,createdBy,subsysName,description"],
      fields: { title: "data.name", body: "data.description", state: "data.state", author: "data.createdBy", subsystem: "data.subsysName" },
    },
    describe: { args: ["alm-card", "edit", "{id}", "-b", "{description}"] },
    list: {
      args: ["alm-card", "list", "--project-id", "{projectId}", "-t", "用户故事", "-S", "新建", "-s", "AI", "-L", "{pageSize}", "-P", "{page}", "--fields", "globalId,name,state,subsysName,createdBy"],
      pageSize: 2,
      fields: { id: "globalId", title: "name", state: "state", subsystem: "subsysName", author: "createdBy" },
    },
  };
}

test("接单器：只接登记空间中标题带 [AI] 的新卡片，按子系统进对应仓库；接不了的说明原因、卡片不变就不再试；回复照常转达；每次最多开始几个", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-factory-"));
  const cards = path.join(dir, "cards.json");
  const card = (name: string, subsysName: string, extra: Record<string, unknown> = {}) => ({ name, state: "新建", createdBy: "张广祥", subsysName, projectId: "186149", description: "# 需求\n\n内容", ...extra });
  fs.writeFileSync(
    cards,
    JSON.stringify({
      "CM#1": card("[AI]【message-service】新增 test 接口", "CSP-CMASTER_云匠"),
      "CM#2": card("新增导出（没有标识）", "CSP-CMASTER_云匠"),
      "CM#3": card("[AI] 子系统没有仓库", "CSP-OTHER"),
      "CM#4": card("【AI】账单导出", "CSP-BILLING"),
      "CM#5": card("[AI] 已经开发中", "CSP-CMASTER_云匠", { state: "开发中" }),
      "OT#1": card("[AI] 别的空间", "CSP-CMASTER_云匠", { projectId: "999" }),
      "CM#6": card("[AI] 第三个", "CSP-BILLING"),
    }),
  );
  const repo = (name: string, cardSource: unknown) => {
    const r = path.join(dir, name);
    fs.mkdirSync(r);
    execFileSync("git", ["init", "-q"], { cwd: r });
    fs.writeFileSync(path.join(r, ".requirement-pipeline.json"), JSON.stringify({ cardSource }));
    return fs.realpathSync(r);
  };
  const backend = repo("message-service", { system: "ALM", projectId: "186149", subsystems: ["CSP-CMASTER_云匠"] });
  const billing = repo("billing", { system: "ALM", projectId: "186149", subsystems: ["CSP-BILLING"] });
  const configPath = path.join(dir, "config.json");
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...base, agents: { builder: { provider: "claude/m" }, reviewer: { provider: "codex/m" } }, integrations: [alm()], factory: { maxNewPerPoll: 2 } }));

  const events = path.join(dir, "events.jsonl");
  const env = { ...process.env, REQ_KIT_HOME: path.join(dir, "home"), FAKE_ALM_CARDS: cards, REQ_PIPELINE_FAKE_RUNTIME: path.join(ROOT, "engine", "test", "fake-runtime.ts"), FAKE_EVENTS: events };
  // The fake runtime and the fake tool read these from the process environment.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { main: card } = await import("../src/card-cmd.js");
    const { main, pollOnce, hasTitleTag, listItems } = await import("../src/factory.js");
    for (const r of [backend, billing]) assert.equal(await card(["route", "--add", r], { env, out: () => undefined }), 0);

    const first = await pollOnce(configPath, { env });
    assert.deepEqual(first.started.map((s) => s.split("「")[0]), ["ALM:CM#1", "ALM:CM#4"]);
    // Paths are shown the way the system writes them; compare with "/".
    const slash = (t: string) => t.replace(/\\/g, "/");
    assert.match(slash(first.started[0]), new RegExp(`→ ${slash(backend).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/docs/features/\\d{8}-cm-1$`));
    assert.match(slash(first.started[1]), /→ .*billing\/docs\/features\/\d{8}-cm-4$/);
    assert.deepEqual(first.skipped.map((s) => s.split("「")[0]), ["ALM:CM#3"]);
    assert.match(first.skipped[0], /子系统「CSP-OTHER」没有对应的仓库/);
    assert.match(first.notes.join("\n"), /这次已开始 2 个需求/);
    const sessions = fs.readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "startSession");
    assert.equal(sessions.length, 2);

    // Next look: the third card is started, nothing is tried twice.
    const second = await pollOnce(configPath, { env });
    assert.deepEqual(second.started.map((s) => s.split("「")[0]), ["ALM:CM#6"]);
    assert.deepEqual(second.skipped, []);
    assert.deepEqual((await pollOnce(configPath, { env })).started, []);

    // The requester renames the skipped card into a subsystem a repository takes: it is tried again.
    const all = JSON.parse(fs.readFileSync(cards, "utf8"));
    all["CM#3"].subsysName = "CSP-BILLING";
    fs.writeFileSync(cards, JSON.stringify(all));
    assert.deepEqual((await pollOnce(configPath, { env })).started.map((s) => s.split("「")[0]), ["ALM:CM#3"]);

    // Replies are passed on in the same look.
    const feature = path.join(backend, "docs", "features", fs.readdirSync(path.join(backend, "docs", "features"))[0]);
    fs.writeFileSync(path.join(feature, "card-ai.md"), "### 待回答的问题\n- Q1 返回什么？\n");
    assert.equal(await card(["publish", "ALM:CM#1", "--config", configPath], { env, out: () => undefined }), 0);
    const now = JSON.parse(fs.readFileSync(cards, "utf8"));
    now["CM#1"].description = now["CM#1"].description.replace("- Q1：", "- Q1：hello world");
    fs.writeFileSync(cards, JSON.stringify(now));
    const relay = await pollOnce(configPath, { env });
    assert.equal(relay.relayed.length, 1);
    assert.match(relay.relayed[0], /CM#1：已转给需求会话（需求方回答了 Q1）/);

    const lines: string[] = [];
    assert.equal(await main(["status"], { env, out: (l) => lines.push(l) }), 0);
    assert.match(lines.join("\n"), /接单器没有在运行[\s\S]*最近一次检查：.*转达 1 条回复/);
    const svc: string[] = [];
    await main(["service"], { env, out: (l) => svc.push(l) });
    assert.match(svc.join("\n"), process.platform === "win32" ? /schtasks/ : /ExecStart=.*req\.mjs" factory run/);

    assert.ok(hasTitleTag("  [ai] x", ["[AI]"]));
    assert.ok(!hasTitleTag("x [AI]", ["[AI]"]));
    assert.deepEqual(listItems({ data: { records: [1] } }), [1]);
    assert.throws(() => listItems({ data: { x: 1 } }), /list\.items/);
  } finally {
    for (const k of Object.keys(env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("接单器（1.13）：本机流水线的后台进程已退出但仍标着运行中时，直接继续（不经过对话），每个进程只继续一次", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-factory-resume-"));
  const repo = path.join(dir, "shop");
  const featureDir = "docs/features/20261017-export";
  fs.mkdirSync(path.join(repo, featureDir, ".pipeline"), { recursive: true });
  const configPath = path.join(dir, "config.json");
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...base, agents: { builder: { provider: "claude/m" }, reviewer: { provider: "codex/m" } } }));
  const events = path.join(dir, "events.jsonl");
  const env = { ...process.env, REQ_KIT_HOME: path.join(dir, "home"), REQ_PIPELINE_FAKE_RUNTIME: path.join(ROOT, "engine", "test", "fake-runtime.ts"), FAKE_EVENTS: events };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { registerRequirement } = await import("../src/records.js");
    const { pollOnce } = await import("../src/factory.js");
    const dead = 2 ** 22 + 12345;
    const stateFile = path.join(repo, featureDir, ".pipeline", "state.json");
    // Written directly: its last change is a while ago (a run that just wrote is left alone).
    const write = (status: string, pid: number, minutesAgo = 10) =>
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          version: 1, repo, featureDir, status, attempt: 1, specHash: "", originAgentId: "chat-1", pid,
          startedAt: new Date().toISOString(), updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), results: {}, history: [],
          stopReason: null, outcome: null, profile: "standard", branch: null, milestones: [],
        }),
      );
    write("running", dead);
    registerRequirement({ repo, featureDir, worktree: null }, env);
    const resumed: string[][] = [];
    const resume = (r: string, f: string) => (resumed.push([r, f]), { ok: true, message: "已在后台启动" });

    const first = await pollOnce(configPath, { env, resume });
    assert.equal(first.resumed.length, 1, JSON.stringify(first));
    assert.match(first.resumed[0], /已自动继续/);
    assert.deepEqual(resumed, [[repo, featureDir]]);
    const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(after.stopKind, "process_exit");
    assert.equal(after.recoveries.at(-1).kind, "auto_resume");
    // No model turn: the chat is not asked.
    const notes = fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "notify") : [];
    assert.equal(notes.length, 0);

    write("running", dead);
    assert.equal((await pollOnce(configPath, { env, resume })).resumed.length, 0, "同一个进程只继续一次");

    write("running", process.pid);
    assert.equal((await pollOnce(configPath, { env, resume })).resumed.length, 0, "进程还在时不动");
    write("running", dead + 1, 0);
    assert.equal((await pollOnce(configPath, { env, resume })).resumed.length, 0, "刚写过状态的不动");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("接单器自检（1.12）：Paseo 连不上、agent 没登录、额度用完时不接新卡片；同样的问题只告警一次，恢复时再说一次", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-factory-health-"));
  const alerts = path.join(dir, "alerts.jsonl");
  const notifier = path.join(dir, "im.mjs");
  fs.writeFileSync(notifier, `import fs from "node:fs";\nexport default (e) => fs.appendFileSync(${JSON.stringify(alerts)}, JSON.stringify(e) + "\\n");\n`);
  const configPath = path.join(dir, "config.json");
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...base, agents: { builder: { provider: "claude/m" }, reviewer: { provider: "codex/m" } }, notifiers: [{ module: notifier, events: ["alert"] }] }));
  const scenario = path.join(dir, "scenario.json");
  const env = { ...process.env, REQ_KIT_HOME: path.join(dir, "home"), REQ_PIPELINE_FAKE_RUNTIME: path.join(ROOT, "engine", "test", "fake-runtime.ts"), FAKE_EVENTS: path.join(dir, "events.jsonl"), FAKE_SCENARIO: scenario };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const sent = () => (fs.existsSync(alerts) ? fs.readFileSync(alerts, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  try {
    const { pollOnce } = await import("../src/factory.js");
    fs.writeFileSync(scenario, JSON.stringify({ providerStatus: [{ provider: "claude", status: "needs_login" }, { provider: "codex", status: "ready" }] }));
    const first = await pollOnce(configPath, { env });
    assert.deepEqual(first.problems, ["builder 用的 claude 不可用（needs_login）：在 Paseo 中登录它"]);
    assert.match(first.notes.join(), /自检没有通过，这次不接新卡片/);
    assert.equal(sent().length, 1);
    assert.equal(sent()[0].type, "alert");
    assert.match(sent()[0].text, /暂停接新卡片：builder 用的 claude 不可用/);
    assert.equal(sent()[0].people.audience, "team");

    await pollOnce(configPath, { env });
    assert.equal(sent().length, 1, "同样的问题只告警一次");

    fs.writeFileSync(scenario, JSON.stringify({ quota: [{ provider: "claude", displayName: "Claude", window: "5 小时", usedPct: 100, resetsAt: null, tone: "danger" }] }));
    assert.match((await pollOnce(configPath, { env })).problems.join(), /Claude 的「5 小时」额度已用完/);
    assert.equal(sent().length, 2, "问题变了再说一次");

    fs.writeFileSync(scenario, JSON.stringify({ daemonDown: true }));
    assert.match((await pollOnce(configPath, { env })).problems.join(), /连不上 Paseo（connect ECONNREFUSED/);

    fs.writeFileSync(scenario, JSON.stringify({}));
    const ok = await pollOnce(configPath, { env });
    assert.deepEqual(ok.problems, []);
    assert.match(sent().at(-1).text, /自检恢复正常，继续接卡片/);
    assert.equal(sent().at(-1).details.recovered, true);
    await pollOnce(configPath, { env });
    assert.equal(sent().length, 4);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
