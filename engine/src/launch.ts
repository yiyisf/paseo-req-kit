// Entry point for the chat agent.
//   start:    validates the request, then starts main.ts in its own session (detached)
//             so the pipeline outlives the agent's shell and turn; returns in a second or two.
//   --status: prints progress in plain language.
//   --stop:   stops the pipeline and its current step agent; --resume continues later.
//   --list:   lists every requirement in this repository's worktrees.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchArgv, parseLaunchArgs, startCommand, verifyCommand } from "./cli-args.js";
import { scheduledStartPrompt } from "./messages.js";
import { describeTime, parseStartTime } from "./schedule-time.js";
import { moveToOwnWorktree, type OwnWorktree } from "./worktree.js";
import { loadConfig, PHASE_MODE_LABELS, type PipelineConfig, PROFILE_LABELS } from "./config.js";
import { cardFieldsText } from "./integrations.js";
import { defaultConfigPath, ENGINE_DIR } from "./locations.js";
import { describeLiveActivity, describeStatus, stopPipeline } from "./control.js";
import { describeFeatures, featuresWithRuns, findWorktreeRun, listFeatures, resolveFeatureArg } from "./features.js";
import { checkChatCwd, normalizeFeatureDir, preflight, type PreflightResult, specProfile, verifyPhaseProblem } from "./preflight.js";
import { loadRuntimeFactory } from "./runtime-loader.js";
import type { AgentRuntime } from "./runtime.js";
import { ensurePipelineDir, hashFile, isAlive, pipelineDir, readState, statePath } from "./state.js";

function fail(message: string): never {
  console.error(`未启动：${message}`);
  process.exit(2);
}

interface Reservation {
  scheduleId: string;
  at: string;
  command: string;
  createdAt: string;
}

function reservationFile(repo: string, featureDir: string): string {
  return path.join(pipelineDir(repo, featureDir), "scheduled-start.json");
}

function readReservation(repo: string, featureDir: string): Reservation | null {
  try {
    return JSON.parse(fs.readFileSync(reservationFile(repo, featureDir), "utf8")) as Reservation;
  } catch {
    return null;
  }
}

/** Runs `use` with a runtime, giving up after `timeoutMs` (the daemon may be unreachable). */
async function withRuntime<T>(config: PipelineConfig, use: (runtime: AgentRuntime) => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const work = (async () => {
    const runtime = await (await loadRuntimeFactory())({ config, log: () => undefined });
    try {
      return await use(runtime);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  })();
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("连接 Paseo 超时")), timeoutMs).unref()),
  ]);
}

/** Cancels a scheduled start, if there is one. Returns it. */
async function dropReservation(repo: string, featureDir: string, config: PipelineConfig): Promise<Reservation | null> {
  const reservation = readReservation(repo, featureDir);
  if (!reservation) return null;
  await withRuntime(config, (runtime) => runtime.cancelSchedule(reservation.scheduleId)).catch(() => undefined);
  fs.rmSync(reservationFile(repo, featureDir), { force: true });
  return reservation;
}

const argv = process.argv.slice(2);
let args;
try {
  args = parseLaunchArgs(argv);
} catch (error) {
  fail((error as Error).message);
}
const configPath = args.configPath ?? defaultConfigPath();

