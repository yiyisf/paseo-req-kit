import fs from "node:fs";
import path from "node:path";
import { type AgentProfile, PROFILE_LABELS, type PipelineConfig, type ReviewPanelMember } from "./config.js";
import {
  blockedMessage,
  completedMessage,
  failedMessage,
  milestoneMessage,
  permissionMessage,
  resultFollowUp,
} from "./messages.js";
import { kitVersion } from "./locations.js";
import { type AgentUsage, describeTotals, totals } from "./usage.js";
import { dispatchNotifiers, type NotifierEventType } from "./notifiers.js";
import { principlesSection, projectAdditions, type PromptLocations, readToolPrompt } from "./prompts.js";
import type { AgentRuntime, ManagedService, ServiceTarget, StepAgent } from "./runtime.js";
import { type PipelineState, type StepRecord, writeState } from "./state.js";
import { type PanelStep, STEPS, type StepDef, type StepId, stepKey, validateResult } from "./steps.js";

export interface PipelineContext {
  repo: string;
  featureDir: string;
  config: PipelineConfig;
  runtime: AgentRuntime;
  state: PipelineState;
  statePath: string;
  prompts: PromptLocations;
  logPath: string;
  resumeCommand: string;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Paseo-managed services of this run (filled in by the pipeline). */
  services?: { names: string[] | null | undefined; started: Set<string> };
  /** Paseo tools the step agents get; looked up once (undefined: not yet). */
  capabilities?: { paseoTools: boolean; browser: boolean } | null;
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

/**
 * Errors that usually go away by themselves: provider rate limits and overload,
 * dropped connections, a restarting daemon. A step that fails this way is started
 * again after a pause instead of stopping the whole run.
 */
const TRANSIENT_ERROR =
  /rate.?limit|too many requests|\b429\b|overload|\b5(?:02|03|04|29)\b|temporarily|unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|disconnect|连接|无法获取 agent 状态/i;

export function isTransientError(message: string): boolean {
  return TRANSIENT_ERROR.test(message);
}

class BusinessDecisionNeeded extends Error {
  constructor(public readonly questions: string[]) {
    super("需要需求方决定");
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

/** Extra material for one run of a step: panel member details, or the panel's findings to consolidate. */
interface StepExtras {
  key?: string;
  title?: string;
  profile?: AgentProfile;
  /** Appended as extra lines inside <pipeline-context>. */
  contextLines?: string[];
  /** Prompt sections appended after the step task (before project additions). */
  sections?: string[];
  /** Prompt file to quote as the review criteria (panel members). */
  criteriaFile?: string;
  /** Step whose project additions (steps/<id>.md) apply; defaults to the step itself. */
  additionsFor?: StepId;
}

function buildPrompt(
  ctx: PipelineContext,
  def: StepDef,
  round: number | null,
  maxRounds: number | null,
  resultFile: string,
  extras: StepExtras = {},
): string {
  const sources = { ...ctx.prompts, repo: ctx.repo };
  const profile = ctx.state.profile;
  const lines = [
    "<pipeline-context>",
    `仓库目录：${ctx.repo}`,
    `功能目录：${ctx.featureDir}`,
    def.id === "spec_review" ? "工作分支：（本步骤不提交）" : `工作分支：${ctx.state.branch ?? "（不是 git 仓库，不需要提交）"}`,
    `档位：${PROFILE_LABELS[profile]}${profile === "quick" ? "（小改动：各产物只写必要内容，保持简短）" : ""}`,
    `本步骤：${def.title}（流水线第 ${def.number} 步）`,
  ];
  if (round !== null && maxRounds !== null) lines.push(`轮次：第 ${round} 轮，最多 ${maxRounds} 轮`);
  const inc = ctx.state.incremental;
  if (inc) {
    lines.push(
      `增量继续：本次是第 ${ctx.state.attempt} 次尝试，接着第 ${inc.fromAttempt} 次的工作（${inc.reason}）`,
      `上一次是否已经写过代码：${inc.hadImplementation ? "是" : "否"}`,
      `本次开始时的提交：${inc.baseCommit ?? "（不是 git 仓库）"}`,
    );
  }
  if (extras.contextLines) lines.push(...extras.contextLines);
  lines.push(`结果文件：${resultFile}`, `结果文件绝对路径：${path.join(ctx.repo, resultFile)}`, "</pipeline-context>");
  const parts = [readToolPrompt(sources, "00-shared-context.md")];
  const principles = principlesSection(sources);
  if (principles) parts.push(principles);
  parts.push(readToolPrompt(sources, def.promptFile));
  if (ctx.state.incremental) parts.push(readToolPrompt(sources, "incremental.md"));
  if (extras.criteriaFile) {
    parts.push(
      [
        "# 评审标准（引用自该评审步骤的说明）",
        "",
        "下面是这一轮评审本来的完整说明，用来确定评审什么、怎么判断级别。其中关于写哪个产物文件、结果文件写什么、是否提交的要求不适用于你，以上一节\"评审小组成员\"的说明为准。",
        "",
        readToolPrompt(sources, extras.criteriaFile),
      ].join("\n"),
    );
  }
  if (extras.sections) parts.push(...extras.sections);
  const extra = projectAdditions(sources, extras.additionsFor ?? def.id);
  if (extra) parts.push(extra);
  parts.push(lines.join("\n"));
  return `${parts.join("\n\n")}\n`;
}

/**
 * The feature directory as the chat should see it: relative to its own directory normally,
 * absolute when the requirement is developed in a worktree created for it.
 */
function shownFeatureDir(ctx: PipelineContext): string {
  return ctx.state.worktree ? path.join(ctx.repo, ctx.featureDir).split(path.sep).join("/") : ctx.featureDir;
}

function specTitle(ctx: PipelineContext): string {
  try {
    const spec = fs.readFileSync(path.join(ctx.repo, ctx.featureDir, "spec.md"), "utf8");
    return /^#\s+(.+)$/m.exec(spec)?.[1]?.trim() ?? featureName(ctx.featureDir);
  } catch {
    return featureName(ctx.featureDir);
  }
}

/** Calls the configured external notifiers (e.g. an internal IM). Never throws. */
async function notifyExternal(ctx: PipelineContext, type: NotifierEventType, text: string, details: Record<string, unknown>): Promise<void> {
  if (ctx.config.notifiers.length === 0) return;
  await dispatchNotifiers(
    ctx.config.notifiers,
    {
      schema: 1,
      type,
      at: new Date().toISOString(),
      kitVersion: kitVersion(),
      feature: { dir: ctx.featureDir, name: featureName(ctx.featureDir), title: specTitle(ctx) },
      repo: ctx.repo,
      branch: ctx.state.branch,
      profile: ctx.state.profile,
      originAgentId: ctx.state.originAgentId,
      text,
      details,
    },
    ctx.log,
  );
}

/** Sends a progress note once per run attempt, when enabled. */
async function milestone(ctx: PipelineContext, id: string, text: string): Promise<void> {
  if (!ctx.config.notifyMilestones || ctx.state.milestones.includes(id)) return;
  ctx.state.milestones.push(id);
  save(ctx);
  await notifyOrigin(ctx, milestoneMessage(text));
  await notifyExternal(ctx, "milestone", text, { milestone: id });
}

async function waitForTurn(ctx: PipelineContext, agent: StepAgent, def: StepDef, agentTitle: string, deadline: number): Promise<AgentUsage | null> {
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
        return outcome.usage ?? null;
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
          await notifyExternal(ctx, "permission", `「${def.title}」步骤在等待权限批准，批准前会一直停在这里。`, {
            stepTitle: def.title,
            agentTitle,
            requests: fresh.map((p) => p.title),
          });
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

/**
 * Runs a step; a transient failure (see isTransientError) starts it again with a
 * fresh agent after a pause, up to config.retry.attempts more times.
 */
async function runStep(
  ctx: PipelineContext,
  id: StepId,
  round: number | null = null,
  maxRounds: number | null = null,
  extras: StepExtras = {},
): Promise<Record<string, unknown>> {
  const { attempts, backoffSeconds } = ctx.config.retry;
  for (let retry = 0; ; retry += 1) {
    try {
      return await runStepOnce(ctx, id, round, maxRounds, extras);
    } catch (error) {
      const message = (error as Error).message;
      if (!(error instanceof StepFailure) || !isTransientError(message) || retry >= attempts) {
        if (error instanceof StepFailure && retry > 0) {
          throw new StepFailure(error.stepTitle, `${message}（已自动重试 ${retry} 次）`);
        }
        throw error;
      }
      const wait = backoffSeconds.at(Math.min(retry, backoffSeconds.length - 1)) ?? 60;
      ctx.log(`${error.stepTitle} 遇到临时错误：${message}。${wait} 秒后自动重试（第 ${retry + 1} 次，最多 ${attempts} 次）`);
      await ctx.sleep(wait * 1000);
      extras = {
        ...extras,
        contextLines: [
          ...(extras.contextLines ?? []).filter((l) => !l.startsWith("自动重试：")),
          `自动重试：本步骤上一次因临时错误中断（${message.slice(0, 200)}）。工作区里可能留有上一次没做完的改动，先用 git status 和 git diff 查看，在此基础上继续，不要重复提交`,
        ],
      };
    }
  }
}

async function runStepOnce(
  ctx: PipelineContext,
  id: StepId,
  round: number | null,
  maxRounds: number | null,
  extras: StepExtras,
): Promise<Record<string, unknown>> {
  const def = STEPS[id];
  const key = extras.key ?? stepKey(id, round);
  const cached = ctx.state.results[key];
  if (cached) {
    ctx.log(`跳过 ${key}：沿用上次运行的结果 ${JSON.stringify(cached)}`);
    return cached;
  }

  const resultRel = `${ctx.featureDir}/.pipeline/results/${key}.json`;
  const resultAbs = path.join(ctx.repo, resultRel);
  fs.rmSync(resultAbs, { force: true });

  const managed = mergeExtras(await serviceExtras(ctx, id), await browserExtras(ctx, id));
  if (managed) {
    extras = {
      ...extras,
      contextLines: [...(extras.contextLines ?? []), ...managed.contextLines],
      sections: [...(extras.sections ?? []), ...managed.sections],
    };
  }

  const agentTitle =
    `[${featureName(ctx.featureDir)}] ` +
    (extras.title ?? `${def.number}-${def.title}${round !== null && round > 1 ? ` 第${round}轮` : ""}`);
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
      prompt: buildPrompt(ctx, def, round, maxRounds, resultRel, extras),
      cwd: ctx.repo,
      labels: {
        "requirement-pipeline": featureName(ctx.featureDir),
        "pipeline-step": key,
      },
      parentAgentId: ctx.config.attachToOriginChat ? ctx.state.originAgentId : null,
      // Always passed: the run's config has Paseo profile names resolved; the runtime's may not.
      profile: extras.profile ?? ctx.config.agents[def.role],
      workspaceId: ctx.state.worktree?.workspaceId ?? null,
    });
    record.agentId = agent.id;
    ctx.state.history.push(record);
    save(ctx);

    const deadline = Date.now() + ctx.config.stepTimeoutMinutes[id] * 60_000;
    record.usage = (await waitForTurn(ctx, agent, def, agentTitle, deadline)) ?? record.usage ?? null;
    let validation = readResultFile(resultAbs, def);
    while (!validation.ok && record.followUps < ctx.config.resultFollowUps) {
      record.followUps += 1;
      save(ctx);
      ctx.log(`${key} 的结果无效（${validation.error}），第 ${record.followUps} 次提醒 agent`);
      await agent.followUp(resultFollowUp({ resultFile: resultAbs, problem: validation.error }));
      record.usage = (await waitForTurn(ctx, agent, def, agentTitle, deadline)) ?? record.usage ?? null;
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

function mergeExtras(
  a: { contextLines: string[]; sections: string[] } | null,
  b: { contextLines: string[]; sections: string[] } | null,
): { contextLines: string[]; sections: string[] } | null {
  if (!a && !b) return null;
  return { contextLines: [...(a?.contextLines ?? []), ...(b?.contextLines ?? [])], sections: [...(a?.sections ?? []), ...(b?.sections ?? [])] };
}

/** Steps that check the result the way a user would. */
const BROWSER_STEPS: readonly StepId[] = ["verify", "defect_fix", "reverify"];

/** Points verification at Paseo's built-in browser when the step agents have it. */
async function browserExtras(ctx: PipelineContext, id: StepId): Promise<{ contextLines: string[]; sections: string[] } | null> {
  if (!BROWSER_STEPS.includes(id) || ctx.config.browserVerify === "off") return null;
  if (ctx.capabilities === undefined) ctx.capabilities = await ctx.runtime.capabilities().catch(() => null);
  if (!ctx.capabilities?.browser) return null;
  return {
    contextLines: ["浏览器：可以用 Paseo 内置浏览器（browser_* 工具）验证网页界面"],
    sections: [readToolPrompt({ ...ctx.prompts, repo: ctx.repo }, "browser-verify.md")],
  };
}

/** Steps that need the project's services running. */
const SERVICE_STEPS: readonly StepId[] = ["service_start", "verify", "defect_fix", "reverify"];

function serviceState(ctx: PipelineContext): NonNullable<PipelineContext["services"]> {
  ctx.services ??= { names: undefined, started: new Set() };
  return ctx.services;
}

/** The workspace whose paseo.json services the steps use: the requirement's own worktree, or the chat's. */
function serviceTarget(ctx: PipelineContext): ServiceTarget | null {
  if (ctx.state.worktree) return { workspaceId: ctx.state.worktree.workspaceId };
  const origin = ctx.state.originAgentId;
  return origin && ctx.config.attachToOriginChat ? { agentId: origin } : null;
}

/** Service scripts from paseo.json that Paseo can run for this pipeline; null when not used. */
async function serviceNames(ctx: PipelineContext): Promise<string[] | null> {
  const state = serviceState(ctx);
  if (state.names !== undefined) return state.names;
  const target = serviceTarget(ctx);
  if (ctx.config.paseoServices === "off" || !target) {
    state.names = null;
    return null;
  }
  state.names = await ctx.runtime.listServices(target).catch(() => null);
  if (state.names) ctx.log(`项目在 paseo.json 中定义了服务（${state.names.join("、")}），服务启动和验证相关的步骤由流水线通过 Paseo 启动它们`);
  return state.names;
}

function describeService(s: ManagedService, logFile: string | null): string {
  const where = `${s.url ?? "（Paseo 没有给出地址）"}${s.port ? `（端口 ${s.port}）` : ""}`;
  const output = logFile ? `，最后的输出见 ${logFile}` : "";
  if (!s.running) return `Paseo 管理的服务：${s.name} 没有启动成功${s.exitCode !== null ? `（退出码 ${s.exitCode}）` : ""}${output}`;
  if (s.health === "unhealthy") return `Paseo 管理的服务：${s.name} → ${where}，已启动但健康检查没有通过${output}`;
  return `Paseo 管理的服务：${s.name} → ${where}，已启动${s.health === "healthy" ? "，健康检查通过" : ""}`;
}

/** Starts the services (fresh, with the current code) before a step that needs them. */
async function serviceExtras(ctx: PipelineContext, id: StepId): Promise<{ contextLines: string[]; sections: string[] } | null> {
  if (!SERVICE_STEPS.includes(id)) return null;
  const names = await serviceNames(ctx);
  const target = serviceTarget(ctx);
  if (!names || !target) return null;
  const sections = [readToolPrompt({ ...ctx.prompts, repo: ctx.repo }, "paseo-services.md")];
  let services: ManagedService[];
  try {
    services = await ctx.runtime.startServices(target, names, ctx.config.serviceReadySeconds * 1000);
  } catch (error) {
    ctx.log(`通过 Paseo 启动服务失败：${(error as Error).message}`);
    return {
      contextLines: [`Paseo 管理的服务：这次没能通过 Paseo 启动（${(error as Error).message}），请按验证方法或 service-start.md 自己启动，用完关掉`],
      sections: [],
    };
  }
  for (const name of names) serviceState(ctx).started.add(name);
  const dir = path.join(ctx.repo, ctx.featureDir, ".pipeline", "services");
  const lines = services.map((s) => {
    let logFile: string | null = null;
    if (s.output && (!s.running || s.health === "unhealthy")) {
      fs.mkdirSync(dir, { recursive: true });
      logFile = `${ctx.featureDir}/.pipeline/services/${s.name}.log`;
      fs.writeFileSync(path.join(ctx.repo, logFile), `${s.output}\n`);
    }
    return describeService(s, logFile);
  });
  ctx.log(lines.join("；"));
  return { contextLines: lines, sections };
}

async function stopManagedServices(ctx: PipelineContext): Promise<void> {
  const started = [...(ctx.services?.started ?? [])];
  const target = serviceTarget(ctx);
  if (started.length === 0 || !target) return;
  await ctx.runtime.stopServices(target, started).catch((error: Error) => ctx.log(`停止服务失败：${error.message}`));
  ctx.services?.started.clear();
  ctx.log(`已停止 Paseo 管理的服务：${started.join("、")}`);
}

/** Warns once at the start when a provider's subscription is nearly used up. Never blocks. */
async function checkQuota(ctx: PipelineContext): Promise<void> {
  const threshold = ctx.config.quotaWarnPercent;
  if (threshold <= 0) return;
  const profiles = [ctx.config.agents.builder, ctx.config.agents.reviewer];
  if (ctx.config.reviewPanel.enabled && ctx.config.reviewPanel.profiles.includes(ctx.state.profile)) profiles.push(...ctx.config.reviewPanel.members);
  const providers = [...new Set(profiles.map((p) => (p.provider ?? "").split("/")[0]).filter(Boolean))];
  const quotas = await ctx.runtime.providerQuota(providers).catch(() => null);
  if (!quotas) return;
  const tight = quotas.filter((q) => (q.usedPct !== null && q.usedPct >= threshold) || q.tone === "danger");
  if (tight.length === 0) {
    ctx.log(`额度：${quotas.map((q) => `${q.displayName} ${q.window} ${q.usedPct === null ? "?" : `${Math.round(q.usedPct)}%`}`).join("，")}`);
    return;
  }
  const items = tight.map((q) => {
    const reset = q.resetsAt ? `，${new Date(q.resetsAt).toLocaleString("zh-CN", { hour12: false })} 恢复` : "";
    return `${q.displayName} 的「${q.window}」额度已用 ${q.usedPct === null ? "大部分" : `${Math.round(q.usedPct)}%`}${reset}`;
  });
  await notifyOrigin(
    ctx,
    [
      "【需求开发流水线通知】这条消息来自后台流水线，不是用户发的。",
      `额度提醒：${items.join("；")}。`,
      "流水线照常进行；额度用完时会遇到限流，流水线会自动等待重试，重试用完会中断，之后可以继续。如果希望等额度恢复后再开发，请转告用户，用户同意的话可以先暂停。",
    ].join("\n"),
  );
}

function panelApplies(ctx: PipelineContext, step: PanelStep, round: number): boolean {
  const panel = ctx.config.reviewPanel;
  return panel.enabled && round === 1 && panel.steps.includes(step) && panel.profiles.includes(ctx.state.profile);
}

const PANEL_OUTPUT: Record<PanelStep, string> = { design_review: "design-review.md", code_review: "code-review.md" };

function memberName(member: ReviewPanelMember, index: number): string {
  return member.name?.trim() || `成员 ${index + 1}`;
}

/**
 * Runs the panel members of one review in parallel. Returns the findings files
 * (relative to the repository) of the members that finished; a member that fails
 * is logged and left out. Fails only when no member finishes.
 */
async function runPanel(ctx: PipelineContext, step: PanelStep, round: number): Promise<string[]> {
  const members = ctx.config.reviewPanel.members;
  const stepTitle = STEPS[step].title;
  const runs = members.map((member, i) => {
    const key = `${step}-r${round}-p${i + 1}`;
    const findings = `${ctx.featureDir}/review-panel/${key}.md`;
    const name = memberName(member, i);
    const contextLines = [
      `评审小组：${stepTitle}，第 ${round} 轮，${name}（共 ${members.length} 位）`,
      `你的意见文件：${findings}`,
      `你的意见文件绝对路径：${path.join(ctx.repo, findings)}`,
    ];
    if (member.focus) contextLines.push(`你的关注重点：${member.focus}`);
    return runStep(ctx, "panel_review", round, null, {
      key,
      title: `${STEPS[step].number}-${stepTitle} 评审小组·${name}`,
      profile: member,
      contextLines,
      criteriaFile: STEPS[step].promptFile,
      additionsFor: step,
    }).then(() => findings);
  });
  const settled = await Promise.allSettled(runs);
  const done: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") done.push(outcome.value);
    else ctx.log(`评审小组${memberName(members[i], i)}没有完成，汇总时不包含它的意见：${(outcome.reason as Error).message}`);
  });
  if (done.length === 0) {
    const first = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    throw first?.reason instanceof StepFailure ? first.reason : new StepFailure(stepTitle, "评审小组的成员都没有完成");
  }
  return done;
}

function consolidationSection(step: PanelStep, findings: string[], total: number): string {
  return [
    "# 评审小组的意见",
    "",
    `这一轮先由 ${total} 位评审者各自独立评审${findings.length < total ? `（其中 ${total - findings.length} 位没有完成，只有下面 ${findings.length} 份）` : ""}，意见文件如下。你负责核实并汇总，再按上文的要求完成本步骤：`,
    "",
    ...findings.map((f) => `- \`${f}\``),
    "",
    "做法：",
    "1. 逐条读完所有意见。不同成员说的是同一个问题的，合并为一条。",
    "2. 每条都亲自核实（读代码、对照 spec、能运行的就运行），然后归入四类之一：",
    "   - **必须修改**：成立，且属于\"阻塞\"或\"重要\"。按上文的格式写进评审意见，参与结论判断。",
    "   - **建议修改**：成立，但属于\"建议\"。",
    "   - **留给人决定**：涉及需求取舍、只有需求方或开发同事能判断的。在 `decisions.tsv` 中记一行，`needs_human` 为 `yes`。",
    "   - **已驳回**：核实后不成立。写明依据，并在 `decisions.tsv` 中记一行，`kind` 为 `驳回意见`。",
    `3. 在 \`${PANEL_OUTPUT[step]}\` 中增加\"评审小组意见汇总\"一节，表格列出每条原始意见：来源成员、意见摘要、归类、理由。被驳回的也要列出，最终报告会展示它们。`,
    "4. 结论和结果文件只根据你核实后的\"必须修改\"判断，不按成员的数量投票。",
  ].join("\n");
}

function proposalsApply(ctx: PipelineContext): boolean {
  const p = ctx.config.designProposals;
  // A continuation after a change only touches what changed; one designer is enough.
  return p.enabled && p.profiles.includes(ctx.state.profile) && !ctx.state.incremental;
}

function proposalMembers(ctx: PipelineContext): ReviewPanelMember[] {
  const members = ctx.config.designProposals.members;
  if (members.length > 0) return members;
  return [
    { ...ctx.config.agents.builder, name: "builder" },
    { ...ctx.config.agents.reviewer, name: "reviewer" },
  ];
}

/**
 * Several agents propose a design in parallel (no code changes, no commits); returns the
 * proposal files of those that finished. The design step then compares and decides.
 */
async function runProposals(ctx: PipelineContext): Promise<string[]> {
  const members = proposalMembers(ctx);
  const runs = members.map((member, i) => {
    const key = `design_proposal-p${i + 1}`;
    const file = `${ctx.featureDir}/design-proposals/${key}.md`;
    const name = memberName(member, i);
    const contextLines = [
      `方案提案：${name}（共 ${members.length} 份，各自独立完成）`,
      `你的提案文件：${file}`,
      `你的提案文件绝对路径：${path.join(ctx.repo, file)}`,
    ];
    if (member.focus) contextLines.push(`你的关注重点：${member.focus}`);
    return runStep(ctx, "design_proposal", null, null, {
      key,
      title: `3-方案提案·${name}`,
      profile: member,
      contextLines,
      additionsFor: "design",
    }).then(() => file);
  });
  const settled = await Promise.allSettled(runs);
  const done: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") done.push(outcome.value);
    else ctx.log(`方案提案·${memberName(members[i], i)}没有完成，方案设计时不包含它：${(outcome.reason as Error).message}`);
  });
  return done;
}

