// The long-running pipeline process. Normally started by launch.ts, detached
// from the chat agent's shell; can also be run in the foreground for debugging.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { LAUNCHER, parseLaunchArgs, resumeCommand } from "./cli-args.js";
import { loadConfig, PROFILE_LABELS } from "./config.js";
import { defaultConfigPath, kitVersion, localPromptsDir, PRINCIPLES_INDEX, PROMPTS_DIR } from "./locations.js";
import { satisfies } from "./daemon-check.js";
import { describeAgentProfile, resolveConfigProfiles, usesPaseoProfiles } from "./paseo-profiles.js";
import { runPipeline } from "./pipeline.js";
import { preflight } from "./preflight.js";
import { loadRuntimeFactory } from "./runtime-loader.js";
import {
  acquireLock,
  ensurePipelineDir,
  hashFile,
  type PipelineState,
  pipelineDir,
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

  // Checked before the state file is touched, so a refused launch leaves no record behind.
  {
    try {
      // In a worktree created for the requirement, the chat stays in the checkout it was cut from.
      const chatDir = args.sourceRepo ?? (mode.kind === "fresh" ? null : mode.previous.worktree?.sourceRepo) ?? repo;
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
    };
    log(`开始新的流水线：${featureDir}（${PROFILE_LABELS[profile]}档，分支 ${checked.branch ?? "无"}）`);
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
    };
    const why = mode.kind === "resume-from-design" ? mode.reason : mode.kind === "restart" ? "按 --restart 从头开始" : "从中断处继续，已完成的步骤沿用结果";
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

  const shutdown = (signal: string) => {
    log(`收到 ${signal}，流水线停止`);
    state.status = "failed";
    state.stopReason = `流水线进程被 ${signal} 终止`;
    writeState(stateFile, state);
    release();
    process.exit(1);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

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
      resumeCommand: resumeCommand({ repo: state.worktree?.sourceRepo ?? repo, featureDir, configPath: args.configPath }),
      log,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    log(`流水线结束：${outcome}`);
    return outcome === "completed" ? 0 : outcome === "waiting_for_business" ? 3 : 1;
  } finally {
    await runtime.close().catch(() => undefined);
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