if (args.cardFields) {
  try {
    const text = cardFieldsText(loadConfig(configPath, fs.existsSync(args.repo) ? args.repo : undefined).config.integrations);
    console.log(text ?? "没有配置外部系统对接（integrations），不需要 card.json，跳过这一步。");
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
}

if (args.list) {
  console.log(describeFeatures(listFeatures(args.repo), args.repo));
  process.exit(0);
}

// A requirement started here with --worktree lives in the worktree created for it; the
// chat stays here, so status, stop and resume from this chat are redirected there.
if (args.featureDir && fs.existsSync(args.repo) && !args.sourceRepo && !args.worktree && !args.specReview) {
  const here = (() => {
    try {
      return resolveFeatureArg(args.repo, args.featureDir);
    } catch {
      return null;
    }
  })();
  const hasRunHere = here !== null && fs.existsSync(statePath(args.repo, here));
  const away = hasRunHere ? null : findWorktreeRun(args.repo, here ?? args.featureDir);
  if (away) {
    args.sourceRepo = fs.realpathSync(args.repo);
    args.repo = away.repo;
    args.featureDir = away.featureDir;
    args.workspaceId = away.workspaceId;
  }
}

// Short names: "sms-login" for docs/features/20261012-sms-login.
if (args.featureDir && fs.existsSync(args.repo)) {
  try {
    args.featureDir = resolveFeatureArg(args.repo, args.featureDir);
  } catch (error) {
    if (args.status || args.stop) {
      console.error((error as Error).message);
      process.exit(2);
    }
    fail((error as Error).message);
  }
}

// --status without --feature: the only requirement here that has run, else the list.
if (args.status && !args.featureDir) {
  const ran = fs.existsSync(args.repo) ? featuresWithRuns(args.repo) : [];
  if (ran.length !== 1) {
    if (ran.length > 1) console.log("这个工作区里有多个需求运行过，请指定要看哪一个（--feature 后写名称即可）。\n");
    console.log(describeFeatures(listFeatures(args.repo), args.repo));
    process.exit(0);
  }
  args.featureDir = ran[0];
}

if (args.status || args.stop) {
  let repo: string;
  let featureDir: string;
  try {
    repo = fs.realpathSync(args.repo);
    featureDir = normalizeFeatureDir(repo, args.featureDir);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const file = statePath(repo, featureDir);
  if (args.status) {
    const state = readState(file);
    const reservation = readReservation(repo, featureDir);
    if (!state && reservation) {
      console.log(`需求：${featureDir}\n状态：已预约在 ${describeTime(new Date(reservation.at))} 开始开发（Paseo 定时任务，到时由这个对话执行启动命令）。取消预约：执行暂停命令。`);
      process.exit(0);
    }
    console.log(describeStatus(state, featureDir));
    if (state && reservation) console.log(`已预约：${describeTime(new Date(reservation.at))} 开始（Paseo 定时任务，到时由对话执行；执行暂停命令可以取消）`);
    if (args.sourceRepo) console.log(`位置：为这个需求新建的工作区 ${repo}（需求文件在 ${path.join(repo, featureDir)}）`);
    // Live detail from Paseo, best effort: the plain status above never depends on the daemon.
    if (state?.status === "running") {
      const fetchLive = async (): Promise<string[]> => {
        const runtime = await (await loadRuntimeFactory())({ config: loadConfig(configPath, repo).config, log: () => undefined });
        try {
          return await describeLiveActivity(state, runtime);
        } finally {
          await runtime.close().catch(() => undefined);
        }
      };
      // Daemon unreachable or config unreadable: the status above is still correct.
      const live = await Promise.race([fetchLive().catch(() => []), new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 10_000).unref())]);
      if (live.length > 0) console.log(`\n${live.join("\n")}`);
    }
    process.exit(0);
  }
  let config;
  try {
    config = loadConfig(configPath, repo).config;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const reservation = await dropReservation(repo, featureDir, config);
  if (reservation) console.log(`已取消预约在 ${describeTime(new Date(reservation.at))} 的开始。`);
  if (reservation && !readState(file)) process.exit(0);
  const result = await stopPipeline({
    statePath: file,
    featureDir,
    config,
    createRuntime: await loadRuntimeFactory(),
    log: (message) => console.error(message),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  console.log(result.message);
  process.exit(result.stopped ? 0 : 1);
}

if (args.specReview) {
  let repo: string;
  let featureDir: string;
  let reviewConfig: PipelineConfig;
  try {
    repo = fs.realpathSync(args.repo);
    checkChatCwd(args, repo);
    featureDir = normalizeFeatureDir(repo, args.featureDir);
    reviewConfig = loadConfig(configPath, repo).config;
  } catch (error) {
    fail((error as Error).message);
  }
  const specFile = path.join(repo, featureDir, "spec.md");
  if (!fs.existsSync(specFile)) fail(`功能目录中没有 spec.md：${featureDir}`);
  const reviewProfile = specProfile(fs.readFileSync(specFile, "utf8")) ?? reviewConfig.defaultProfile;
  if (reviewConfig.specReview === "off" || (reviewConfig.specReview === "standard" && reviewProfile === "quick")) {
    console.log(
      reviewConfig.specReview === "off"
        ? "跳过：配置中关闭了需求说明审阅（specReview）。直接请用户确认需求说明即可。"
        : "跳过：快速档的需求不做独立审阅。直接请用户确认需求说明即可。",
    );
    process.exit(0);
  }
  const current = readState(statePath(repo, featureDir));
  if (current?.status === "running" && isAlive(current.pid)) fail("这个需求的开发流水线正在运行，不需要再审阅需求说明");
  ensurePipelineDir(repo, featureDir);
  const reviewLog = path.join(pipelineDir(repo, featureDir), "spec-review.log");
  const reviewOut = fs.openSync(reviewLog, "a");
  const reviewer = spawn(process.execPath, [...process.execArgv, path.join(ENGINE_DIR, "src", "spec-review.ts"), ...launchArgv({ ...args, featureDir })], {
    cwd: repo,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", reviewOut, reviewOut],
    env: process.env,
  });
  reviewer.unref();
  console.log(
    [
      "已开始需求说明的独立审阅（后台进行，通常需要几分钟）。",
      `功能目录：${featureDir}`,
      `审阅结果会写到 ${featureDir}/spec-review.md，完成后会作为一条消息发回这个对话。`,
      `日志：${reviewLog}`,
      "等待期间可以继续和用户确认其他细节，但先不要把需求说明标为已确认。",
    ].join("\n"),
  );
  process.exit(0);
}

let checked: PreflightResult;
try {
  checked = preflight(args, hashFile);
} catch (error) {
  fail((error as Error).message);
}

let loaded;
try {
  loaded = loadConfig(configPath, checked.repo);
} catch (error) {
  fail((error as Error).message);
}

if (args.verifyAt) {
  const at = parseStartTime(args.verifyAt);
  if (!at) fail(`看不懂测试验证的开始时间"${args.verifyAt}"。可以写 22:00、明天 8:30、2026-10-14 08:30 或 +2h`);
  if (!args.originAgentId) fail("预约测试验证需要在 Paseo 的对话中执行：到时由这个对话执行开始测试验证的命令。");
  if (args.phases === "develop-only") fail("只做研发时没有测试验证阶段，--verify-at 不适用");
  args.verifyAt = at.toISOString();
}

if (checked.entersVerify) {
  const previous = checked.mode.kind === "fresh" ? null : checked.mode.previous;
  const environment = args.verifyEnv ?? previous?.phases?.environment ?? loaded.config.phases.verify.environment;
  const problem = verifyPhaseProblem(checked.repo, checked.featureDir, environment);
  if (problem) fail(problem);
}

if (args.at) {
  const at = parseStartTime(args.at);
  if (!at) fail(`看不懂开始时间"${args.at}"。可以写 22:00、明天 8:30、2026-10-14 08:30 或 +2h`);
  if (at.getTime() < Date.now() + 60_000) fail("开始时间要在至少 1 分钟之后");
  const origin = args.originAgentId;
  if (!origin) fail("预约开始需要在 Paseo 的对话中执行：到时由这个对话执行启动命令。");
  const command = args.phase
    ? verifyCommand({ repo: checked.repo, featureDir: checked.featureDir, configPath: args.configPath, verifyEnv: args.verifyEnv, defects: args.defects })
    : startCommand({
        repo: checked.repo,
        featureDir: checked.featureDir,
        configPath: args.configPath,
        profile: args.profile,
        worktree: args.worktree,
        phases: args.phases,
        verifyAt: args.verifyAt,
      });
  let scheduleId: string | null;
  try {
    await dropReservation(checked.repo, checked.featureDir, loaded.config);
    scheduleId = await withRuntime(loaded.config, (runtime) =>
      runtime.scheduleMessage({
        agentId: origin,
        at,
        name: `req-kit 预约${args.phase ? "测试验证" : "开发"}：${path.basename(checked.featureDir)}`,
        prompt: scheduledStartPrompt({ featureDir: checked.featureDir, command }),
      }),
    );
  } catch (error) {
    fail(`没能预约：${(error as Error).message}`);
  }
  if (!scheduleId) fail("这个 Paseo 版本不支持定时任务，无法预约。可以到时再启动。");
  ensurePipelineDir(checked.repo, checked.featureDir);
  const reservation: Reservation = { scheduleId, at: at.toISOString(), command, createdAt: new Date().toISOString() };
  fs.writeFileSync(reservationFile(checked.repo, checked.featureDir), `${JSON.stringify(reservation, null, 2)}\n`);
  console.log(
    [
      `已预约在 ${describeTime(at)} 开始${args.phase ? "测试验证" : "开发"}（Paseo 定时任务，在 Paseo 的 Schedules 中可以看到）。到时会在这个对话里自动执行启动命令。`,
      `功能目录：${checked.featureDir}`,
      "查看：查看进度命令；取消：暂停命令。在那之前修改需求说明也没关系，开始时以最新的为准。",
    ].join("\n"),
  );
  process.exit(0);
}

// Starting now: a start scheduled earlier (or this start, fired by it) is no longer needed.
if (readReservation(checked.repo, checked.featureDir)) await dropReservation(checked.repo, checked.featureDir, loaded.config);

let ownWorktree: OwnWorktree | null = null;
if (args.worktree) {
  // Create the requirement's own worktree now, so the pipeline starts there.
  const spec = fs.readFileSync(checked.specPath, "utf8");
  const title = (/^#\s+(.+)$/m.exec(spec)?.[1] ?? path.basename(checked.featureDir)).trim();
  const create = async () => {
    const runtime = await (await loadRuntimeFactory())({ config: loaded.config, log: () => undefined });
    try {
      return await moveToOwnWorktree({ runtime, sourceRepo: checked.repo, featureDir: checked.featureDir, originAgentId: args.originAgentId, title });
    } finally {
      await runtime.close().catch(() => undefined);
    }
  };
  try {
    ownWorktree = await Promise.race([
      create(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("连接 Paseo 新建工作区超过 2 分钟没有完成")), 120_000).unref()),
    ]);
  } catch (error) {
    fail(`没能为这个需求新建工作区：${(error as Error).message}`);
  }
  args.sourceRepo = checked.repo;
  args.repo = ownWorktree.repo;
  args.workspaceId = ownWorktree.workspaceId;
  args.worktree = false;
  try {
    checked = preflight(args, hashFile);
  } catch (error) {
    fail(`新工作区 ${ownWorktree.repo} 已建好，但无法在那里启动：${(error as Error).message}`);
  }
}

ensurePipelineDir(checked.repo, checked.featureDir);
const logPath = path.join(pipelineDir(checked.repo, checked.featureDir), "pipeline.log");
const out = fs.openSync(logPath, "a");

// Re-use this process's loader flags (tsx registers itself through execArgv).
const child = spawn(process.execPath, [...process.execArgv, path.join(ENGINE_DIR, "src", "main.ts"), ...launchArgv(args)], {
  cwd: checked.repo,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", out, out],
  env: process.env,
});
child.unref();

const modeText: Record<string, string> = {
  fresh: "新启动",
  restart: "从头重新开始",
  "resume-reuse": "从中断处继续",
  "resume-from-design": "需求有变化，从方案设计开始增量处理",
};
const phaseMode =
  args.phases ??
  (checked.mode.kind === "resume-reuse" ? checked.mode.previous.phases?.mode : null) ??
  checked.specPhases ??
  (checked.mode.kind === "fresh" ? null : checked.mode.previous.phases?.mode) ??
  (args.verifyAt ? "gated" : loaded.config.phases.mode);
const profile =
  args.profile ??
  (checked.mode.kind === "resume-reuse" ? checked.mode.previous.profile : null) ??
  checked.specProfile ??
  loaded.config.defaultProfile;

console.log(
  [
    checked.entersVerify
      ? `已在后台开始测试验证阶段（${PROFILE_LABELS[profile]}档），进程 ${child.pid}。提测说明：${checked.featureDir}/handoff.md`
      : `已在后台启动（${args.approve && checked.mode.kind === "resume-reuse" ? "已确认方案，开始写代码" : modeText[checked.mode.kind]}，${PROFILE_LABELS[profile]}档${phaseMode === "continuous" ? "" : `，执行方式：${PHASE_MODE_LABELS[phaseMode]}`}），进程 ${child.pid}。`,
    !checked.entersVerify && phaseMode === "gated"
      ? `研发完成（写好提测说明）后会停下来通知这个对话，等待测试验证${args.verifyAt ? `；已安排在 ${describeTime(new Date(args.verifyAt))} 之后自动开始测试验证` : ""}。`
      : !checked.entersVerify && phaseMode === "develop-only"
        ? "只做研发：写好提测说明和研发报告后结束，测试由人完成。"
        : null,
    ownWorktree
      ? `已为这个需求新建工作区：${ownWorktree.repo}（分支 ${ownWorktree.branch}，在 Paseo 侧边栏中可以看到）。开发在那里进行，步骤仍挂在这个对话下；这个对话的工作目录不变。` +
        `需求文件已移到 ${path.join(ownWorktree.repo, checked.featureDir)}${ownWorktree.removedSource ? "" : "（这里原有的已提交版本保留不动）"}，之后读写需求文件请用这个路径。`
      : args.sourceRepo
        ? `这个需求在为它新建的工作区中开发：${checked.repo}`
        : null,
    `功能目录：${checked.featureDir}`,
    checked.branch ? `工作分支：${checked.branch}` : "不是 git 仓库：步骤不会提交代码。",
    loaded.sources.length > 1 ? `使用了项目配置：${loaded.sources[1]}` : null,
    `运行日志：${logPath}`,
    args.originAgentId
      ? `进展和结果会发回 agent ${args.originAgentId} 的对话。`
      : "没有提供 --origin-agent，进展只写入日志。",
  ]
    .filter(Boolean)
    .join("\n"),
);
