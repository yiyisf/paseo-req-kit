import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentProfile,
  PHASE_MODE_LABELS,
  PROFILE_LABELS,
  type PipelineConfig,
  REQUIREMENT_TYPE_LABELS,
  resolveRelatedRepo,
  type ReviewPanelMember,
} from "./config.js";
import { changedFiles, changedSince, checkApplies, headCommit, logName, matchesPath, runCheck, tail } from "./gate.js";
import { activeJoint, ensureJointRepos, loadProjectChecks, type StepTarget, syncJointDocs } from "./joint.js";
import { playbookSection, promptSections, stepTitle } from "./playbooks.js";
import {
  approvalContinuePrompt,
  approvalMessage,
  approvalReminderMessage,
  autoResumePrompt,
  blockedMessage,
  gateFollowUp,
  waitingReminderMessage,
  completedMessage,
  failedMessage,
  phaseDoneMessage,
  phaseWaitingReminderMessage,
  verifyStartPrompt,
  milestoneMessage,
  permissionMessage,
  resultFollowUp,
} from "./messages.js";
import { KIT_ROOT, kitVersion } from "./locations.js";
import { type AgentUsage, describeTotals, totals } from "./usage.js";
import { dispatchNotifiers, type NotifierEventType, peopleOf } from "./notifiers.js";
import { describeExternal, type IntegrationEvent, renderArgs, resolveCommand, type Runner, syncIntegration } from "./integrations.js";
import { cardSlug, planAppendix, publishCard, readSource } from "./card.js";
import { principlesSection, projectAdditions, type PromptLocations, readToolPrompt } from "./prompts.js";
import type { AgentRuntime, ManagedService, ServiceTarget, StepAgent, WaitOutcome } from "./runtime.js";
import { type CheckOutcome, type GateRun, type JointRepo, type PhaseName, type PipelineState, type Recovery, type RunPhases, type StepRecord, type StopKind, writeState } from "./state.js";
import { type PanelStep, STEPS, type StepDef, type StepId, stepKey, validateResult, VERIFY_PHASE_STEPS } from "./steps.js";

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
  /** Command to see progress; used in prompts that Paseo schedules send to the chat. */
  statusCommand?: string;
  /** Command that starts the verify phase (gated runs). */
  verifyCommand?: string;
  /** Command that confirms a design waiting at the confirmation point. */
  approveCommand?: string;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Runs integration commands; tests replace it. Default: the real command line. */
  integrationRunner?: Runner;
  /** Paseo-managed services of this run (filled in by the pipeline). */
  services?: { names: string[] | null | undefined; started: Set<string> };
  /** Paseo tools the step agents get; looked up once (undefined: not yet). */
  capabilities?: { paseoTools: boolean; browser: boolean } | null;
  /** Related repositories found on this machine, looked up once (undefined: not yet). */
  related?: Array<{ name: string; dir: string; role: string | null; ref: string | null }>;
  /** Joint requirement: the related repositories the spec says this requirement also changes. */
  jointNames?: string[];
  /** Paseo-managed services started in the joint repositories' worktrees, by workspace. */
  jointServices?: Map<string, string[]>;
  /** Quality-gate checks of the joint repositories, read once. */
  jointChecksCache?: Map<string, PipelineConfig["checks"]>;
}

export type PipelineOutcome = "completed" | "waiting_for_business" | "failed" | "phase_done" | "waiting_for_approval";

/** The develop phase is done and the run stops at the gate (phases.mode "gated"). */
class PhaseGate extends Error {
  constructor() {
    super("研发完成，待测试验证");
    this.name = "PhaseGate";
  }
}

/** The design waits for the requester's confirmation before any code is written (designApproval). */
class ApprovalNeeded extends Error {
  constructor() {
    super("方案等待需求方确认");
    this.name = "ApprovalNeeded";
  }
}

const DEFAULT_PHASES: RunPhases = { mode: "continuous", environment: "local", defects: "fix" };

export function runPhases(state: Pick<PipelineState, "phases">): RunPhases {
  return state.phases ?? DEFAULT_PHASES;
}

const ENVIRONMENT_TEXT = { local: "本地启动服务验证", deployed: "已部署的测试环境（见 test-env.md）" } as const;
const DEFECTS_TEXT = { fix: "当场修复并复验", handback: "只记录，退回研发阶段修复后再提测", report: "只记录，不修复" } as const;

function phaseOf(ctx: PipelineContext): PhaseName {
  return ctx.state.phase ?? "develop";
}

function verifyCommandOf(ctx: PipelineContext): string {
  return ctx.verifyCommand ?? `${ctx.resumeCommand} --phase verify`;
}

function approveCommandOf(ctx: PipelineContext): string {
  return ctx.approveCommand ?? ctx.resumeCommand.replace(/ --resume$/, " --approve");
}

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

/** The step gave up on its agent while the agent may still be working (1.11). */
class AgentLeftRunning extends StepFailure {
  constructor(
    stepTitle: string,
    message: string,
    readonly timedOut: boolean,
  ) {
    super(stepTitle, message);
  }
}

/** The agent's turn ended with an error status (1.12). */
class AgentErrored extends StepFailure {}

/** The agent did not write a valid result file, even after the reminders (1.12). */
class ResultInvalid extends StepFailure {}

/** Notes something the pipeline handled by itself (state.recoveries, the log). */
function recover(ctx: PipelineContext, key: string, kind: Recovery["kind"], detail: string): void {
  ctx.state.recoveries = [...(ctx.state.recoveries ?? []), { at: new Date().toISOString(), key, kind, detail: detail.slice(0, 300) }].slice(-200);
  save(ctx);
  ctx.log(`自动处理（${key}）：${detail}`);
}

