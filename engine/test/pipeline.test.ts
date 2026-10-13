import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FakeScenario } from "./fake-runtime.js";
import { lockPath } from "../src/state.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
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
  const result = spawnSync(TSX, args, { env: fakeEnv(env, scenario), encoding: "utf8", timeout: 60_000 });
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
  assert.deepEqual(starts(env), ["design", "design_review-r1", "implement", "code_review-r1", "verify", "report"]);

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
  assert.equal(s.history.length, 6);
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
  assert.match(note, /node .*start-pipeline\.mjs --repo .* --feature docs\/features\/20261012-sms-login --config .* --resume/);
  assert.doesNotMatch(note, /--origin-agent/, "继续命令由对话执行时会自动识别对话，不应写死对话 ID");
  assert.ok(!fs.existsSync(lockPath(env.repo)));

  const again = runMain(env, {});
  assert.equal(again.code, 2);
  assert.match(again.out, /--resume/);

  fs.appendFileSync(path.join(env.repo, FEATURE, "spec.md"), "\n补充：历史订单不显示。\n");
  const before = events(env).length;
  const resumed = runMain(env, {}, ["--resume"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(starts(env, before), ["design", "design_review-r1", "implement", "code_review-r1", "verify", "report"]);
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
  assert.deepEqual(starts(env, before), ["implement", "code_review-r1", "verify", "report"]);
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
});

test("步骤超时：判定失败并说明 agent 可能仍在运行", () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const env = setup({ stepTimeoutMinutes: { ...base.stepTimeoutMinutes, implement: 0.003 } });
  const { code, out } = runMain(env, { steps: { implement: { hang: true } } });
  assert.equal(code, 1, out);
  assert.match(notifications(env)[0].text ?? "", /超过 0\.003 分钟仍未完成/);
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
  const launch = spawnSync(LAUNCHER, ["--repo", unconfirmed.repo, "--feature", FEATURE, "--config", unconfirmed.configPath], {
    encoding: "utf8",
  });
  assert.equal(launch.status, 2);
  assert.match(launch.stderr, /未启动：spec\.md 还没有被确认/);
  assert.ok(!fs.existsSync(path.join(unconfirmed.repo, FEATURE, ".pipeline", "state.json")));

  const env = setup();
  const outside = spawnSync(LAUNCHER, ["--repo", env.repo, "--feature", "../elsewhere", "--config", env.configPath], {
    encoding: "utf8",
  });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /功能目录必须位于仓库目录之内/);

  fs.writeFileSync(lockPath(env.repo), JSON.stringify({ pid: process.pid, featureDir: "docs/features/other", startedAt: "2026-10-12T00:00:00Z" }));
  try {
    const locked = spawnSync(LAUNCHER, ["--repo", env.repo, "--feature", FEATURE, "--config", env.configPath], {
      encoding: "utf8",
    });
    assert.equal(locked.status, 2);
    assert.match(locked.stderr, /已有一条流水线在运行/);
  } finally {
    fs.rmSync(lockPath(env.repo), { force: true });
  }

  const badConfig = setup({ agents: { builder: { provider: "claude" }, reviewer: { provider: "codex/x" } } });
  const cfg = spawnSync(LAUNCHER, ["--repo", badConfig.repo, "--feature", FEATURE, "--config", badConfig.configPath], {
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

test("启动器：立即返回，流水线在独立会话中继续运行到结束", async () => {
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

  const statePath = path.join(env.repo, FEATURE, ".pipeline", "state.json");
  const deadline = Date.now() + 30_000;
  let status = "";
  while (Date.now() < deadline) {
    if (fs.existsSync(statePath)) {
      status = JSON.parse(fs.readFileSync(statePath, "utf8")).status;
      if (status === "completed" || status === "failed") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(status, "completed");
  const log = fs.readFileSync(path.join(env.repo, FEATURE, ".pipeline", "pipeline.log"), "utf8");
  assert.match(log, /流水线结束：completed/);
  assert.equal(notifications(env).length, 2);
});

test("发起对话不在仓库目录：启动器直接拒绝，不留下运行记录", () => {
  const env = setup();
  const result = spawnSync(LAUNCHER, ["--repo", env.repo, "--feature", FEATURE, "--config", env.configPath, "--origin-agent", ORIGIN], {
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
  assert.match(implementStarts[1].prompt ?? "", /自动重试：本步骤上一次因临时错误中断（agent 报告错误：provider error: rate limit exceeded \(429\)）/);
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
  const none = setup();
  assert.equal(runMain(none, { capabilities: { paseoTools: true, browser: false } }).code, 0);
  assert.doesNotMatch(events(none).find((e) => e.type === "start" && e.key === "verify")?.prompt ?? "", /用浏览器验证/);
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

