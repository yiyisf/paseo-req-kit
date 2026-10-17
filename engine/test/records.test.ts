// 1.9: the machine's index of requirements, usage records, `req stats` and `req api`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apiFile, apiList, apiStatus, attentionOf } from "../src/api.js";
import { readIndex, readRuns, requirementKey, type RunRecord, runsFile } from "../src/records.js";
import { describeStats, parsePeriod, statsCsv, statsMain, summarizeRuns } from "../src/stats.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const MAIN = path.join(ROOT, "engine", "src", "main.ts");
const FAKE = path.join(ROOT, "engine", "test", "fake-runtime.ts");
const FEATURE = "docs/features/20261012-sms-login";

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-records-home-"));
  process.env.REQ_KIT_HOME = home;
  return home;
}

function project(): { repo: string; configPath: string; scenarioPath: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-records-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", "-b", "feature/20261012-sms-login"], { cwd: repo });
  fs.mkdirSync(path.join(repo, FEATURE), { recursive: true });
  fs.writeFileSync(
    path.join(repo, FEATURE, "spec.md"),
    "# 短信验证码登录\n\n- 状态：已确认（2026-10-12）\n- 需求提出人：运营部\n\n## 5. 功能需求与验收标准\n\n### FR-1 用短信验证码登录\n- **AC-1.1** ...\n",
  );
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const configPath = path.join(repo, "..", `${path.basename(repo)}.config.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...base,
      agents: { builder: { provider: "claude/test-model", modeId: "bypassPermissions" }, reviewer: { provider: "codex/test-model", modeId: "full-access" } },
      waitChunkSeconds: 0.05,
      permissionPollSeconds: 0.01,
      notifyMilestones: false,
      reviewAxes: { enabled: false, profiles: ["standard"] },
    }),
  );
  const scenarioPath = path.join(repo, "..", `${path.basename(repo)}.scenario.json`);
  fs.writeFileSync(scenarioPath, "{}");
  return { repo, configPath, scenarioPath };
}

function runMain(p: ReturnType<typeof project>, env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(TSX, [MAIN, "--repo", p.repo, "--feature", FEATURE, "--config", p.configPath, "--origin-agent", "chat-1"], {
    env: { ...process.env, REQ_PIPELINE_FAKE_RUNTIME: FAKE, FAKE_SCENARIO: p.scenarioPath, FAKE_EVENTS: `${p.scenarioPath}.events`, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("需求索引与运行记录：流水线结束时登记需求、追加一条运行记录；req api 读得到", () => {
  const home = freshHome();
  const p = project();
  const { code, out } = runMain(p);
  assert.equal(code, 0, out);

  const index = readIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].repo, p.repo);
  assert.equal(index[0].featureDir, FEATURE);
  assert.equal(index[0].key, requirementKey(p.repo, FEATURE));
  assert.equal(index[0].present, true);

  const runs = readRuns(runsFile());
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.run.status, "completed");
  assert.equal(run.requirement.title, "短信验证码登录");
  assert.equal(run.requirement.name, "20261012-sms-login");
  assert.deepEqual(
    run.steps.map((s) => s.key),
    ["design", "design_review-r1", "implement", "code_review-r1", "handoff", "verify", "report"],
  );
  assert.match(run.agents.builder ?? "", /claude\/test-model/);

  const list = apiList({ repo: os.tmpdir(), all: true });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "短信验证码登录");
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].attention, null);
  assert.equal(list[0].running, false);

  const status = apiStatus(p.repo, "sms-login");
  assert.equal(status.steps.length, 7);
  assert.equal(status.steps[0].title, "方案设计");
  assert.ok(status.files.includes("spec.md"));
  assert.equal(apiFile(p.repo, "sms-login", "spec.md").content.split("\n")[0], "# 短信验证码登录");
  assert.throws(() => apiFile(p.repo, "sms-login", "../../../etc/passwd"), /只能读取这些文件/);

  // The JSON envelope through the req command.
  const cli = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "api", "list", "--all"], { env: process.env, encoding: "utf8", cwd: p.repo });
  assert.equal(cli.status, 0, cli.stderr);
  const envelope = JSON.parse(cli.stdout);
  assert.equal(envelope.schema, 1);
  assert.equal(envelope.data[0].featureDir, FEATURE);
  const refused = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "api", "run", "start", "sms-login"], { env: process.env, encoding: "utf8", cwd: p.repo });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, "not_allowed");

  // Gone from disk: still listed, marked; --prune forgets it.
  fs.rmSync(path.join(p.repo, FEATURE, ".pipeline"), { recursive: true });
  assert.equal(apiList({ repo: p.repo, all: true })[0].present, false);
  const prune = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "index", "--prune"], { env: process.env, encoding: "utf8", cwd: p.repo });
  assert.match(prune.stdout, /移除了 1 个/);
  assert.equal(readIndex().length, 0);
  assert.ok(fs.existsSync(path.join(home, "usage", "runs.jsonl")));
});

test("REQ_KIT_NO_RECORD：评估运行不进本机的索引和运行记录", () => {
  freshHome();
  const p = project();
  assert.equal(runMain(p, { REQ_KIT_NO_RECORD: "1" }).code, 0);
  assert.equal(readIndex().length, 0);
  assert.equal(readRuns(runsFile()).length, 0);
});

function run(over: {
  key: string;
  project?: string;
  start: string;
  end: string;
  status: string;
  outcome?: string | null;
  steps?: Array<{ stepId: string; minutes: number; round?: number | null; cost?: number }>;
  machine?: string;
  type?: string | null;
  builder?: string;
  gateFailed?: number;
  stopKind?: string | null;
  recoveries?: Record<string, number>;
}): RunRecord {
  return {
    schema: 1,
    kind: "run",
    machine: over.machine ?? "pc-1",
    kitVersion: "1.9.0",
    requirement: { key: over.key, project: over.project ?? "shop", name: `2026-${over.key}`, title: `需求 ${over.key}`, type: over.type ?? null, profile: "standard" },
    run: { startedAt: over.start, endedAt: over.end, attempt: 1, phase: "develop", phaseMode: "continuous", status: over.status, outcome: over.outcome ?? null, stopReason: null, ...(over.stopKind !== undefined ? { stopKind: over.stopKind } : {}), ...(over.recoveries ? { recoveries: over.recoveries } : {}) },
    agents: { builder: over.builder ?? "claude/opus", reviewer: "codex/gpt" },
    steps: (over.steps ?? []).map((s, i) => ({
      key: `${s.stepId}${s.round ? `-r${s.round}` : ""}`,
      stepId: s.stepId,
      phase: "develop",
      attempt: 1,
      round: s.round ?? null,
      startedAt: over.start,
      endedAt: over.end,
      minutes: s.minutes,
      outcome: "completed",
      inputTokens: 1000 * (i + 1),
      outputTokens: 100,
      costUsd: s.cost ?? null,
    })),
    gate: { runs: 2, failed: over.gateFailed ?? 0 },
  };
}

test("使用统计：交付周期、返工、等待确认、各步骤用时；按月份统计；CSV 一个需求一行", () => {
  const runs = [
    // A: waits for approval 2 hours, then completes on Oct 3 after two review rounds.
    run({ key: "a", start: "2026-10-01T01:00:00Z", end: "2026-10-01T02:00:00Z", status: "waiting_for_approval", steps: [{ stepId: "design", minutes: 30, cost: 1 }] }),
    run({
      key: "a",
      start: "2026-10-01T04:00:00Z",
      end: "2026-10-03T01:00:00Z",
      status: "completed",
      outcome: "completed",
      steps: [
        { stepId: "implement", minutes: 60, cost: 2 },
        { stepId: "code_review", minutes: 10, round: 1 },
        { stepId: "code_review", minutes: 8, round: 2 },
      ],
      gateFailed: 1,
    }),
    // B: a defect, completed with issues after a defect-fix round, on another machine.
    run({
      key: "b",
      machine: "pc-2",
      type: "defect",
      start: "2026-10-10T00:00:00Z",
      end: "2026-10-10T06:00:00Z",
      status: "completed",
      outcome: "completed_with_issues",
      steps: [
        { stepId: "design", minutes: 20 },
        { stepId: "defect_fix", minutes: 15, round: 1 },
      ],
    }),
    // C: last month, out of the period.
    run({ key: "c", start: "2026-09-20T00:00:00Z", end: "2026-09-20T03:00:00Z", status: "completed", outcome: "completed" }),
  ];
  const s = summarizeRuns(runs, parsePeriod({ month: "2026-10" }));
  assert.equal(s.active, 2);
  assert.equal(s.completed.total, 2);
  assert.deepEqual(s.completed.byOutcome, { completed: 1, completed_with_issues: 1 });
  assert.deepEqual(s.byType, { defect: 1, normal: 1 });
  assert.deepEqual(s.machines, ["pc-1", "pc-2"]);
  const a = s.requirements.find((q) => q.key === "a")!;
  assert.equal(a.cycleHours, 48);
  assert.equal(a.reviewRounds, 2);
  assert.equal(a.waits.approval, 120);
  assert.equal(a.costUsd, 3);
  assert.equal(s.cycleHours.median, 27);
  assert.equal(s.rework.averageReviewRounds, 1);
  assert.equal(s.rework.withDefectRounds, 0.5);
  assert.equal(s.rework.gateFailed, 1);
  assert.deepEqual(s.waits, [{ kind: "approval", label: "等待确认方案", requirements: 1, averageMinutes: 120 }]);
  assert.deepEqual(
    s.steps.map((x) => [x.stepId, x.count]),
    [
      ["design", 2],
      ["implement", 1],
      ["code_review", 2],
      ["defect_fix", 1],
    ],
  );
  const md = describeStats(s);
  assert.match(md, /# req-kit 使用情况：2026 年 10 月/);
  assert.match(md, /完成：2 个（已完成 1，已完成，有遗留问题 1）/);
  assert.match(md, /\| 等待确认方案 \| 1 \| 2 小时 \|/);
  const csv = statsCsv(s);
  assert.ok(csv.startsWith("﻿project,name,title"));
  assert.equal(csv.trim().split("\n").length, 3);

  // The same run exported twice (merged files) counts once.
  assert.equal(summarizeRuns([...runs, ...runs], parsePeriod({ month: "2026-10" })).requirements.find((q) => q.key === "a")!.runs, 2);
  assert.match(describeStats(summarizeRuns([], parsePeriod({ since: "7d" }))), /没有流水线运行记录/);
});

test("使用统计（1.12）：停下等人的原因、无人工到提测的比例、自动处理的比例；旧记录按状态推断", () => {
  const runs = [
    // a: approval only, then done — unattended.
    run({ key: "a", start: "2026-10-01T01:00:00Z", end: "2026-10-01T02:00:00Z", status: "waiting_for_approval", stopKind: "approval" }),
    run({ key: "a", start: "2026-10-01T03:00:00Z", end: "2026-10-01T04:00:00Z", status: "phase_done", stopKind: "phase_gate", recoveries: { retry: 2, extend_timeout: 1 } }),
    // b: a timeout on the way — not unattended.
    run({ key: "b", start: "2026-10-02T01:00:00Z", end: "2026-10-02T02:00:00Z", status: "failed", stopKind: "timeout" }),
    run({ key: "b", start: "2026-10-02T03:00:00Z", end: "2026-10-02T04:00:00Z", status: "completed", outcome: "completed", stopKind: null }),
    // c: an older record without stopKind.
    run({ key: "c", start: "2026-10-03T01:00:00Z", end: "2026-10-03T02:00:00Z", status: "waiting_for_business" }),
  ];
  const s = summarizeRuns(runs, parsePeriod({ month: "2026-10" }));
  assert.deepEqual(
    s.stops.map((x) => [x.kind, x.runs, x.necessary]),
    [["approval", 1, true], ["business", 1, false], ["phase_gate", 1, true], ["timeout", 1, false]],
  );
  assert.equal(s.automation.unattendedShare, 0.5);
  assert.deepEqual(s.automation.recovered, { retry: 2, extend_timeout: 1 });
  assert.equal(s.automation.interrupted, 1);
  assert.equal(s.automation.autoRecoveryShare, 0.75);
  const text = describeStats(s);
  assert.match(text, /## 人工介入/);
  assert.match(text, /除了确认方案外没有停下等人的：50%/);
  assert.match(text, /\| 步骤超时 \| 1 \| 否 \|/);
});

test("req stats：导出本机记录，合并多台机器的导出生成汇报文件", () => {
  const home = freshHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-stats-"));
  fs.mkdirSync(path.join(home, "usage"), { recursive: true });
  const mine = [run({ key: "a", start: "2026-10-01T01:00:00Z", end: "2026-10-01T05:00:00Z", status: "completed", outcome: "completed" })];
  fs.writeFileSync(runsFile(), `${mine.map((r) => JSON.stringify(r)).join("\n")}\n{torn line`);
  const log = console.log;
  const printed: string[] = [];
  console.log = (...a: unknown[]) => printed.push(a.join(" "));
  try {
    assert.equal(statsMain(["--month", "2026-10", "--export", "pc-1.jsonl"], process.env, dir), 0);
    fs.writeFileSync(path.join(dir, "pc-2.jsonl"), `${JSON.stringify(run({ key: "b", machine: "pc-2", start: "2026-10-02T00:00:00Z", end: "2026-10-02T02:00:00Z", status: "failed" }))}\n`);
    assert.equal(statsMain(["--month", "2026-10", "--merge", "pc-1.jsonl", "pc-2.jsonl", "--report", "--out", "out"], process.env, dir), 0);
  } finally {
    console.log = log;
  }
  assert.match(printed[0], /已导出 1 条运行记录/);
  const md = fs.readFileSync(path.join(dir, "out", "req-kit-usage-2026-10.md"), "utf8");
  assert.match(md, /机器：pc-1、pc-2/);
  assert.match(md, /有进展的需求：2 个/);
  assert.equal(fs.readFileSync(path.join(dir, "out", "req-kit-usage-2026-10.csv"), "utf8").trim().split("\n").length, 3);
  assert.throws(() => statsMain(["--merge", "missing.jsonl"], process.env, dir), /没有这个文件/);
  assert.throws(() => statsMain(["--month", "October"], process.env, dir), /看不懂月份/);
});

test("需要人处理的情况：等待确认、等待决定、中断、未完成", () => {
  assert.equal(attentionOf({ status: "waiting_for_approval", pid: 1, outcome: null }), "approval");
  assert.equal(attentionOf({ status: "waiting_for_business", pid: 1, outcome: null }), "business");
  assert.equal(attentionOf({ status: "running", pid: 99_999_999, outcome: null }), "interrupted");
  assert.equal(attentionOf({ status: "running", pid: process.pid, outcome: null }), null);
  assert.equal(attentionOf({ status: "completed", pid: 1, outcome: "not_completed" }), "not_completed");
  assert.equal(attentionOf(null), null);
});