/** Why a run stopped, as a code for the usage record (1.12). */
function failureKind(error: unknown): StopKind {
  if (error instanceof AgentLeftRunning) return error.timedOut ? "timeout" : "transient";
  const message = (error as Error).message ?? "";
  if (error instanceof StepFailure && isTransientError(message)) return "transient";
  if (error instanceof AgentErrored) return "agent_error";
  if (error instanceof ResultInvalid) return "invalid_result";
  return "other";
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

/** 1.13: the requirement used its token budget (config budget); stops before the next step. */
class BudgetReached extends Error {
  constructor(
    public readonly used: number,
    public readonly allowance: number,
  ) {
    super(`token 用量 ${tokenText(used)} 已到预算 ${tokenText(allowance)}`);
    this.name = "BudgetReached";
  }
}

function tokenText(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000) / 10} 万` : String(n);
}

/** Tokens (input + output) of every step of the requirement so far, all attempts. */
export function tokensUsed(state: Pick<PipelineState, "history">): number {
  return state.history.reduce((sum, h) => sum + (h.usage?.inputTokens ?? 0) + (h.usage?.outputTokens ?? 0), 0);
}

/**
 * Before a new step agent starts: warns once per budget level at warnPercent, and stops at the
 * allowance (the step that crossed it is finished, the next one waits for a person).
 */
async function checkBudget(ctx: PipelineContext, stepTitle: string): Promise<void> {
  const limit = ctx.config.budget.tokens;
  if (limit === null) return;
  const budget = (ctx.state.budget ??= { allowance: limit, warnedAt: null });
  const used = tokensUsed(ctx.state);
  if (used >= budget.allowance) throw new BudgetReached(used, budget.allowance);
  if (used >= (budget.allowance * ctx.config.budget.warnPercent) / 100 && budget.warnedAt !== budget.allowance) {
    budget.warnedAt = budget.allowance;
    save(ctx);
    const text = `【需求开发流水线通知】${shownFeatureDir(ctx)} 已用 ${tokenText(used)} tokens，到了预算 ${tokenText(budget.allowance)} 的 ${Math.round((used / budget.allowance) * 100)}%。流水线继续（下一步：${stepTitle}）；用完预算时会做完当前步骤后停下等你决定。这条消息只是告知，不需要处理。`;
    await notifyOrigin(ctx, text);
    await notifyExternal(ctx, "milestone", `需求 ${featureName(ctx.featureDir)} 的 token 用量已到预算的 ${ctx.config.budget.warnPercent}%`, { used, budget: budget.allowance });
  }
}

class BusinessDecisionNeeded extends Error {
  constructor(
    public readonly questions: string[],
    /** "reproduce": a defect that could not be reproduced. */
    public readonly source: "design_review" | "reproduce" = "design_review",
  ) {
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
  /** Run the quality gate after the step, sending new failures back to its agent (code-changing steps). */
  gate?: boolean;
  /** Run in one of the joint repositories instead of this one. */
  target?: StepTarget;
}

/** The joint repositories this run works in (empty: an ordinary requirement). */
function jointTargets(ctx: PipelineContext): StepTarget[] {
  return activeJoint(ctx.state, ctx.jointNames ?? []).map((j) => ({
    name: j.name,
    slug: j.slug,
    repo: j.repo,
    featureDir: ctx.featureDir,
    workspaceId: j.workspaceId,
    branch: j.branch,
    joint: j,
  }));
}

/** A step key for a joint repository: "implement@backend", "code_review-r2@backend". */
function keyFor(base: string, target: StepTarget | undefined): string {
  return target ? `${base}@${target.slug}` : base;
}

/** The step as this requirement sees it: a playbook may rename it (e.g. 方案设计 → 复现与定位). */
function stepDef(ctx: PipelineContext, id: StepId): StepDef {
  return { ...STEPS[id], title: stepTitle(ctx.state.type, id) };
}

/** Related repositories that exist on this machine, with the branch and commit they are at. */
function relatedRepos(ctx: PipelineContext): NonNullable<PipelineContext["related"]> {
  if (ctx.related) return ctx.related;
  const projectDir = ctx.state.worktree?.sourceRepo ?? ctx.repo;
  ctx.related = [];
  const joint = ctx.jointNames ?? [];
  for (const r of ctx.config.relatedRepos) {
    // A repository this requirement changes is not a read-only reference: it has its own worktree.
    if (joint.includes(r.name)) continue;
    const dir = resolveRelatedRepo(r, projectDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      ctx.log(`关联仓库「${r.name}」不在这台机器上（${dir}），步骤看不到它`);
      continue;
    }
    let ref: string | null = null;
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      ref = `分支 ${branch}，提交 ${commit}`;
    } catch {
      // Not a git repository: still readable.
    }
    ctx.related.push({ name: r.name, dir, role: r.role?.trim() || null, ref });
  }
  if (ctx.related.length > 0) ctx.log(`关联仓库（只读）：${ctx.related.map((r) => `${r.name} ${r.dir}${r.ref ? `（${r.ref}）` : ""}`).join("；")}`);
  return ctx.related;
}

function buildPrompt(
  ctx: PipelineContext,
  def: StepDef,
  round: number | null,
  maxRounds: number | null,
  resultFile: string,
  extras: StepExtras = {},
): string {
  const target = extras.target;
  const stepRepo = target?.repo ?? ctx.repo;
  // A joint repository's own project notes, verify.md and step additions apply to its steps.
  const sources = { ...ctx.prompts, repo: stepRepo };
  const profile = ctx.state.profile;
  const branch = target ? target.branch : ctx.state.branch;
  const lines = [
    "<pipeline-context>",
    `仓库目录：${stepRepo}`,
    `功能目录：${ctx.featureDir}`,
    def.id === "spec_review" ? "工作分支：（本步骤不提交）" : `工作分支：${branch ?? "（不是 git 仓库，不需要提交）"}`,
    `档位：${PROFILE_LABELS[profile]}${profile === "quick" ? "（小改动：各产物只写必要内容，保持简短）" : ""}`,
    `本步骤：${def.title}（流水线第 ${def.number} 步）`,
  ];
  if (round !== null && maxRounds !== null) lines.push(`轮次：第 ${round} 轮，最多 ${maxRounds} 轮`);
  const type = ctx.state.type ?? null;
  if (type) lines.push(`需求类型：${REQUIREMENT_TYPE_LABELS[type]}（按下文"本需求类型的做法"进行）`);
  const joint = jointTargets(ctx);
  if (joint.length > 0 && target) {
    lines.push(
      `联合需求：本步骤在「${target.name}」仓库中进行（${target.repo}，分支 ${target.branch}）`,
      `联合需求的主仓库：${ctx.repo}（需求说明、方案、接口约定的原件在 ${path.join(ctx.repo, ctx.featureDir)}，本仓库功能目录中的是同步过来的副本）`,
    );
  } else if (joint.length > 0) {
    lines.push(`联合需求：本需求同时改 ${joint.length + 1} 个仓库，本仓库是主仓库（${ctx.repo}，分支 ${ctx.state.branch ?? "无"}）`);
    for (const t of joint) lines.push(`联合需求的仓库：${t.name} → ${t.repo}（分支 ${t.branch}）`);
  }
  const planning: readonly StepId[] = ["design", "design_proposal", "design_review", "design_revise"];
  if (planning.includes(def.id) && type !== "assessment") {
    lines.push(
      joint.length > 0
        ? "切片：联合需求每个仓库由一个 agent 实现，不按切片；实施计划按仓库分开列出任务"
        : ctx.config.slices.profiles.includes(profile) && ctx.config.slices.max >= 2
          ? `切片上限：${ctx.config.slices.max} 片（实施计划分成多片时，按片逐个实现）`
          : "切片：本次不按切片实现，实施计划按任务列出即可",
    );
  }
  const approval = approvalMode(ctx);
  if (approval && (def.id === "design" || def.id === "design_revise" || def.id === "design_review")) {
    lines.push(
      approval === "always"
        ? "方案确认点：开启。方案审核通过后，需求方先看 preview.md 再决定是否开始写代码"
        : "方案确认点：界面改动时开启。结果文件写 ui_change；为 true 时写 preview.md 和界面原型，方案审核通过后需求方先确认再开始写代码",
    );
  }
  const related = relatedRepos(ctx);
  for (const r of related) {
    lines.push(`关联仓库（只读）：${r.name} → ${r.dir}${r.ref || r.role ? `（${[r.ref, r.role].filter(Boolean).join("；")}）` : ""}`);
  }
  const phases = runPhases(ctx.state);
  if (ctx.state.phases && phases.mode !== "continuous") {
    lines.push(`执行方式：${PHASE_MODE_LABELS[phases.mode]}（当前阶段：${phaseOf(ctx) === "verify" ? "测试验证" : "研发"}）`);
  }
  if (VERIFY_PHASE_STEPS.includes(def.id) || def.id === "report") {
    if (phases.environment !== "local" || phases.defects !== "fix") {
      lines.push(`测试验证：${ENVIRONMENT_TEXT[phases.environment]}；发现缺陷时${DEFECTS_TEXT[phases.defects]}`);
    }
    lines.push(`提测说明：${ctx.featureDir}/handoff.md（研发阶段写的，先读它）`);
  }
  const inc = ctx.state.incremental;
  if (inc) {
    lines.push(
      `增量继续：本次是第 ${ctx.state.attempt} 次尝试，接着第 ${inc.fromAttempt} 次的工作（${inc.reason}）`,
      `上一次是否已经写过代码：${inc.hadImplementation ? "是" : "否"}`,
      `本次开始时的提交：${inc.baseCommit ?? "（不是 git 仓库）"}`,
    );
  }
  if (extras.contextLines) lines.push(...extras.contextLines);
  lines.push(`结果文件：${resultFile}`, `结果文件绝对路径：${path.join(stepRepo, resultFile)}`, "</pipeline-context>");
  const parts = [readToolPrompt(sources, "00-shared-context.md")];
  const principles = principlesSection(sources);
  if (principles) parts.push(principles);
  parts.push(readToolPrompt(sources, def.promptFile));
  if (type) {
    const playbook = playbookSection(sources, type, extras.additionsFor ?? def.id);
    if (playbook) parts.push(playbook);
  }
  if (joint.length > 0) {
    const jointGuide = promptSections(sources, "joint.md", extras.additionsFor ?? def.id);
    if (jointGuide) parts.push(jointGuide);
  }
  if (ctx.state.incremental) parts.push(readToolPrompt(sources, "incremental.md"));
  if (related.length > 0) parts.push(readToolPrompt(sources, "related-repos.md"));
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
      people: (() => {
        const source = readSource(ctx.repo, ctx.featureDir);
        return peopleOf(type, source?.author ?? null, source ? { system: source.system, id: source.id, url: source.url } : null, ctx.config.people);
      })(),
    },
    ctx.log,
  );
}

/** Keeps the requirement's card in each configured external system in step (1.9). Never throws. */
async function integrate(ctx: PipelineContext, event: IntegrationEvent): Promise<void> {
  if (ctx.config.integrations.length === 0) return;
  for (const config of ctx.config.integrations) {
    await syncIntegration({
      config,
      ctx: { repo: ctx.repo, featureDir: ctx.featureDir, state: ctx.state, projectDefaults: ctx.config.integrationDefaults[config.name] },
      event,
      run: ctx.integrationRunner,
      log: ctx.log,
    });
  }
  save(ctx);
  await updateCard(ctx, event);
}

const CARD_PROGRESS: Record<IntegrationEvent, string> = {
  started: "需求方已确认，开发中（方案设计、实现、评审）",
  approval: "方案已通过审核，等待需求方确认方案（见下方“待确认的方案”）",
  blocked: "等待需求方决定（见需求会话中的问题）",
  phase_done: "研发完成，已写好提测说明，等待测试",
  verify: "测试验证中",
  completed: "已完成",
  failed: "流水线中断，正在处理",
};

/**
 * A requirement that started from a card (1.10), with `push` on: once development is done and the
 * handoff is written, pushes each repository's branch to <remote>/<prefix><card>. Never forced
 * (a rejected push is reported, not retried with force), never merged. Never throws.
 */
function pushBranch(ctx: PipelineContext): void {
  const push = ctx.config.push;
  if (!push.enabled) return;
  const source = readSource(ctx.repo, ctx.featureDir);
  if (!source) return;
  const branch = `${push.branchPrefix}${cardSlug(source.id)}`;
  const repos = [ctx.repo, ...(ctx.state.joint ?? []).map((j) => j.repo)];
  const at = new Date().toISOString();
  for (const repo of repos) {
    let error: string | null = null;
    try {
      execFileSync("git", ["push", push.remote, `HEAD:refs/heads/${branch}`], { cwd: repo, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, windowsHide: true });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer | string }).stderr?.toString().trim();
      error = (stderr || (e as Error).message).split("\n").filter(Boolean).slice(-2).join(" ");
    }
    const before = ctx.state.pushed?.find((p) => p.repo === repo);
    ctx.log(error ? `推送 ${repo} 的分支到 ${push.remote}/${branch} 失败：${error}` : `已推送 ${repo} 的分支到 ${push.remote}/${branch}`);
    // A merge request is made once; later pushes (after testing sent defects back) update it by themselves.
    const mergeRequest = !error && push.mergeRequest && !before?.mergeRequest?.url ? makeMergeRequest(ctx, repo, branch, source) : (before?.mergeRequest ?? null);
    ctx.state.pushed = [...(ctx.state.pushed ?? []).filter((p) => p.repo !== repo), { repo, remote: push.remote, branch, at, error, mergeRequest }];
  }
  save(ctx);
}

/** The remote's default branch (origin/HEAD), for the merge request's target; main when unknown. */
function defaultBranch(repo: string, remote: string): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { cwd: repo, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString().trim();
    return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref || "main";
  } catch {
    return "main";
  }
}

/**
 * 1.12: a draft merge request for the pushed branch, with the machine's own command (push.mergeRequest).
 * Its description is the handoff note and the card. Never merged here. Never throws.
 */
function makeMergeRequest(ctx: PipelineContext, repo: string, branch: string, source: NonNullable<ReturnType<typeof readSource>>): { url: string | null; at: string; error: string | null } {
  const mr = ctx.config.push.mergeRequest!;
  const at = new Date().toISOString();
  const handoff = path.join(repo, ctx.featureDir, "handoff.md");
  const note = fs.existsSync(handoff) ? fs.readFileSync(handoff, "utf8").trim() : "";
  const cardLine = `需求卡片：${source.system} ${source.id}${source.url ? ` ${source.url}` : ""}`;
  const values: Record<string, string> = {
    branch,
    target: mr.target || defaultBranch(repo, ctx.config.push.remote),
    title: `[${source.id}] ${specTitle(ctx)}`,
    description: [`> 由 req-kit 在研发完成后创建的草稿，合并前请人工评审。`, "", cardLine, "", note.slice(0, 20_000)].join("\n"),
    card: source.id,
    cardUrl: source.url ?? "",
  };
  try {
    const { file, prefix } = resolveCommand(mr.command);
    const output = execFileSync(file, [...prefix, ...renderArgs(mr.args, values)], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: (mr.timeoutSeconds ?? 60) * 1000,
      windowsHide: true,
    }).toString();
    const url = /https?:\/\/\S+/.exec(output)?.[0]?.replace(/[)。，,.]+$/, "") ?? null;
    ctx.log(`已为 ${branch} 建草稿合并请求${url ? `：${url}` : "（输出中没有找到地址）"}`);
    return { url, at, error: null };
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr?.toString().trim();
    const error = (stderr || (e as Error).message).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
    ctx.log(`为 ${branch} 建合并请求失败：${error}。分支已推送，可以手工建`);
    return { url: null, at, error };
  }
}

/** Where the requirement's code is, for the card: the pushed branch, or the local one. */
function branchText(ctx: PipelineContext): string | null {
  const mine = ctx.state.pushed?.find((p) => p.repo === ctx.repo);
  if (mine?.error) return `分支 ${ctx.state.branch}（推送到 ${mine.remote}/${mine.branch} 失败：${mine.error}）`;
  if (mine) return `代码已推送到 ${mine.remote} 的分支 ${mine.branch}${mine.mergeRequest?.url ? `，草稿合并请求 ${mine.mergeRequest.url}` : ""}`;
  return ctx.state.branch ? `分支 ${ctx.state.branch}` : null;
}

/** A requirement that started from a card (1.10): its AI section follows the pipeline. Never throws. */
async function updateCard(ctx: PipelineContext, event: IntegrationEvent): Promise<void> {
  const source = readSource(ctx.repo, ctx.featureDir);
  if (!source) return;
  const config = ctx.config.integrations.find((i) => i.name === source.system);
  if (!config?.describe || !config.query) return;
  const approval = event === "approval";
  let progress = CARD_PROGRESS[event];
  if (event === "phase_done" && branchText(ctx)) progress += `，${branchText(ctx)}`;
  if (event === "completed" && ctx.state.outcome && ctx.state.outcome !== "completed") progress = `已结束（${ctx.state.outcome === "completed_with_issues" ? "有遗留问题，见完成报告" : "没有完成，见完成报告"}）`;
  try {
    await publishCard({
      config,
      repo: ctx.repo,
      featureDir: ctx.featureDir,
      source,
      progress,
      appendix: approval ? (planAppendix(ctx.repo, ctx.featureDir) ?? undefined) : undefined,
      planConfirm: approval,
      run: ctx.integrationRunner,
    });
    ctx.log(`${config.name}：卡片 ${source.id} 的 AI 区已更新（${progress}）`);
  } catch (error) {
    ctx.log(`${config.name}：更新卡片 ${source.id} 的 AI 区失败：${(error as Error).message}`);
  }
}

/** Sends a progress note once per run attempt, when enabled. */
async function milestone(ctx: PipelineContext, id: string, text: string): Promise<void> {
  if (!ctx.config.notifyMilestones || ctx.state.milestones.includes(id)) return;
  ctx.state.milestones.push(id);
  save(ctx);
  await notifyOrigin(ctx, milestoneMessage(text));
  await notifyExternal(ctx, "milestone", text, { milestone: id });
}

/** A step's time limit; `extended` once it was given a second period (selfHeal). */
interface Deadline {
  at: number;
  extended: boolean;
  key: string;
  /** The step's record, so a later run waiting for the same agent knows the extra period was used. */
  record?: StepRecord;
}

async function waitForTurn(ctx: PipelineContext, agent: StepAgent, def: StepDef, agentTitle: string, deadline: Deadline): Promise<AgentUsage | null> {
  const notifiedPermissions = new Set<string>();
  let consecutiveErrors = 0;
  for (;;) {
    let remaining = deadline.at - Date.now();
    if (remaining <= 0 && ctx.config.selfHeal && !deadline.extended) {
      // Usually a big step, not a stuck one: the agent keeps its progress and gets as long again.
      deadline.extended = true;
      if (deadline.record) deadline.record.extendedTimeout = true;
      deadline.at = Date.now() + ctx.config.stepTimeoutMinutes[def.id] * 60_000;
      remaining = deadline.at - Date.now();
      recover(ctx, deadline.key, "extend_timeout", `超过 ${ctx.config.stepTimeoutMinutes[def.id]} 分钟仍未完成，agent 还在做，再给它同样长的时间`);
    }
    if (remaining <= 0) {
      const total = ctx.config.stepTimeoutMinutes[def.id] * (deadline.extended ? 2 : 1);
      throw new AgentLeftRunning(
        def.title,
        `超过 ${total} 分钟仍未完成。agent「${agentTitle}」还在运行，没有停止它；继续时会先看它的情况：做完了就用它的结果，还在做就接着等它，不会另起一个 agent 重复做。`,
        true,
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
        throw new AgentLeftRunning(def.title, `连续 ${consecutiveErrors} 次无法获取 agent 状态：${(error as Error).message}`, false);
      }
      await ctx.sleep(Math.min(60_000, 5_000 * consecutiveErrors));
      continue;
    }
    // 1.13: whether the step waits for a permission, for the plugin's "等你处理".
    const waitingNow = outcome.status === "permission";
    if (!waitingNow && ctx.state.waitingPermission) {
      ctx.state.waitingPermission = null;
      save(ctx);
    }
    switch (outcome.status) {
      case "idle":
        return outcome.usage ?? null;
      case "timeout":
        continue;
      case "error":
        throw new AgentErrored(def.title, `agent 报告错误：${outcome.error ?? "未知错误"}`);
      case "permission": {
        const requests = outcome.pendingPermissions.map((p) => p.title);
        const w = ctx.state.waitingPermission;
        if (!w || w.agentId !== agent.id || w.requests.join("\n") !== requests.join("\n")) {
          ctx.state.waitingPermission = { agentId: agent.id, stepTitle: def.title, requests, since: w?.agentId === agent.id ? w.since : new Date().toISOString() };
          save(ctx);
        }
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
  const key = extras.key ?? keyFor(stepKey(id, round), extras.target);
  const fallback = ctx.config.agents.fallback ?? null;
  let redone = false;
  let usedFallback = false;
  for (let retry = 0; ; retry += 1) {
    try {
      return await runStepOnce(ctx, id, round, maxRounds, extras);
    } catch (error) {
      const message = (error as Error).message;
      const transient = error instanceof StepFailure && isTransientError(message);
      const healable = error instanceof AgentErrored || error instanceof ResultInvalid;
      // 1.12: a step whose agent errored or wrote no valid result is redone once with a new
      // agent; one that keeps hitting rate limits gets the fallback model, when there is one.
      if (error instanceof StepFailure && ctx.config.selfHeal && !transient && healable && !redone) {
        redone = true;
        const switchModel = fallback !== null && !usedFallback && error instanceof AgentErrored;
        if (switchModel) usedFallback = true;
        recover(
          ctx,
          key,
          switchModel ? "fallback" : "redo",
          `${message.slice(0, 160)}；${switchModel ? "换备用模型" : "新开一个 agent"}重做这一步`,
        );
        extras = withRetryNote({ ...extras, ...(switchModel ? { profile: fallback } : {}) }, message);
        continue;
      }
      if (error instanceof StepFailure && transient && retry >= attempts && fallback !== null && !usedFallback && !(error instanceof AgentLeftRunning)) {
        usedFallback = true;
        recover(ctx, key, "fallback", `重试 ${retry} 次后仍然${message.slice(0, 120)}；换备用模型继续这一步`);
        extras = withRetryNote({ ...extras, profile: fallback }, message);
        continue;
      }
      if (!(error instanceof StepFailure) || !transient || retry >= attempts) {
        if (error instanceof StepFailure && retry > 0) {
          throw new (error.constructor as typeof StepFailure)(error.stepTitle, `${message}（已自动重试 ${retry} 次）`);
        }
        throw error;
      }
      const wait = backoffSeconds.at(Math.min(retry, backoffSeconds.length - 1)) ?? 60;
      recover(ctx, key, "retry", `遇到临时错误：${message.slice(0, 160)}。${wait} 秒后自动重试（第 ${retry + 1} 次，最多 ${attempts} 次）`);
      await ctx.sleep(wait * 1000);
      extras = withRetryNote(extras, message);
    }
  }
}

/** Tells the next agent of a step that an earlier one stopped part way. */
function withRetryNote(extras: StepExtras, message: string): StepExtras {
  return {
    ...extras,
    contextLines: [
      ...(extras.contextLines ?? []).filter((l) => !l.startsWith("自动重试：")),
      `自动重试：本步骤上一次中断了（${message.slice(0, 200)}）。工作区里可能留有上一次没做完的改动，先用 git status 和 git diff 查看，在此基础上继续，不要重复提交`,
    ],
  };
}

async function runStepOnce(
  ctx: PipelineContext,
  id: StepId,
  round: number | null,
  maxRounds: number | null,
  extras: StepExtras,
): Promise<Record<string, unknown>> {
  const def = stepDef(ctx, id);
  const target = extras.target;
  const key = extras.key ?? keyFor(stepKey(id, round), target);
  const stepRepo = target?.repo ?? ctx.repo;
  const cached = ctx.state.results[key];
  if (cached) {
    ctx.log(`跳过 ${key}：沿用上次运行的结果 ${JSON.stringify(cached)}`);
    return cached;
  }

  const resultRel = `${ctx.featureDir}/.pipeline/results/${key}.json`;
  const resultAbs = path.join(stepRepo, resultRel);
  fs.mkdirSync(path.dirname(resultAbs), { recursive: true });

  // An earlier run of this step may have left its agent working: use it, never run a second one.
  const leftover = await checkLeftover(ctx, key, def, resultAbs);
  if (leftover.done) return leftover.done;
  if (!leftover.agent) fs.rmSync(resultAbs, { force: true });

  // Services, the browser and the deployed environment belong to the steps in this repository.
  const managed = target
    ? null
    : mergeExtras(
        mergeExtras(mergeExtras(await serviceExtras(ctx, id), await jointServiceExtras(ctx, id)), await browserExtras(ctx, id)),
        deployedExtras(ctx, id),
      );
  if (managed) {
    extras = {
      ...extras,
      contextLines: [...(extras.contextLines ?? []), ...managed.contextLines],
      sections: [...(extras.sections ?? []), ...managed.sections],
    };
  }

  const agentTitle =
    `[${featureName(ctx.featureDir)}] ` +
    (extras.title ?? `${def.number}-${def.title}${round !== null && round > 1 ? ` 第${round}轮` : ""}${target ? `（${target.name}）` : ""}`);
  if (!leftover.agent) await checkBudget(ctx, def.title);
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
    phase: phaseOf(ctx),
  };
  if (leftover.agent) {
    record.agentId = leftover.agent.id;
    record.reattached = leftover.reattached;
  }
  ctx.log(leftover.agent ? `继续等待 ${key}（${def.title}）上一次的 agent ${leftover.agent.id}` : `开始 ${key}（${def.title}）`);

  const stepProfile = extras.profile ?? phaseAgent(ctx, id) ?? ctx.config.agents[def.role];
  if (!leftover.agent) record.agent = agentName(stepProfile);
  try {
    const agent = leftover.agent ?? await ctx.runtime.startAgent({
      role: def.role,
      title: agentTitle,
      prompt: buildPrompt(ctx, def, round, maxRounds, resultRel, extras),
      cwd: stepRepo,
      labels: {
        "requirement-pipeline": featureName(ctx.featureDir),
        "pipeline-step": key,
        ...(target ? { "joint-repo": target.slug } : {}),
      },
      parentAgentId: ctx.config.attachToOriginChat ? ctx.state.originAgentId : null,
      // Always passed: the run's config has Paseo profile names resolved; the runtime's may not.
      profile: stepProfile,
      workspaceId: target ? target.workspaceId : (ctx.state.worktree?.workspaceId ?? null),
    });
    record.agentId = agent.id;
    ctx.state.history.push(record);
    save(ctx);

    const deadline: Deadline = { at: Date.now() + ctx.config.stepTimeoutMinutes[id] * 60_000, extended: leftover.extended ?? false, key, record };
    if (deadline.extended) record.extendedTimeout = true;
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
      throw new ResultInvalid(def.title, `提醒 ${record.followUps} 次后仍没有得到有效的结果文件：${validation.error}`);
    }

    if (extras.gate) {
      // The same agent fixes what its own change broke: it still has the context.
      await qualityGate(ctx, key, target, async (text) => {
        await agent.followUp(text);
        record.usage = (await waitForTurn(ctx, agent, def, agentTitle, deadline)) ?? record.usage ?? null;
        const again = readResultFile(resultAbs, def);
        if (again.ok) validation = again;
      });
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
    if (error instanceof AgentLeftRunning) record.leftRunning = true;
    if (!ctx.state.history.includes(record)) ctx.state.history.push(record);
    save(ctx);
    if (error instanceof StepFailure) throw error;
    throw new StepFailure(def.title, (error as Error).message);
  }
}

/**
 * Before a step starts an agent, looks at the agent an earlier run of the same step left
 * working (a timeout, unreadable status, or a pipeline process that died mid-step):
 * - it has finished and written a valid result: that result is the step's result;
 * - it is still working: the step waits for it again (once); the second time it is stopped
 *   and a new agent starts, so a stuck agent does not hold the step forever;
 * - it cannot be reached, or finished without a valid result: a new agent starts.
 * Two agents on one step would edit the same files, commit in the same worktree and write
 * the same result file, so a new one never starts while the old one may be working.
 */
async function checkLeftover(
  ctx: PipelineContext,
  key: string,
  def: StepDef,
  resultAbs: string,
): Promise<{ done?: Record<string, unknown>; agent?: StepAgent; reattached?: number; extended?: boolean }> {
  const last = [...ctx.state.history].reverse().find((h) => h.key === key);
  if (!last?.agentId || last.outcome === "completed") return {};
  if (last.outcome !== "running" && !last.leftRunning) return {};
  last.leftRunning = false;
  // 1.12.1: an agent left by an earlier attempt worked on an earlier version of the requirement:
  // never wait for it or take its result; stop it so it does not touch the files any more.
  const sameAttempt = last.attempt === ctx.state.attempt;
  if (last.outcome === "running") {
    last.outcome = "failed";
    last.endedAt = new Date().toISOString();
    last.error ??= "流水线进程在这一步运行时退出";
  }
  save(ctx);
  const agent = ctx.runtime.attachAgent(last.agentId);
  if (!sameAttempt) {
    ctx.log(`${key} 有第 ${last.attempt} 次尝试留下的 agent ${last.agentId}，它按旧的需求在做：停止它，新建一个 agent`);
    await stopLeftover(ctx, agent, last.agentId, "需求已经变了，流水线会按新的需求另起一个 agent 重做这一步。");
    return {};
  }
  let status: WaitOutcome["status"] | "unreachable";
  try {
    status = (await agent.wait(Math.min(5_000, ctx.config.waitChunkSeconds * 1000))).status;
  } catch (error) {
    ctx.log(`无法读取 ${key} 上一次的 agent ${last.agentId} 的状态（${(error as Error).message}），新建一个 agent`);
    status = "unreachable";
  }
  if (status === "idle") {
    const validation = readResultFile(resultAbs, def);
    if (validation.ok) {
      last.outcome = "completed";
      last.endedAt = new Date().toISOString();
      last.error = null;
      last.result = validation.value;
      ctx.state.results[key] = validation.value;
      save(ctx);
      recover(ctx, key, "reuse_result", `上一次的 agent ${last.agentId} 已经做完，沿用它的结果`);
      if (ctx.config.archiveStepAgents) await agent.archive().catch(() => undefined);
      return { done: validation.value };
    }
    ctx.log(`${key} 上一次的 agent ${last.agentId} 已经停下，但没有有效的结果文件（${validation.error}），新建一个 agent`);
    return {};
  }
  if (status === "timeout" || status === "permission") {
    if ((last.reattached ?? 0) < 1) {
      recover(ctx, key, "reattach", `上一次的 agent ${last.agentId} 还在做，接着等它，不另起一个`);
      return { agent, reattached: (last.reattached ?? 0) + 1, extended: last.extendedTimeout ?? false };
    }
    ctx.log(`${key} 上一次的 agent ${last.agentId} 已经等过两轮仍未完成，停止它并新建一个 agent`);
    await stopLeftover(ctx, agent, last.agentId, "这一步已超时，流水线会另起一个 agent 重做。");
    return {};
  }
  return {};
}

/** Tells an earlier agent of a step to stop, and gives it a moment before a new one touches the same files. */
async function stopLeftover(ctx: PipelineContext, agent: StepAgent, agentId: string, why: string): Promise<void> {
  await ctx.runtime
    .interruptAgent(agentId, `${why}请立即停止当前工作，不要再修改任何文件，也不要写结果文件，直接结束。`)
    .catch((error: Error) => ctx.log(`无法停止 agent ${agentId}：${error.message}`));
  await agent.wait(Math.min(60_000, ctx.config.waitChunkSeconds * 1000 * 2)).catch(() => undefined);
}

/** phases.verify.agents applies to the verify-phase steps. */
function phaseAgent(ctx: PipelineContext, id: StepId): AgentProfile | undefined {
  if (!VERIFY_PHASE_STEPS.includes(id)) return undefined;
  return ctx.config.phases.verify.agents[STEPS[id].role];
}

function deployed(ctx: PipelineContext): boolean {
  return runPhases(ctx.state).environment === "deployed";
}

/** Verification against an environment deployed for testing, described in test-env.md. */
function deployedExtras(ctx: PipelineContext, id: StepId): { contextLines: string[]; sections: string[] } | null {
  if (!deployed(ctx) || !["verify", "defect_fix", "reverify"].includes(id)) return null;
  return {
    contextLines: [`验证环境：已部署的测试环境，地址、账号从哪里取、可以用的测试数据见 ${ctx.featureDir}/test-env.md`],
    sections: [readToolPrompt({ ...ctx.prompts, repo: ctx.repo }, "verify-deployed.md")],
  };
}

function mergeExtras(
  a: { contextLines: string[]; sections: string[] } | null,
  b: { contextLines: string[]; sections: string[] } | null,
): { contextLines: string[]; sections: string[] } | null {
  if (!a && !b) return null;
  return { contextLines: [...(a?.contextLines ?? []), ...(b?.contextLines ?? [])], sections: [...(a?.sections ?? []), ...(b?.sections ?? [])] };
}

/** How a step's agent is named in records and statistics (1.13). */
export function agentName(profile: AgentProfile | null | undefined): string | undefined {
  if (!profile) return undefined;
  return profile.paseoProfile?.trim() || profile.provider?.trim() || undefined;
}

/** Steps that check the result the way a user would. */
const BROWSER_STEPS: readonly StepId[] = ["verify", "defect_fix", "reverify"];

/**
 * How verification looks at web pages: `req ui-check` (1.13; reports in words, needs no vision
 * and no Paseo desktop) always, plus Paseo's built-in browser when the step agents have it.
 */
async function browserExtras(ctx: PipelineContext, id: StepId): Promise<{ contextLines: string[]; sections: string[] } | null> {
  if (!BROWSER_STEPS.includes(id) || ctx.config.browserVerify === "off") return null;
  const prompts = { ...ctx.prompts, repo: ctx.repo };
  const out = {
    contextLines: [`界面检查命令：node "${path.join(KIT_ROOT, "bin", "req.mjs")}" ui-check`],
    sections: [readToolPrompt(prompts, "ui-check.md")],
  };
  if (ctx.capabilities === undefined) ctx.capabilities = await ctx.runtime.capabilities().catch(() => null);
  if (ctx.capabilities?.browser) {
    out.contextLines.push("浏览器：可以用 Paseo 内置浏览器（browser_* 工具）验证网页界面");
    out.sections.push(readToolPrompt(prompts, "browser-verify.md"));
  }
  return out;
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
  if (!SERVICE_STEPS.includes(id) || deployed(ctx)) return null;
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

/** Joint requirement: the other repositories' paseo.json services, started with their current code too. */
async function jointServiceExtras(ctx: PipelineContext, id: StepId): Promise<{ contextLines: string[]; sections: string[] } | null> {
  if (!SERVICE_STEPS.includes(id) || deployed(ctx) || ctx.config.paseoServices === "off") return null;
  const joint = jointTargets(ctx);
  if (joint.length === 0) return null;
  ctx.jointServices ??= new Map();
  const lines: string[] = [];
  for (const t of joint) {
    if (!t.workspaceId) continue;
    const names = await ctx.runtime.listServices({ workspaceId: t.workspaceId }).catch(() => null);
    if (!names || names.length === 0) {
      lines.push(`联合仓库「${t.name}」：paseo.json 中没有定义服务，需要它的服务时按它的验证方法自己启动（在 ${t.repo}），用完关掉`);
      continue;
    }
    try {
      const services = await ctx.runtime.startServices({ workspaceId: t.workspaceId }, names, ctx.config.serviceReadySeconds * 1000);
      ctx.jointServices.set(t.workspaceId, names);
      for (const service of services) lines.push(`联合仓库「${t.name}」的${describeService(service, null)}`);
    } catch (error) {
      lines.push(`联合仓库「${t.name}」的服务这次没能通过 Paseo 启动（${(error as Error).message}），需要时按它的验证方法自己启动，用完关掉`);
    }
  }
  if (lines.length > 0) ctx.log(lines.join("；"));
  return lines.length > 0 ? { contextLines: lines, sections: [] } : null;
}

async function stopManagedServices(ctx: PipelineContext): Promise<void> {
  for (const [workspaceId, names] of ctx.jointServices ?? []) {
    await ctx.runtime.stopServices({ workspaceId }, names).catch((error: Error) => ctx.log(`停止联合仓库的服务失败：${error.message}`));
    ctx.log(`已停止联合仓库中由 Paseo 管理的服务：${names.join("、")}`);
  }
  ctx.jointServices?.clear();
  const started = [...(ctx.services?.started ?? [])];
  const target = serviceTarget(ctx);
  if (started.length === 0 || !target) return;
  await ctx.runtime.stopServices(target, started).catch((error: Error) => ctx.log(`停止服务失败：${error.message}`));
  ctx.services?.started.clear();
  ctx.log(`已停止 Paseo 管理的服务：${started.join("、")}`);
}

/** A Paseo schedule that reminds the chat about unanswered questions; returns the hours, or null. */
async function scheduleReminder(ctx: PipelineContext, what: string[] | "phase" | "approval"): Promise<number | null> {
  const hours = ctx.config.waitingReminderHours;
  const origin = ctx.state.originAgentId;
  if (hours <= 0 || !origin) return null;
  const at = new Date(Date.now() + hours * 3600_000);
  const shown = shownFeatureDir(ctx);
  try {
    const id = await ctx.runtime.scheduleMessage({
      agentId: origin,
      at,
      name: `req-kit 提醒：${featureName(ctx.featureDir)} ${what === "phase" ? "待测试验证" : what === "approval" ? "等待确认方案" : "等待回答"}`,
      prompt:
        what === "phase"
          ? phaseWaitingReminderMessage({ featureDir: shown, hours, handoffPath: `${shown}/handoff.md`, verifyCommand: verifyCommandOf(ctx) })
          : what === "approval"
            ? approvalReminderMessage({ featureDir: shown, hours, previewPath: `${shown}/preview.md`, approveCommand: approveCommandOf(ctx) })
            : waitingReminderMessage({ featureDir: shown, hours, questions: what, resumeCommand: ctx.resumeCommand }),
    });
    if (!id) return null;
    ctx.state.schedules = [...(ctx.state.schedules ?? []), { id, kind: "reminder", at: at.toISOString() }];
    save(ctx);
    ctx.log(`已预约 ${hours} 小时后的提醒（Paseo 定时任务 ${id}）`);
    return hours;
  } catch (error) {
    ctx.log(`预约提醒失败：${(error as Error).message}`);
    return null;
  }
}

function shortTime(at: Date): string {
  return at.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** --verify-at: a Paseo schedule that has the chat start the verify phase; returns the time as text, or null. */
async function scheduleVerifyStart(ctx: PipelineContext): Promise<string | null> {
  const origin = ctx.state.originAgentId;
  if (!ctx.state.verifyAt || !origin) return null;
  const at = new Date(ctx.state.verifyAt);
  try {
    const id = await ctx.runtime.scheduleMessage({
      agentId: origin,
      at,
      name: `req-kit 测试验证：${featureName(ctx.featureDir)}`,
      prompt: verifyStartPrompt({
        featureDir: shownFeatureDir(ctx),
        statusCommand: ctx.statusCommand ?? ctx.resumeCommand.replace(/ --resume$/, " --status"),
        verifyCommand: verifyCommandOf(ctx),
        environment: runPhases(ctx.state).environment,
      }),
    });
    if (!id) return null;
    ctx.state.schedules = [...(ctx.state.schedules ?? []), { id, kind: "verify-start", at: at.toISOString() }];
    save(ctx);
    ctx.log(`已预约在 ${shortTime(at)} 开始测试验证（Paseo 定时任务 ${id}）`);
    return shortTime(at);
  } catch (error) {
    ctx.log(`预约测试验证失败：${(error as Error).message}`);
    return null;
  }
}

/** designApproval.autoContinueHours: a Paseo schedule that has the chat approve the design if nobody did; returns the time, or null. */
async function scheduleApprovalContinue(ctx: PipelineContext): Promise<string | null> {
  const hours = ctx.config.designApproval.autoContinueHours;
  const origin = ctx.state.originAgentId;
  if (hours <= 0 || !origin) return null;
  const at = new Date(Date.now() + hours * 3600_000);
  try {
    const id = await ctx.runtime.scheduleMessage({
      agentId: origin,
      at,
      name: `req-kit 方案确认超时：${featureName(ctx.featureDir)}`,
      prompt: approvalContinuePrompt({
        featureDir: shownFeatureDir(ctx),
        hours,
        statusCommand: ctx.statusCommand ?? ctx.resumeCommand.replace(/ --resume$/, " --status"),
        approveCommand: approveCommandOf(ctx),
      }),
    });
    if (!id) return null;
    ctx.state.schedules = [...(ctx.state.schedules ?? []), { id, kind: "approval-continue", at: at.toISOString() }];
    save(ctx);
    ctx.log(`已预约 ${hours} 小时后仍未确认时按方案继续（Paseo 定时任务 ${id}）`);
    return shortTime(at);
  } catch (error) {
    ctx.log(`预约按方案继续失败：${(error as Error).message}`);
    return null;
  }
}

/** A Paseo schedule that has the chat continue the run later; returns the time as text, or null. */
/** Rate limits and used-up subscriptions, as opposed to network trouble. */
const QUOTA_ERROR = /rate.?limit|too many requests|\b429\b|quota|usage limit|额度|限流/i;

/**
 * 1.12: when a step stopped on rate limits and Paseo says when a used-up subscription window
 * resets, the time to continue (5 minutes after the reset, within 24 hours); null otherwise.
 */
async function quotaResetTime(ctx: PipelineContext, reason: string): Promise<Date | null> {
  if (!QUOTA_ERROR.test(reason)) return null;
  const profiles = [ctx.config.agents.builder, ctx.config.agents.reviewer, ...(ctx.config.agents.fallback ? [ctx.config.agents.fallback] : [])];
  const providers = [...new Set(profiles.map((p) => (p.provider ?? "").split("/")[0]).filter(Boolean))];
  const quotas = await ctx.runtime.providerQuota(providers).catch(() => null);
  const now = Date.now();
  const resets = (quotas ?? [])
    .filter((q) => q.resetsAt && ((q.usedPct !== null && q.usedPct >= 95) || q.tone === "danger"))
    .map((q) => new Date(q.resetsAt!).getTime())
    .filter((t) => t > now && t < now + 24 * 3600_000);
  return resets.length === 0 ? null : new Date(Math.max(...resets) + 5 * 60_000);
}

async function scheduleAutoResume(ctx: PipelineContext, reason: string): Promise<string | null> {
  const minutes = ctx.config.autoResumeMinutes;
  const origin = ctx.state.originAgentId;
  if (minutes <= 0 || !origin) return null;
  const used = ctx.state.autoResumes?.attempt === ctx.state.attempt ? ctx.state.autoResumes.count : 0;
  if (used >= ctx.config.autoResumeMax) {
    ctx.log(`这次尝试已经自动继续过 ${used} 次，不再预约`);
    return null;
  }
  const reset = await quotaResetTime(ctx, reason);
  const at = reset ?? new Date(Date.now() + minutes * 60_000);
  try {
    const id = await ctx.runtime.scheduleMessage({
      agentId: origin,
      at,
      name: `req-kit 自动继续：${featureName(ctx.featureDir)}`,
      prompt: autoResumePrompt({
        featureDir: shownFeatureDir(ctx),
        reason: reason.slice(0, 300),
        statusCommand: ctx.statusCommand ?? ctx.resumeCommand.replace(/ --resume$/, " --status"),
        resumeCommand: ctx.resumeCommand,
      }),
    });
    if (!id) return null;
    ctx.state.schedules = [...(ctx.state.schedules ?? []), { id, kind: "auto-resume", at: at.toISOString() }];
    ctx.state.autoResumes = { attempt: ctx.state.attempt, count: used + 1 };
    save(ctx);
    const when = at.toLocaleString("zh-CN", { hour12: false });
    if (reset) recover(ctx, "pipeline", "quota_wait", `额度用完，Paseo 显示会恢复；已预约在 ${when} 自动继续（Paseo 定时任务 ${id}）`);
    else recover(ctx, "pipeline", "auto_resume", `已预约 ${minutes} 分钟后自动继续（Paseo 定时任务 ${id}）`);
    return at.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (error) {
    ctx.log(`预约自动继续失败：${(error as Error).message}`);
    return null;
  }
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
      `流水线照常进行；额度用完时会遇到限流，流水线会先重试${ctx.config.agents.fallback ? "、再换备用模型" : ""}，仍不行就预约在额度恢复后自动继续，不需要人处理。如果希望等额度恢复后再开发，请转告用户，用户同意的话可以先暂停，再预约在恢复时间开始。`,
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
/** A reviewer of a panel; `section` is extra guidance for this member only (review axes). */
type PanelMember = ReviewPanelMember & { section?: string };

async function runPanel(
  ctx: PipelineContext,
  step: PanelStep,
  round: number,
  shared: string[] = [],
  members: PanelMember[] = ctx.config.reviewPanel.members,
  target?: StepTarget,
): Promise<string[]> {
  const title = stepDef(ctx, step).title;
  const runs = members.map((member, i) => {
    const key = keyFor(`${step}-r${round}-p${i + 1}`, target);
    const findings = `${ctx.featureDir}/review-panel/${key.replace("@", "-")}.md`;
    const name = memberName(member, i);
    const contextLines = [
      `评审小组：${title}，第 ${round} 轮，${name}（共 ${members.length} 位）`,
      `你的意见文件：${findings}`,
      `你的意见文件绝对路径：${path.join(target?.repo ?? ctx.repo, findings)}`,
      ...shared,
    ];
    if (member.focus) contextLines.push(`你的关注重点：${member.focus}`);
    const { section, ...profile } = member;
    return runStep(ctx, "panel_review", round, null, {
      key,
      title: `${STEPS[step].number}-${title}${target ? `（${target.name}）` : ""} 评审小组·${name}`,
      target,
      profile,
      contextLines,
      sections: section ? [section] : undefined,
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
    throw first?.reason instanceof StepFailure ? first.reason : new StepFailure(title, "评审小组的成员都没有完成");
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
  // A defect is located, not designed; an assessment compares options itself.
  const type = ctx.state.type;
  return p.enabled && p.profiles.includes(ctx.state.profile) && !ctx.state.incremental && type !== "defect" && type !== "assessment";
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
async function runReview(
  ctx: PipelineContext,
  step: PanelStep,
  round: number,
  maxRounds: number,
  contextLines: string[] = [],
  target?: StepTarget,
): Promise<Record<string, unknown>> {
  const members = panelApplies(ctx, step, round) ? ctx.config.reviewPanel.members : axesApply(ctx, step, round) ? axisMembers(ctx) : null;
  if (!members) return runStep(ctx, step, round, maxRounds, { contextLines, target });
  const findings = await runPanel(ctx, step, round, contextLines, members, target);
  return runStep(ctx, step, round, maxRounds, {
    contextLines,
    target,
    sections: [consolidationSection(step, findings, members.length)],
  });
}

/** Code review in two axes: the first round of a standard run, unless a review panel is configured. */
function axesApply(ctx: PipelineContext, step: PanelStep, round: number): boolean {
  const axes = ctx.config.reviewAxes;
  return step === "code_review" && round === 1 && axes.enabled && axes.profiles.includes(ctx.state.profile);
}

/** The spec reviewer and the standards reviewer, both with the configured reviewer agent. */
function axisMembers(ctx: PipelineContext): PanelMember[] {
  const sources = { ...ctx.prompts, repo: ctx.repo };
  return [
    { ...ctx.config.agents.reviewer, name: "规格评审", section: readToolPrompt(sources, "review-axis-spec.md") },
    { ...ctx.config.agents.reviewer, name: "规范评审", section: readToolPrompt(sources, "review-axis-standards.md") },
  ];
}

/** Runs one step outside the pipeline's flow (the spec review started from the chat). */
export async function runSingleStep(ctx: PipelineContext, id: StepId, extras: StepExtras = {}): Promise<Record<string, unknown>> {
  try {
    return await runStep(ctx, id, null, null, extras);
  } catch (error) {
    throw new Error((error as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Quality gate (ADR 0023): the engine runs the project's checks itself after the
// steps that change code. Before the first code change of an attempt it records a
// baseline; afterwards only checks that passed then and fail now block, and the
// step's own agent is asked to fix them, up to qualityGate.fixAttempts times.
// ---------------------------------------------------------------------------

/** Where the code base and the quality gate of a repository are kept: the state, or its joint entry. */
type GateHolder = Pick<JointRepo, "codeBase" | "gate">;

function holderOf(ctx: PipelineContext, target: StepTarget | undefined): GateHolder {
  return target ? target.joint : ctx.state;
}

/** The quality-gate checks of this repository (configuration) or of a joint one (its own project file). */
function checksOf(ctx: PipelineContext, target: StepTarget | undefined): PipelineConfig["checks"] {
  if (!target) return ctx.config.checks;
  ctx.jointChecksCache ??= new Map();
  let checks = ctx.jointChecksCache.get(target.slug);
  if (!checks) {
    checks = loadProjectChecks(target.repo, ctx.log);
    ctx.jointChecksCache.set(target.slug, checks);
  }
  return checks;
}

function implementedThisAttempt(ctx: PipelineContext, target?: StepTarget): boolean {
  const suffix = target ? `@${target.slug}` : "";
  return Object.keys(ctx.state.results).some((k) => {
    if (!k.endsWith(suffix) || (!target && k.includes("@"))) return false;
    const base = target ? k.slice(0, -suffix.length) : k;
    return base === "implement" || base.startsWith("implement-s");
  });
}

/** Records the commit before the attempt's first change (before design); set once per attempt. */
function recordCodeBase(ctx: PipelineContext, target?: StepTarget): void {
  const holder = holderOf(ctx, target);
  if (holder.codeBase?.attempt === ctx.state.attempt) return;
  // An older run that already implemented without recording it: unknown, rather than wrong.
  holder.codeBase = { attempt: ctx.state.attempt, commit: implementedThisAttempt(ctx, target) ? null : headCommit(target?.repo ?? ctx.repo) };
  save(ctx);
}

function codeBaseCommit(ctx: PipelineContext, target?: StepTarget): string | null {
  const holder = holderOf(ctx, target);
  return holder.codeBase?.attempt === ctx.state.attempt ? (holder.codeBase.commit ?? null) : null;
}

function gateState(ctx: PipelineContext, target?: StepTarget): NonNullable<PipelineState["gate"]> {
  const holder = holderOf(ctx, target);
  holder.gate ??= { baseline: null, runs: [] };
  return holder.gate;
}

function checksDir(ctx: PipelineContext, key: string, target?: StepTarget): string {
  return path.join(target?.repo ?? ctx.repo, ctx.featureDir, ".pipeline", "checks", key);
}

/** Runs every check on the code as it is before the change; skipped when one exists for this attempt. */
async function gateBaseline(ctx: PipelineContext, target?: StepTarget): Promise<void> {
  const checks = checksOf(ctx, target);
  if (checks.length === 0) return;
  const gate = gateState(ctx, target);
  if (gate.baseline?.attempt === ctx.state.attempt) return;
  const where = target ? `「${target.name}」` : "";
  if (implementedThisAttempt(ctx, target)) {
    ctx.log(`质量门${where}：这次尝试已经开始写代码，没有改动前的基线，检查失败一律按新问题处理`);
    return;
  }
  const dir = checksDir(ctx, "baseline", target);
  fs.mkdirSync(dir, { recursive: true });
  const results: Record<string, CheckOutcome> = {};
  for (const check of checks) {
    const run = await runCheck(check, target?.repo ?? ctx.repo, ctx.config.qualityGate.timeoutMinutes);
    fs.writeFileSync(path.join(dir, logName(check.name)), run.output);
    results[check.name] = run.outcome;
  }
  gate.baseline = { attempt: ctx.state.attempt, commit: codeBaseCommit(ctx, target), at: new Date().toISOString(), results };
  save(ctx);
  const failing = Object.entries(results).filter(([, r]) => r === "fail").map(([n]) => n);
  ctx.log(`质量门基线${where}（改动前）：${checks.length} 项检查，${failing.length > 0 ? `原本就失败的：${failing.join("、")}` : "全部通过"}`);
}

/**
 * Runs the checks that apply to the change after a step. New failures go back to the
 * step's agent through `fix` (a follow-up turn) until they pass or the attempts run out;
 * either way the run goes on, and the outcome is recorded for the review and the report.
 */
async function qualityGate(ctx: PipelineContext, key: string, target: StepTarget | undefined, fix: (text: string) => Promise<void>): Promise<void> {
  const checks = checksOf(ctx, target);
  if (checks.length === 0) return;
  const repo = target?.repo ?? ctx.repo;
  const gate = gateState(ctx, target);
  const baseline = gate.baseline?.attempt === ctx.state.attempt ? gate.baseline : null;
  const max = ctx.config.qualityGate.fixAttempts;
  const dir = checksDir(ctx, key, target);
  fs.mkdirSync(dir, { recursive: true });
  for (let fixRounds = 0; ; fixRounds += 1) {
    const files = changedFiles(repo, codeBaseCommit(ctx, target));
    const runs: GateRun["checks"] = [];
    const failures: Parameters<typeof gateFollowUp>[0]["failures"] = [];
    for (const check of checks) {
      const failedBefore = baseline?.results[check.name] === "fail";
      if (!checkApplies(check, files)) {
        runs.push({ name: check.name, result: "skipped", failedBefore });
        continue;
      }
      const run = await runCheck(check, repo, ctx.config.qualityGate.timeoutMinutes);
      const logFile = path.join(dir, logName(check.name));
      fs.writeFileSync(logFile, run.output);
      runs.push({ name: check.name, result: run.outcome, failedBefore });
      if (run.outcome === "fail" && !failedBefore) {
        failures.push({ name: check.name, command: check.command, cwd: check.cwd ?? null, logFile, tail: tail(run.output) });
      }
    }
    if (failures.length === 0 || fixRounds >= max) {
      const record: GateRun = {
        key,
        attempt: ctx.state.attempt,
        at: new Date().toISOString(),
        checks: runs,
        newFailures: failures.map((f) => f.name),
        fixRounds,
        passed: failures.length === 0,
      };
      gate.runs.push(record);
      save(ctx);
      ctx.log(`质量门（${key} 之后）：${describeGateRun(record)}`);
      return;
    }
    ctx.log(`质量门（${key} 之后）：${failures.map((f) => f.name).join("、")} 改动前通过、现在失败，第 ${fixRounds + 1} 次要求修复`);
    const preexisting = runs.filter((r) => r.result === "fail" && r.failedBefore).map((r) => r.name);
    await fix(gateFollowUp({ failures, round: fixRounds + 1, max, preexisting }));
  }
}

function describeGateRun(run: GateRun): string {
  const ran = run.checks.filter((c) => c.result !== "skipped");
  const skipped = run.checks.length - ran.length;
  const old = ran.filter((c) => c.result === "fail" && c.failedBefore).map((c) => c.name);
  const parts = [
    run.passed
      ? `通过（运行 ${ran.length} 项${run.fixRounds > 0 ? `，要求修复 ${run.fixRounds} 次后通过` : ""}）`
      : `${run.newFailures.join("、")} 改动前通过、现在失败，要求修复 ${run.fixRounds} 次后仍失败`,
  ];
  if (old.length > 0) parts.push(`${old.join("、")} 改动前就失败`);
  if (skipped > 0) parts.push(`${skipped} 项与改动的模块无关，没有运行`);
  return parts.join("；");
}

/** What the gate found in this attempt, for the code review and the report. */
function gateLines(ctx: PipelineContext, target?: StepTarget): string[] {
  if (checksOf(ctx, target).length === 0) return [];
  const gate = holderOf(ctx, target).gate;
  const where = target ? `「${target.name}」` : "";
  const lines: string[] = [];
  const baseline = gate?.baseline?.attempt === ctx.state.attempt ? gate.baseline : null;
  if (baseline) {
    const failing = Object.entries(baseline.results).filter(([, r]) => r === "fail").map(([n]) => n);
    lines.push(`质量门基线${where}（改动前，流水线运行）：${Object.keys(baseline.results).length} 项检查，${failing.length > 0 ? `原本就失败：${failing.join("、")}` : "全部通过"}`);
  }
  const latest = new Map<string, GateRun>();
  for (const run of gate?.runs ?? []) if (run.attempt === ctx.state.attempt) latest.set(run.key, run);
  for (const run of latest.values()) lines.push(`质量门（${run.key} 之后，流水线运行）：${describeGateRun(run)}`);
  if (lines.length > 0) lines.push(`质量门${where}的完整输出：${path.join(target?.repo ?? "", ctx.featureDir, ".pipeline", "checks").split(path.sep).join("/")}/`);
  return lines;
}

/** The latest plan of this attempt: the design's slices and files, as revised. */
function currentPlan(ctx: PipelineContext): { slices: string[]; files: string[]; uiChange: boolean | null } {
  const plan = { slices: [] as string[], files: [] as string[], uiChange: null as boolean | null };
  const take = (r: Record<string, unknown> | undefined) => {
    if (!r) return;
    if (typeof r.ui_change === "boolean") plan.uiChange = r.ui_change;
    if (Array.isArray(r.slices)) plan.slices = (r.slices as string[]).map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(r.files)) plan.files = (r.files as string[]).map((s) => s.trim()).filter(Boolean);
  };
  take(ctx.state.results.design);
  const revisions = Object.keys(ctx.state.results)
    .filter((k) => /^design_revise-r\d+$/.test(k))
    .sort((a, b) => Number(a.slice(15)) - Number(b.slice(15)));
  for (const k of revisions) take(ctx.state.results[k]);
  return plan;
}

/** The slices to implement one by one, or [] for a single implementation step. */
function implementationSlices(ctx: PipelineContext): string[] {
  // A joint requirement runs one implementation per repository instead.
  if (jointTargets(ctx).length > 0) return [];
  const { slices } = currentPlan(ctx);
  if (slices.length < 2 || !ctx.config.slices.profiles.includes(ctx.state.profile)) return [];
  const max = ctx.config.slices.max;
  if (max < 2) return [];
  if (slices.length <= max) return slices;
  ctx.log(`方案分了 ${slices.length} 个切片，超过上限 ${max}，最后几片合并为一片`);
  return [...slices.slice(0, max - 1), slices.slice(max - 1).join("；")];
}

function sliceSection(index: number, total: number, title: string): string {
  return [
    "# 按切片实现",
    "",
    `方案把实施计划分成了 ${total} 个纵向切片（见 \`design.md\` 的实施计划）。每个切片由一个新的 agent 完成，你负责第 ${index} 片：**${title}**。`,
    "",
    index > 1
      ? `- 前面 ${index - 1} 片已经完成并提交：先读 \`implementation.md\` 中它们的记录，用 \`git log\` 看提交，在它们的基础上继续。`
      : "- 你是第一片：按上文的\"开始前\"记录基线提交，`implementation.md` 按完整结构写。",
    index < total ? "- 后面的切片由之后的 agent 完成，不要提前做它们的任务。" : "- 这是最后一片：完成后运行完整的测试、代码检查、类型检查和构建。",
    index > 1
      ? `- \`implementation.md\`：不改前面切片的记录，在末尾追加"## 切片 ${index}：${title}"一节，写本片的任务完成情况、改动的文件、测试结果、与方案的偏离。`
      : `- \`implementation.md\` 的任务完成情况表只填本片的任务，并注明"切片 1"；后面的切片会追加各自的一节。`,
    "- 本片做完的标志：本片对应的验收标准有测试或验证覆盖并通过，前面切片的测试仍然通过。提交信息中注明切片编号。",
    "- 结果文件：本片的任务全部完成写 `done`，否则写 `partial` 并在本片的记录里说明。",
  ].join("\n");
}

