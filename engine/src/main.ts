// The long-running pipeline process. Normally started by launch.ts, detached
// from the chat agent's shell; can also be run in the foreground for debugging.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { approveCommand, LAUNCHER, parseLaunchArgs, resumeCommand, statusCommand, verifyCommand } from "./cli-args.js";
import { dequeuedMessage, queuedMessage, watchdogPrompt } from "./messages.js";
import { slotHolders, slotsDir, tryAcquireSlot } from "./queue.js";
import { cronEvery, parseStartTime } from "./schedule-time.js";
import { loadConfig, PHASE_MODE_LABELS, PROFILE_LABELS, REQUIREMENT_TYPE_LABELS } from "./config.js";
import { defaultConfigPath, kitVersion, localPromptsDir, PRINCIPLES_INDEX, PROMPTS_DIR } from "./locations.js";
import { satisfies } from "./daemon-check.js";
import { describeAgentProfile, resolveConfigProfiles, usesPaseoProfiles } from "./paseo-profiles.js";
import { runPipeline } from "./pipeline.js";
import { preflight, verifyPhaseProblem } from "./preflight.js";
import { loadRuntimeFactory } from "./runtime-loader.js";
import {
  acquireLock,
  ensurePipelineDir,
  hashFile,
  type PipelineState,
  pipelineDir,
  type RunPhases,
  STATE_VERSION,
  statePath,
  writeState,
} from "./state.js";

