// Entry point for the chat agent.
//   start:    validates the request, then starts main.ts in its own session (detached)
//             so the pipeline outlives the agent's shell and turn; returns in a second or two.
//   --status: prints progress in plain language.
//   --stop:   stops the pipeline and its current step agent; --resume continues later.
//   --list:   lists every requirement in this repository's worktrees.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseLaunchArgs } from "./cli-args.js";
import { loadConfig, PROFILE_LABELS } from "./config.js";
import { defaultConfigPath, ENGINE_DIR } from "./locations.js";
import { describeStatus, stopPipeline } from "./control.js";
import { describeFeatures, featuresWithRuns, listFeatures, resolveFeatureArg } from "./features.js";
import { normalizeFeatureDir, preflight } from "./preflight.js";
import { loadRuntimeFactory } from "./runtime-loader.js";
import { ensurePipelineDir, hashFile, pipelineDir, readState, statePath } from "./state.js";

function fail(message: string): never {
  console.error(`未启动：${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let args;
try {
  args = parseLaunchArgs(argv);
} catch (error) {
  fail((error as Error).message);
}
const configPath = args.configPath ?? defaultConfigPath();

if (args.list) {
  console.log(describeFeatures(listFeatures(args.repo), args.repo));
  process.exit(0);
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
    console.log(describeStatus(readState(file), featureDir));
    process.exit(0);
  }
  let config;
  try {
    config = loadConfig(configPath, repo).config;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
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

let checked;
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

ensurePipelineDir(checked.repo, checked.featureDir);
const logPath = path.join(pipelineDir(checked.repo, checked.featureDir), "pipeline.log");
const out = fs.openSync(logPath, "a");

// Re-use this process's loader flags (tsx registers itself through execArgv).
const child = spawn(process.execPath, [...process.execArgv, path.join(ENGINE_DIR, "src", "main.ts"), ...argv], {
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
const profile =
  args.profile ??
  (checked.mode.kind === "resume-reuse" ? checked.mode.previous.profile : null) ??
  checked.specProfile ??
  loaded.config.defaultProfile;

console.log(
  [
    `已在后台启动（${modeText[checked.mode.kind]}，${PROFILE_LABELS[profile]}档），进程 ${child.pid}。`,
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
