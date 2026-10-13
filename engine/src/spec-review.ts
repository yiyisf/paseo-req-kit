// Independent review of a draft spec, started from the chat before the requester
// confirms it (launch.ts --spec-review). Runs one "spec_review" agent under the chat,
// waits for it in the background, then posts the findings back into the chat.

import fs from "node:fs";
import path from "node:path";
import { parseLaunchArgs } from "./cli-args.js";
import { loadConfig } from "./config.js";
import { defaultConfigPath, KIT_ROOT, localPromptsDir, PRINCIPLES_INDEX, PROMPTS_DIR } from "./locations.js";
import { specReviewFailedMessage, specReviewMessage } from "./messages.js";
import { resolveConfigProfiles, usesPaseoProfiles } from "./paseo-profiles.js";
import { runSingleStep } from "./pipeline.js";
import { normalizeFeatureDir, specProfile } from "./preflight.js";
import { loadRuntimeFactory } from "./runtime-loader.js";
import { ensurePipelineDir, hashFile, type PipelineState, pipelineDir, STATE_VERSION } from "./state.js";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main(): Promise<number> {
  const args = parseLaunchArgs(process.argv.slice(2));
  const repo = fs.realpathSync(args.repo);
  const featureDir = normalizeFeatureDir(repo, args.featureDir);
  const specPath = path.join(repo, featureDir, "spec.md");
  let config = loadConfig(args.configPath ?? defaultConfigPath(), repo).config;
  ensurePipelineDir(repo, featureDir);
  const runtime = await (await loadRuntimeFactory())({ config, log });
  const origin = args.originAgentId;
  const notify = async (text: string) => {
    log(`通知：\n${text}`);
    if (origin) await runtime.notifyAgent(origin, text).catch((error: Error) => log(`通知发送失败：${error.message}`));
  };
  try {
    if (origin) await runtime.verifyOrigin(origin, repo);
    if (usesPaseoProfiles(config)) config = resolveConfigProfiles(config, await runtime.listPaseoProfiles());
    const now = new Date().toISOString();
    // A scratch state: the review is not part of a pipeline run and must not touch state.json.
    const state: PipelineState = {
      version: STATE_VERSION,
      repo,
      featureDir,
      status: "running",
      attempt: 1,
      specHash: hashFile(specPath),
      originAgentId: origin,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      results: {},
      history: [],
      stopReason: null,
      outcome: null,
      profile: specProfile(fs.readFileSync(specPath, "utf8")) ?? config.defaultProfile,
      branch: null,
      milestones: [],
      incremental: null,
    };
    const result = await runSingleStep(
      {
        repo,
        featureDir,
        config,
        runtime,
        state,
        statePath: path.join(pipelineDir(repo, featureDir), "spec-review-state.json"),
        prompts: { promptsDir: PROMPTS_DIR, localPromptsDir: localPromptsDir(), principlesFile: PRINCIPLES_INDEX },
        logPath: path.join(pipelineDir(repo, featureDir), "spec-review.log"),
        resumeCommand: "",
        log,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      "spec_review",
      { contextLines: [`需求说明的写法清单：${path.join(KIT_ROOT, "skills", "spec-writing", "SKILL.md")}`] },
    );
    await notify(
      specReviewMessage({
        featureDir,
        verdict: String(result.verdict),
        issues: (result.issues as string[] | undefined) ?? [],
        reviewPath: `${featureDir}/spec-review.md`,
      }),
    );
    return 0;
  } catch (error) {
    log(`审阅没有完成：${(error as Error).message}`);
    await notify(specReviewFailedMessage({ featureDir, reason: (error as Error).message }));
    return 1;
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`[${new Date().toISOString()}] 需求说明审阅无法启动：${error.message}`);
    process.exit(2);
  },
);
