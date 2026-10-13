import fs from "node:fs";
import path from "node:path";
import { PROFILE_LABELS, type PipelineConfig } from "./config.js";
import {
  blockedMessage,
  completedMessage,
  failedMessage,
  milestoneMessage,
  permissionMessage,
  resultFollowUp,
} from "./messages.js";
import { projectAdditions, readToolPrompt } from "./prompts.js";
import type { AgentRuntime, StepAgent } from "./runtime.js";
import { type PipelineState, type StepRecord, writeState } from "./state.js";
import { STEPS, type StepDef, type StepId, stepKey, validateResult } from "./steps.js";

export interface PipelineContext {
  repo: string;
  featureDir: string;
  config: PipelineConfig;
  runtime: AgentRuntime;
  state: PipelineState;
  statePath: string;
  toolDir: string;
  logPath: string;
  resumeCommand: string;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export type PipelineOutcome = "completed" | "waiting_for_business" | "failed";

/** Ends the run early; the message is what the user-facing notification explains. */
class StepFailure extends Error {
  constructor(
    public readonly stepTitle: string,
    message: string,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

class BusinessDecisionNeeded extends Error {
  constructor(public readonly questions: string[]) {
    super("需要业务决定");
    this.name = "BusinessDecisionNeeded";
  }
}

function featureName(featureDir: string): string {
  return path.basename(featureDir);
}

function save(ctx: PipelineContext): void {
  writeState(ctx.statePath, ctx.state);
}

async function notifyOrigin(ctx: PipelineContext, text: string): Promise<void> {
  const origin = ctx.state.originAgentId;
  ctx.log(`通知：\n${text}`);
  if (!origin) {
    ctx.log("没有发起对话的 agent ID，通知只写入日志。");
    return;
  }
  try {
    await ctx.runtime.notifyAgent(origin, text);
  } catch (error) {
    // The chat may have been archived. The state file and log still hold everything.
    ctx.log(`通知发送失败（agent ${origin}）：${(error as Error).message}`);
  }
}

function buildPrompt(ctx: PipelineContext, def: StepDef, round: number | null, maxRounds: number | null, resultFile: string): string {
  const sources = { toolDir: ctx.toolDir, repo: ctx.repo };
  const profile = ctx.state.profile;
  const lines = [
    "<pipeline-context>",
    `仓库目录：${ctx.repo}`,
    `功能目录：${ctx.featureDir}`,
    `工作分支：${ctx.state.branch ?? "（不是 git 仓库，不需要提交）"}`,
    `档位：${PROFILE_LABELS[profile]}${profile === "quick" ? "（小改动：各产物只写必要内容，保持简短）" : ""}`,
    `本步骤：${def.title}（流水线第 ${def.number} 步）`,
  ];
  if (round !== null && maxRounds !== null) lines.push(`轮次：第 ${round} 轮，最多 ${maxRounds} 轮`);
  lines.push(`结果文件：${resultFile}`, `结果文件绝对路径：${path.join(ctx.repo, resultFile)}`, "</pipeline-context>");
  const parts = [readToolPrompt(sources, "00-shared-context.md"), readToolPrompt(sources, def.promptFile)];
  const extra = projectAdditions(sources, def.id);
  if (extra) parts.push(extra);
  parts.push(lines.join("\n"));
  return `${parts.join("\n\n")}\n`;
}

/** Sends a progress note once per run attempt, when enabled. */
async function milestone(ctx: PipelineContext, id: string, text: string): Promise<void> {
  if (!ctx.config.notifyMilestones || ctx.state.milestones.includes(id)) return;
  ctx.state.milestones.push(id);
  save(ctx);
  await notifyOrigin(ctx, milestoneMessage(text));
}

async function waitForTurn(ctx: PipelineContext, agent: StepAgent, def: StepDef, agentTitle: string, deadline: number): Promise<void> {
  const notifiedPermissions = new Set<string>();
  let consecutiveErrors = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new StepFailure(
        def.title,
        `超过 ${ctx.config.stepTimeoutMinutes[def.id]} 分钟仍未完成。该 agent 可能仍在运行，可以在 Paseo 中查看「${agentTitle}」。`,
      );
    }
    let outcome;
    try {
      outcome = await agent.wait(Math.min(ctx.config.waitChunkSeconds * 1000, remaining));
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      ctx.log(`等待 ${agentTitle} 时出错（第 ${consecutiveErrors} 次）：${(error as Error).message}`);
      if (consecutiveErrors >= 5) {
        throw new StepFailure(def.title, `连续 ${consecutiveErrors} 次无法获取 agent 状态：${(error as Error).message}`);
      }
      await ctx.sleep(Math.min(60_000, 5_000 * consecutiveErrors));
      continue;
    }
    switch (outcome.status) {
      case "idle":
        return;
      case "timeout":
        continue;
      case "error":
        throw new StepFailure(def.title, `agent 报告错误：${outcome.error ?? "未知错误"}`);
      case "permission": {
        const fresh = outcome.pendingPermissions.filter((p) => !notifiedPermissions.has(p.id));
        if (fresh.length > 0) {
          for (const p of fresh) notifiedPermissions.add(p.id);
          await notifyOrigin(
            ctx,
            permissionMessage({ stepTitle: def.title, agentTitle, requests: fresh.map((p) => p.title) }),
          );
        }
        await ctx.sleep(ctx.config.permissionPollSeconds * 1000);
        continue;
      }
    }
  }
}

function readResultFile(file: string, def: StepDef) {
  if (!fs.existsSync(file)) return { ok: false as const, error: "结果文件不存在" };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false as const, error: `结果文件不是合法的 JSON（${(error as Error).message}）` };
  }
  return validateResult(def.result, raw);
}