function proposalsSection(files: string[], total: number): string {
  return [
    "# 方案提案",
    "",
    `这一次先由 ${total} 个 agent 各自独立提出了方案${files.length < total ? `（其中 ${total - files.length} 份没有完成，只有下面 ${files.length} 份）` : ""}：`,
    "",
    ...files.map((f) => `- \`${f}\``),
    "",
    "你负责比较并做出决定，再按上文的要求写 `design.md`：",
    "1. 逐份读完，对照 spec 和代码核实其中的判断，不要只看结论。",
    "2. 选择一份为基础，或者把各份中更好的部分合并起来。不要为了合并而合并，取舍要有理由。",
    "3. 在 `design.md` 中增加\"方案比较\"一节：一张表列出各提案的思路、优点、风险、改动范围，写明最后的选择和理由，以及放弃了什么。",
    "4. 会影响需求方能看到的行为、成本或时间的取舍，在 `decisions.tsv` 中记一行，`needs_human` 为 `yes`。",
  ].join("\n");
}

/** One review round; with a panel in the first round, members review first and this step consolidates. */
async function runReview(ctx: PipelineContext, step: PanelStep, round: number, maxRounds: number): Promise<Record<string, unknown>> {
  if (!panelApplies(ctx, step, round)) return runStep(ctx, step, round, maxRounds);
  const findings = await runPanel(ctx, step, round);
  return runStep(ctx, step, round, maxRounds, {
    sections: [consolidationSection(step, findings, ctx.config.reviewPanel.members.length)],
  });
}