/** Files changed outside the feature directory since the attempt's code base. */
function changedOutsideFeature(ctx: PipelineContext): string[] | null {
  const files = changedFiles(ctx.repo, codeBaseCommit(ctx));
  return files === null ? null : files.filter((f) => !f.startsWith(`${ctx.featureDir}/`));
}

/** The scope check: changed files the plan did not list, for the code review and the report. */
function scopeLines(ctx: PipelineContext): string[] {
  const { files: planned } = currentPlan(ctx);
  if (planned.length === 0) return [];
  const changed = changedOutsideFeature(ctx);
  if (changed === null) return [];
  const extra = changed.filter((f) => !planned.some((p) => matchesPath(f, p)));
  if (extra.length === 0) return [`范围检查（流水线比对）：改动的 ${changed.length} 个文件都在方案列出的范围内`];
  const shown = extra.slice(0, 30).join("、");
  return [`范围检查（流水线比对）：共改动 ${changed.length} 个文件，其中 ${extra.length} 个不在方案列出的范围内：${shown}${extra.length > 30 ? " 等" : ""}`];
}

/** The confirmation point setting that applies to this requirement, or null. */
function approvalMode(ctx: PipelineContext): "ui" | "always" | null {
  const a = ctx.config.designApproval;
  if (a.mode === "off" || !a.profiles.includes(ctx.state.profile) || ctx.state.type === "assessment") return null;
  return a.mode;
}