async function runStep(
  ctx: PipelineContext,
  id: StepId,
  round: number | null = null,
  maxRounds: number | null = null,
): Promise<Record<string, unknown>> {
  const def = STEPS[id];
  const key = stepKey(id, round);
  const cached = ctx.state.results[key];
  if (cached) {
    ctx.log(`跳过 ${key}：沿用上次运行的结果 ${JSON.stringify(cached)}`);
    return cached;
  }

  const resultRel = `${ctx.featureDir}/.pipeline/results/${key}.json`;
  const resultAbs = path.join(ctx.repo, resultRel);
  fs.rmSync(resultAbs, { force: true });

  const agentTitle = `[${featureName(ctx.featureDir)}] ${def.number}-${def.title}${round !== null && round > 1 ? ` 第${round}轮` : ""}`;
  const record: StepRecord = {
    key,
    stepId: id,
    round,
    attempt: ctx.state.attempt,
    agentId: "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    outcome: "running",
    followUps: 0,
    result: null,
    error: null,
  };
  ctx.log(`开始 ${key}（${def.title}）`);

  try {
    const agent = await ctx.runtime.startAgent({
      role: def.role,
      title: agentTitle,
      prompt: buildPrompt(ctx, def, round, maxRounds, resultRel),
      cwd: ctx.repo,
      labels: {
        "requirement-pipeline": featureName(ctx.featureDir),
        "pipeline-step": key,
      },
      parentAgentId: ctx.config.attachToOriginChat ? ctx.state.originAgentId : null,
    });
    record.agentId = agent.id;
    ctx.state.history.push(record);
    save(ctx);

    const deadline = Date.now() + ctx.config.stepTimeoutMinutes[id] * 60_000;
    await waitForTurn(ctx, agent, def, agentTitle, deadline);
    let validation = readResultFile(resultAbs, def);
    while (!validation.ok && record.followUps < ctx.config.resultFollowUps) {
      record.followUps += 1;
      save(ctx);
      ctx.log(`${key} 的结果无效（${validation.error}），第 ${record.followUps} 次提醒 agent`);
      await agent.followUp(resultFollowUp({ resultFile: resultAbs, problem: validation.error }));
      await waitForTurn(ctx, agent, def, agentTitle, deadline);
      validation = readResultFile(resultAbs, def);
    }
    if (!validation.ok) {
      throw new StepFailure(def.title, `提醒 ${record.followUps} 次后仍没有得到有效的结果文件：${validation.error}`);
    }

    record.outcome = "completed";
    record.endedAt = new Date().toISOString();
    record.result = validation.value;
    ctx.state.results[key] = validation.value;
    save(ctx);
    ctx.log(`完成 ${key}：${JSON.stringify(validation.value)}`);
    if (ctx.config.archiveStepAgents) {
      await agent.archive().catch((error: Error) => ctx.log(`归档 ${agentTitle} 失败：${error.message}`));
    }
    return validation.value;
  } catch (error) {
    record.outcome = "failed";
    record.endedAt = new Date().toISOString();
    record.error = (error as Error).message;
    if (!ctx.state.history.includes(record)) ctx.state.history.push(record);
    save(ctx);
    if (error instanceof StepFailure) throw error;
    throw new StepFailure(def.title, (error as Error).message);
  }
}

