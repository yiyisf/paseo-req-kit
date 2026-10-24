import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FakeScenario } from "./fake-runtime.js";
import { isAlive, lockPath } from "../src/state.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
// tsx's own entry, run with this Node.js: node_modules/.bin/tsx is a shell script that Windows cannot start.
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAIN = path.join(ROOT, "engine", "src", "main.ts");
const LAUNCHER = path.join(ROOT, "bin", "start-pipeline");
const NODE_LAUNCHER = path.join(ROOT, "bin", "start-pipeline.mjs");
const FAKE = path.join(ROOT, "engine", "test", "fake-runtime.ts");
// Machine settings for every process these tests start: never the real ~/.req-kit.
const KIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-home-"));
process.env.REQ_KIT_HOME = KIT_HOME;
const FEATURE = "docs/features/20261012-sms-login";
const ORIGIN = "chat-agent-1";

interface Env {
  repo: string;
  configPath: string;
  eventsPath: string;
  scenarioPath: string;
}

function setup(configOverrides: Record<string, unknown> = {}, specStatus = "已确认（2026-10-12）"): Env {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "req-pipeline-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", "-b", "feature/20261012-sms-login"], { cwd: repo });
  fs.mkdirSync(path.join(repo, FEATURE), { recursive: true });
  fs.writeFileSync(
    path.join(repo, FEATURE, "spec.md"),
    `# 短信验证码登录\n\n- 状态：${specStatus}\n- 需求提出人：运营部\n\n## 5. 功能需求与验收标准\n\n### FR-1 用短信验证码登录\n- **AC-1.1** ...\n`,
  );
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const config = {
    ...base,
    agents: {
      builder: { provider: "claude/test-model", modeId: "bypassPermissions" },
      reviewer: { provider: "codex/test-model", modeId: "full-access" },
    },
    waitChunkSeconds: 0.05,
    permissionPollSeconds: 0.01,
    // Most tests count notifications; milestone notes have their own test.
    notifyMilestones: false,
    // Most tests count steps; the two review axes have their own test.
    reviewAxes: { enabled: false, profiles: ["standard"] },
    // Most tests count schedules and failures; the watchdog and self-healing have their own tests.
    watchdogMinutes: 0,
    selfHeal: false,
    answerQuestionsFirst: false,
    ...configOverrides,
  };
  const configPath = path.join(repo, "..", `${path.basename(repo)}.config.json`);
  fs.writeFileSync(configPath, JSON.stringify(config));
  return {
    repo,
    configPath,
    eventsPath: path.join(repo, "..", `${path.basename(repo)}.events.jsonl`),
    scenarioPath: path.join(repo, "..", `${path.basename(repo)}.scenario.json`),
  };
}

function fakeEnv(env: Env, scenario: FakeScenario): NodeJS.ProcessEnv {
  fs.writeFileSync(env.scenarioPath, JSON.stringify(scenario));
  return {
    ...process.env,
    REQ_PIPELINE_FAKE_RUNTIME: FAKE,
    FAKE_SCENARIO: env.scenarioPath,
    FAKE_EVENTS: env.eventsPath,
  };
}

function runMain(env: Env, scenario: FakeScenario, extra: string[] = [], origin: string | null = ORIGIN) {
  const args = [MAIN, "--repo", env.repo, "--feature", FEATURE, "--config", env.configPath, ...extra];
  if (origin) args.push("--origin-agent", origin);
  // Windows CI starts Node and compiles the engine noticeably slower, the first run most of all.
  const result = spawnSync(process.execPath, [TSX_CLI, ...args], { env: fakeEnv(env, scenario), encoding: "utf8", timeout: process.platform === "win32" ? 180_000 : 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

interface FakeEvent {
  type: string;
  key?: string;
  text?: string;
  agentId?: string;
  role?: string;
  provider?: string | null;
  modeId?: string | null;
  cwd?: string;
  id?: string;
  runAt?: string | null;
  cron?: string | null;
  names?: string[];
  providers?: string[];
  title?: string;
  parentAgentId?: string | null;
  labels?: Record<string, string>;
  hasSharedContext?: boolean;
  hasStepTask?: boolean;
  prompt?: string;
}

function events(env: Env): FakeEvent[] {
  if (!fs.existsSync(env.eventsPath)) return [];
  return fs
    .readFileSync(env.eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeEvent);
}

function starts(env: Env, from = 0): string[] {
  return events(env)
    .slice(from)
    .filter((e) => e.type === "start")
    .map((e) => e.key as string);
}

function notifications(env: Env): FakeEvent[] {
  return events(env).filter((e) => e.type === "notify");
}

function state(env: Env) {
  return JSON.parse(fs.readFileSync(path.join(env.repo, FEATURE, ".pipeline", "state.json"), "utf8"));
}

test("全部一次通过：按顺序执行，跳过不需要的步骤，结果发回发起对话", () => {
  const env = setup();
  const { code, out } = runMain(env, {});
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), ["design", "design_review-r1", "implement", "code_review-r1", "handoff", "verify", "report"]);

  const startEvents = events(env).filter((e) => e.type === "start");
  for (const e of startEvents) {
    assert.ok(e.hasSharedContext && e.hasStepTask, `${e.key} 的提示词不完整`);
    assert.equal(e.parentAgentId, ORIGIN);
    assert.equal(e.labels?.["requirement-pipeline"], "20261012-sms-login");
    assert.equal(e.labels?.["pipeline-step"], e.key);
  }
  const roles = Object.fromEntries(startEvents.map((e) => [e.key, e.role]));
  assert.deepEqual(roles, {
    design: "builder",
    "design_review-r1": "reviewer",
    implement: "builder",
    handoff: "builder",
    "code_review-r1": "reviewer",
    verify: "reviewer",
    report: "builder",
  });
  assert.equal(startEvents[0].title, "[20261012-sms-login] 3-方案设计");

  const notes = notifications(env);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].agentId, ORIGIN);
  assert.match(notes[0].text ?? "", /结论：已完成，可以验收/);
  assert.match(notes[0].text ?? "", /短信登录已经做好，可以验收。/);
  assert.match(notes[0].text ?? "", /docs\/features\/20261012-sms-login\/report\.md/);

  const s = state(env);
  assert.equal(s.status, "completed");
  assert.equal(s.outcome, "completed");
  assert.equal(s.history.length, 7);
  assert.ok(s.history.every((h: { outcome: string }) => h.outcome === "completed"));
  assert.equal(fs.readFileSync(path.join(env.repo, FEATURE, ".pipeline", ".gitignore"), "utf8"), "*\n");
  assert.ok(!fs.existsSync(lockPath(env.repo)), "锁没有释放");
});

test("返工路径：审核、评审、验证各自循环，直到通过", () => {
  const env = setup();
  const { code, out } = runMain(env, {
    steps: {
      design: { result: { has_runnable_service: true } },
      "design_review-r1": { result: { verdict: "changes_required" } },
      "code_review-r1": { result: { verdict: "changes_required" } },
      verify: { result: { result: "defects_found" } },
      "reverify-r1": { result: { result: "defects_remaining" } },
    },
  });
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), [
    "design",
    "design_review-r1",
    "design_revise-r1",
    "design_review-r2",
    "implement",
    "code_review-r1",
    "review_fix-r1",
    "code_review-r2",
    "handoff",
    "service_start",
    "verify",
    "defect_fix-r1",
    "reverify-r1",
    "defect_fix-r2",
    "reverify-r2",
    "report",
  ]);
  const titles = events(env).filter((e) => e.type === "start").map((e) => e.title);
  assert.ok(titles.includes("[20261012-sms-login] 4-方案审核 第2轮"));
});

test("轮数用完：继续往下走，报告结论为有遗留问题", () => {
  const env = setup({ rounds: { designReview: 2, codeReview: 3, defectFix: 3 } });
  const { code, out } = runMain(env, {
    steps: {
      design_review: { result: { verdict: "changes_required" } },
      code_review: { result: { verdict: "changes_required" } },
      verify: { result: { result: "defects_found" } },
      reverify: { result: { result: "defects_remaining" } },
      report: { result: { outcome: "completed_with_issues", summary: "主要功能可用，验证码过期提示还有问题。" } },
    },
  });
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), [
    "design",
    "design_review-r1",
    "design_revise-r1",
    "design_review-r2",
    "design_revise-r2",
    "implement",
    "code_review-r1",
    "review_fix-r1",
    "code_review-r2",
    "review_fix-r2",
    "code_review-r3",
    "review_fix-r3",
    "handoff",
    "verify",
    "defect_fix-r1",
    "reverify-r1",
    "defect_fix-r2",
    "reverify-r2",
    "defect_fix-r3",
    "reverify-r3",
    "report",
  ]);
  assert.match(notifications(env)[0].text ?? "", /结论：已完成，但有遗留问题/);
});

test("需要业务决定：暂停并把问题发回对话；更新 spec 后用 --resume 从方案设计重新开始", () => {
  const env = setup();
  const blocked = runMain(env, {
    steps: {
      design_review: {
        result: { verdict: "blocked", questions: ["历史订单也要显示新的配送状态吗？A. 只有新订单 B. 历史订单也显示"] },
      },
    },
  });
  assert.equal(blocked.code, 3, blocked.out);
  assert.deepEqual(starts(env), ["design", "design_review-r1"]);
  assert.equal(state(env).status, "waiting_for_business");

  const note = notifications(env)[0].text ?? "";
  assert.match(note, /需要用户决定的问题/);
  assert.match(note, /历史订单也要显示新的配送状态吗/);
  assert.match(note, /node .*start-pipeline\.mjs"? --repo .* --feature "?docs[\\/]features[\\/]20261012-sms-login"? --config .* --resume/);
  assert.doesNotMatch(note, /--origin-agent/, "继续命令由对话执行时会自动识别对话，不应写死对话 ID");
  assert.ok(!fs.existsSync(lockPath(env.repo)));

  const again = runMain(env, {});
  assert.equal(again.code, 2);
  assert.match(again.out, /--resume/);

  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n补充：历史订单不显示。\n");
  const before = events(env).length;
  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(starts(env, before), ["design", "design_review-r1", "implement", "code_review-r1", "handoff", "verify", "report"]);
  const s = state(env);
  assert.equal(s.status, "completed");
  assert.equal(s.attempt, 2);
  assert.equal(s.history.filter((h: { attempt: number }) => h.attempt === 1).length, 2);
});

test("步骤失败：通知中断原因；--resume 沿用已完成的步骤，从失败处继续", () => {
  const env = setup();
  const failed = runMain(env, { steps: { implement: { error: "provider process exited" } } });
  assert.equal(failed.code, 1, failed.out);
  const s = state(env);
  assert.equal(s.status, "failed");
  assert.match(s.stopReason, /代码实现/);
  const note = notifications(env)[0].text ?? "";
  assert.match(note, /在「代码实现」步骤停止/);
  assert.match(note, /provider process exited/);
  assert.match(note, /--resume/);

  const before = events(env).length;
  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(starts(env, before), ["implement", "code_review-r1", "handoff", "verify", "report"]);
  assert.match(resumed.out, /跳过 design：沿用上次运行的结果/);
  assert.equal(state(env).attempt, 1);
});

test("失败后修改了 spec：--resume 改为从方案设计重新开始", () => {
  const env = setup();
  assert.equal(runMain(env, { steps: { verify: { error: "boom" } } }).code, 1);
  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n补充一条验收标准。\n");
  const before = events(env).length;
  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(starts(env, before)[0], "design");
  assert.match(resumed.out, /spec\.md 在上次运行后被修改过/);
});

test("完成后修改需求或验收发现问题：spec 改过才能 --resume，并从方案设计重新开始", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  const unchanged = runMain(env, {}, ["--resume"]);
  assert.equal(unchanged.code, 2);
  assert.match(unchanged.out, /已经完成，没有可继续的步骤。要修改需求或修复验收中发现的问题，请先更新并重新确认 spec\.md/);

  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n- **AC-1.2** 验收发现：验证码过期后应提示重新获取。\n");
  const before = events(env).length;
  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(starts(env, before)[0], "design");
  assert.match(resumed.out, /流水线完成后 spec\.md 被修改过/);
  assert.equal(state(env).attempt, 2);
  assert.equal(state(env).status, "completed");
});

test("结果文件缺失或格式错误时提醒 agent 补写；一直不写则判定失败", () => {
  const env = setup();
  const ok = runMain(env, {
    steps: { "code_review-r1": { skipResultFirst: true }, verify: { invalidFirst: true } },
  });
  assert.equal(ok.code, 0, ok.out);
  const followUps = events(env).filter((e) => e.type === "followUp");
  assert.deepEqual(
    followUps.map((e) => e.key),
    ["code_review-r1", "verify"],
  );
  assert.match(followUps[0].text ?? "", /结果文件不存在/);
  assert.match(followUps[1].text ?? "", /verdict|缺少字段 result/);

  const env2 = setup();
  const bad = runMain(env2, { steps: { design: { neverWritesResult: true } } });
  assert.equal(bad.code, 1, bad.out);
  assert.equal(events(env2).filter((e) => e.type === "followUp").length, 2);
  assert.match(notifications(env2)[0].text ?? "", /仍没有得到有效的结果文件/);
});

test("等待权限批准：同一个请求只通知一次，批准后继续", () => {
  const env = setup();
  const { code, out } = runMain(env, { steps: { implement: { permission: true } } });
  assert.equal(code, 0, out);
  const notes = notifications(env);
  assert.equal(notes.length, 2);
  assert.match(notes[0].text ?? "", /「代码实现」步骤在等待权限批准/);
  assert.match(notes[0].text ?? "", /运行 npm install/);
  assert.match(notes[0].text ?? "", /\[20261012-sms-login\] 5-代码实现/);
  assert.match(notes[1].text ?? "", /流水线已经结束/);
  // 1.13: recorded while it waited (for the plugin's inbox), cleared once it went on.
  assert.equal(state(env).waitingPermission, null);
});

test("步骤超时：判定失败并说明 agent 可能仍在运行", () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const env = setup({ stepTimeoutMinutes: { ...base.stepTimeoutMinutes, implement: 0.003 } });
  const { code, out } = runMain(env, { steps: { implement: { hang: true } } });
  assert.equal(code, 1, out);
  assert.match(notifications(env)[0].text ?? "", /超过 0\.003 分钟仍未完成/);
  assert.match(notifications(env)[0].text ?? "", /还在运行，没有停止它/);
});

function timedOutImplement() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const env = setup({ stepTimeoutMinutes: { ...base.stepTimeoutMinutes, implement: 0.003 } });
  const first = runMain(env, { steps: { implement: { hang: true } } });
  assert.equal(first.code, 1, first.out);
  const old = events(env).find((e) => e.type === "start" && e.key === "implement");
  assert.ok(old?.agentId);
  return { env, oldId: old.agentId };
}

const implementStarts = (env: Env) => events(env).filter((e) => e.type === "start" && e.key === "implement").length;