/**
 * Design confirmation point: after the design review, the requester sees what they will get
 * (preview.md, a prototype for UI changes) and says "yes" before any code is written. The run
 * stops here once per attempt; --approve continues, a changed spec starts over from design.
 */
function confirmDesign(ctx: PipelineContext): void {
  const mode = approvalMode(ctx);
  if (!mode) return;
  const uiChange = currentPlan(ctx).uiChange;
  if (mode === "ui" && uiChange !== true) return;
  const approval = ctx.state.approval;
  if (approval?.attempt === ctx.state.attempt && approval.status === "approved") return;
  ctx.state.approval = { attempt: ctx.state.attempt, status: "waiting", at: new Date().toISOString() };
  save(ctx);
  throw new ApprovalNeeded();
}

/** Acceptance tests committed before the code (implement results): were they changed afterwards? */
function acceptanceLines(ctx: PipelineContext, target?: StepTarget): string[] {
  const lines: string[] = [];
  const suffix = target ? `@${target.slug}` : "";
  const keys = Object.keys(ctx.state.results)
    .filter((k) => k.endsWith(suffix) && (target || !k.includes("@")))
    .filter((k) => /^implement(-s\d+)?$/.test(target ? k.slice(0, -suffix.length) : k))
    .sort((a, b) => Number(a.replace(/@.*/, "").slice(11) || 0) - Number(b.replace(/@.*/, "").slice(11) || 0));
  for (const key of keys) {
    const r = ctx.state.results[key];
    const files = Array.isArray(r.acceptance_tests) ? (r.acceptance_tests as string[]).map((f) => f.trim()).filter(Boolean) : [];
    const commit = typeof r.acceptance_tests_commit === "string" ? r.acceptance_tests_commit.trim() : "";
    if (files.length === 0 || !commit) continue;
    const changed = changedSince(target?.repo ?? ctx.repo, commit, files);
    const where = key === "implement" ? "" : `（${key}）`;
    if (changed === null) lines.push(`验收测试锁定（流水线比对）${where}：记录的提交 ${commit} 不在仓库中，没能核对 ${files.length} 个验收测试是否被改过`);
    else if (changed.length === 0) lines.push(`验收测试锁定（流水线比对）${where}：${files.length} 个验收测试文件自提交 ${commit} 之后没有被修改`);
    else lines.push(`验收测试锁定（流水线比对）${where}：以下验收测试在提交 ${commit} 之后被修改：${changed.join("、")}`);
  }
  return lines;
}