/** Steps 3–11. Loop rounds and optional steps come from the run's profile. */
async function flow(ctx: PipelineContext): Promise<Record<string, unknown>> {
  const settings = ctx.config.profiles[ctx.state.profile];
  const rounds = settings.rounds;

  const design = await runStep(ctx, "design");

  let designRounds = 0;
  for (let r = 1; r <= rounds.designReview; r++) {
    const review = await runStep(ctx, "design_review", r, rounds.designReview);
    designRounds = r;
    if (review.verdict === "approved") break;
    if (review.verdict === "blocked") throw new BusinessDecisionNeeded(review.questions as string[]);
    // changes_required. The last round's revision goes straight to implementation;
    // the implementer reads both the review and the revision record.
    await runStep(ctx, "design_revise", r, rounds.designReview);
  }
  await milestone(
    ctx,
    "design-settled",
    `技术方案已经确定（审核 ${designRounds} 轮），开始写代码。写代码和代码检查通常是整个过程中最耗时的部分。`,
  );

  await runStep(ctx, "implement");

  for (let r = 1; r <= rounds.codeReview; r++) {
    const review = await runStep(ctx, "code_review", r, rounds.codeReview);
    if (review.verdict === "pass") break;
    await runStep(ctx, "review_fix", r, rounds.codeReview);
  }
  await milestone(ctx, "code-reviewed", "代码已经写完并通过检查，开始按验收标准逐条验证功能。");

  if (design.has_runnable_service === true && settings.serviceStart) {
    await runStep(ctx, "service_start");
  } else if (design.has_runnable_service === true) {
    ctx.log(`${PROFILE_LABELS[ctx.state.profile]}档不执行服务启动验证，由功能验证一并处理。`);
  } else {
    ctx.log("方案设计判断项目没有常驻服务，跳过服务启动验证。");
  }

  const verification = await runStep(ctx, "verify");
  if (verification.result === "defects_found") {
    await milestone(
      ctx,
      "fixing-defects",
      `验证中发现了一些问题，正在修复并重新验证（最多 ${rounds.defectFix} 轮）。`,
    );
    for (let r = 1; r <= rounds.defectFix; r++) {
      await runStep(ctx, "defect_fix", r, rounds.defectFix);
      const recheck = await runStep(ctx, "reverify", r, rounds.defectFix);
      if (recheck.result === "pass") break;
    }
  }

  return runStep(ctx, "report");
}

export async function runPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
  ctx.state.status = "running";
  ctx.state.stopReason = null;
  save(ctx);
  try {
    const report = await flow(ctx);
    ctx.state.status = "completed";
    ctx.state.outcome = report.outcome as string;
    save(ctx);
    await notifyOrigin(
      ctx,
      completedMessage({
        featureDir: ctx.featureDir,
        outcome: report.outcome as string,
        summary: report.summary as string,
        reportPath: `${ctx.featureDir}/report.md`,
      }),
    );
    return "completed";
  } catch (error) {
    if (error instanceof BusinessDecisionNeeded) {
      ctx.state.status = "waiting_for_business";
      ctx.state.stopReason = `方案审核需要业务决定：${error.questions.join("；")}`;
      save(ctx);
      await notifyOrigin(
        ctx,
        blockedMessage({ featureDir: ctx.featureDir, questions: error.questions, resumeCommand: ctx.resumeCommand }),
      );
      return "waiting_for_business";
    }
    const stepTitle = error instanceof StepFailure ? error.stepTitle : "流水线";
    ctx.state.status = "failed";
    ctx.state.stopReason = `${stepTitle}：${(error as Error).message}`;
    save(ctx);
    await notifyOrigin(
      ctx,
      failedMessage({
        stepTitle,
        reason: (error as Error).message,
        logPath: ctx.logPath,
        resumeCommand: ctx.resumeCommand,
      }),
    );
    return "failed";
  }
}