test("超时后继续：旧 agent 已经做完时沿用它的结果，不另起 agent", () => {
  const { env, oldId } = timedOutImplement();
  const resumed = runMain(env, { leftovers: { [oldId]: "idle" } }, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(implementStarts(env), 1);
  const state = JSON.parse(fs.readFileSync(path.join(env.repo, FEATURE, ".pipeline", "state.json"), "utf8"));
  assert.deepEqual(state.results.implement, { status: "done" });
});

test("超时后继续：旧 agent 还在做时接着等它；再次超时才停止它并新建", () => {
  const { env, oldId } = timedOutImplement();
  // Still working, finishes while we wait again: no second agent.
  const { env: env2, oldId: oldId2 } = timedOutImplement();
  const waited = runMain(env, { leftovers: { [oldId]: "finishes" } }, ["--resume"]);
  assert.equal(waited.code, 0, waited.out);
  assert.equal(implementStarts(env), 1);
  assert.equal(events(env).filter((e) => e.type === "interrupt").length, 0);

  // Stuck: waited once more (times out again), then stopped before a new agent starts.
  const again = runMain(env2, { leftovers: { [oldId2]: "hang" } }, ["--resume"]);
  assert.equal(again.code, 1, again.out);
  assert.equal(implementStarts(env2), 1);
  const last = runMain(env2, { leftovers: { [oldId2]: "hang" } }, ["--resume"]);
  assert.equal(last.code, 0, last.out);
  const stops = events(env2).filter((e) => e.type === "interrupt");
  assert.deepEqual(stops.map((e) => e.agentId), [oldId2]);
  assert.equal(implementStarts(env2), 2);
  const stopAt = events(env2).findIndex((e) => e.type === "interrupt");
  const newStartAt = events(env2).findIndex((e, i) => i > stopAt && e.type === "start" && e.key === "implement");
  assert.ok(newStartAt > stopAt);
});

test("自愈：超时后同一个 agent 再等一轮；报错、结果无效时新开 agent 重做一次；有备用模型时换备用", () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const fallback = { provider: "opencode/backup-model" };

  // Runs over its time but finishes within a second period: no failure, no second agent.
  const slow = setup({ selfHeal: true, stepTimeoutMinutes: { ...base.stepTimeoutMinutes, implement: 0.003 } });
  const slowRun = runMain(slow, { steps: { implement: { finishAfterWaits: 6 } } });
  assert.equal(slowRun.code, 0, slowRun.out);
  assert.equal(implementStarts(slow), 1);
  assert.match(slowRun.out, /自动处理（implement）：超过 0\.003 分钟仍未完成，agent 还在做，再给它同样长的时间/);
  assert.deepEqual(state(slow).recoveries.map((r: { kind: string }) => r.kind), ["extend_timeout"]);

  // Never finishes: fails after twice the time, the stop is recorded as a timeout.
  const stuck = setup({ selfHeal: true, stepTimeoutMinutes: { ...base.stepTimeoutMinutes, implement: 0.003 } });
  assert.equal(runMain(stuck, { steps: { implement: { hang: true } } }).code, 1);
  assert.match(notifications(stuck)[0].text ?? "", /超过 0\.006 分钟仍未完成/);
  assert.equal(state(stuck).stopKind, "timeout");

  // An agent error: redone once with the fallback model.
  const errored = setup({ selfHeal: true, agents: { ...base.agents, builder: { provider: "claude/test-model" }, reviewer: { provider: "codex/test-model" }, fallback } });
  const erroredRun = runMain(errored, { steps: { implement: { errorStarts: 1 } } });
  assert.equal(erroredRun.code, 0, erroredRun.out);
  const starts = events(errored).filter((e) => e.type === "start" && e.key === "implement");
  assert.deepEqual(starts.map((e) => e.provider), ["claude/test-model", "opencode/backup-model"]);
  assert.match(starts[1].prompt ?? "", /自动重试：本步骤上一次中断了（agent 报告错误：tool crashed/);
  assert.deepEqual(state(errored).recoveries.map((r: { kind: string }) => r.kind), ["fallback"]);

  // Twice in a row: redone only once, then it stops.
  const twice = setup({ selfHeal: true });
  assert.equal(runMain(twice, { steps: { implement: { errorStarts: 2 } } }).code, 1);
  assert.equal(implementStarts(twice), 2);
  assert.equal(state(twice).stopKind, "agent_error");

  // No valid result even after the reminders: a new agent (same model) redoes it.
  const invalid = setup({ selfHeal: true });
  assert.equal(runMain(invalid, { steps: { implement: { noResultStarts: 1 } } }).code, 0);
  assert.equal(implementStarts(invalid), 2);
  assert.deepEqual(state(invalid).recoveries.map((r: { kind: string }) => r.kind), ["redo"]);

  // Rate limits after all the retries: one more try with the fallback model.
  const limited = setup({ retry: { attempts: 1, backoffSeconds: [0.01] }, agents: { ...base.agents, builder: { provider: "claude/test-model" }, reviewer: { provider: "codex/test-model" }, fallback } });
  assert.equal(runMain(limited, { steps: { implement: { transientErrors: 2 } } }).code, 0);
  assert.deepEqual(
    events(limited).filter((e) => e.type === "start" && e.key === "implement").map((e) => e.provider),
    ["claude/test-model", "claude/test-model", "opencode/backup-model"],
  );
});

test("方案审核要需求方决定时：builder 先自答，只把剩下的业务问题（带推荐答案）交给需求方；都答了就不停", async () => {
  const blocked = { verdict: "blocked", questions: ["导出用什么格式？", "历史订单要不要显示？"] };
  const all = setup({ answerQuestionsFirst: true });
  const allRun = runMain(all, { steps: { "design_review-r1": { result: blocked }, "design_revise-r1": { result: { status: "done", business_questions: [] } } } });
  assert.equal(allRun.code, 0, allRun.out);
  const revise = events(all).find((e) => e.type === "start" && e.key === "design_revise-r1");
  assert.match(revise?.prompt ?? "", /审核结论：需要需求方决定（2 个问题/);
  assert.ok(starts(all).includes("design_review-r2"), "自答后照常再审一轮");
  assert.deepEqual(state(all).recoveries.map((r: { kind: string }) => r.kind), ["self_answer"]);

  const some = setup({ answerQuestionsFirst: true });
  const left = "历史订单要不要显示？推荐：不显示（理由：没有数据）";
  assert.equal(runMain(some, { steps: { "design_review-r1": { result: blocked }, "design_revise-r1": { result: { status: "done", business_questions: [left] } } } }).code, 3);
  assert.equal(state(some).status, "waiting_for_business");
  assert.equal(state(some).stopKind, "business");
  assert.match(notifications(some).at(-1)?.text ?? "", /推荐：不显示/);
  assert.doesNotMatch(notifications(some).at(-1)?.text ?? "", /导出用什么格式/);

  // 1.12: the plugin's inbox sees the question and passes an answer to the chat.
  const { apiList } = await import("../src/api.js");
  const listed = apiList({ repo: some.repo, all: false }).find((i) => i.featureDir === FEATURE);
  assert.deepEqual(listed?.waiting?.questions, [left]);
  assert.equal(listed?.waiting?.canReply, true);
  const reply = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "reply", FEATURE, "历史订单不显示"], { cwd: some.repo, env: fakeEnv(some, {}), encoding: "utf8" });
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const relayed = notifications(some).at(-1);
  assert.equal(relayed?.agentId, ORIGIN);
  assert.match(relayed?.text ?? "", /来自 req-kit 插件[\s\S]*<plugin-reply>\n历史订单不显示\n<\/plugin-reply>/);
});

test("1.12.1：需求改了以后，上一次尝试留下的 agent 不接手、不沿用，先停掉再新建", () => {
  const { env, oldId } = timedOutImplement();
  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n- **AC-1.9** 新增：验证码 5 分钟过期。\n");
  const resumed = runMain(env, { leftovers: { [oldId]: "idle" } }, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(events(env).filter((e) => e.type === "interrupt").map((e) => e.agentId), [oldId]);
  assert.equal(implementStarts(env), 2, "按新需求新开一个 agent");
  assert.ok(!(state(env).recoveries ?? []).some((r: { kind: string }) => r.kind === "reuse_result"), "旧结果没有被沿用");
});

test("1.12.1：超时多等一轮只有一次，接着等旧 agent 时不再延长", () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const env = setup({ selfHeal: true, stepTimeoutMinutes: { ...base.stepTimeoutMinutes, implement: 0.003 } });
  assert.equal(runMain(env, { steps: { implement: { hang: true } } }).code, 1);
  const oldId = events(env).find((e) => e.type === "start" && e.key === "implement")?.agentId ?? "";
  assert.equal(runMain(env, { leftovers: { [oldId]: "hang" } }, ["--resume"]).code, 1);
  const kinds = state(env).recoveries.map((r: { kind: string }) => r.kind);
  assert.deepEqual(kinds.filter((k: string) => k === "extend_timeout"), ["extend_timeout"]);
  assert.ok(kinds.includes("reattach"));
});

test("1.12.1：最后一轮方案审核的问题由 builder 自答后，再审一轮", () => {
  const blocked = { verdict: "blocked", questions: ["导出用什么格式？"] };
  const env = setup({ answerQuestionsFirst: true });
  const run = runMain(env, { steps: { "design_review-r1": { result: blocked }, "design_revise-r1": { result: { status: "done", business_questions: [] } } } }, ["--profile", "quick"]);
  assert.equal(run.code, 0, run.out);
  const keys = starts(env);
  assert.ok(keys.includes("design_review-r2"), keys.join(","));
  assert.ok(keys.indexOf("design_review-r2") < keys.indexOf("implement"), "复核在写代码之前");
});

test("状态读不到的旧 agent：新建 agent", () => {
  const { env } = timedOutImplement();
  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(implementStarts(env), 2);
});

test("没有发起对话：步骤 agent 独立创建，通知只写日志", () => {
  const env = setup();
  const { code, out } = runMain(env, {}, [], null);
  assert.equal(code, 0, out);
  assert.ok(events(env).filter((e) => e.type === "start").every((e) => e.parentAgentId === null));
  assert.equal(notifications(env).length, 0);
  assert.match(out, /通知只写入日志/);
});

test("通知发送失败（对话已归档）不影响流水线完成", () => {
  const env = setup();
  const { code, out } = runMain(env, { notifyFails: true });
  assert.equal(code, 0, out);
  assert.match(out, /通知发送失败/);
  assert.equal(state(env).status, "completed");
});

test("启动前检查：spec 未确认、目录越界、同一仓库已有流水线时拒绝启动", () => {
  const unconfirmed = setup({}, "草稿");
  const launch = spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", unconfirmed.repo, "--feature", FEATURE, "--config", unconfirmed.configPath], {
    encoding: "utf8",
  });
  assert.equal(launch.status, 2);
  assert.match(launch.stderr, /未启动：spec\.md 还没有被确认/);
  assert.ok(!fs.existsSync(path.join(unconfirmed.repo, FEATURE, ".pipeline", "state.json")));

  const env = setup();
  const outside = spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", "../elsewhere", "--config", env.configPath], {
    encoding: "utf8",
  });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /功能目录必须位于仓库目录之内/);

  fs.writeFileSync(lockPath(env.repo), JSON.stringify({ pid: process.pid, featureDir: "docs/features/other", startedAt: "2026-10-12T00:00:00Z" }));
  try {
    const locked = spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--config", env.configPath], {
      encoding: "utf8",
    });
    assert.equal(locked.status, 2);
    assert.match(locked.stderr, /已有一条流水线在运行/);
  } finally {
    fs.rmSync(lockPath(env.repo), { force: true });
  }

  const badConfig = setup({ agents: { builder: { provider: "claude" }, reviewer: { provider: "codex/x" } } });
  const cfg = spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", badConfig.repo, "--feature", FEATURE, "--config", badConfig.configPath], {
    encoding: "utf8",
  });
  assert.equal(cfg.status, 2);
  assert.match(cfg.stderr, /provider\/model/);
});

function sessionId(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[3]);
  } catch {
    return null;
  }
}

function ancestorsOf(pid: number): number[] {
  const chain: number[] = [];
  let current = pid;
  for (let i = 0; i < 64; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${current}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!parent || parent === current) break;
      chain.push(parent);
      current = parent;
    } catch {
      break;
    }
  }
  return chain;
}

test("启动器：立即返回，流水线在独立会话中继续运行到结束", { skip: process.platform === "win32" ? "用 bash 和 Linux 的进程会话检查" : false }, async () => {
  // Slow the run down so it is still going when the launching shell exits.
  const env = setup({ permissionPollSeconds: 1.5 });
  fs.writeFileSync(env.scenarioPath, JSON.stringify({ steps: { implement: { permission: true } } }));
  const startedAt = Date.now();
  // The launching shell exits right after the launcher returns, like a chat agent's tool call.
  const shell = spawnSync(
    "bash",
    ["-c", `"${LAUNCHER}" --repo "${env.repo}" --feature ${FEATURE} --config "${env.configPath}" --origin-agent ${ORIGIN}; exit 0`],
    { encoding: "utf8", env: fakeEnv(env, { steps: { implement: { permission: true } } }) },
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /已在后台启动（新启动，标准档）/);
  assert.ok(elapsed < 10_000, `启动器用了 ${elapsed}ms`);

  const pid = Number(/进程 (\d+)/.exec(shell.stdout)?.[1]);
  assert.ok(pid > 0);
  // detached: true makes the pipeline its own session leader, outside the shell's session.
  assert.equal(sessionId(pid), pid, "流水线进程没有脱离启动它的会话");
  assert.notEqual(sessionId(pid), sessionId(process.pid));
  // Paseo stops a provider with tree-kill, which follows parent links. Once the
  // launcher has exited, the pipeline is no longer a descendant of whoever ran it.
  const ancestors = ancestorsOf(pid);
  assert.ok(!ancestors.includes(process.pid), `流水线仍是启动方的子孙进程：${ancestors.join(" <- ")}`);

  // The state turns "completed" a moment before the last log line and notification are
  // written, so wait for the process itself to exit before reading them.
  const statePath = path.join(env.repo, FEATURE, ".pipeline", "state.json");
  const logPath = path.join(env.repo, FEATURE, ".pipeline", "pipeline.log");
  const deadline = Date.now() + 30_000;
  let status = "";
  while (Date.now() < deadline) {
    if (fs.existsSync(statePath)) status = JSON.parse(fs.readFileSync(statePath, "utf8")).status;
    if (!isAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (fs.existsSync(statePath)) status = JSON.parse(fs.readFileSync(statePath, "utf8")).status;
  assert.equal(status, "completed");
  assert.match(fs.readFileSync(logPath, "utf8"), /流水线结束：completed/);
  assert.equal(notifications(env).length, 2);
});

test("发起对话不在仓库目录：启动器直接拒绝，不留下运行记录", () => {
  const env = setup();
  const result = spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--config", env.configPath, "--origin-agent", ORIGIN], {
    encoding: "utf8",
    env: { ...fakeEnv(env, {}), PASEO_AGENT_ID: ORIGIN, PASEO_AGENT_CWD: os.tmpdir() },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /与当前对话的工作目录 .* 不一致/);
  assert.match(result.stderr, /对话过程中不要切换工作目录/);
  assert.ok(!fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "state.json")));
});

test("在对话中用 node 启动器、只传 --feature：对话 ID 和仓库目录都从对话环境中识别", async () => {
  const env = setup();
  const shell = spawnSync(
    process.execPath,
    [NODE_LAUNCHER, "--feature", FEATURE, "--config", env.configPath],
    {
      encoding: "utf8",
      cwd: os.tmpdir(), // the shell's own cwd is somewhere else; the chat's directory must win
      env: { ...fakeEnv(env, {}), PASEO_AGENT_ID: ORIGIN, PASEO_AGENT_CWD: env.repo },
    },
  );
  assert.equal(shell.status, 0, shell.stderr);
  const statePath = path.join(env.repo, FEATURE, ".pipeline", "state.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath, "utf8")).status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(state(env).status, "completed");
  assert.equal(state(env).repo, fs.realpathSync(env.repo));
  assert.equal(state(env).originAgentId, ORIGIN);
  assert.ok(events(env).filter((e) => e.type === "start").every((e) => e.parentAgentId === ORIGIN));
});

test("发起对话的目录与仓库不一致或已不存在：流水线拒绝启动，通知对话，不写运行记录", () => {
  const env = setup();
  const mismatch = runMain(env, { originCwd: "/somewhere/else" });
  assert.equal(mismatch.code, 2, mismatch.out);
  assert.match(mismatch.out, /未启动：发起对话的工作目录是 \/somewhere\/else/);
  assert.equal(starts(env).length, 0);
  assert.match(notifications(env)[0].text ?? "", /流水线没有启动/);
  assert.ok(!fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "state.json")));
  assert.ok(!fs.existsSync(lockPath(env.repo)));

  const env2 = setup();
  const missing = runMain(env2, { originMissing: true });
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.out, /找不到发起对话的 agent/);
});

test("续跑时不传 --origin-agent：沿用并重新校验原来的发起对话", () => {
  const env = setup();
  assert.equal(runMain(env, { steps: { implement: { error: "boom" } } }).code, 1);
  const before = events(env).length;
  const resumed = runMain(env, {}, ["--resume"], null);
  assert.equal(resumed.code, 0, resumed.out);
  const after = events(env).slice(before);
  assert.deepEqual(after.filter((e) => e.type === "verifyOrigin").map((e) => e.agentId), [ORIGIN]);
  assert.ok(after.filter((e) => e.type === "start").every((e) => e.parentAgentId === ORIGIN));
});

// ---------------------------------------------------------------------------
// Worktree / branch rules
// ---------------------------------------------------------------------------

function launch(env: Env, extra: string[], scenario: FakeScenario = {}) {
  return spawnSync(
    process.execPath,
    [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--config", env.configPath, "--origin-agent", ORIGIN, ...extra],
    { encoding: "utf8", env: fakeEnv(env, scenario) },
  );
}

async function waitForStatus(env: Env, wanted: string[], timeoutMs = 30_000): Promise<string> {
  const file = path.join(env.repo, FEATURE, ".pipeline", "state.json");
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      status = JSON.parse(fs.readFileSync(file, "utf8")).status;
      if (wanted.includes(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return status;
}

test("分支规则：默认分支、分离 HEAD 上拒绝启动；续跑时分支变了也拒绝", () => {
  const env = setup();
  execFileSync("git", ["checkout", "-q", "-b", "main"], { cwd: env.repo });
  const onMain = launch(env, []);
  assert.equal(onMain.status, 2);
  assert.match(onMain.stderr, /当前在默认分支 main 上/);
  assert.match(onMain.stderr, /worktree 工作区/);

  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: env.repo });
  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: env.repo });
  const detached = launch(env, []);
  assert.equal(detached.status, 2);
  assert.match(detached.stderr, /detached HEAD/);

  execFileSync("git", ["checkout", "-q", "-b", "feature/20261012-sms-login"], { cwd: env.repo });
  assert.equal(runMain(env, { steps: { implement: { error: "boom" } } }).code, 1);
  assert.equal(state(env).branch, "feature/20261012-sms-login");
  execFileSync("git", ["checkout", "-q", "-b", "other-branch"], { cwd: env.repo });
  const moved = runMain(env, {}, ["--resume"]);
  assert.equal(moved.code, 2);
  assert.match(moved.out, /之前在分支 feature\/20261012-sms-login 上进行，现在的分支是 other-branch/);
});