/** Runs one step outside the pipeline's flow (the spec review started from the chat). */
export async function runSingleStep(ctx: PipelineContext, id: StepId, extras: StepExtras = {}): Promise<Record<string, unknown>> {
  try {
    return await runStep(ctx, id, null, null, extras);
  } catch (error) {
    throw new Error((error as Error).message);
  }
}

/** Steps 3–11. Loop rounds and optional steps come from the run's profile. */
async function flow(ctx: PipelineContext): Promise<Record<string, unknown>> {
  const settings = ctx.config.profiles[ctx.state.profile];
  const rounds = settings.rounds;

  let designExtras: StepExtras = {};
  if (proposalsApply(ctx) && !ctx.state.results.design) {
    const files = await runProposals(ctx);
    if (files.length > 0) designExtras = { sections: [proposalsSection(files, proposalMembers(ctx).length)] };
    else ctx.log("方案提案都没有完成，按原来的方式由一个 agent 做方案设计");
  }
  const design = await runStep(ctx, "design", null, null, designExtras);

  let designRounds = 0;
  for (let r = 1; r <= rounds.designReview; r++) {
    const review = await runReview(ctx, "design_review", r, rounds.designReview);
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
    const review = await runReview(ctx, "code_review", r, rounds.codeReview);
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

  const thisAttempt = ctx.state.history.filter((h) => h.attempt === ctx.state.attempt);
  const allAttempts = ctx.state.history;
  const usageLines = [`用时与用量（本次尝试，截至报告前）：${describeTotals(totals(thisAttempt))}`];
  if (ctx.state.attempt > 1) usageLines.push(`用时与用量（这个需求的全部尝试）：${describeTotals(totals(allAttempts))}`);
  await stopManagedServices(ctx);
  return runStep(ctx, "report", null, null, { contextLines: usageLines });
}

export async function runPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
  ctx.state.status = "running";
  ctx.state.stopReason = null;
  save(ctx);
  try {
    await checkQuota(ctx);
    const report = await flow(ctx);
    ctx.state.status = "completed";
    ctx.state.outcome = report.outcome as string;
    save(ctx);
    await notifyOrigin(
      ctx,
      completedMessage({
        featureDir: shownFeatureDir(ctx),
        outcome: report.outcome as string,
        summary: report.summary as string,
        reportPath: `${shownFeatureDir(ctx)}/report.md`,
      }),
    );
    const outcomeText: Record<string, string> = {
      completed: "已完成，可以验收",
      completed_with_issues: "已完成，但有遗留问题",
      not_completed: "未完成",
    };
    await notifyExternal(ctx, "completed", `开发流水线已结束：${outcomeText[report.outcome as string] ?? report.outcome}。`, {
      outcome: report.outcome,
      summary: report.summary,
      reportPath: `${ctx.featureDir}/report.md`,
    });
    return "completed";
  } catch (error) {
    if (error instanceof BusinessDecisionNeeded) {
      ctx.state.status = "waiting_for_business";
      ctx.state.stopReason = `方案审核需要需求方决定：${error.questions.join("；")}`;
      save(ctx);
      await notifyOrigin(
        ctx,
        blockedMessage({ featureDir: shownFeatureDir(ctx), questions: error.questions, resumeCommand: ctx.resumeCommand }),
      );
      await notifyExternal(ctx, "blocked", `方案审核发现 ${error.questions.length} 个需要需求方决定的问题，流水线已暂停，请到发起的对话中回答。`, {
        questions: error.questions,
        resumeCommand: ctx.resumeCommand,
      });
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
    await notifyExternal(ctx, "failed", `开发流水线在「${stepTitle}」步骤中断：${(error as Error).message}`, {
      stepTitle,
      reason: (error as Error).message,
      logPath: ctx.logPath,
      resumeCommand: ctx.resumeCommand,
    });
    return "failed";
  } finally {
    await stopManagedServices(ctx);
  }
}