/** Assessment: read-only research → assessment.md → independent review ⇄ revise. */
async function assessmentPhase(ctx: PipelineContext): Promise<void> {
  const rounds = ctx.config.profiles[ctx.state.profile].rounds;
  recordCodeBase(ctx);
  await runStep(ctx, "design");
  for (let r = 1; r <= rounds.designReview; r++) {
    const review = await runReview(ctx, "design_review", r, rounds.designReview);
    if (review.verdict === "approved") break;
    if (review.verdict === "blocked") {
      await answerFirst(ctx, review, r, rounds.designReview);
      continue;
    }
    await runStep(ctx, "design_revise", r, rounds.designReview);
  }
}

/**
 * The review says only the requester can decide (1.12): the builder first answers what the
 * code, the documents and the spec settle, in a revision of the design; what is left goes to
 * the requester, each with a recommended answer.
 */
async function answerFirst(ctx: PipelineContext, review: Record<string, unknown>, round: number, maxRounds: number): Promise<void> {
  const questions = (review.questions as string[]) ?? [];
  if (!ctx.config.answerQuestionsFirst) throw new BusinessDecisionNeeded(questions);
  const revised = await runStep(ctx, "design_revise", round, maxRounds, {
    contextLines: [`审核结论：需要需求方决定（${questions.length} 个问题，见 design-review.md）。按本步骤说明中"审核要求需求方决定时"一节，先自己找答案`],
  });
  const left = Array.isArray(revised.business_questions) ? (revised.business_questions as string[]).map((q) => q.trim()).filter(Boolean) : [];
  const answered = Math.max(0, questions.length - left.length);
  if (answered > 0) {
    recover(ctx, `design_revise-r${round}`, "self_answer", `方案审核提出的 ${questions.length} 个问题中，${answered} 个由 builder 从代码和文档中确定了答案${left.length > 0 ? `，${left.length} 个交给需求方` : "，不用等需求方"}`);
  }
  if (left.length > 0) throw new BusinessDecisionNeeded(left);
  // 1.12.1: answers the builder settled itself are checked by the reviewer before any code is
  // written. On the last round there is no next review, so one more is added — once.
  if (answered > 0 && round >= maxRounds) {
    const extra = round + 1;
    ctx.log(`方案审核的问题由 builder 自答后，加一轮方案审核（第 ${extra} 轮）复核这些答案`);
    const again = await runReview(ctx, "design_review", extra, extra);
    if (again.verdict === "blocked") throw new BusinessDecisionNeeded((again.questions as string[]) ?? []);
    if (again.verdict !== "approved") await runStep(ctx, "design_revise", extra, extra);
  }
}