test("步骤提示词带上工作分支和档位，并要求不要切换分支", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  const design = events(env).find((e) => e.type === "start" && e.key === "design");
  assert.match(design?.prompt ?? "", /工作分支：feature\/20261012-sms-login/);
  assert.match(design?.prompt ?? "", /档位：标准/);
  assert.match(design?.prompt ?? "", /不要切换分支/);
});

// ---------------------------------------------------------------------------
// Status and stop
// ---------------------------------------------------------------------------

test("进度查询：未启动、运行中、已完成时都给出白话说明", async () => {
  const env = setup({ permissionPollSeconds: 3 });
  const before = launch(env, ["--status"]);
  assert.equal(before.status, 0);
  assert.match(before.stdout, /还没有启动过开发流水线/);

  // Slow run: the implement step waits on a permission for a while. Every call passes
  // the same scenario, because the helper rewrites the scenario file the pipeline reads.
  const scenario = { steps: { implement: { permission: true } } };
  assert.equal(launch(env, [], scenario).status, 0);
  const deadline = Date.now() + 15_000;
  let during = "";
  while (Date.now() < deadline) {
    during = launch(env, ["--status"], scenario).stdout;
    if (/当前步骤：代码实现/.test(during)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(during, /状态：运行中/);
  assert.match(during, /当前步骤：代码实现，已进行/);
  assert.match(during, /1\. 方案设计：完成/);
  assert.match(during, /2\. 方案审核（第 1 轮）：通过/);

  assert.equal(await waitForStatus(env, ["completed"]), "completed");
  const after = launch(env, ["--status"], scenario).stdout;
  assert.match(after, /状态：已完成（已完成，可以验收）/);
  assert.match(after, /完成报告：已完成，可以验收/);
});

test("停止：结束后台进程、打断当前步骤的 agent、可以续跑", async () => {
  const env = setup({ permissionPollSeconds: 5 });
  const scenario = { steps: { implement: { permission: true } } };
  const started = launch(env, [], scenario);
  assert.equal(started.status, 0, started.stderr);
  const pid = Number(/进程 (\d+)/.exec(started.stdout)?.[1]);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !events(env).some((e) => e.type === "start" && e.key === "implement")) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stopped = launch(env, ["--stop"], scenario);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /流水线已停止，停在「代码实现」/);
  assert.match(stopped.stdout, /--resume/);

  assert.ok(!fs.existsSync(`/proc/${pid}`), "后台进程仍在运行");
  const s = state(env);
  assert.equal(s.status, "failed");
  assert.equal(s.stopReason, "已被手动停止");
  const implementAgent = events(env).find((e) => e.type === "start" && e.key === "implement")?.agentId;
  const interrupt = events(env).find((e) => e.type === "interrupt");
  assert.equal(interrupt?.agentId, implementAgent);
  assert.match(interrupt?.text ?? "", /不要再修改任何文件/);
  assert.ok(!fs.existsSync(lockPath(env.repo)), "锁没有释放");

  const again = launch(env, ["--stop"], scenario);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /当前没有在运行/);

  const before = events(env).length;
  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(starts(env, before)[0], "implement");
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const REWORK: FakeScenario = {
  steps: {
    design: { result: { has_runnable_service: true } },
    code_review: { result: { verdict: "changes_required" } },
    verify: { result: { result: "defects_found" } },
    reverify: { result: { result: "defects_remaining" } },
  },
};

test("快速档：各环节只做一轮，跳过服务启动验证；提示词注明保持简短", () => {
  const env = setup();
  const { code, out } = runMain(env, REWORK, ["--profile", "quick"]);
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), [
    "design",
    "design_review-r1",
    "implement",
    "code_review-r1",
    "review_fix-r1",
    "handoff",
    "verify",
    "defect_fix-r1",
    "reverify-r1",
    "report",
  ]);
  assert.match(out, /快速档不执行服务启动验证/);
  assert.equal(state(env).profile, "quick");
  const design = events(env).find((e) => e.type === "start" && e.key === "design");
  assert.match(design?.prompt ?? "", /档位：快速（小改动：各产物只写必要内容，保持简短）/);
});

test("档位来源：spec 中的档位行；续跑沿用上次的档位；--profile 优先", () => {
  const env = setup();
  const spec = path.join(env.repo, FEATURE, "spec.md");
  fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replace("- 需求提出人", "- 档位：快速\n- 需求提出人"));
  assert.equal(runMain(env, { steps: { implement: { error: "boom" } } }).code, 1);
  assert.equal(state(env).profile, "quick");
  assert.equal(runMain(env, {}, ["--resume"]).code, 0);
  assert.equal(state(env).profile, "quick");
  assert.equal(runMain(env, REWORK, ["--restart", "--profile", "standard"]).code, 0);
  assert.equal(state(env).profile, "standard");
  assert.ok(starts(env).includes("code_review-r3"));
});

// ---------------------------------------------------------------------------
// Project customisation
// ---------------------------------------------------------------------------

test("项目配置：覆盖本机配置，机器相关的字段被忽略并提示", () => {
  const env = setup();
  fs.writeFileSync(
    path.join(env.repo, ".requirement-pipeline.json"),
    JSON.stringify({ defaultProfile: "quick", daemonUrl: "ws://elsewhere/ws", profiles: { quick: { rounds: { codeReview: 2 } } } }),
  );
  const launched = launch(env, ["--status"]);
  assert.equal(launched.status, 0);
  const { code, out } = runMain(env, REWORK);
  assert.equal(code, 0, out);
  assert.match(out, /配置：.*pipeline.*\.config\.json → .*\.requirement-pipeline\.json/);
  assert.match(out, /daemonUrl 只能在本机配置中设置，已忽略/);
  assert.equal(state(env).profile, "quick");
  assert.deepEqual(
    starts(env).filter((k) => k.startsWith("code_review")),
    ["code_review-r1", "code_review-r2"],
  );
});

