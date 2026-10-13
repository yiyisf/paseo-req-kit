// The long-running pipeline process. Normally started by launch.ts, detached
// from the chat agent's shell; can also be run in the foreground for debugging.

import path from "node:path";
import { LAUNCHER, parseLaunchArgs, resumeCommand, TOOL_DIR } from "./cli-args.js";
import { defaultConfigPath, loadConfig, PROFILE_LABELS } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { preflight } from "./preflight.js";
import { loadRuntimeFactory } from "./runtime-loader.js";
import {
  acquireLock,
  ensurePipelineDir,
  hashFile,
  type PipelineState,
  pipelineDir,
  statePath,
  writeState,
} from "./state.js";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main(): Promise<number> {
  const args = parseLaunchArgs(process.argv.slice(2));
  const configPath = args.configPath ?? defaultConfigPath(TOOL_DIR);
  const checked = preflight(args, hashFile);
  const { repo, featureDir, mode } = checked;
  const { config, sources, ignored } = loadConfig(configPath, repo);
  log(`配置：${sources.join(" → ")}`);
  if (ignored.length > 0) log(`项目配置中的 ${ignored.join("、")} 只能在本机配置中设置，已忽略`);

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
  if (originAgentId) {
    try {
      await runtime.verifyOrigin(originAgentId, repo);
    } catch (error) {
      const reason = (error as Error).message;
      log(`未启动：${reason}`);
      await runtime
        .notifyAgent(originAgentId, `【需求开发流水线通知】这条消息来自后台流水线，不是用户发的。流水线没有启动：${reason}`)
        .catch(() => undefined);
      await runtime.close().catch(() => undefined);
      release();
      return 2;
    }
  }

  const previous = mode.kind === "fresh" ? null : mode.previous;
  const profile =
    args.profile ?? (mode.kind === "resume-reuse" ? previous?.profile : null) ?? checked.specProfile ?? config.defaultProfile;

  let state: PipelineState;
  if (mode.kind === "fresh") {
    state = {
      version: 1,
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
    };
    log(`开始新的流水线：${featureDir}（${PROFILE_LABELS[profile]}档，分支 ${checked.branch ?? "无"}）`);
  } else {
    const startOver = mode.kind !== "resume-reuse";
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
    };
    const why = mode.kind === "resume-from-design" ? mode.reason : mode.kind === "restart" ? "按 --restart 从头开始" : "从中断处继续，已完成的步骤沿用结果";
    log(`继续流水线：${featureDir}（第 ${state.attempt} 次尝试，${PROFILE_LABELS[profile]}档）—— ${why}`);
  }
  writeState(stateFile, state);

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
      toolDir: TOOL_DIR,
      logPath: path.join(pipelineDir(repo, featureDir), "pipeline.log"),
      resumeCommand: resumeCommand({ repo, featureDir, configPath: args.configPath }),
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