/** Develop phase: design → design review ⇄ revise → implement → code review ⇄ fix → handoff. Returns the design result. */
async function developPhase(ctx: PipelineContext): Promise<Record<string, unknown>> {
  const rounds = ctx.config.profiles[ctx.state.profile].rounds;
  // Before anything is committed: a defect's reproduction test, committed while locating
  // the cause, must not make the whole test check count as failing before the change.
  const joint = jointTargets(ctx);
  recordCodeBase(ctx);
  await gateBaseline(ctx);
  for (const t of joint) {
    recordCodeBase(ctx, t);
    await gateBaseline(ctx, t);
  }

  let designExtras: StepExtras = {};
  if (proposalsApply(ctx) && !ctx.state.results.design) {
    const files = await runProposals(ctx);
    if (files.length > 0) designExtras = { sections: [proposalsSection(files, proposalMembers(ctx).length)] };
    else ctx.log("方案提案都没有完成，按原来的方式由一个 agent 做方案设计");
  }
  const design = await runStep(ctx, "design", null, null, designExtras);
  if (ctx.state.type === "defect" && design.reproduced === false) {
    // Fixing what could not be reproduced is guessing: ask for what is missing.
    throw new BusinessDecisionNeeded(design.questions as string[], "reproduce");
  }

  let designRounds = 0;
  for (let r = 1; r <= rounds.designReview; r++) {
    const review = await runReview(ctx, "design_review", r, rounds.designReview);
    designRounds = r;
    if (review.verdict === "approved") break;
    if (review.verdict === "blocked") {
      await answerFirst(ctx, review, r, rounds.designReview);
      continue;
    }
    // changes_required. The last round's revision goes straight to implementation;
    // the implementer reads both the review and the revision record.
    await runStep(ctx, "design_revise", r, rounds.designReview);
  }
  confirmDesign(ctx);
  const slices = implementationSlices(ctx);
  await milestone(
    ctx,
    "design-settled",
    `技术方案已经确定（审核 ${designRounds} 轮），开始写代码${slices.length > 0 ? `，分 ${slices.length} 个切片逐个完成` : ""}。写代码和代码检查通常是整个过程中最耗时的部分。`,
  );

  if (joint.length > 0) {
    // The other repositories get the settled design and the interface contract next to their code.
    syncJointDocs(activeJoint(ctx.state, ctx.jointNames ?? []), ctx.repo, ctx.featureDir, JOINT_DOCS, specTitle(ctx), ctx.log);
    save(ctx);
  }

  const implementHere = async () => {
    if (slices.length === 0) {
      await runStep(ctx, "implement", null, null, { gate: true });
      return;
    }
    for (const [i, title] of slices.entries()) {
      await runStep(ctx, "implement", null, null, {
        key: `implement-s${i + 1}`,
        title: `5-代码实现 第${i + 1}/${slices.length}片`,
        contextLines: [`切片：第 ${i + 1} 片，共 ${slices.length} 片（${title}）`],
        sections: [sliceSection(i + 1, slices.length, title)],
        gate: true,
      });
    }
  };
  // Joint requirement: every repository is implemented at the same time, against the contract.
  await allOrFirstError([implementHere(), ...joint.map((t) => runStep(ctx, "implement", null, null, { gate: true, target: t }))]);

  const reviewLoop = async (target?: StepTarget) => {
    for (let r = 1; r <= rounds.codeReview; r++) {
      const lines = [...gateLines(ctx, target), ...(target ? [] : scopeLines(ctx)), ...acceptanceLines(ctx, target)];
      const review = await runReview(ctx, "code_review", r, rounds.codeReview, lines, target);
      if (review.verdict === "pass") break;
      await runStep(ctx, "review_fix", r, rounds.codeReview, { gate: true, target });
    }
  };
  await allOrFirstError([reviewLoop(), ...joint.map((t) => reviewLoop(t))]);
  await runStep(ctx, "handoff", null, null, { contextLines: jointLines(ctx) });
  return design;
}