test("项目补充说明：追加到每个步骤；按步骤的说明只出现在对应步骤", () => {
  const env = setup();
  const dir = path.join(env.repo, ".requirement-pipeline");
  fs.mkdirSync(path.join(dir, "steps"), { recursive: true });
  fs.writeFileSync(path.join(dir, "project-notes.md"), "本项目使用 pnpm，不要改动 legacy/ 目录。");
  fs.writeFileSync(path.join(dir, "steps", "verify.md"), "端到端测试用 pnpm e2e 运行。");
  assert.equal(runMain(env, {}).code, 0);
  const prompts: Record<string, string> = Object.fromEntries(
    events(env)
      .filter((e) => e.type === "start")
      .map((e): [string, string] => [e.key ?? "", e.prompt ?? ""]),
  );
  for (const [key, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /# 本项目的补充说明[\s\S]*本项目使用 pnpm/, `${key} 缺少项目说明`);
    // The project section comes after the task and before the run context.
    assert.ok(prompt.indexOf("# 本项目的补充说明") > prompt.indexOf("# 本步骤任务"));
    assert.ok(prompt.indexOf("# 本项目的补充说明") < prompt.lastIndexOf("<pipeline-context>"));
  }
  assert.match(prompts.verify, /## 针对本步骤\s+端到端测试用 pnpm e2e 运行。/);
  assert.doesNotMatch(prompts.design, /pnpm e2e/);
});

test("工作原则：每个步骤的提示词都带上原则索引，位于通用要求之后、本步骤任务之前", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  const prompts = events(env).filter((e) => e.type === "start").map((e) => e.prompt ?? "");
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.match(prompt, /# 工作原则[\s\S]*证明它能用[\s\S]*别卡在等人/);
    assert.ok(prompt.indexOf("# 工作原则") > prompt.indexOf("# 背景：你在一条需求开发流水线中"));
    assert.ok(prompt.indexOf("# 工作原则") < prompt.indexOf("# 本步骤任务"));
    // The index's own title is replaced by the section heading.
    assert.doesNotMatch(prompt, /# req-kit 工作原则索引/);
  }
});

test("验证方法 verify.md：只追加到构建、启动、测试相关的步骤", () => {
  const env = setup({}, "已确认（2026-10-12）");
  const dir = path.join(env.repo, ".requirement-pipeline");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "verify.md"), "单元测试：pnpm test\n启动：pnpm dev，等待 http://localhost:3000/health 返回 200");
  const scenario = { steps: { "code_review-r1": { result: { verdict: "changes_required" } }, verify: { result: { result: "defects_found" } } } };
  assert.equal(runMain(env, scenario).code, 0);
  const prompts: Record<string, string> = Object.fromEntries(
    events(env)
      .filter((e) => e.type === "start")
      .map((e): [string, string] => [e.key ?? "", e.prompt ?? ""]),
  );
  for (const key of ["implement", "review_fix-r1", "verify", "defect_fix-r1", "reverify-r1"]) {
    assert.match(prompts[key] ?? "", /## 本项目的验证方法[\s\S]*pnpm dev，等待/, `${key} 缺少验证方法`);
  }
  for (const key of ["design", "design_review-r1", "code_review-r1", "report"]) {
    assert.doesNotMatch(prompts[key] ?? "", /本项目的验证方法/, `${key} 不应包含验证方法`);
  }
});

test("决策记录：每个步骤的提示词都说明 decisions.tsv 的写法；报告汇总需要人确认的决定", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  const starts = events(env).filter((e) => e.type === "start");
  for (const e of starts) assert.match(e.prompt ?? "", /decisions\.tsv[\s\S]*time\tstep\tref\tdecision\talternatives\treason\tkind\tneeds_human/);
  const report = starts.find((e) => e.key === "report")?.prompt ?? "";
  assert.match(report, /需要你确认的决定[\s\S]*needs_human` 为 `yes`/);
});

test("--list：列出所有工作区中的需求及其阶段，同一需求取最近更新的一份", () => {
  const env = setup();
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: env.repo });
  const other = `${env.repo}-wt`;
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/20261013-export", other], { cwd: env.repo });
  const add = (root: string, name: string, spec: string, state?: object, acceptance?: string) => {
    const dir = path.join(root, "docs", "features", name);
    fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.md"), spec);
    if (state) fs.writeFileSync(path.join(dir, ".pipeline", "state.json"), JSON.stringify(state));
    if (acceptance) fs.writeFileSync(path.join(dir, "acceptance.md"), acceptance);
  };
  add(other, "20261013-export", "# 订单导出\n\n- 状态：已确认（2026-10-13）\n- 档位：快速\n- 类型：小改动\n- 版本：2\n", { status: "completed", outcome: "completed" });
  add(other, "20261014-draft", "# 草稿需求\n\n- 状态：草稿\n");
  add(env.repo, "20261011-old", "# 旧需求\n\n- 状态：已确认（2026-10-11）\n", { status: "completed", outcome: "completed" }, "# 验收记录\n\n- 验收结论：通过（2026-10-12）\n");
  add(env.repo, "20261010-stuck", "# 卡住的需求\n\n- 状态：已确认（2026-10-10）\n", { status: "running", pid: 2 ** 22 + 4321 });

  const result = spawnSync(process.execPath, [NODE_LAUNCHER, "--list", "--repo", env.repo], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /共 5 个需求/);
  assert.match(out, /订单导出（docs\/features\/20261013-export）\n   待验收；小改动；快速档；需求第 2 版/);
  assert.match(out, /草稿需求[\s\S]*?对齐中/);
  assert.match(out, /旧需求[\s\S]*?已验收/);
  assert.match(out, /卡住的需求[\s\S]*?已中断（可继续）/);
  assert.match(out, /短信验证码登录[\s\S]*?已确认，未开始开发[\s\S]*?位置：当前工作区，分支 feature\/20261012-sms-login/);
  assert.match(out, new RegExp(`位置：工作区 ${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}，分支 feature/20261013-export`));
});

const PANEL = {
  // Member failures in these tests are not meant to be retried.
  retry: { attempts: 0, backoffSeconds: [0] },
  reviewPanel: {
    enabled: true,
    members: [
      { name: "安全视角", provider: "codex/panel-a", modeId: "full-access", focus: "重点检查权限和数据安全" },
      { provider: "opencode/openai/panel-b", modeId: "build", featureValues: { auto_accept: true } },
    ],
  },
};

test("评审小组：首轮方案审核和代码评审先由成员并行评审，再由评审者核实汇总；后续轮次不用小组", () => {
  const env = setup(PANEL);
  const scenario = { steps: { "code_review-r1": { result: { verdict: "changes_required" } } } };
  const result = runMain(env, scenario);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(starts(env), [
    "design",
    "design_review-r1-p1",
    "design_review-r1-p2",
    "design_review-r1",
    "implement",
    "code_review-r1-p1",
    "code_review-r1-p2",
    "code_review-r1",
    "review_fix-r1",
    "code_review-r2",
    "handoff",
    "verify",
    "report",
  ]);
  const all = events(env).filter((e) => e.type === "start");
  const byKey = (key: string) => all.find((e) => e.key === key)!;
  const member = byKey("code_review-r1-p1");
  assert.equal(member.provider, "codex/panel-a");
  assert.equal(byKey("code_review-r1-p2").provider, "opencode/openai/panel-b");
  assert.equal(byKey("code_review-r1").provider, "codex/test-model", "汇总者使用配置的 reviewer");
  assert.match(member.title ?? "", /6-代码评审 评审小组·安全视角/);
  assert.match(byKey("code_review-r1-p2").title ?? "", /评审小组·成员 2/);
  const prompt = member.prompt ?? "";
  assert.match(prompt, /# 本步骤任务：评审小组成员[\s\S]*# 评审标准（引用自该评审步骤的说明）[\s\S]*# 本步骤任务：代码评审/);
  assert.match(prompt, /你的意见文件：docs\/features\/20261012-sms-login\/review-panel\/code_review-r1-p1\.md/);
  assert.match(prompt, /你的关注重点：重点检查权限和数据安全/);
  const consolidate = byKey("code_review-r1").prompt ?? "";
  assert.match(consolidate, /# 评审小组的意见[\s\S]*由 2 位评审者各自独立评审/);
  assert.match(consolidate, /review-panel\/code_review-r1-p1\.md[\s\S]*review-panel\/code_review-r1-p2\.md/);
  assert.match(consolidate, /已驳回[\s\S]*评审小组意见汇总/);
  assert.doesNotMatch(byKey("code_review-r2").prompt ?? "", /评审小组/);
  assert.ok(fs.existsSync(path.join(env.repo, FEATURE, "review-panel", "design_review-r1-p2.md")));
});

test("评审小组：快速档不使用；成员失败时只汇总完成的成员；续跑时沿用已完成成员的结果", () => {
  const quick = setup(PANEL);
  assert.equal(runMain(quick, {}, ["--profile", "quick"]).code, 0);
  assert.ok(!starts(quick).some((k) => k.includes("-p")), "快速档不应启动评审小组");

  const env = setup(PANEL);
  const partial = runMain(env, { steps: { "design_review-r1-p2": { error: "model unavailable" } } });
  assert.equal(partial.code, 0, partial.out);
  const consolidate = events(env).find((e) => e.type === "start" && e.key === "design_review-r1")?.prompt ?? "";
  assert.match(consolidate, /其中 1 位没有完成，只有下面 1 份/);
  assert.doesNotMatch(consolidate, /design_review-r1-p2\.md/);

  const resumed = setup(PANEL);
  assert.equal(runMain(resumed, { steps: { "design_review-r1": { error: "boom" } } }).code, 1);
  const before = events(resumed).length;
  assert.equal(runMain(resumed, {}, ["--resume"]).code, 0);
  assert.equal(starts(resumed, before)[0], "design_review-r1", "成员已完成，续跑时直接汇总");
});

test("评审小组：开启但没有成员时，启动前就报配置错误", () => {
  const env = setup({ reviewPanel: { enabled: true, members: [] } });
  const result = runMain(env, {});
  assert.notEqual(result.code, 0);
  assert.match(result.out, /开启了 reviewPanel，但 reviewPanel\.members 为空/);
});

test("外部通知：按配置把事件交给通知模块；模块出错或超时不影响流水线", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-notifier-"));
  const sink = path.join(dir, "events.jsonl");
  fs.writeFileSync(
    path.join(dir, "im.mjs"),
    `import fs from "node:fs";\nexport default async function notify(event, options) { fs.appendFileSync(${JSON.stringify(sink)}, JSON.stringify({ event, options }) + "\\n"); }\n`,
  );
  fs.writeFileSync(path.join(dir, "broken.mjs"), "export default () => { throw new Error('IM 不可用'); };\n");
  fs.writeFileSync(path.join(dir, "nothing.mjs"), "export const other = 1;\n");
  const env = setup({
    notifyMilestones: true,
    notifiers: [
      { module: path.join(dir, "im.mjs"), events: ["milestone", "blocked", "completed"], options: { group: "dev" } },
      { module: path.join(dir, "broken.mjs") },
      { module: path.join(dir, "nothing.mjs") },
    ],
  });
  const blocked = runMain(env, { steps: { "design_review-r1": { result: { verdict: "blocked", questions: ["过期的验证码能否重发？"] } } } });
  assert.equal(blocked.code, 3, blocked.out);
  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n补充：可以重发。\n");
  const done = runMain(env, {}, ["--resume"]);
  assert.equal(done.code, 0, done.out);

  const sent = fs.readFileSync(sink, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(sent.map((s) => s.event.type), ["blocked", "milestone", "milestone", "completed"]);
  const first = sent[0].event;
  assert.equal(first.schema, 1);
  assert.equal(first.feature.title, "短信验证码登录");
  assert.equal(first.feature.dir, FEATURE);
  assert.equal(first.branch, "feature/20261012-sms-login");
  assert.deepEqual(first.details.questions, ["过期的验证码能否重发？"]);
  assert.match(first.text, /1 个需要需求方决定的问题/);
  assert.deepEqual(sent[0].options, { group: "dev" });
  // 1.12: not from a card: nobody in particular, the group.
  assert.deepEqual(first.people, { audience: "team", requester: null, card: null, recipients: [] });
  assert.equal(sent[3].event.details.outcome, "completed");
  assert.match(sent[3].event.details.summary, /可以验收/);

  const log = done.out;
  assert.match(log, /外部通知失败（completed，.*broken\.mjs）：IM 不可用。不影响流水线/);
  assert.match(log, /nothing\.mjs 没有导出 notify 函数/);
});

test("临时错误自动重试：限流等错误换一个 agent 重试并提示检查上次的改动；普通错误不重试；重试用完才失败", () => {
  const env = setup({ retry: { attempts: 2, backoffSeconds: [0.01] } });
  const ok = runMain(env, { steps: { implement: { transientErrors: 2 } } });
  assert.equal(ok.code, 0, ok.out);
  const implementStarts = events(env).filter((e) => e.type === "start" && e.key === "implement");
  assert.equal(implementStarts.length, 3);
  assert.doesNotMatch(implementStarts[0].prompt ?? "", /自动重试/);
  assert.match(implementStarts[1].prompt ?? "", /自动重试：本步骤上一次中断了（agent 报告错误：provider error: rate limit exceeded \(429\)）/);
  assert.equal((implementStarts[2].prompt ?? "").match(/自动重试：/g)?.length, 1, "重试说明只保留一条");
  assert.match(ok.out, /遇到临时错误.*0\.01 秒后自动重试（第 1 次，最多 2 次）/);

  const plain = setup({ retry: { attempts: 2, backoffSeconds: [0.01] } });
  assert.equal(runMain(plain, { steps: { implement: { error: "tests failed: syntax error" } } }).code, 1);
  assert.equal(events(plain).filter((e) => e.type === "start" && e.key === "implement").length, 1);

  const exhausted = setup({ retry: { attempts: 1, backoffSeconds: [0.01] } });
  assert.equal(runMain(exhausted, { steps: { verify: { transientErrors: 5 } } }).code, 1);
  assert.match(notifications(exhausted).at(-1)?.text ?? "", /rate limit exceeded \(429\)（已自动重试 1 次）/);
});

test("需求变更后继续：各步骤在已有方案和代码上增量处理；--restart 则从零开始", () => {
  const env = setup();
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: env.repo });
  assert.equal(runMain(env, {}).code, 0);
  assert.equal(state(env).incremental, null);
  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n- **AC-1.2** 新增：验证码 5 分钟过期。\n");
  const before = events(env).length;
  assert.equal(runMain(env, {}, ["--resume"]).code, 0);
  const second = events(env).slice(before).filter((e) => e.type === "start");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.repo, encoding: "utf8" }).trim();
  for (const e of second) {
    assert.match(e.prompt ?? "", /# 这次是需求变更后的继续/, `${e.key} 缺少增量说明`);
    assert.match(e.prompt ?? "", /增量继续：本次是第 2 次尝试，接着第 1 次的工作（流水线完成后 spec\.md 被修改过/);
    assert.match(e.prompt ?? "", /上一次是否已经写过代码：是/);
    assert.match(e.prompt ?? "", new RegExp(`本次开始时的提交：${head}`));
  }
  assert.equal(state(env).incremental?.fromAttempt, 1);

  const mark = events(env).length;
  assert.equal(runMain(env, {}, ["--restart"]).code, 0);
  const third = events(env).slice(mark).filter((e) => e.type === "start");
  assert.ok(third.every((e) => !(e.prompt ?? "").includes("这次是需求变更后的继续")));
  assert.equal(state(env).incremental, null);
});

test("回答了需求方的问题后继续：标记为增量，但上一次没有写过代码", () => {
  const env = setup();
  assert.equal(runMain(env, { steps: { "design_review-r1": { result: { verdict: "blocked", questions: ["要不要支持海外手机号？"] } } } }).code, 3);
  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n只支持中国大陆手机号。\n");
  const before = events(env).length;
  assert.equal(runMain(env, {}, ["--resume"]).code, 0);
  const design = events(env).slice(before).find((e) => e.type === "start" && e.key === "design")?.prompt ?? "";
  assert.match(design, /上一次是否已经写过代码：否/);
  assert.match(design, /上次因等待需求方决定而停止/);
});

test("用时与用量：每步记录 agent 报告的用量；报告步骤拿到汇总数字；进度查询显示合计", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  const history = state(env).history;
  assert.ok(history.every((h: { usage?: { inputTokens?: number } }) => h.usage?.inputTokens === 12_000));
  const report = events(env).find((e) => e.type === "start" && e.key === "report")?.prompt ?? "";
  const steps = history.length - 1;
  assert.match(report, new RegExp(`用时与用量（本次尝试，截至报告前）：${steps} 个步骤，agent 合计用时 .+；输入 ${(steps * 1.2).toFixed(1).replace(/\.0$/, "")} 万 tokens`));
  const status = spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--status"], { encoding: "utf8" });
  assert.match(status.stdout, /用时与用量：\d+ 个步骤，agent 合计用时/);
});

test("简写：--feature 可以只写名称的一部分；--status 不写 --feature 时自动选唯一运行过的需求", () => {
  const env = setup();
  const status = (...extra: string[]) =>
    spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--status", ...extra], { encoding: "utf8" });
  // Nothing has run yet: falls back to the list.
  assert.match(status().stdout, /共 1 个需求/);
  assert.equal(runMain(env, {}).code, 0);
  assert.match(status().stdout, /已完成|结束/);
  assert.match(status("--feature", "sms-login").stdout, /已完成|结束/);
  fs.mkdirSync(path.join(env.repo, "docs/features/20261013-sms-limit/.pipeline"), { recursive: true });
  fs.writeFileSync(path.join(env.repo, "docs/features/20261013-sms-limit/spec.md"), "# 短信限流\n");
  fs.writeFileSync(path.join(env.repo, "docs/features/20261013-sms-limit/.pipeline/state.json"), "{}");
  assert.match(status().stdout, /多个需求运行过[\s\S]*共 2 个需求/);
  const ambiguous = status("--feature", "sms");
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /对应多个需求/);
  assert.match(status("--feature", "nothing-like-this").stderr, /没有找到/);
});

const PASEO_PROFILES = [
  { id: "p-1", name: "实现", provider: "claude", model: "opus-x", modeId: "bypassPermissions", notes: "写代码" },
  { id: "p-2", name: "评审", provider: "codex", model: "gpt-x", modeId: "read-only" },
];

test("Paseo profile：角色写 profile 名称，启动时按 daemon 中的 profile 解析，自己写的字段优先", () => {
  const env = setup({ agents: { builder: { paseoProfile: "实现" }, reviewer: { paseoProfile: "评审", modeId: "full-access" } } });
  const { code, out } = runMain(env, { paseoProfiles: PASEO_PROFILES });
  assert.equal(code, 0, out);
  const byKey = (key: string) => events(env).find((e) => e.type === "start" && e.key === key)!;
  assert.equal(byKey("design").provider, "claude/opus-x");
  assert.equal(byKey("design").modeId, "bypassPermissions");
  assert.equal(byKey("code_review-r1").provider, "codex/gpt-x");
  assert.equal(byKey("code_review-r1").modeId, "full-access", "配置中写的 modeId 覆盖 profile 的");
  assert.match(out, /builder：Paseo profile「实现」→ claude\/opus-x（模式 bypassPermissions）/);
});

test("Paseo profile：名称不存在时不启动，告诉对话现有哪些 profile", () => {
  const env = setup({ agents: { builder: { paseoProfile: "实现者" }, reviewer: { provider: "codex/test-model", modeId: "full-access" } } });
  const { code } = runMain(env, { paseoProfiles: PASEO_PROFILES });
  assert.equal(code, 2);
  assert.ok(!fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "state.json")), "拒绝启动时不留下状态文件");
  const text = notifications(env).at(-1)?.text ?? "";
  assert.match(text, /流水线没有启动：agents\.builder 使用的 Paseo profile「实现者」不存在。现有的 profile：「实现」、「评审」/);
});

test("Paseo 管理的服务：服务启动和验证前用当前代码重启 paseo.json 中的服务，报告前停止", () => {
  const env = setup();
  const { code, out } = runMain(env, {
    steps: { design: { result: { has_runnable_service: true } } },
    services: { names: ["web"] },
  });
  assert.equal(code, 0, out);
  const all = events(env);
  const order = all
    .filter((e) => ["start", "startServices", "stopServices"].includes(e.type))
    .map((e) => (e.type === "start" ? e.key : e.type));
  assert.deepEqual(order, [
    "design",
    "design_review-r1",
    "implement",
    "code_review-r1",
    "handoff",
    "startServices",
    "service_start",
    "startServices",
    "verify",
    "stopServices",
    "report",
  ]);
  const prompt = all.find((e) => e.type === "start" && e.key === "service_start")?.prompt ?? "";
  assert.match(prompt, /Paseo 管理的服务：web → http:\/\/web--feature--repo\.localhost:6767（端口 41000），已启动，健康检查通过/);
  assert.match(prompt, /# Paseo 管理的服务/);
  assert.doesNotMatch(all.find((e) => e.type === "start" && e.key === "design")?.prompt ?? "", /Paseo 管理的服务/);
  assert.deepEqual(all.find((e) => e.type === "stopServices")?.names, ["web"]);
});

test("Paseo 管理的服务：启动失败时把输出写到文件交给步骤；关闭后或没有发起对话时不使用", () => {
  const env = setup();
  assert.equal(runMain(env, { services: { names: ["web"], failing: ["web"] } }).code, 0);
  const prompt = events(env).find((e) => e.type === "start" && e.key === "verify")?.prompt ?? "";
  assert.match(prompt, new RegExp(`web 没有启动成功（退出码 1），最后的输出见 ${FEATURE}/\\.pipeline/services/web\\.log`));
  assert.match(fs.readFileSync(path.join(env.repo, FEATURE, ".pipeline", "services", "web.log"), "utf8"), /Cannot find module/);

  const off = setup({ paseoServices: "off" });
  assert.equal(runMain(off, { services: { names: ["web"] } }).code, 0);
  assert.ok(!events(off).some((e) => e.type === "listServices" || e.type === "startServices"));

  const headless = setup();
  assert.equal(runMain(headless, { services: { names: ["web"] } }, [], null).code, 0);
  assert.ok(!events(headless).some((e) => e.type === "startServices"), "没有发起对话时不知道是哪个工作区");
});

test("额度提醒：开始前查看所用 agent 的订阅额度，接近用完时在对话里提醒一次，不阻止运行", () => {
  const env = setup();
  const quota = [
    { provider: "claude", displayName: "Claude", window: "5 小时", usedPct: 92, resetsAt: null, tone: "warning" },
    { provider: "codex", displayName: "Codex", window: "每周", usedPct: 30, resetsAt: null, tone: "ok" },
  ] as const;
  assert.equal(runMain(env, { quota: [...quota] }).code, 0);
  assert.deepEqual(events(env).find((e) => e.type === "providerQuota")?.providers, ["claude", "codex"]);
  const warnings = notifications(env).filter((n) => /额度提醒/.test(n.text ?? ""));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text ?? "", /Claude 的「5 小时」额度已用 92%/);
  assert.doesNotMatch(warnings[0].text ?? "", /Codex/);

  const calm = setup();
  assert.equal(runMain(calm, { quota: [{ ...quota[0], usedPct: 40, tone: "ok" as const }] }).code, 0);
  assert.ok(!notifications(calm).some((n) => /额度提醒/.test(n.text ?? "")));
});

test("进度查询：运行中时附上当前步骤 agent 最近在做什么（从 Paseo 读取，读不到就省略）", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  const file = path.join(env.repo, FEATURE, ".pipeline", "state.json");
  const s = state(env);
  s.status = "running";
  s.pid = process.pid;
  s.history.push({ ...s.history.at(-1), key: "verify", stepId: "verify", agentId: "agent-live", outcome: "running", endedAt: null, round: null });
  fs.writeFileSync(file, JSON.stringify(s));
  const status = (scenario: FakeScenario) =>
    spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--config", env.configPath, "--status"], {
      encoding: "utf8",
      env: fakeEnv(env, scenario),
    }).stdout;
  const live = status({ activity: [{ at: new Date().toISOString(), text: "运行命令：npm test" }] });
  assert.match(live, /当前步骤：功能验证/);
  assert.match(live, /「功能验证」的 agent 最近在做：\n  刚刚：运行命令：npm test/);
  assert.ok(events(env).some((e) => e.type === "recentActivity" && e.agentId === "agent-live"));
  assert.doesNotMatch(status({ activity: null }), /最近在做/);
});

async function waitForEvent(env: Env, match: (e: FakeEvent) => boolean, timeoutMs = 30_000): Promise<FakeEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events(env).find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test("需求说明审阅：草稿阶段由 reviewer 在后台独立审阅，只写审阅文件，结果发回对话，不碰流水线状态", async () => {
  const env = setup({}, "草稿");
  const launched = launch(env, ["--spec-review"]);
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /已开始需求说明的独立审阅/);
  const note = await waitForEvent(env, (e) => e.type === "notify");
  assert.ok(note, "应在审阅结束后通知对话");
  assert.match(note.text ?? "", /发现 1 个建议在确认前澄清的问题/);
  assert.match(note.text ?? "", /AC-1\.1 没有说明验证码过期后怎么提示/);
  const start = events(env).find((e) => e.type === "start")!;
  assert.equal(start.key, "spec_review");
  assert.equal(start.role, "reviewer");
  assert.equal(start.parentAgentId, ORIGIN);
  assert.match(start.prompt ?? "", /# 本步骤任务：需求说明审阅/);
  assert.match(start.prompt ?? "", /工作分支：（本步骤不提交）/);
  assert.match(start.prompt ?? "", /需求说明的写法清单：.*spec-writing/);
  assert.ok(fs.existsSync(path.join(env.repo, FEATURE, "spec-review.md")));
  assert.ok(!fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "state.json")), "审阅不是流水线运行");

  fs.writeFileSync(path.join(env.repo, FEATURE, "spec.md"), "# 改文案\n\n- 状态：草稿\n- 档位：快速\n");
  assert.match(launch(env, ["--spec-review"]).stdout, /跳过：快速档的需求不做独立审阅/);
  const off = setup({ specReview: "off" }, "草稿");
  assert.match(launch(off, ["--spec-review"]).stdout, /跳过：配置中关闭了需求说明审阅/);
});

test("方案提案：开启后标准档先由 builder 和 reviewer 各提一份方案，方案设计比较后决定；快速档和增量继续不做", () => {
  const env = setup({ designProposals: { enabled: true, profiles: ["standard"], members: [] } });
  assert.equal(runMain(env, {}).code, 0);
  assert.deepEqual(starts(env).slice(0, 3), ["design_proposal-p1", "design_proposal-p2", "design"]);
  const all = events(env).filter((e) => e.type === "start");
  assert.equal(all[0].provider, "claude/test-model");
  assert.equal(all[1].provider, "codex/test-model");
  assert.match(all[0].prompt ?? "", /你的提案文件：docs\/features\/20261012-sms-login\/design-proposals\/design_proposal-p1\.md/);
  const design = all.find((e) => e.key === "design")?.prompt ?? "";
  assert.match(design, /# 方案提案[\s\S]*design_proposal-p1\.md[\s\S]*design_proposal-p2\.md[\s\S]*方案比较/);

  const quick = setup({ designProposals: { enabled: true, profiles: ["standard"], members: [] } });
  assert.equal(runMain(quick, {}, ["--profile", "quick"]).code, 0);
  assert.ok(!starts(quick).some((k) => k.startsWith("design_proposal")));

  // A continuation after a spec change only handles the change: no proposals.
  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n- **AC-1.2** 新增\n");
  const before = events(env).length;
  assert.equal(runMain(env, {}, ["--resume"]).code, 0);
  assert.ok(!starts(env, before).some((k) => k.startsWith("design_proposal")));
});

test("浏览器验证：步骤 agent 有 Paseo 浏览器工具时，验证类步骤附上浏览器验证的做法", () => {
  const env = setup();
  assert.equal(runMain(env, { capabilities: { paseoTools: true, browser: true } }).code, 0);
  const prompt = (key: string) => events(env).find((e) => e.type === "start" && e.key === key)?.prompt ?? "";
  assert.match(prompt("verify"), /浏览器：可以用 Paseo 内置浏览器/);
  assert.match(prompt("verify"), /# 用浏览器验证网页界面/);
  assert.doesNotMatch(prompt("design"), /用浏览器验证/);

  const off = setup({ browserVerify: "off" });
  assert.equal(runMain(off, { capabilities: { paseoTools: true, browser: true } }).code, 0);
  assert.doesNotMatch(events(off).find((e) => e.type === "start" && e.key === "verify")?.prompt ?? "", /用浏览器验证/);
  assert.doesNotMatch(events(off).find((e) => e.type === "start" && e.key === "verify")?.prompt ?? "", /界面检查命令/);
  // 1.13: without Paseo's browser (the web UI, no desktop app), verification still checks pages, in words.
  const none = setup();
  assert.equal(runMain(none, { capabilities: { paseoTools: true, browser: false } }).code, 0);
  const verify = events(none).find((e) => e.type === "start" && e.key === "verify")?.prompt ?? "";
  assert.doesNotMatch(verify, /用浏览器验证/);
  assert.match(verify, /界面检查命令：node ".*req\.mjs" ui-check/);
  assert.match(verify, /# 不靠看图检查网页界面/);
  assert.match(prompt("verify"), /# 不靠看图检查网页界面[\s\S]*# 用浏览器验证网页界面/);
});

test("自动新建工作区：在主分支上用 --worktree 启动，需求移到新 worktree 提交，步骤放进那里但仍挂在对话下；之后从原对话查看和继续", async () => {
  const env = setup();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: env.repo, encoding: "utf8" });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(env.repo, "README.md"), "app\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  const source = fs.realpathSync(env.repo);
  const chatEnv = (scenario: FakeScenario) => ({ ...fakeEnv(env, scenario), PASEO_AGENT_ID: ORIGIN, PASEO_AGENT_CWD: source });
  const run = (extra: string[], feature = FEATURE) =>
    spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", source, "--feature", feature, "--config", env.configPath, "--origin-agent", ORIGIN, ...extra], {
      encoding: "utf8",
      env: chatEnv({}),
    });

  const onMain = run([]);
  assert.equal(onMain.status, 2);
  assert.match(onMain.stderr, /可以加 --worktree/);

  const started = run(["--worktree"]);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /已为这个需求新建工作区：.*（分支 feature\/20261012-sms-login/);
  const created = events(env).find((e) => e.type === "createWorktree") as FakeEvent & { directory: string; baseRef: string; branchName: string };
  assert.equal(created.baseRef, "main");
  const worktree = fs.realpathSync(created.directory);
  assert.ok(!fs.existsSync(path.join(source, FEATURE)), "原目录中未提交的需求文件已移走");
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: worktree, encoding: "utf8" }).trim(), "docs(req): 短信验证码登录 需求说明");

  const stateFile = path.join(worktree, FEATURE, ".pipeline", "state.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, "utf8")).status === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const finished = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.worktree, { workspaceId: "fake-wks-1", sourceRepo: source });
  assert.equal(finished.branch, "feature/20261012-sms-login");
  const steps = events(env).filter((e) => e.type === "start") as Array<FakeEvent & { workspaceId: string; cwd: string }>;
  assert.ok(steps.length > 0 && steps.every((e) => e.workspaceId === "fake-wks-1" && e.cwd === worktree && e.parentAgentId === ORIGIN));
  assert.equal(events(env).find((e) => e.type === "verifyOrigin")?.cwd, source, "对话仍在原目录");
  assert.ok(events(env).some((e) => e.type === "waitForWorkspaceSetup"));
  assert.ok((notifications(env).at(-1)?.text ?? "").includes(`完整报告：${worktree.split(path.sep).join("/")}/${FEATURE}/report.md`), "对话不在新工作区，给出完整路径");

  const status = run(["--status"], "sms-login");
  assert.match(status.stdout, /已完成/);
  assert.match(status.stdout, /位置：为这个需求新建的工作区/);

  fs.appendFileSync(path.join(worktree, FEATURE, "spec.md"), "\n- **AC-1.2** 新增\n");
  const before = events(env).length;
  const resumed = run(["--resume"], "sms-login");
  assert.equal(resumed.status, 0, resumed.stderr);
  const deadline2 = Date.now() + 30_000;
  while (Date.now() < deadline2 && JSON.parse(fs.readFileSync(stateFile, "utf8")).attempt !== 2) await new Promise((r) => setTimeout(r, 100));
  while (Date.now() < deadline2 && JSON.parse(fs.readFileSync(stateFile, "utf8")).status !== "completed") await new Promise((r) => setTimeout(r, 100));
  const again = events(env).slice(before).filter((e) => e.type === "start") as Array<FakeEvent & { workspaceId: string }>;
  assert.ok(again.length > 0 && again.every((e) => e.workspaceId === "fake-wks-1"));
});

const BLOCKED: FakeScenario = { steps: { design_review: { result: { verdict: "blocked", questions: ["验证码有效期多久？"] } } } };

test("等待提醒：需要需求方决定时预约 24 小时后在对话里提醒一次；继续时取消上次的预约", () => {
  const env = setup();
  const started = Date.now();
  assert.equal(runMain(env, BLOCKED).code, 3);
  const scheduled = events(env).find((e) => e.type === "scheduleMessage")!;
  assert.equal(scheduled.agentId, ORIGIN);
  const hours = (new Date(scheduled.runAt ?? 0).getTime() - started) / 3600_000;
  assert.ok(hours > 23.9 && hours < 24.1, `约 24 小时后：${hours}`);
  assert.match(scheduled.prompt ?? "", /已经超过 24 小时[\s\S]*验证码有效期多久/);
  assert.match(notifications(env).at(-1)?.text ?? "", /24 小时内还没有回答，会在这个对话里提醒一次/);
  assert.deepEqual(state(env).schedules.map((s: { kind: string }) => s.kind), ["reminder"]);
  assert.match(spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--status"], { encoding: "utf8" }).stdout, /已预约：.* 提醒/);

  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n- **AC-1.2** 有效期 5 分钟\n");
  assert.equal(runMain(env, {}, ["--resume"]).code, 0);
  assert.ok(events(env).some((e) => e.type === "cancelSchedule" && e.id === scheduled.id));
  assert.deepEqual(state(env).schedules, []);
});

test("自动继续：临时错误中断后预约在对话里自动继续（每次尝试最多 2 次）；其他错误不预约；暂停命令取消预约", () => {
  const env = setup({ retry: { attempts: 0, backoffSeconds: [0] } });
  const flaky: FakeScenario = { steps: { implement: { transientErrors: 99 } } };
  assert.equal(runMain(env, flaky).code, 1);
  const first = events(env).filter((e) => e.type === "scheduleMessage");
  assert.equal(first.length, 1);
  assert.match(first[0].prompt ?? "", /预约的自动继续[\s\S]*--status[\s\S]*--resume/);
  assert.match(notifications(env).at(-1)?.text ?? "", /已预约在 .* 自动继续/);
  assert.equal(state(env).autoResumes.count, 1);

  const stop = spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--config", env.configPath, "--stop"], {
    encoding: "utf8",
    env: fakeEnv(env, {}),
  });
  assert.match(stop.stdout, /已取消预约的提醒或自动继续（1 个）/);
  assert.deepEqual(state(env).schedules, []);

  assert.equal(runMain(env, flaky, ["--resume"]).code, 1);
  assert.equal(runMain(env, flaky, ["--resume"]).code, 1);
  assert.equal(events(env).filter((e) => e.type === "scheduleMessage").length, 2, "同一次尝试最多自动继续 2 次");
  assert.doesNotMatch(notifications(env).at(-1)?.text ?? "", /已预约在/);

  const broken = setup({ retry: { attempts: 0, backoffSeconds: [0] } });
  assert.equal(runMain(broken, { steps: { implement: { error: "TypeError: x is undefined" } } }).code, 1);
  assert.ok(!events(broken).some((e) => e.type === "scheduleMessage"));

  // Rate limited and Paseo says the window resets in 3 hours: continue then, not in 30 minutes.
  const resetsAt = new Date(Date.now() + 3 * 3600_000);
  const limited = setup({ retry: { attempts: 0, backoffSeconds: [0] } });
  const withQuota: FakeScenario = {
    ...flaky,
    quota: [{ provider: "claude", displayName: "Claude", window: "5 小时", usedPct: 100, resetsAt: resetsAt.toISOString(), tone: "danger" }],
  };
  assert.equal(runMain(limited, withQuota).code, 1);
  const scheduled = events(limited).find((e) => e.type === "scheduleMessage");
  assert.ok(scheduled?.runAt);
  assert.equal(new Date(scheduled.runAt).getTime(), resetsAt.getTime() + 5 * 60_000);
  assert.equal(state(limited).recoveries.at(-1).kind, "quota_wait");
  assert.equal(state(limited).stopKind, "transient");
});

test("预约开始：--at 用 Paseo 定时任务预约，到时由对话执行启动命令；可以查看和取消", () => {
  const env = setup();
  const scheduled = launch(env, ["--at", "+2h"]);
  assert.equal(scheduled.status, 0, scheduled.stderr);
  assert.match(scheduled.stdout, /已预约在 .* 开始开发/);
  const event = events(env).find((e) => e.type === "scheduleMessage")!;
  assert.match(event.prompt ?? "", /用户之前预约的开发开始时间[\s\S]*--feature docs\/features\/20261012-sms-login/);
  assert.doesNotMatch(event.prompt ?? "", /--at/);
  assert.ok(fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "scheduled-start.json")));
  assert.match(launch(env, ["--status"]).stdout, /已预约在 .* 开始开发/);
  assert.match(launch(env, ["--at", "下午三点"]).stderr, /看不懂开始时间/);

  const cancelled = launch(env, ["--stop"]);
  assert.match(cancelled.stdout, /已取消预约在 .* 的开始/);
  assert.ok(events(env).some((e) => e.type === "cancelSchedule" && e.id === event.id));
  assert.ok(!fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "scheduled-start.json")));

  // Starting by hand before the time drops the reservation too.
  assert.equal(launch(env, ["--at", "+1h"]).status, 0);
  const second = events(env).filter((e) => e.type === "scheduleMessage").at(-1)!;
  assert.equal(launch(env, []).status, 0);
  assert.ok(events(env).some((e) => e.type === "cancelSchedule" && e.id === second.id));
});

test("并发上限：本机运行的流水线已满时排队，通知对话；空出名额后自动开始", async () => {
  const env = setup({ maxConcurrentPipelines: 1, queuePollSeconds: 0.2 });
  const slots = path.join(KIT_HOME, "slots");
  fs.mkdirSync(slots, { recursive: true });
  const busy = path.join(slots, "slot-0.json");
  fs.writeFileSync(busy, JSON.stringify({ pid: process.pid, repo: "/other", featureDir: "docs/features/other", since: new Date().toISOString() }));
  const child = spawn(process.execPath, [TSX_CLI, MAIN, "--repo", env.repo, "--feature", FEATURE, "--config", env.configPath, "--origin-agent", ORIGIN], {
    env: fakeEnv(env, {}),
    stdio: "ignore",
  });
  try {
    const queued = await waitForEvent(env, (e) => e.type === "notify" && /在排队/.test(e.text ?? ""));
    assert.ok(queued);
    assert.match(queued.text ?? "", /正在运行：docs\/features\/other/);
    assert.match(spawnSync(process.execPath, [NODE_LAUNCHER, "--repo", env.repo, "--feature", FEATURE, "--status"], { encoding: "utf8" }).stdout, /排队中/);
    assert.ok(!events(env).some((e) => e.type === "start"), "排队时不启动步骤");
    fs.rmSync(busy);
    assert.ok(await waitForEvent(env, (e) => e.type === "notify" && /排队结束/.test(e.text ?? "")));
    assert.equal(await waitForStatus(env, ["completed"]), "completed");
    // The slot goes a moment after the state says "completed"; wait for it before stopping the
    // process (on Windows kill() ends it at once, before it could tidy up).
    for (let i = 0; i < 100 && fs.readdirSync(slots).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
  } finally {
    child.kill();
  }
  assert.deepEqual(fs.readdirSync(slots), [], "结束后释放名额");
});

test("定时检查（可选）：开启后运行期间预约对话定时检查，正常结束时取消", () => {
  const env = setup({ watchdogMinutes: 30 });
  assert.equal(runMain(env, {}).code, 0);
  const watch = events(env).find((e) => e.type === "scheduleMessage")!;
  assert.equal(watch.cron, "*/30 * * * *");
  assert.match(watch.prompt ?? "", /定时检查[\s\S]*已中断（后台进程意外退出/);
  assert.ok(events(env).some((e) => e.type === "cancelSchedule" && e.id === watch.id));
  assert.deepEqual(state(env).schedules, []);
});

test("定时检查（1.13）：req-kit 插件最近检查过时，不再预约对话的定时检查（插件会直接继续）", () => {
  const file = path.join(KIT_HOME, "watchdog.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  fs.mkdirSync(KIT_HOME, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), by: "plugin", handled: {} }));
  try {
    const env = setup({ watchdogMinutes: 30 });
    assert.equal(runMain(env, {}).code, 0);
    assert.ok(!events(env).some((e) => e.type === "scheduleMessage"));
    // An old heartbeat (the plugin stopped): the chat checks again.
    fs.writeFileSync(file, JSON.stringify({ at: new Date(Date.now() - 3600_000).toISOString(), by: "plugin" }));
    const old = setup({ watchdogMinutes: 30 });
    assert.equal(runMain(old, {}).code, 0);
    assert.ok(events(old).some((e) => e.type === "scheduleMessage"));
  } finally {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  }
});

test("prompts.local：同名文件替换随工具发布的提示词", () => {
  const env = setup();
  const local = path.join(KIT_HOME, "prompts.local");
  const created = !fs.existsSync(local);
  fs.mkdirSync(local, { recursive: true });
  const file = path.join(local, "03-design.md");
  try {
    fs.writeFileSync(file, "# 本步骤任务：方案设计（团队定制版）\n\n结果文件写 has_runnable_service。");
    assert.equal(runMain(env, {}).code, 0);
    const design = events(env).find((e) => e.type === "start" && e.key === "design")?.prompt ?? "";
    assert.match(design, /团队定制版/);
    const review = events(env).find((e) => e.type === "start" && e.key === "design_review-r1")?.prompt ?? "";
    assert.doesNotMatch(review, /团队定制版/);
  } finally {
    fs.rmSync(file, { force: true });
    if (created) fs.rmSync(local, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

test("里程碑通知：方案确定、评审完成、发现问题时各发一次；续跑不重复", () => {
  const env = setup({ notifyMilestones: true });
  const failed = runMain(env, {
    steps: { verify: { result: { result: "defects_found" } }, "defect_fix-r1": { error: "boom" } },
  });
  assert.equal(failed.code, 1);
  const first = notifications(env).map((n) => n.text ?? "");
  assert.equal(first.length, 4);
  assert.match(first[0], /通知 · 进展[\s\S]*技术方案已经确定（审核 1 轮），开始写代码/);
  assert.match(first[1], /代码已经写完并通过检查，开始按验收标准逐条验证功能/);
  assert.match(first[2], /验证中发现了一些问题，正在修复并重新验证（最多 3 轮）/);
  assert.match(first[3], /在「缺陷修复」步骤停止/);

  const resumed = runMain(env, { steps: { verify: { result: { result: "defects_found" } } } }, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  const second = notifications(env).slice(4).map((n) => n.text ?? "");
  assert.equal(second.length, 1, second.join("\n---\n"));
  assert.match(second[0], /流水线已经结束/);
});

test("关闭里程碑通知后只发结果", () => {
  const env = setup({ notifyMilestones: false });
  assert.equal(runMain(env, REWORK).code, 0);
  assert.equal(notifications(env).length, 1);
});


// ---------------------------------------------------------------------------
// Phased execution (1.7): develop phase → gate → verify phase. ADR 0022.
// ---------------------------------------------------------------------------

const DEVELOP = ["design", "design_review-r1", "implement", "code_review-r1", "handoff"];

test("分阶段：研发完成写提测说明后停在闸口，通知对话；--phase verify 开始测试验证，沿用研发结果", () => {
  const env = setup();
  const first = runMain(env, {}, ["--phases", "gated"]);
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(starts(env), DEVELOP);
  let s = state(env);
  assert.equal(s.status, "phase_done");
  assert.equal(s.phase, "develop");
  assert.deepEqual(s.phases, { mode: "gated", environment: "local", defects: "fix" });
  assert.ok(fs.existsSync(path.join(env.repo, FEATURE, "handoff.md")));
  const note = notifications(env).at(-1)?.text ?? "";
  assert.match(note, /研发阶段已经完成/);
  assert.match(note, /handoff\.md/);
  assert.match(note, /--resume --phase verify/);
  // Waiting at the gate is reminded like an unanswered question.
  const reminder = events(env).find((e) => e.type === "scheduleMessage");
  assert.match(reminder?.prompt ?? "", /一直在等待测试验证/);
  assert.equal(s.schedules[0].kind, "reminder");

  // Without --resume the launch is refused with a hint.
  const refused = runMain(env, {});
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /等待测试验证.*--phase verify/);

  const before = events(env).length;
  const second = runMain(env, {}, ["--phase", "verify"]);
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(starts(env, before), ["verify", "report"]);
  assert.ok(events(env).slice(before).some((e) => e.type === "cancelSchedule"), "进入测试验证时取消提醒");
  s = state(env);
  assert.equal(s.status, "completed");
  assert.equal(s.phase, "verify");
  assert.equal(s.attempt, 1);
  const byKey = Object.fromEntries(s.history.map((h: { key: string; phase: string }) => [h.key, h.phase]));
  assert.equal(byKey.design, "develop");
  assert.equal(byKey.handoff, "develop");
  assert.equal(byKey.verify, "verify");
  const verifyPrompt = events(env).find((e) => e.type === "start" && e.key === "verify")?.prompt ?? "";
  assert.match(verifyPrompt, /执行方式：分阶段（当前阶段：测试验证）/);
  assert.match(verifyPrompt, /提测说明：docs\/features\/20261012-sms-login\/handoff\.md/);
  const reportPrompt = events(env).find((e) => e.type === "start" && e.key === "report")?.prompt ?? "";
  assert.match(reportPrompt, /用时与用量（研发阶段，全部尝试）/);
  assert.match(reportPrompt, /用时与用量（测试验证阶段，全部尝试）/);
});

test("分阶段：spec 中的执行方式生效；在闸口单独的 --resume 也开始测试验证；--phase verify 在研发未完成时被拒绝", () => {
  const env = setup();
  const spec = path.join(env.repo, FEATURE, "spec.md");
  fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replace("- 需求提出人", "- 执行方式：分阶段\n- 需求提出人"));
  const early = runMain(env, { steps: { implement: { error: "boom" } } });
  assert.equal(early.code, 1, early.out);
  assert.equal(state(env).phases.mode, "gated");
  const tooSoon = runMain(env, {}, ["--phase", "verify"]);
  assert.equal(tooSoon.code, 2, tooSoon.out);
  assert.match(tooSoon.out, /研发阶段还没有完成/);

  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(state(env).status, "phase_done");
  const before = events(env).length;
  const verify = runMain(env, {}, ["--resume"]);
  assert.equal(verify.code, 0, verify.out);
  assert.deepEqual(starts(env, before), ["verify", "report"]);
});

test("分阶段：测试验证开始前需求说明改过，回到研发阶段的方案设计", () => {
  const env = setup();
  assert.equal(runMain(env, {}, ["--phases", "gated"]).code, 0);
  const spec = path.join(env.repo, FEATURE, "spec.md");
  fs.appendFileSync(spec, "- **AC-1.2** 新增的验收标准\n");
  const before = events(env).length;
  const again = runMain(env, {}, ["--phase", "verify"]);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(starts(env, before), DEVELOP);
  const s = state(env);
  assert.equal(s.status, "phase_done");
  assert.equal(s.attempt, 2);
  assert.ok(s.incremental);
});

test("只做研发：写提测说明和研发报告后结束；之后仍可用 --phase verify 让流水线做测试验证", async () => {
  const env = setup({ phases: { mode: "develop-only" } });
  const { code, out } = runMain(env, {});
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), [...DEVELOP, "report"]);
  const reportPrompt = events(env).find((e) => e.type === "start" && e.key === "report")?.prompt ?? "";
  assert.match(reportPrompt, /只做研发：本次不做测试验证/);
  assert.match(reportPrompt, /## 只做研发时/);
  const done = notifications(env).at(-1)?.text ?? "";
  assert.match(done, /执行方式：只做研发/);
  assert.match(done, /提测说明：docs\/features\/20261012-sms-login\/handoff\.md/);
  assert.equal(state(env).status, "completed");
  const { describeStatus } = await import("../src/control.js");
  assert.match(describeStatus(state(env), FEATURE), /状态：研发已完成，待人工测试/);

  const plain = runMain(env, {}, ["--resume"]);
  assert.equal(plain.code, 2, plain.out);
  assert.match(plain.out, /只做研发.*--phase verify/);

  const before = events(env).length;
  const verify = runMain(env, {}, ["--phase", "verify"]);
  assert.equal(verify.code, 0, verify.out);
  assert.deepEqual(starts(env, before), ["verify", "report"]);
  assert.equal(state(env).phase, "verify");
  assert.doesNotMatch(notifications(env).at(-1)?.text ?? "", /只做研发/);
});

test("测试验证在已部署的测试环境中进行：需要 test-env.md；不在本地启动服务；附加已部署环境的说明", () => {
  const env = setup({ phases: { mode: "gated", verify: { environment: "deployed" } } });
  const scenario: FakeScenario = { steps: { design: { result: { has_runnable_service: true } } }, services: { names: ["web"] } };
  assert.equal(runMain(env, scenario).code, 0);
  const refused = runMain(env, scenario, ["--phase", "verify"]);
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /test-env\.md/);
  assert.equal(state(env).status, "phase_done", "被拒绝时不改运行记录");

  fs.writeFileSync(path.join(env.repo, FEATURE, "test-env.md"), "# 测试环境\n- 地址：https://test.example.internal\n");
  const before = events(env).length;
  const ok = runMain(env, scenario, ["--phase", "verify"]);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(starts(env, before), ["verify", "report"]);
  assert.ok(!events(env).slice(before).some((e) => e.type === "startServices"), "不在本地启动服务");
  const prompt = events(env).find((e) => e.type === "start" && e.key === "verify")?.prompt ?? "";
  assert.match(prompt, /验证环境：已部署的测试环境/);
  assert.match(prompt, /# 在已部署的测试环境中验证/);
  assert.match(prompt, /测试验证：已部署的测试环境/);
});

test("测试验证可以用单独的 agent；--verify-env 和 --defects 在开始测试时临时指定", () => {
  const env = setup({ phases: { mode: "gated", verify: { agents: { reviewer: { provider: "codex/tester-model", modeId: "full-access" } } } } });
  assert.equal(runMain(env, {}).code, 0);
  const before = events(env).length;
  const ok = runMain(env, { steps: { verify: { result: { result: "defects_found" } } } }, ["--phase", "verify", "--defects", "report"]);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(starts(env, before), ["verify", "report"], "只记录缺陷，不修复");
  const all = events(env).filter((e) => e.type === "start");
  assert.equal(all.find((e) => e.key === "verify")?.provider, "codex/tester-model");
  assert.equal(all.find((e) => e.key === "code_review-r1")?.provider, "codex/test-model");
  assert.equal(all.find((e) => e.key === "report")?.provider, "claude/test-model");
  assert.equal(state(env).phases.defects, "report");
});

test("缺陷退回研发：记入 changes.md，从方案设计开始新一轮研发，修完重新提测", () => {
  const env = setup({ phases: { mode: "continuous", verify: { defects: "handback" } } });
  const scenario: FakeScenario = { steps: { verify: { resultsByStart: [{ result: "defects_found" }, { result: "pass" }] } } };
  const { code, out } = runMain(env, scenario);
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), [...DEVELOP, "verify", ...DEVELOP, "verify", "report"]);
  const s = state(env);
  assert.equal(s.attempt, 2);
  assert.equal(s.handbacks, 1);
  assert.match(s.incremental.reason, /测试验证发现缺陷/);
  assert.match(fs.readFileSync(path.join(env.repo, FEATURE, "changes.md"), "utf8"), /测试验证退回（第 1 次）[\s\S]*来源：测试验证/);
  const redesign = events(env).filter((e) => e.type === "start" && e.key === "design")[1]?.prompt ?? "";
  assert.match(redesign, /增量继续：本次是第 2 次尝试/);
  assert.match(redesign, /测试验证退回的/);
  assert.ok(notifications(env).some((n) => /退回研发阶段修复（第 1 次）/.test(n.text ?? "")));
});

test("缺陷退回研发：分阶段时修完停在闸口重新提测；退回次数用完后写报告", () => {
  const env = setup({ profiles: { standard: { rounds: { defectFix: 1 } } }, phases: { mode: "gated", verify: { defects: "handback" } } });
  const scenario: FakeScenario = { steps: { verify: { result: { result: "defects_found" } } } };
  assert.equal(runMain(env, scenario).code, 0);
  let before = events(env).length;
  assert.equal(runMain(env, scenario, ["--phase", "verify"]).code, 0);
  assert.deepEqual(starts(env, before), ["verify", ...DEVELOP]);
  assert.equal(state(env).status, "phase_done");
  assert.match(notifications(env).at(-1)?.text ?? "", /测试退回后第 1 次修复完成/);
  before = events(env).length;
  const last = runMain(env, scenario, ["--phase", "verify"]);
  assert.equal(last.code, 0, last.out);
  assert.deepEqual(starts(env, before), ["verify", "report"]);
  assert.match(last.out, /已经退回研发 1 次/);
});

test("--verify-at：研发完成后预约开始测试验证；时间已过则直接继续", () => {
  const env = setup();
  const { code, out } = runMain(env, {}, ["--verify-at", "+3h"]);
  assert.equal(code, 0, out);
  const s = state(env);
  assert.equal(s.phases.mode, "gated", "--verify-at 隐含分阶段");
  assert.equal(s.status, "phase_done");
  const scheduled = events(env).filter((e) => e.type === "scheduleMessage");
  assert.equal(scheduled.length, 1, "预约了测试验证就不再另外提醒");
  assert.match(scheduled[0].prompt ?? "", /预约的测试验证开始时间/);
  assert.match(scheduled[0].prompt ?? "", /--phase verify/);
  assert.equal(s.schedules[0].kind, "verify-start");
  assert.match(notifications(env).at(-1)?.text ?? "", /已预约在 .* 自动开始测试验证/);

  const env2 = setup({ phases: { mode: "gated" } });
  const st = runMain(env2, { steps: { handoff: { error: "boom" } } }, ["--verify-at", "+1m"]);
  assert.equal(st.code, 1, st.out);
  const file = path.join(env2.repo, FEATURE, ".pipeline", "state.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.verifyAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw));
  const before = events(env2).length;
  const late = runMain(env2, {}, ["--resume"]);
  assert.equal(late.code, 0, late.out);
  assert.deepEqual(starts(env2, before), ["handoff", "verify", "report"]);
});

test("状态和总览：研发完成，待测试验证；按阶段统计用时", async () => {
  const env = setup({ phases: { mode: "gated" } });
  assert.equal(runMain(env, {}).code, 0);
  const { describeStatus } = await import("../src/control.js");
  const text = describeStatus(state(env), FEATURE);
  assert.match(text, /状态：研发完成，待测试验证/);
  assert.match(text, /执行方式：分阶段（当前阶段：研发）/);
  assert.match(text, /已预约：.*提醒/);
  const { listFeatures } = await import("../src/features.js");
  const { digestText } = await import("../src/digest.js");
  const features = listFeatures(env.repo);
  assert.equal(features[0].stage, "研发完成，待测试验证");
  assert.match(digestText("shop", features), /需要处理：\n- 短信验证码登录（20261012-sms-login）：研发完成，待测试验证/);
});

test("测试同事接手：自动新建工作区的需求研发完成后，同一仓库另一个工作区的对话可以开始测试验证；研发阶段不行", async () => {
  const env = setup({ phases: { mode: "gated" } });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  // The worktree commit made by the launcher needs an identity (CI has no global git config).
  git(env.repo, "config", "user.email", "t@t");
  git(env.repo, "config", "user.name", "t");
  git(env.repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(env.repo, "README.md"), "app\n");
  git(env.repo, "add", "README.md");
  git(env.repo, "commit", "-q", "-m", "init");
  const source = fs.realpathSync(env.repo);
  const tester = path.join(path.dirname(source), `${path.basename(source)}-tester`);
  git(source, "worktree", "add", "-q", "-b", "qa/tester", tester);
  const testerDir = fs.realpathSync(tester);
  const launch = (cwd: string, agent: string, extra: string[], scenario: FakeScenario = {}) =>
    spawnSync(process.execPath, [NODE_LAUNCHER, "--feature", "sms-login", "--config", env.configPath, ...extra], {
      encoding: "utf8",
      env: { ...fakeEnv(env, scenario), PASEO_AGENT_ID: agent, PASEO_AGENT_CWD: cwd },
    });
  const waitFor = async (file: string, done: (s: { status: string }) => boolean) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(fs.existsSync(file) && done(JSON.parse(fs.readFileSync(file, "utf8"))))) await new Promise((r) => setTimeout(r, 100));
  };

  const started = launch(source, ORIGIN, ["--worktree"]);
  assert.equal(started.status, 0, started.stderr);
  const created = events(env).find((e) => e.type === "createWorktree") as FakeEvent & { directory: string };
  const worktree = fs.realpathSync(created.directory);
  const stateFile = path.join(worktree, FEATURE, ".pipeline", "state.json");
  await waitFor(stateFile, (s) => s.status === "phase_done");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).status, "phase_done");

  const before = events(env).length;
  const takeover = launch(testerDir, "tester-chat", ["--phase", "verify"]);
  assert.equal(takeover.status, 0, takeover.stderr);
  assert.match(takeover.stdout, /已在后台开始测试验证阶段/);
  await waitFor(stateFile, (s) => s.status === "completed");
  const steps = events(env).slice(before).filter((e) => e.type === "start") as Array<FakeEvent & { workspaceId: string }>;
  assert.deepEqual(steps.map((e) => e.key), ["verify", "report"]);
  assert.ok(steps.every((e) => e.workspaceId === "fake-wks-1" && e.parentAgentId === "tester-chat" && e.cwd === worktree));
  assert.equal(events(env).slice(before).find((e) => e.type === "verifyOrigin")?.cwd, testerDir);
  assert.equal(notifications(env).at(-1)?.agentId, "tester-chat");

  // A requirement still in development stays with the chat it was started from.
  const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  s.status = "failed";
  s.phase = "develop";
  fs.writeFileSync(stateFile, JSON.stringify(s));
  const refused = launch(testerDir, "tester-chat", ["--resume"]);
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).status, "failed");
});

// ---------------------------------------------------------------------------
// 1.8: requirement types, the quality gate, slices, the scope check, related repositories
// ---------------------------------------------------------------------------

function specHeader(env: Env, line: string): void {
  const spec = path.join(env.repo, FEATURE, "spec.md");
  fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replace("- 需求提出人", `${line}\n- 需求提出人`));
}

/** Commits everything so far (the code base the gate and the scope check compare with). */
function commitAll(env: Env): void {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: env.repo, stdio: "pipe" });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}

function prompt(env: Env, key: string): string {
  return events(env).filter((e) => e.type === "start" && e.key === key).at(-1)?.prompt ?? "";
}

function title(env: Env, key: string): string {
  return events(env).filter((e) => e.type === "start" && e.key === key).at(-1)?.title ?? "";
}

const CHECK_SCRIPT = 'import fs from "node:fs";\nprocess.exit(fs.existsSync("BROKEN") ? 1 : 0);\n';

test("需求类型·缺陷：先复现与定位；复现不了时暂停，请需求方补充信息；补充后继续修复", () => {
  const env = setup();
  specHeader(env, "- 类型：缺陷");
  const notReproduced = { has_runnable_service: false, reproduced: false, questions: ["出错时用的是哪种账号？"] };
  const first = runMain(env, { steps: { design: { result: notReproduced } } });
  assert.equal(first.code, 3, first.out);
  assert.deepEqual(starts(env), ["design"]);
  assert.equal(title(env, "design"), "[20261012-sms-login] 3-复现与定位");
  const design = prompt(env, "design");
  assert.match(design, /需求类型：缺陷修复/);
  assert.match(design, /# 本需求类型的做法：缺陷修复/);
  assert.match(design, /## 复现与定位（design）/);
  assert.doesNotMatch(design, /## 代码实现（implement）/);
  assert.match(notifications(env).at(-1)?.text ?? "", /没能复现这个缺陷[\s\S]*出错时用的是哪种账号？/);
  assert.equal(state(env).status, "waiting_for_business");
  assert.match(state(env).stopReason, /没能复现缺陷/);

  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n补充：出错的是企业账号。\n");
  const from = events(env).length;
  const second = runMain(env, {}, ["--resume"]);
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(starts(env, from), ["design", "design_review-r1", "implement", "code_review-r1", "handoff", "verify", "report"]);
  const implement = prompt(env, "implement");
  assert.match(implement, /## 代码实现（implement）/);
  assert.doesNotMatch(implement, /## 复现与定位（design）/);
  assert.match(prompt(env, "code_review-r1"), /复现测试在修复前确实失败/);
});

test("需求类型·评估：只做调研、审阅和报告，不写代码；执行方式不适用；改了代码会写进报告", () => {
  const env = setup();
  specHeader(env, "- 类型：评估\n- 执行方式：分阶段");
  commitAll(env);
  const { code, out } = runMain(env, { steps: { design: { writeFiles: { "src/x.ts": "export {};\n" } } } });
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), ["design", "design_review-r1", "report"]);
  assert.equal(title(env, "design"), "[20261012-sms-login] 3-调研评估");
  assert.equal(title(env, "design_review-r1"), "[20261012-sms-login] 4-评估审阅");
  assert.equal(title(env, "report"), "[20261012-sms-login] 11-评估报告");
  assert.match(prompt(env, "design"), /本步骤写 `assessment.md`，不写 `design.md`/);
  assert.match(prompt(env, "report"), /评估期间改动了功能目录之外的文件.*src\/x\.ts/);
  const s = state(env);
  assert.equal(s.status, "completed");
  assert.equal(s.phases.mode, "continuous");
  assert.equal(s.type, "assessment");
  assert.match(launch(env, ["--status"]).stdout, /类型：评估/);
});

test("需求类型·重构走自己的做法；配置关掉某个类型时按普通需求处理", () => {
  const env = setup();
  specHeader(env, "- 类型：重构");
  assert.equal(runMain(env, {}).code, 0);
  assert.equal(title(env, "design"), "[20261012-sms-login] 3-方案设计与行为锁定");
  assert.match(prompt(env, "implement"), /特征测试/);
  assert.match(prompt(env, "code_review-r1"), /首要问题是"行为有没有变"/);

  const off = setup({ requirementTypes: ["assessment"] });
  specHeader(off, "- 类型：缺陷");
  assert.equal(runMain(off, {}).code, 0);
  assert.equal(title(off, "design"), "[20261012-sms-login] 3-方案设计");
  assert.doesNotMatch(prompt(off, "design"), /需求类型：/);
  assert.equal(state(off).type, null);
});

test("质量门：改动前记录基线；实现后流水线自己运行检查，新失败发回同一个 agent 修复；原本就失败的不算", () => {
  const env = setup({ checks: [{ name: "test", command: "node check.mjs" }, { name: "lint", command: "node lint.mjs" }] });
  fs.writeFileSync(path.join(env.repo, "check.mjs"), CHECK_SCRIPT);
  fs.writeFileSync(path.join(env.repo, "lint.mjs"), "process.exit(1);\n");
  commitAll(env);
  const { code, out } = runMain(env, { steps: { implement: { writeFiles: { BROKEN: "x" }, fixOnFollowUp: ["BROKEN"] } } });
  assert.equal(code, 0, out);
  const followUps = events(env).filter((e) => e.type === "followUp" && e.key === "implement");
  assert.equal(followUps.length, 1);
  assert.match(followUps[0].text ?? "", /质量门[\s\S]*### test[\s\S]*node check\.mjs[\s\S]*（lint 在改动之前就失败/);
  assert.doesNotMatch(followUps[0].text ?? "", /### lint/);

  const s = state(env);
  assert.deepEqual(s.gate.baseline.results, { test: "pass", lint: "fail" });
  assert.equal(s.gate.runs.length, 1);
  assert.equal(s.gate.runs[0].key, "implement");
  assert.equal(s.gate.runs[0].passed, true);
  assert.equal(s.gate.runs[0].fixRounds, 1);
  assert.ok(fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "checks", "implement", "test.log")));
  const review = prompt(env, "code_review-r1");
  assert.match(review, /质量门基线（改动前，流水线运行）：2 项检查，原本就失败：lint/);
  assert.match(review, /质量门（implement 之后，流水线运行）：通过（运行 2 项，要求修复 1 次后通过）；lint 改动前就失败/);
  assert.match(prompt(env, "implement"), /流水线会复查/);
});

test("质量门：修复次数用完仍失败时照常继续，交给评审和报告；与改动的模块无关的检查不运行", () => {
  const env = setup({
    checks: [
      { name: "test", command: "node check.mjs" },
      { name: "web 测试", command: "node ../check.mjs", cwd: "web" },
    ],
  });
  fs.writeFileSync(path.join(env.repo, "check.mjs"), CHECK_SCRIPT);
  fs.mkdirSync(path.join(env.repo, "web"));
  fs.writeFileSync(path.join(env.repo, "web", "index.js"), "\n");
  commitAll(env);
  const { code, out } = runMain(env, { steps: { implement: { writeFiles: { BROKEN: "x" } } } });
  assert.equal(code, 0, out);
  assert.equal(events(env).filter((e) => e.type === "followUp" && e.key === "implement").length, 2);
  const run = state(env).gate.runs[0];
  assert.equal(run.passed, false);
  assert.deepEqual(run.newFailures, ["test"]);
  assert.deepEqual(
    run.checks.map((c: { name: string; result: string }) => [c.name, c.result]),
    [["test", "fail"], ["web 测试", "skipped"]],
  );
  assert.match(prompt(env, "report"), /test 改动前通过、现在失败，要求修复 2 次后仍失败；1 项与改动的模块无关，没有运行/);
  assert.match(launch(env, ["--status"]).stdout, /质量门（流水线自己运行的检查）：test 在 implement 之后仍失败/);
});

test("质量门：项目没有配置检查时不运行，报告中说明", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  assert.equal(state(env).gate ?? null, null);
  assert.match(prompt(env, "report"), /项目没有配置检查（checks）/);
  assert.doesNotMatch(prompt(env, "code_review-r1"), /质量门基线|质量门（/);
});

test("按切片实现：方案分几片就逐片启动实现；中断后只重做当前片；快速档和片数上限", () => {
  const env = setup();
  const sliced = { has_runnable_service: false, slices: ["S1 发送验证码（AC-1.1）", "S2 验证码登录（AC-2.1）", "S3 风控（AC-3.1）"] };
  const first = runMain(env, { steps: { design: { result: sliced }, "implement-s2": { error: "agent crashed" } } });
  assert.equal(first.code, 1, first.out);
  assert.deepEqual(starts(env), ["design", "design_review-r1", "implement-s1", "implement-s2"]);
  assert.match(prompt(env, "design"), /切片上限：6 片/);
  assert.equal(title(env, "implement-s2"), "[20261012-sms-login] 5-代码实现 第2/3片");
  const second = prompt(env, "implement-s2");
  assert.match(second, /# 按切片实现/);
  assert.match(second, /你负责第 2 片：\*\*S2 验证码登录（AC-2.1）\*\*/);
  assert.match(second, /切片：第 2 片，共 3 片（S2 验证码登录（AC-2.1））/);
  assert.match(launch(env, ["--status"]).stdout, /代码实现（第 1 片）：完成/);

  const from = events(env).length;
  const resumed = runMain(env, { steps: { design: { result: sliced } } }, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(starts(env, from), ["implement-s2", "implement-s3", "code_review-r1", "handoff", "verify", "report"]);

  const quick = setup();
  specHeader(quick, "- 档位：快速");
  assert.equal(runMain(quick, { steps: { design: { result: sliced } } }).code, 0);
  assert.deepEqual(starts(quick).filter((k) => k.startsWith("implement")), ["implement"]);
  assert.match(prompt(quick, "design"), /本次不按切片实现/);

  const capped = setup({ slices: { max: 2 } });
  assert.equal(runMain(capped, { steps: { design: { result: sliced } } }).code, 0);
  assert.deepEqual(starts(capped).filter((k) => k.startsWith("implement")), ["implement-s1", "implement-s2"]);
  assert.match(prompt(capped, "implement-s2"), /S2 验证码登录（AC-2.1）；S3 风控（AC-3.1）/);
});

test("范围检查：方案列出的文件之外的改动交给代码评审逐一说明；方案修订可以更新文件清单", () => {
  const env = setup();
  commitAll(env);
  const scenario: FakeScenario = {
    steps: {
      design: { result: { has_runnable_service: false, files: ["src/"] } },
      "design_review-r1": { result: { verdict: "changes_required" } },
      // The revision adds config/app.json to the plan; docs/notes.md stays outside it.
      "design_revise-r1": { result: { status: "done", files: ["src/", "config/app.json"] } },
      implement: { writeFiles: { "src/a.ts": "x", "config/app.json": "{}", "docs/notes.md": "n" } },
    },
  };
  const { code, out } = runMain(env, scenario);
  assert.equal(code, 0, out);
  assert.match(prompt(env, "code_review-r1"), /范围检查（流水线比对）：共改动 3 个文件，其中 1 个不在方案列出的范围内：docs\/notes\.md/);
  assert.match(prompt(env, "code_review-r1"), /\*\*影响面\*\*/);
});

test("关联仓库：步骤可以只读参考登记的其他仓库，写明分支和提交；本机没有的跳过", () => {
  const env = setup();
  const backend = fs.mkdtempSync(path.join(os.tmpdir(), "req-backend-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: backend });
  fs.writeFileSync(path.join(backend, "api.md"), "POST /login\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: backend });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "api"], { cwd: backend });
  fs.writeFileSync(
    path.join(env.repo, ".requirement-pipeline.json"),
    JSON.stringify({ relatedRepos: [{ name: "后端", path: path.relative(env.repo, backend), role: "提供登录接口" }, { name: "支付", path: "../no-such-repo" }] }),
  );
  const { code, out } = runMain(env, {});
  assert.equal(code, 0, out);
  const design = prompt(env, "design");
  assert.match(design, new RegExp(`关联仓库（只读）：后端 → ${backend.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（分支 main，提交 [0-9a-f]+；提供登录接口）`));
  assert.match(design, /# 关联仓库（只读参考）/);
  assert.doesNotMatch(design, /支付/);
  assert.match(out, /关联仓库「支付」不在这台机器上/);
});

test("方案确认点：界面改动在方案审核通过后停下，请需求方确认；--approve 才继续写代码", () => {
  const env = setup();
  const ui = { steps: { design: { result: { has_runnable_service: false, ui_change: true } } } };
  const first = runMain(env, ui);
  assert.equal(first.code, 3, first.out);
  assert.deepEqual(starts(env), ["design", "design_review-r1"]);
  assert.match(prompt(env, "design"), /方案确认点：界面改动时开启/);
  assert.equal(state(env).status, "waiting_for_approval");
  const note = notifications(env).at(-1)?.text ?? "";
  assert.match(note, /请确认方案/);
  assert.match(note, /preview\.md/);
  assert.match(note, /--approve/);
  assert.ok(events(env).some((e) => e.type === "scheduleMessage" && /等待确认方案/.test(String((e as { name?: string }).name))));
  assert.match(launch(env, ["--status"]).stdout, /等待需求方确认方案/);

  const refused = runMain(env, ui, ["--resume"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /方案正在等待需求方确认[\s\S]*--approve/);

  const from = events(env).length;
  const approved = runMain(env, ui, ["--approve"]);
  assert.equal(approved.code, 0, approved.out);
  assert.deepEqual(starts(env, from), ["implement", "code_review-r1", "handoff", "verify", "report"]);
  assert.equal(state(env).approval.status, "approved");
  assert.match(prompt(env, "implement"), /需求方已经确认过它和 `prototype\/` 中的原型/);
});

test("方案确认点：确认时提出修改，更新需求说明后重新设计并再确认一次；没有等待时 --approve 被拒绝", () => {
  const env = setup();
  const ui = { steps: { design: { result: { has_runnable_service: false, ui_change: true } } } };
  assert.equal(runMain(env, ui).code, 3);
  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n补充：按钮放在输入框右侧。\n");
  const from = events(env).length;
  const changed = runMain(env, ui, ["--resume"]);
  assert.equal(changed.code, 3, changed.out);
  assert.deepEqual(starts(env, from), ["design", "design_review-r1"]);
  assert.equal(state(env).attempt, 2);
  assert.equal(state(env).approval.attempt, 2);
  assert.match(prompt(env, "design"), /方案确认时需求方提出了修改/);

  const other = setup();
  assert.equal(runMain(other, {}).code, 0);
  const wrong = runMain(other, {}, ["--approve"]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.out, /没有等待确认的方案/);
});

test("方案确认点：快速档、非界面改动不停；always 总是停；off 从不停；可以设置超时后按方案继续", () => {
  const ui = { steps: { design: { result: { has_runnable_service: false, ui_change: true } } } };
  const quick = setup();
  specHeader(quick, "- 档位：快速");
  assert.equal(runMain(quick, ui).code, 0);

  const noUi = setup();
  assert.equal(runMain(noUi, { steps: { design: { result: { has_runnable_service: false, ui_change: false } } } }).code, 0);

  const always = setup({ designApproval: { mode: "always", autoContinueHours: 4 } });
  assert.equal(runMain(always, {}).code, 3);
  assert.match(prompt(always, "design"), /方案确认点：开启/);
  const auto = events(always).find((e) => e.type === "scheduleMessage" && /方案确认超时/.test(String((e as { name?: string }).name)));
  assert.ok(auto, "没有预约超时后按方案继续");
  assert.match(auto.prompt ?? "", /--approve/);
  assert.match(notifications(always).at(-1)?.text ?? "", /仍没有确认时，会按这个方案继续开发/);

  const off = setup({ designApproval: { mode: "off" } });
  assert.equal(runMain(off, ui).code, 0);
  assert.doesNotMatch(prompt(off, "design"), /^方案确认点：/m);
});

test("评审分两个方向：标准档第一轮代码评审由规格评审和规范评审并行，再由评审者汇总；之后的轮次、快速档和评审小组不用", () => {
  const env = setup({ reviewAxes: { enabled: true, profiles: ["standard"] } });
  const { code, out } = runMain(env, { steps: { code_review: { resultsByStart: [{ verdict: "changes_required" }] }, "code_review-r2": { result: { verdict: "pass" } } } });
  assert.equal(code, 0, out);
  assert.deepEqual(starts(env), [
    "design",
    "design_review-r1",
    "implement",
    "code_review-r1-p1",
    "code_review-r1-p2",
    "code_review-r1",
    "review_fix-r1",
    "code_review-r2",
    "handoff",
    "verify",
    "report",
  ]);
  assert.equal(title(env, "code_review-r1-p1"), "[20261012-sms-login] 6-代码评审 评审小组·规格评审");
  assert.match(prompt(env, "code_review-r1-p1"), /# 你的评审方向：规格/);
  assert.doesNotMatch(prompt(env, "code_review-r1-p1"), /# 你的评审方向：规范/);
  assert.match(prompt(env, "code_review-r1-p2"), /# 你的评审方向：规范/);
  assert.match(prompt(env, "code_review-r1"), /# 评审小组的意见[\s\S]*由 2 位评审者各自独立评审/);
  assert.doesNotMatch(prompt(env, "code_review-r2"), /# 评审小组的意见/);
  const roles = events(env).filter((e) => e.type === "start" && /-p\d$/.test(e.key ?? "")).map((e) => e.provider);
  assert.deepEqual(roles, ["codex/test-model", "codex/test-model"]);

  const quick = setup({ reviewAxes: { enabled: true, profiles: ["standard"] } });
  specHeader(quick, "- 档位：快速");
  assert.equal(runMain(quick, {}).code, 0);
  assert.ok(!starts(quick).some((k) => /-p\d$/.test(k)));

  const panel = setup({
    reviewAxes: { enabled: true, profiles: ["standard"] },
    reviewPanel: { enabled: true, steps: ["code_review"], profiles: ["standard"], members: [{ provider: "claude/a", name: "安全" }, { provider: "pi/x/b", name: "性能" }, { provider: "codex/c" }] },
  });
  assert.equal(runMain(panel, {}).code, 0);
  assert.deepEqual(starts(panel).filter((k) => /-p\d$/.test(k)), ["code_review-r1-p1", "code_review-r1-p2", "code_review-r1-p3"]);
  assert.match(title(panel, "code_review-r1-p1"), /评审小组·安全/);
});

test("验收测试锁定：先提交的验收测试后来被改了，流水线在代码评审前列出，交给评审确认有没有依据", () => {
  const env = setup();
  fs.mkdirSync(path.join(env.repo, "test"));
  fs.writeFileSync(path.join(env.repo, "test", "a.test.js"), "// AC-1.1\n");
  fs.writeFileSync(path.join(env.repo, "test", "b.test.js"), "// AC-1.2\n");
  commitAll(env);
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: env.repo, encoding: "utf8" }).trim();
  const result = { status: "done", acceptance_tests: ["test/a.test.js", "test/b.test.js"], acceptance_tests_commit: commit };
  const { code, out } = runMain(env, { steps: { implement: { result, writeFiles: { "test/a.test.js": "// AC-1.1 放宽了\n" } } } });
  assert.equal(code, 0, out);
  assert.match(prompt(env, "code_review-r1"), new RegExp(`验收测试锁定（流水线比对）：以下验收测试在提交 ${commit} 之后被修改：test/a\\.test\\.js$`, "m"));
  assert.match(prompt(env, "report"), /验收测试锁定/);
  assert.match(prompt(env, "implement"), /把这些验收测试单独提交一次/);

  const bogus = setup();
  const r2 = { status: "done", acceptance_tests: ["test/x.test.js"], acceptance_tests_commit: "deadbeef" };
  assert.equal(runMain(bogus, { steps: { implement: { result: r2 } } }).code, 0);
  assert.match(prompt(bogus, "code_review-r1"), /记录的提交 deadbeef 不在仓库中/);
});

test("反复出现的问题：几个需求的 lessons.tsv 中同一类问题出现两次以上，需求总览提示变成规则；已处理的类别不再提示", async () => {
  const env = setup();
  const header = "category\tfinding\tsource\trule\tlayer\n";
  const write = (name: string, rows: string) => {
    const dir = path.join(env.repo, "docs", "features", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.md"), `# ${name}\n\n- 状态：已确认（2026-10-15）\n`);
    fs.writeFileSync(path.join(dir, "lessons.tsv"), header + rows);
  };
  write("20261001-a", "SQL 拼接\t订单查询拼接了 SQL\tCR-2\tlint 规则禁止模板字符串拼接 SQL\tlint\n时间处理\t测试用了当前时间\tCR-4\t测试统一注入时钟\t测试\n");
  write("20261005-b", "SQL 拼接\t导出接口拼接了 SQL\tCR-1\tlint 规则禁止模板字符串拼接 SQL\tlint\n");
  write("20261008-c", "SQL 拼接\t报表拼接了 SQL\t质量门 lint\t\tlint\n输入校验\t分页参数没有上限\tCR-3\t\t测试\n");
  const { listFeatures } = await import("../src/features.js");
  const { digestText } = await import("../src/digest.js");
  const { handledCategories, recurringLessons } = await import("../src/lessons.js");
  const lessons = recurringLessons(listFeatures(env.repo), handledCategories(env.repo));
  assert.deepEqual(lessons.map((l) => [l.category, l.features.length]), [["SQL 拼接", 3]]);
  assert.match(digestText("shop", listFeatures(env.repo), new Date(), 7, lessons), /反复出现的问题[\s\S]*- SQL 拼接：3 个需求（20261001-a、20261005-b、20261008-c）；建议：lint 规则禁止模板字符串拼接 SQL/);

  fs.mkdirSync(path.join(env.repo, ".requirement-pipeline"), { recursive: true });
  fs.writeFileSync(path.join(env.repo, ".requirement-pipeline", "lessons-handled.txt"), "SQL 拼接  # 2026-10-15 已加 lint 规则\n");
  assert.deepEqual(recurringLessons(listFeatures(env.repo), handledCategories(env.repo)), []);
  assert.match(fs.readFileSync(path.join(ROOT, "engine", "prompts", "11-report.md"), "utf8"), /## 记录可以变成规则的问题（`lessons\.tsv`）/);
});

test("方案确认点：测试验证退回研发修缺陷时，不再请需求方确认一次", () => {
  const env = setup({ phases: { mode: "continuous", verify: { defects: "handback" } } });
  const scenario: FakeScenario = {
    steps: {
      design: { result: { has_runnable_service: false, ui_change: true } },
      verify: { resultsByStart: [{ result: "defects_found" }, { result: "pass" }] },
    },
  };
  assert.equal(runMain(env, scenario).code, 3);
  const approved = runMain(env, scenario, ["--approve"]);
  assert.equal(approved.code, 0, approved.out);
  const s = state(env);
  assert.equal(s.status, "completed");
  assert.equal(s.attempt, 2);
  assert.deepEqual(s.approval.attempt, 2);
});

function backendRepo(env: Env, checks?: object[]): string {
  const backend = fs.mkdtempSync(path.join(os.tmpdir(), "req-backend-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: backend, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(backend, "api.md"), "POST /login\n");
  if (checks) fs.writeFileSync(path.join(backend, ".requirement-pipeline.json"), JSON.stringify({ checks }));
  fs.writeFileSync(path.join(backend, "check.mjs"), CHECK_SCRIPT);
  git("add", "-A");
  git("commit", "-q", "-m", "api");
  fs.writeFileSync(
    path.join(env.repo, ".requirement-pipeline.json"),
    JSON.stringify({ relatedRepos: [{ name: "后端", path: path.relative(env.repo, backend) }] }),
  );
  return fs.realpathSync(backend);
}

test("联合需求：每个仓库一个工作区，同时实现和评审；提测、验证、报告在主仓库；缺陷发回所在的仓库修", () => {
  const env = setup();
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: env.repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: env.repo });
  const backend = backendRepo(env, [{ name: "接口测试", command: "node check.mjs" }]);
  specHeader(env, "- 联合开发：后端");
  const slug = path.basename(backend).toLowerCase();
  const scenario: FakeScenario = {
    steps: {
      [`implement@${slug}`]: { writeFiles: { BROKEN: "x" }, fixOnFollowUp: ["BROKEN"] },
      verify: { result: { result: "defects_found", defect_repos: ["后端"] } },
    },
  };
  const { code, out } = runMain(env, scenario);
  assert.equal(code, 0, out);
  const keys = starts(env);
  assert.deepEqual(keys.slice(0, 2), ["design", "design_review-r1"]);
  assert.deepEqual(new Set(keys.slice(2, 4)), new Set(["implement", `implement@${slug}`]));
  assert.deepEqual(new Set(keys.slice(4, 6)), new Set(["code_review-r1", `code_review-r1@${slug}`]));
  assert.deepEqual(keys.slice(6), ["handoff", "verify", `defect_fix-r1@${slug}`, "reverify-r1", "report"]);

  const s = state(env);
  assert.equal(s.joint.length, 1);
  const wt = s.joint[0];
  assert.equal(wt.name, "后端");
  assert.equal(wt.branch, "feature/20261012-sms-login");
  assert.equal(wt.sourceRepo, backend);
  assert.notEqual(wt.repo, backend);
  // The backend checkout itself is untouched; the work happens in its worktree.
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: backend, encoding: "utf8" }).trim(), "main");

  const child = events(env).find((e) => e.type === "start" && e.key === `implement@${slug}`) as FakeEvent & { workspaceId: string };
  assert.equal(child.cwd, wt.repo);
  assert.equal(child.workspaceId, wt.workspaceId);
  assert.equal(child.parentAgentId, ORIGIN);
  assert.equal(child.title, "[20261012-sms-login] 5-代码实现（后端）");
  assert.match(child.prompt ?? "", new RegExp(`仓库目录：${wt.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(child.prompt ?? "", /联合需求：本步骤在「后端」仓库中进行/);
  assert.match(child.prompt ?? "", /# 联合需求：一个需求，几个仓库[\s\S]*## 代码实现（implement）/);
  assert.match(prompt(env, "design"), /联合需求的仓库：后端 → /);
  assert.match(prompt(env, "design"), /## 方案设计（design）[\s\S]*contract\.md/);
  assert.doesNotMatch(prompt(env, "design"), /关联仓库（只读）：后端/);

  // The spec and the design were copied to the backend's worktree and committed there.
  const log = execFileSync("git", ["log", "--format=%s", "-3"], { cwd: wt.repo, encoding: "utf8" });
  assert.match(log, /同步自主仓库/);
  assert.ok(fs.existsSync(path.join(wt.repo, FEATURE, "spec.md")));
  assert.ok(fs.existsSync(path.join(wt.repo, FEATURE, "design.md")));
  // Its own checks ran as its quality gate, against its own baseline.
  assert.equal(wt.gate.baseline.results["接口测试"], "pass");
  assert.equal(wt.gate.runs[0].key, `implement@${slug}`);
  assert.equal(wt.gate.runs[0].passed, true);
  assert.match(prompt(env, "report"), /联合需求的仓库「后端」：工作区 .*分支 feature\/20261012-sms-login/);
  assert.match(launch(env, ["--status"]).stdout, /代码实现·后端：完成/);
});

test("联合需求：需求说明写的仓库没有登记、不在本机或超过两个时，不启动", () => {
  const env = setup();
  specHeader(env, "- 联合开发：支付");
  backendRepo(env);
  const missing = runMain(env, {});
  assert.equal(missing.code, 2);
  assert.match(missing.out, /「支付」，但项目配置的 relatedRepos 里没有登记这个仓库（已登记：后端）/);
  assert.ok(!fs.existsSync(path.join(env.repo, FEATURE, ".pipeline", "state.json")));
});

test("联合需求：一个仓库的步骤失败时等另一个仓库做完再中断；继续时沿用已建的工作区，只重做失败的部分", () => {
  const env = setup();
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: env.repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: env.repo });
  const backend = backendRepo(env);
  specHeader(env, "- 联合开发：后端");
  const slug = path.basename(backend).toLowerCase();
  const first = runMain(env, { steps: { [`implement@${slug}`]: { error: "agent crashed" } } });
  assert.equal(first.code, 1, first.out);
  assert.equal(state(env).results.implement?.status, "done");
  assert.equal(events(env).filter((e) => e.type === "createWorktree").length, 1);
  const from = events(env).length;
  const second = runMain(env, {}, ["--resume"]);
  assert.equal(second.code, 0, second.out);
  assert.equal(events(env).filter((e) => e.type === "createWorktree").length, 1);
  const again = starts(env, from);
  assert.equal(again[0], `implement@${slug}`);
  assert.ok(!again.includes("implement"));
});

test("token 预算（1.13）：到提醒比例时告知一次，用完时做完当前步骤就停下；继续时再给一份预算；记录每步用的模型", () => {
  // Every fake step reports 12,000 + 800 tokens.
  const env = setup({ budget: { tokens: 30_000, warnPercent: 80 } });
  const first = runMain(env, {});
  assert.notEqual(first.code, 0, first.out);
  const s = state(env);
  assert.equal(s.status, "failed");
  assert.equal(s.stopKind, "budget");
  assert.match(s.stopReason, /token 用量 3\.8 万 已到预算 3 万/);
  assert.deepEqual(s.budget, { allowance: 60_000, warnedAt: 30_000 });
  assert.equal(s.history.length, 3);
  assert.ok(s.history.every((h: { agent?: string }) => typeof h.agent === "string" && h.agent.length > 0), JSON.stringify(s.history.map((h: { agent?: string }) => h.agent)));
  const notes = events(env).filter((e) => e.type === "notify").map((e) => e.text ?? "");
  assert.equal(notes.filter((t) => /到了预算 3 万 的 85%/.test(t)).length, 1);
  assert.ok(notes.some((t) => /用完 token 预算[\s\S]*到 6 万 时再停/.test(t)));

  // Continuing: one more budget, so the run goes on and stops again at 60,000.
  const again = runMain(env, {}, ["--resume"]);
  assert.notEqual(again.code, 0, again.out);
  const s2 = state(env);
  assert.equal(s2.stopKind, "budget");
  assert.equal(s2.history.length, 5);
  assert.equal(s2.budget.allowance, 90_000);

  // No budget: nothing changes.
  const none = setup();
  assert.equal(runMain(none, {}).code, 0);
  assert.equal(state(none).budget, undefined);

  // Agents that report no usage: the budget cannot work, said once, and the run goes on.
  const blind = setup({ budget: { tokens: 30_000, warnPercent: 80 } });
  const blindRun = runMain(blind, { noUsage: true });
  assert.equal(blindRun.code, 0, blindRun.out);
  const blindNotes = events(blind).filter((e) => e.type === "notify").map((e) => e.text ?? "");
  assert.equal(blindNotes.filter((t) => /agent 都没有报告 token 用量，所以预算不会起作用/.test(t)).length, 1);
  assert.equal(state(blind).budget.noUsageNoticed, true);
});

test("搜索大目录的命令：一分钟后打断并告诉 agent 怎么查，同一个命令只打断一次；构建命令和关掉时不打断", () => {
  const scan = setup();
  const run = runMain(scan, { steps: { implement: { finishAfterWaits: 3 } }, runningTool: { kind: "shell", text: "find ~/.m2 -name '*.jar'", minutesAgo: 2 } });
  assert.equal(run.code, 0, run.out);
  const interrupts = events(scan).filter((e) => e.type === "interrupt");
  assert.equal(interrupts.length, 1);
  assert.match(String(interrupts[0].text), /已停止你刚才的命令「find ~\/\.m2 -name '\*\.jar'」：它在搜索Maven 本地仓库（\.m2）/);
  assert.match(String(interrupts[0].text), /mvn dependency:tree/);
  assert.deepEqual(state(scan).recoveries.map((r: { kind: string }) => r.kind), ["stop_scan"]);

  const build = setup();
  assert.equal(runMain(build, { steps: { implement: { finishAfterWaits: 3 } }, runningTool: { kind: "shell", text: "mvn -q test", minutesAgo: 30 } }).code, 0);
  assert.equal(events(build).filter((e) => e.type === "interrupt").length, 0);

  const off = setup({ scanGuard: { enabled: false, minutes: 5, paths: [] } });
  assert.equal(runMain(off, { steps: { implement: { finishAfterWaits: 3 } }, runningTool: { kind: "shell", text: "find / -name x", minutesAgo: 9 } }).code, 0);
  assert.equal(events(off).filter((e) => e.type === "runningTool" || e.type === "interrupt").length, 0);
});

test("人工代码评审退回（1.14）：--review-fix 开始新的一次增量尝试，需求说明不变；没有待处理的意见时不启动", () => {
  const env = setup();
  assert.equal(runMain(env, {}).code, 0);
  const refused = runMain(env, {}, ["--resume", "--review-fix"]);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /没有待处理的人工代码评审意见/);
  const dir = path.join(env.repo, FEATURE, ".pipeline", "code-review");
  fs.mkdirSync(dir, { recursive: true });
  const human = { status: "changes_requested", at: new Date().toISOString(), reviewer: "王工", reviewers: [], head: null, items: [{ id: "HR-1", file: null, line: null, finding: null, text: "加权限校验" }], note: "", consumedAttempt: null };
  fs.writeFileSync(path.join(dir, "human.json"), JSON.stringify(human));
  const run = runMain(env, {}, ["--resume", "--review-fix"]);
  assert.equal(run.code, 0, run.out);
  const s = state(env);
  assert.equal(s.attempt, 2);
  assert.match(s.incremental.reason, /人工代码评审提出了 1 条修改意见/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "human.json"), "utf8")).consumedAttempt, 2);
  assert.ok(starts(env).filter((k) => k === "design").length >= 2, "从方案设计开始");
});

test("危险命令（1.14）：推送时打断 agent 并通知用户，同一个调用只处理一次；关掉时不看", () => {
  const env = setup();
  const run = runMain(env, { steps: { implement: { finishAfterWaits: 3 } }, toolCalls: [{ kind: "shell", text: "git push origin HEAD:main", status: "running" }, { kind: "shell", text: "npm test", status: "completed" }] });
  assert.equal(run.code, 0, run.out);
  const dangers = state(env).dangers as Array<{ agentId: string; label: string; ran: boolean; key: string }>;
  assert.ok(dangers.length >= 1);
  assert.ok(dangers.every((d) => d.label === "推送到远程仓库" && d.ran === false));
  assert.equal(new Set(dangers.map((d) => d.agentId)).size, dangers.length, "每个 agent 的同一个调用只记一次");
  const interrupts = events(env).filter((e) => e.type === "interrupt" && /推送到远程仓库/.test(String(e.text)));
  assert.ok(interrupts.some((e) => /已停止你正在运行的命令「git push origin HEAD:main」/.test(String(e.text))));
  assert.ok(events(env).some((e) => e.type === "notify" && /开始运行一条不允许的命令（推送到远程仓库）/.test(String(e.text))));

  const off = setup({ dangerGuard: { enabled: false, production: [], allow: [] } });
  assert.equal(runMain(off, { toolCalls: [{ kind: "shell", text: "git push", status: "running" }] }).code, 0);
  assert.equal(events(off).filter((e) => e.type === "toolCalls").length, 0);
});

/** The test repositories start without commits; the secret scan needs one to start from. */
function initialCommit(env: Env): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: env.repo });
}

test("密钥扫描（1.14）：实现写进的密钥发回给 agent 去掉；去不掉的记进报告", () => {
  const env = setup();
  initialCommit(env);
  const run = runMain(env, { steps: { implement: { writeFiles: { "src/config.ts": 'export const apiKey = "Zx9kQ2mP7vR4tY8w";\n' }, fixOnFollowUp: ["src/config.ts"] } } });
  assert.equal(run.code, 0, run.out);
  const follow = events(env).filter((e) => e.type === "followUp" && /疑似密钥/.test(String(e.text)));
  assert.equal(follow.length, 1);
  assert.match(String(follow[0].text), /src\/config\.ts:1（口令或密钥，还没提交）：export const apiKey = "Zx9k…"/);
  const scans = state(env).secretScans as Array<{ key: string; passed: boolean; fixRounds: number }>;
  assert.deepEqual(scans.find((s) => s.key === "implement"), { ...scans.find((s) => s.key === "implement"), passed: true, fixRounds: 1 });

  const stuck = setup();
  initialCommit(stuck);
  assert.equal(runMain(stuck, { steps: { implement: { writeFiles: { "src/config.ts": 'const token = "glpat-AbCdEfGhIjKlMnOpQrSt12";\n' } } } }).code, 0);
  const s = (state(stuck).secretScans as Array<{ key: string; passed: boolean }>).find((r) => r.key === "implement")!;
  assert.equal(s.passed, false);
  assert.ok(events(stuck).some((e) => e.type === "notify" && /密钥扫描仍发现 1 处疑似密钥/.test(String(e.text))));
});