function headCommit(repo: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main(): Promise<number> {
  const args = parseLaunchArgs(process.argv.slice(2));
  const configPath = args.configPath ?? defaultConfigPath();
  const checked = preflight(args, hashFile);
  const { repo, featureDir, mode } = checked;
  const loaded = loadConfig(configPath, repo);
  const { sources, ignored } = loaded;
  let config = loaded.config;
  log(`req-kit ${kitVersion()}；配置：${sources.join(" → ")}`);
  if (ignored.length > 0) log(`${ignored.join("、")} 只能在本机配置中设置，已忽略`);
  if (config.requiredVersion && !satisfies(kitVersion(), config.requiredVersion)) {
    log(`提醒：团队或项目要求 req-kit ${config.requiredVersion}，当前为 ${kitVersion()}。流水线照常运行，请找时间升级（见 /req-doctor）。`);
  }

  ensurePipelineDir(repo, featureDir);
  const release = acquireLock(repo, featureDir);
  const stateFile = statePath(repo, featureDir);
  const now = new Date().toISOString();
  const specHash = hashFile(checked.specPath);

  const createRuntime = await loadRuntimeFactory();
  const runtime = await createRuntime({ config, log });

  // A resume without --origin-agent keeps reporting to the chat that started the run.
  const originAgentId = args.originAgentId ?? (mode.kind === "fresh" ? null : mode.previous.originAgentId);

  const previousState = mode.kind === "fresh" ? null : mode.previous;
  const reuse = mode.kind === "resume-reuse";
  // Execution mode: --phases, else what this run already uses (continuing), else the spec, else the config.
  let phaseMode =
    args.phases ?? (reuse ? previousState?.phases?.mode : null) ?? checked.specPhases ?? previousState?.phases?.mode ?? config.phases.mode;
  // --verify-at only makes sense with a gate; asking for it implies one.
  if (args.verifyAt && phaseMode === "continuous" && !args.phases) phaseMode = "gated";
  // A playbook type the configuration turned off runs the normal flow.
  const type = checked.specType && config.requirementTypes.includes(checked.specType) ? checked.specType : null;
  // An assessment writes no code: there is nothing to hand over for testing.
  if (type === "assessment") phaseMode = "continuous";
  const phases: RunPhases = {
    mode: phaseMode,
    environment: args.verifyEnv ?? previousState?.phases?.environment ?? config.phases.verify.environment,
    defects: args.defects ?? previousState?.phases?.defects ?? config.phases.verify.defects,
  };
  const verifyAtText = args.verifyAt ?? null;
  const verifyAt = verifyAtText ? (parseStartTime(verifyAtText) ?? (Number.isNaN(Date.parse(verifyAtText)) ? null : new Date(verifyAtText))) : null;

  // Checked before the state file is touched, so a refused launch leaves no record behind.
  {
    try {
      // In a worktree created for the requirement, the chat stays in the checkout it was cut from.
      const chatDir = args.sourceRepo ?? (mode.kind === "fresh" ? null : mode.previous.worktree?.sourceRepo) ?? repo;
      if (verifyAtText && !verifyAt) throw new Error(`看不懂测试验证的开始时间"${verifyAtText}"`);
      if (verifyAtText && phases.mode === "develop-only") throw new Error("只做研发时没有测试验证阶段，--verify-at 不适用");
      if (type === "assessment" && (verifyAtText || args.phase === "verify")) throw new Error("评估类需求只做调研、不写代码，没有测试验证阶段");
      if (checked.entersVerify) {
        const problem = verifyPhaseProblem(repo, featureDir, phases.environment);
        if (problem) throw new Error(problem);
      }
      if (originAgentId) await runtime.verifyOrigin(originAgentId, chatDir);
      if (usesPaseoProfiles(config)) config = resolveConfigProfiles(config, await runtime.listPaseoProfiles());
    } catch (error) {
      const reason = (error as Error).message;
      log(`未启动：${reason}`);
      if (originAgentId) {
        await runtime
          .notifyAgent(originAgentId, `【需求开发流水线通知】这条消息来自后台流水线，不是用户发的。流水线没有启动：${reason}`)
          .catch(() => undefined);
      }
      await runtime.close().catch(() => undefined);
      release();
      return 2;
    }
  }

  log(`builder：${describeAgentProfile(config.agents.builder)}；reviewer：${describeAgentProfile(config.agents.reviewer)}`);

  const previous = mode.kind === "fresh" ? null : mode.previous;
  const profile =
    args.profile ?? (mode.kind === "resume-reuse" ? previous?.profile : null) ?? checked.specProfile ?? config.defaultProfile;

  let state: PipelineState;
  if (mode.kind === "fresh") {
    state = {
      version: STATE_VERSION,
      repo,
      featureDir,
      status: "running",
      attempt: 1,
      specHash,
      originAgentId,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      results: {},
      history: [],
      stopReason: null,
      outcome: null,
      profile,
      branch: checked.branch,
      milestones: [],
      incremental: null,
      worktree: args.sourceRepo && args.workspaceId ? { workspaceId: args.workspaceId, sourceRepo: args.sourceRepo } : null,
      phases,
      phase: "develop",
      verifyAt: verifyAt?.toISOString() ?? null,
      handbacks: 0,
      type,
    };
    log(
      `开始新的流水线：${featureDir}（${PROFILE_LABELS[profile]}档，${type ? `类型：${REQUIREMENT_TYPE_LABELS[type]}，` : ""}执行方式：${PHASE_MODE_LABELS[phases.mode]}，分支 ${checked.branch ?? "无"}）`,
    );
  } else {
    const startOver = mode.kind !== "resume-reuse";
    const previousImplemented = Object.keys(mode.previous.results).some((k) => k === "implement") ||
      mode.previous.history.some((h) => h.stepId === "implement" && h.outcome === "completed");
    state = {
      ...mode.previous,
      status: "running",
      attempt: startOver ? mode.previous.attempt + 1 : mode.previous.attempt,
      specHash,
      // A later launch from a different chat moves notifications to that chat.
      originAgentId,
      pid: process.pid,
      results: startOver ? {} : mode.previous.results,
      stopReason: null,
      outcome: null,
      profile,
      branch: checked.branch,
      // Older state files have no milestones; a fresh attempt sends them again.
      milestones: startOver ? [] : (mode.previous.milestones ?? []),
      incremental:
        mode.kind === "resume-from-design"
          ? { fromAttempt: mode.previous.attempt, reason: mode.reason, baseCommit: headCommit(repo), hadImplementation: previousImplemented }
          : mode.kind === "restart"
            ? null
            : (mode.previous.incremental ?? null),
      phases,
      // The verify phase starts when development is done; any other start over goes back to development.
      phase: checked.entersVerify ? "verify" : startOver ? "develop" : (mode.previous.phase ?? "develop"),
      verifyAt: checked.entersVerify ? null : (verifyAt?.toISOString() ?? (startOver ? null : (mode.previous.verifyAt ?? null))),
      handbacks: mode.kind === "restart" ? 0 : (mode.previous.handbacks ?? 0),
      type,
      codeBase: startOver ? null : (mode.previous.codeBase ?? null),
      // --approve: the requester confirmed the design that was waiting at the confirmation point.
      approval:
        args.approve && mode.previous.status === "waiting_for_approval"
          ? { attempt: mode.previous.attempt, status: "approved", at: now }
          : startOver
            ? null
            : (mode.previous.approval ?? null),
      gate: mode.kind === "restart" ? null : (mode.previous.gate ?? null),
    };
    if (checked.entersVerify) {
      // A develop-only run that ends with its development report gets a full report after verification.
      delete state.results.report;
      log(`开始测试验证阶段（${phases.environment === "deployed" ? "已部署的测试环境" : "本地"}，缺陷处理：${phases.defects}）`);
    }
    const why =
      mode.kind === "resume-from-design"
        ? mode.reason
        : mode.kind === "restart"
          ? "按 --restart 从头开始"
          : args.approve
            ? "需求方已确认方案，开始写代码"
            : "从中断处继续，已完成的步骤沿用结果";
    log(`继续流水线：${featureDir}（第 ${state.attempt} 次尝试，${PROFILE_LABELS[profile]}档）—— ${why}`);
  }
  writeState(stateFile, state);
  if (state.worktree) log(`在为这个需求新建的工作区中开发：${repo}（Paseo 工作区 ${state.worktree.workspaceId}，对话所在目录 ${state.worktree.sourceRepo}）`);

  if (state.worktree && mode.kind === "fresh") {
    // paseo.json's worktree.setup (installing dependencies, copying .env) runs in the background.
    const setup = await runtime.waitForWorkspaceSetup(state.worktree.workspaceId, 30 * 60_000).catch(() => ({ status: "none" as const, error: null }));
    if (setup.status === "completed") log("新工作区的环境准备（paseo.json）已完成");
    else if (setup.status === "failed" || setup.status === "timeout") {
      const why = setup.status === "timeout" ? "30 分钟内没有完成" : `失败：${setup.error ?? "原因未知"}`;
      log(`新工作区的环境准备（paseo.json）${why}。流水线继续，步骤会按验证方法自行准备环境。`);
    }
  }

  // The chat's own directory: a tester's chat may sit in another checkout of the same repository.
  const chatRepo = args.sourceRepo ?? state.worktree?.sourceRepo ?? repo;
  const commands = {
    resume: resumeCommand({ repo: chatRepo, featureDir, configPath: args.configPath }),
    status: statusCommand({ repo: chatRepo, featureDir, configPath: args.configPath }),
    verify: verifyCommand({ repo: chatRepo, featureDir, configPath: args.configPath }),
    approve: approveCommand({ repo: chatRepo, featureDir, configPath: args.configPath }),
  };
  const notify = async (text: string) => {
    log(`通知：\n${text}`);
    if (originAgentId) await runtime.notifyAgent(originAgentId, text).catch((error: Error) => log(`通知发送失败：${error.message}`));
  };

  // Reminders and automatic continuations from the previous run are no longer needed.
  if (state.schedules?.length) {
    for (const s of state.schedules) await runtime.cancelSchedule(s.id).catch((error: Error) => log(`取消定时任务 ${s.id} 失败：${error.message}`));
    log(`已取消上次运行留下的 Paseo 定时任务：${state.schedules.map((s) => s.kind).join("、")}`);
    state.schedules = [];
    writeState(stateFile, state);
  }

  let releaseSlot = () => {};
  const shutdown = (signal: string) => {
    log(`收到 ${signal}，流水线停止`);
    state.status = "failed";
    state.stopReason = `流水线进程被 ${signal} 终止`;
    state.queuedSince = null;
    writeState(stateFile, state);
    releaseSlot();
    release();
    process.exit(1);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // Machine-wide limit on concurrent pipelines: wait for a free slot.
  if (config.maxConcurrentPipelines > 0) {
    const dir = slotsDir();
    const holder = { pid: process.pid, repo, featureDir, since: new Date().toISOString() };
    let slot = tryAcquireSlot(dir, config.maxConcurrentPipelines, holder);
    if (!slot) {
      const since = Date.now();
      state.queuedSince = new Date(since).toISOString();
      writeState(stateFile, state);
      log(`本机同时运行的流水线已达上限（${config.maxConcurrentPipelines}），排队等待`);
      await notify(queuedMessage({ featureDir, max: config.maxConcurrentPipelines, holders: slotHolders(dir) }));
      while (!slot) {
        await new Promise((resolve) => setTimeout(resolve, config.queuePollSeconds * 1000));
        slot = tryAcquireSlot(dir, config.maxConcurrentPipelines, holder);
      }
      state.queuedSince = null;
      writeState(stateFile, state);
      log("排队结束，开始运行");
      await notify(dequeuedMessage({ featureDir, waitedMinutes: (Date.now() - since) / 60_000 }));
    }
    releaseSlot = slot;
  }

  // Optional watchdog: the chat checks on the run now and then and continues it if the process died.
  let watchdog: string | null = null;
  if (config.watchdogMinutes > 0 && originAgentId) {
    watchdog = await runtime
      .scheduleMessage({
        agentId: originAgentId,
        cron: cronEvery(config.watchdogMinutes),
        expiresAt: new Date(Date.now() + 3 * 24 * 3600_000),
        name: `req-kit 定时检查：${path.basename(featureDir)}`,
        prompt: watchdogPrompt({ featureDir, statusCommand: commands.status, resumeCommand: commands.resume }),
      })
      .catch((error: Error) => {
        log(`预约定时检查失败：${error.message}`);
        return null;
      });
    if (watchdog) {
      state.schedules = [...(state.schedules ?? []), { id: watchdog, kind: "watchdog", at: null }];
      writeState(stateFile, state);
      log(`已预约定时检查（每 ${config.watchdogMinutes} 分钟，Paseo 定时任务 ${watchdog}）`);
    }
  }

  try {
    const outcome = await runPipeline({
      repo,
      featureDir,
      config,
      runtime,
      state,
      statePath: stateFile,
      prompts: { promptsDir: PROMPTS_DIR, localPromptsDir: localPromptsDir(), principlesFile: PRINCIPLES_INDEX },
      logPath: path.join(pipelineDir(repo, featureDir), "pipeline.log"),
      // Run from the chat, whose directory is the source checkout when the requirement has its own worktree.
      resumeCommand: commands.resume,
      statusCommand: commands.status,
      verifyCommand: commands.verify,
      approveCommand: commands.approve,
      log,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    log(`流水线结束：${outcome}`);
    return outcome === "completed" || outcome === "phase_done" ? 0 : outcome === "waiting_for_business" || outcome === "waiting_for_approval" ? 3 : 1;
  } finally {
    // The run ended by itself: the watchdog has nothing left to watch.
    if (watchdog) {
      await runtime.cancelSchedule(watchdog).catch(() => undefined);
      state.schedules = (state.schedules ?? []).filter((s) => s.id !== watchdog);
      writeState(stateFile, state);
    }
    await runtime.close().catch(() => undefined);
    releaseSlot();
    release();
  }
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`[${new Date().toISOString()}] 流水线无法启动：${error.message}`);
    console.error(`启动命令：${LAUNCHER}`);
    process.exit(2);
  },
);