/** Files of the feature directory a joint repository gets a copy of, before its implementation. */
const JOINT_DOCS = ["spec.md", "alignment.md", "design.md", "contract.md", "preview.md", "prototype"];

/**
 * Waits for all of them, so no agent keeps working unseen after one failed; then fails with
 * the first failure, if any.
 */
async function allOrFirstError(runs: Array<Promise<unknown>>): Promise<void> {
  const settled = await Promise.allSettled(runs);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
}

/** Each joint repository's worktree, branch and what the gate found there, for the handoff and the report. */
function jointLines(ctx: PipelineContext): string[] {
  const lines: string[] = [];
  for (const t of jointTargets(ctx)) {
    lines.push(`联合需求的仓库「${t.name}」：工作区 ${t.repo}，分支 ${t.branch}，改动前的提交 ${codeBaseCommit(ctx, t)?.slice(0, 12) ?? "未知"}；实现、评审记录在那里的 ${ctx.featureDir}/`);
    lines.push(...gateLines(ctx, t), ...acceptanceLines(ctx, t));
  }
  return lines;
}

/**
 * Verify phase: service start → verification → defects as configured.
 * Returns true when the defects go back to development (defects "handback").
 */
async function verifyPhase(ctx: PipelineContext, design: Record<string, unknown>): Promise<boolean> {
  const settings = ctx.config.profiles[ctx.state.profile];
  const rounds = settings.rounds;
  const phases = runPhases(ctx.state);
  const serviceStart = phases.environment === "deployed" ? false : (ctx.config.phases.verify.serviceStart ?? settings.serviceStart);

  if (design.has_runnable_service === true && serviceStart) {
    await runStep(ctx, "service_start");
  } else if (design.has_runnable_service === true && phases.environment === "deployed") {
    ctx.log("在已部署的测试环境中验证，不在本地做服务启动验证。");
  } else if (design.has_runnable_service === true) {
    ctx.log(`${PROFILE_LABELS[ctx.state.profile]}档不执行服务启动验证，由功能验证一并处理。`);
  } else {
    ctx.log("方案设计判断项目没有常驻服务，跳过服务启动验证。");
  }

  const joint = jointTargets(ctx);
  const jointContext = joint.length > 0 ? { contextLines: jointLines(ctx) } : {};
  const verification = await runStep(ctx, "verify", null, null, jointContext);
  if (verification.result !== "defects_found") return false;
  if (phases.defects === "report") {
    ctx.log("验证发现了问题，按设置只记录、不修复，直接写报告。");
    return false;
  }
  if (phases.defects === "handback") {
    const used = ctx.state.handbacks ?? 0;
    if (used < rounds.defectFix) return true;
    ctx.log(`已经退回研发 ${used} 次（上限 ${rounds.defectFix}），不再退回，问题写进报告。`);
    return false;
  }
  await milestone(ctx, "fixing-defects", `验证中发现了一些问题，正在修复并重新验证（最多 ${rounds.defectFix} 轮）。`);
  let found = verification;
  for (let r = 1; r <= rounds.defectFix; r++) {
    // Joint requirement: each defect is fixed in the repository it belongs to.
    const where = defectTargets(ctx, found);
    await allOrFirstError(where.map((t) => runStep(ctx, "defect_fix", r, rounds.defectFix, { gate: true, target: t ?? undefined, ...(t ? {} : jointContext) })));
    const recheck = await runStep(ctx, "reverify", r, rounds.defectFix, jointContext);
    if (recheck.result === "pass") break;
    found = recheck;
  }
  return false;
}

/**
 * Where the defects of a verification (or re-verification) are: null stands for this
 * repository. Results name the repositories in `defect_repos` ("本仓库" or a joint name);
 * without it, every repository of a joint requirement is asked to look.
 */
function defectTargets(ctx: PipelineContext, result: Record<string, unknown>): Array<StepTarget | null> {
  const joint = jointTargets(ctx);
  if (joint.length === 0) return [null];
  const named = Array.isArray(result.defect_repos) ? (result.defect_repos as string[]).map((n) => n.trim()) : [];
  if (named.length === 0) return [null, ...joint];
  const here = named.some((n) => n === "本仓库" || n === "主仓库");
  const there = joint.filter((t) => named.includes(t.name));
  const out: Array<StepTarget | null> = [...(here ? [null] : []), ...there];
  return out.length > 0 ? out : [null, ...joint];
}

/**
 * Defects found in the verify phase go back to development: recorded in changes.md (source
 * "测试验证"), then a new attempt starts from design and only handles them (incremental).
 */
async function handBack(ctx: PipelineContext): Promise<void> {
  const n = (ctx.state.handbacks ?? 0) + 1;
  const changes = path.join(ctx.repo, ctx.featureDir, "changes.md");
  const today = new Date().toISOString().slice(0, 10);
  const section = [
    "",
    `## ${today} 测试验证退回（第 ${n} 次）`,
    "",
    "- 来源：测试验证",
    `- 内容：第 ${ctx.state.attempt} 次尝试的功能验证发现了缺陷，缺陷清单见 verification.md 最后一轮的“缺陷”一节`,
    "- 处理：回到研发阶段，从方案设计开始只处理这些缺陷，修复经过代码评审后重新写提测说明、再提测",
    "",
  ].join("\n");
  fs.appendFileSync(changes, fs.existsSync(changes) ? section : `# 变更记录\n${section}`);
  ctx.state.handbacks = n;
  ctx.state.incremental = {
    fromAttempt: ctx.state.attempt,
    reason: `测试验证发现缺陷，第 ${n} 次退回研发阶段修复（见 changes.md 和 verification.md）`,
    baseCommit: headCommit(ctx.repo),
    hadImplementation: true,
  };
  ctx.state.attempt += 1;
  ctx.state.results = {};
  ctx.state.milestones = [];
  ctx.state.phase = "develop";
  // Fixing defects does not change what the requester confirmed: no second confirmation.
  if (ctx.state.approval?.status === "approved") ctx.state.approval = { ...ctx.state.approval, attempt: ctx.state.attempt };
  save(ctx);
  ctx.log(`测试验证发现缺陷，第 ${n} 次退回研发阶段（第 ${ctx.state.attempt} 次尝试）`);
  const text = `测试验证发现了缺陷，按设置退回研发阶段修复（第 ${n} 次）：从方案设计开始只处理这些缺陷，修完经过代码评审后${runPhases(ctx.state).mode === "gated" ? "重新提测" : "再次验证"}。`;
  await notifyOrigin(ctx, milestoneMessage(text));
  await notifyExternal(ctx, "milestone", text, { milestone: `handback-${n}` });
}

function usageLines(ctx: PipelineContext): string[] {
  const thisAttempt = ctx.state.history.filter((h) => h.attempt === ctx.state.attempt);
  const lines = [`用时与用量（本次尝试，截至报告前）：${describeTotals(totals(thisAttempt))}`];
  if (ctx.state.attempt > 1) lines.push(`用时与用量（这个需求的全部尝试）：${describeTotals(totals(ctx.state.history))}`);
  if (ctx.state.phases && runPhases(ctx.state).mode !== "continuous") {
    for (const [phase, label] of [["develop", "研发阶段"], ["verify", "测试验证阶段"]] as const) {
      const records = ctx.state.history.filter((h) => (h.phase ?? "develop") === phase);
      if (records.length > 0) lines.push(`用时与用量（${label}，全部尝试）：${describeTotals(totals(records))}`);
    }
  }
  return lines;
}

/** Joint requirement: the other repositories' worktrees exist and have the current spec. */
async function setUpJoint(ctx: PipelineContext): Promise<void> {
  const names = ctx.jointNames ?? [];
  if (names.length === 0) return;
  try {
    const entries = await ensureJointRepos({
      runtime: ctx.runtime,
      state: ctx.state,
      featureDir: ctx.featureDir,
      names,
      related: ctx.config.relatedRepos,
      projectDir: ctx.state.worktree?.sourceRepo ?? ctx.repo,
      title: specTitle(ctx),
      log: ctx.log,
    });
    save(ctx);
    syncJointDocs(entries, ctx.repo, ctx.featureDir, ["spec.md", "alignment.md"], specTitle(ctx), ctx.log);
    save(ctx);
  } catch (error) {
    save(ctx);
    throw new StepFailure("联合开发准备", (error as Error).message);
  }
}

/** What the report is told about this attempt: usage, the quality gate, the scope check. */
/** The requirement's cards in external systems, for the report's appendix. */
function externalLines(ctx: PipelineContext): string[] {
  return describeExternal(ctx.state.external).map((l) => `外部系统 ${l}`);
}

function reportLines(ctx: PipelineContext): string[] {
  const lines = [...usageLines(ctx), ...gateLines(ctx), ...scopeLines(ctx), ...acceptanceLines(ctx), ...jointLines(ctx), ...externalLines(ctx)];
  if (ctx.config.checks.length === 0 && ctx.state.type !== "assessment") {
    lines.push("质量门：项目没有配置检查（checks），流水线没有自己运行检查，以各步骤记录的检查结果为准");
  }
  return lines;
}

/** Steps 3–11. Loop rounds and optional steps come from the run's profile; the gate from the execution mode. */
async function flow(ctx: PipelineContext): Promise<Record<string, unknown>> {
  await setUpJoint(ctx);
  if (ctx.state.type === "assessment") {
    // Read-only: no code, so no implementation, review of code, handoff or verification.
    await assessmentPhase(ctx);
    const changed = changedOutsideFeature(ctx) ?? [];
    if (changed.length > 0) ctx.log(`评估期间功能目录之外有文件被改动：${changed.join("、")}`);
    return runStep(ctx, "report", null, null, {
      contextLines: [
        ...usageLines(ctx),
        ...(changed.length > 0
          ? [`评估期间改动了功能目录之外的文件（评估不应改动代码，请在报告中如实说明）：${changed.slice(0, 30).join("、")}`]
          : []),
      ],
    });
  }
  for (;;) {
    const design = await developPhase(ctx);
    const phases = runPhases(ctx.state);
    if (phaseOf(ctx) !== "verify") {
      if (phases.mode === "develop-only") {
        await stopManagedServices(ctx);
        return runStep(ctx, "report", null, null, {
          contextLines: [...reportLines(ctx), "只做研发：本次不做测试验证，完成报告按本步骤说明中“只做研发时”一节写成研发报告"],
        });
      }
      if (phases.mode === "gated") {
        const at = ctx.state.verifyAt ? new Date(ctx.state.verifyAt) : null;
        if (!at || at.getTime() > Date.now()) throw new PhaseGate();
        ctx.log("研发完成时已经过了预约的测试验证时间，直接开始测试验证");
        ctx.state.verifyAt = null;
      } else {
        await milestone(ctx, "code-reviewed", "代码已经写完并通过检查，开始按验收标准逐条验证功能。");
      }
      ctx.state.phase = "verify";
      save(ctx);
      await integrate(ctx, "verify");
    }
    if (!(await verifyPhase(ctx, design))) break;
    await handBack(ctx);
  }
  await stopManagedServices(ctx);
  return runStep(ctx, "report", null, null, { contextLines: reportLines(ctx) });
}

export async function runPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
  ctx.state.status = "running";
  ctx.state.stopReason = null;
  ctx.state.stopKind = null;
  ctx.state.pendingQuestions = null;
  save(ctx);
  await integrate(ctx, phaseOf(ctx) === "verify" ? "verify" : "started");
  try {
    await checkQuota(ctx);
    const report = await flow(ctx);
    ctx.state.status = "completed";
    ctx.state.outcome = report.outcome as string;
    save(ctx);
    const developOnly = runPhases(ctx.state).mode === "develop-only" && phaseOf(ctx) !== "verify";
    await notifyOrigin(
      ctx,
      completedMessage({
        featureDir: shownFeatureDir(ctx),
        outcome: report.outcome as string,
        summary: report.summary as string,
        reportPath: `${shownFeatureDir(ctx)}/report.md`,
        handoffPath: developOnly ? `${shownFeatureDir(ctx)}/handoff.md` : null,
      }),
    );
    const outcomeText: Record<string, string> = {
      completed: "已完成，可以验收",
      completed_with_issues: "已完成，但有遗留问题",
      not_completed: "未完成",
    };
    const text = developOnly
      ? `研发已完成（只做研发）：${outcomeText[report.outcome as string] ?? report.outcome}，请按提测说明人工测试。`
      : `开发流水线已结束：${outcomeText[report.outcome as string] ?? report.outcome}。`;
    // Develop-only ends where testing by people begins: for the card that is "研发完成，待测试".
    if (developOnly && report.outcome !== "not_completed") pushBranch(ctx);
    await integrate(ctx, developOnly && report.outcome !== "not_completed" ? "phase_done" : "completed");
    await notifyExternal(ctx, "completed", text, {
      outcome: report.outcome,
      summary: report.summary,
      reportPath: `${ctx.featureDir}/report.md`,
      ...(developOnly ? { mode: "develop-only", handoffPath: `${ctx.featureDir}/handoff.md` } : {}),
    });
    return "completed";
  } catch (error) {
    if (error instanceof PhaseGate) {
      ctx.state.status = "phase_done";
      ctx.state.stopReason = null;
      ctx.state.stopKind = "phase_gate";
      save(ctx);
      await stopManagedServices(ctx);
      const verifyAt = await scheduleVerifyStart(ctx);
      const reminderHours = verifyAt ? null : await scheduleReminder(ctx, "phase");
      await notifyOrigin(
        ctx,
        phaseDoneMessage({
          featureDir: shownFeatureDir(ctx),
          handoffPath: `${shownFeatureDir(ctx)}/handoff.md`,
          verifyCommand: verifyCommandOf(ctx),
          environment: runPhases(ctx.state).environment,
          verifyAt,
          reminderHours,
          handbacks: ctx.state.handbacks ?? 0,
        }),
      );
      pushBranch(ctx);
      await integrate(ctx, "phase_done");
      await notifyExternal(ctx, "phase_done", `研发已完成，可以提测：提测说明在 ${ctx.featureDir}/handoff.md。${verifyAt ? `已预约在 ${verifyAt} 开始测试验证。` : ""}`, {
        handoffPath: `${ctx.featureDir}/handoff.md`,
        mode: runPhases(ctx.state).mode,
        verifyCommand: verifyCommandOf(ctx),
        verifyAt: ctx.state.verifyAt ?? null,
        handbacks: ctx.state.handbacks ?? 0,
      });
      return "phase_done";
    }
    if (error instanceof ApprovalNeeded) {
      ctx.state.status = "waiting_for_approval";
      ctx.state.stopReason = null;
      ctx.state.stopKind = "approval";
      save(ctx);
      const autoContinueAt = await scheduleApprovalContinue(ctx);
      const reminderHours = await scheduleReminder(ctx, "approval");
      const prototype = path.join(ctx.repo, ctx.featureDir, "prototype");
      await notifyOrigin(
        ctx,
        approvalMessage({
          featureDir: shownFeatureDir(ctx),
          previewPath: `${shownFeatureDir(ctx)}/preview.md`,
          prototypePath: fs.existsSync(prototype) ? `${shownFeatureDir(ctx)}/prototype/` : null,
          approveCommand: approveCommandOf(ctx),
          resumeCommand: ctx.resumeCommand,
          reminderHours,
          autoContinueAt,
        }),
      );
      await integrate(ctx, "approval");
      await notifyExternal(ctx, "approval", `方案已通过审核，请需求方确认"做完后会看到什么"再开始写代码：${ctx.featureDir}/preview.md`, {
        previewPath: `${ctx.featureDir}/preview.md`,
        approveCommand: approveCommandOf(ctx),
        resumeCommand: ctx.resumeCommand,
      });
      return "waiting_for_approval";
    }
    if (error instanceof BusinessDecisionNeeded) {
      const reproduce = error.source === "reproduce";
      ctx.state.status = "waiting_for_business";
      ctx.state.stopKind = reproduce ? "reproduce" : "business";
      ctx.state.pendingQuestions = error.questions;
      ctx.state.stopReason = `${reproduce ? "没能复现缺陷，需要需求方补充信息" : "方案审核需要需求方决定"}：${error.questions.join("；")}`;
      save(ctx);
      const reminderHours = await scheduleReminder(ctx, error.questions);
      await notifyOrigin(
        ctx,
        blockedMessage({ featureDir: shownFeatureDir(ctx), questions: error.questions, resumeCommand: ctx.resumeCommand, reminderHours, source: error.source }),
      );
      const external = reproduce
        ? `没能复现这个缺陷，需要需求方补充 ${error.questions.length} 项信息，流水线已暂停，请到发起的对话中回答。`
        : `方案审核发现 ${error.questions.length} 个需要需求方决定的问题，流水线已暂停，请到发起的对话中回答。`;
      await integrate(ctx, "blocked");
      await notifyExternal(ctx, "blocked", external, {
        questions: error.questions,
        resumeCommand: ctx.resumeCommand,
      });
      return "waiting_for_business";
    }
    if (error instanceof BudgetReached) {
      // Continuing (req resume, or "继续开发") gives one more budget.
      const limit = ctx.config.budget.tokens ?? error.allowance;
      ctx.state.status = "failed";
      ctx.state.stopKind = "budget";
      ctx.state.stopReason = `${error.message}，已停下等你决定是否继续`;
      ctx.state.budget = { allowance: error.allowance + limit, warnedAt: ctx.state.budget?.warnedAt ?? null };
      save(ctx);
      await notifyOrigin(
        ctx,
        [
          "【需求开发流水线通知 · 用完 token 预算】",
          "",
          `功能目录：${shownFeatureDir(ctx)}`,
          `情况：这个需求已用 ${tokenText(error.used)} tokens，到了预算 ${tokenText(error.allowance)}。已完成的步骤都保留，流水线停在下一步开始之前。`,
          "",
          "请这样处理：把用量告诉用户（可以运行查看进度的命令看各步骤），问是否继续。",
          `- 继续：执行下面的命令，会再给一份预算（到 ${tokenText(error.allowance + limit)} 时再停）：\n\n${ctx.resumeCommand}`,
          "- 不继续：不用执行任何命令；需要时可以缩小需求范围再继续。",
        ].join("\n"),
      );
      await integrate(ctx, "failed");
      await notifyExternal(ctx, "failed", `需求 ${featureName(ctx.featureDir)} 用完了 token 预算（${tokenText(error.used)}），已暂停等需求方决定`, {
        reason: error.message,
        resumeCommand: ctx.resumeCommand,
      });
      return "failed";
    }
    const stepTitle = error instanceof StepFailure ? error.stepTitle : "流水线";
    ctx.state.status = "failed";
    ctx.state.stopReason = `${stepTitle}：${(error as Error).message}`;
    ctx.state.stopKind = failureKind(error);
    save(ctx);
    const autoResumeAt =
      error instanceof StepFailure && isTransientError((error as Error).message) ? await scheduleAutoResume(ctx, (error as Error).message) : null;
    await notifyOrigin(
      ctx,
      failedMessage({
        stepTitle,
        reason: (error as Error).message,
        logPath: ctx.logPath,
        resumeCommand: ctx.resumeCommand,
        autoResumeAt,
      }),
    );
    await integrate(ctx, "failed");
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
