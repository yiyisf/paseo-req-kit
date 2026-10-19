import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IntegrationConfig, validateIntegrations } from "./integrations.js";
import { NOTIFIER_EVENT_TYPES, type NotifierConfig } from "./notifiers.js";
import type { StepId } from "./steps.js";

export interface AgentProfile {
  /**
   * Name (or ID) of a Paseo agent profile to take the settings from, e.g. "实现".
   * Resolved against the daemon when a run starts; fields written next to it win.
   * See paseo-profiles.ts.
   */
  paseoProfile?: string;
  /**
   * "provider/model", split at the first "/". Examples: "claude/claude-sonnet-5",
   * "pi/anthropic/claude-sonnet-5" (Pi model IDs carry their own "upstream/model").
   * Run `npm run smoke -- check` to list what your daemon offers. Required unless
   * paseoProfile is given.
   */
  provider?: string;
  /**
   * Provider mode. Use one that does not stop for approvals, e.g. "bypassPermissions" (Claude)
   * or "full-access" (Codex). Omit it for providers without modes, such as Pi.
   */
  modeId?: string;
  thinkingOptionId?: string;
  /** Provider feature toggles, e.g. { "auto_accept": true } for OpenCode. */
  featureValues?: Record<string, unknown>;
  /** Provider-native options, passed through unchanged. */
  options?: Record<string, unknown>;
}

/** Settings ready to launch an agent: a Paseo profile, if named, has been resolved. */
export type ResolvedProfile = AgentProfile & { provider: string };

export function isResolved(profile: AgentProfile): profile is ResolvedProfile {
  return typeof profile.provider === "string" && profile.provider.includes("/");
}

export interface ReviewPanelMember extends AgentProfile {
  /** Short name shown in titles and the consolidated review, e.g. "安全视角". */
  name?: string;
  /** Extra focus for this member, appended to its prompt, e.g. "重点检查权限和数据安全". */
  focus?: string;
}

export interface ReviewPanelSettings {
  enabled: boolean;
  /** Which reviews use the panel (first round only; later rounds check fixes with the single reviewer). */
  steps: Array<"design_review" | "code_review">;
  /** Which profiles use the panel. */
  profiles: ProfileName[];
  /** Reviewers that run in parallel; the configured reviewer then consolidates their findings. */
  members: ReviewPanelMember[];
}

export type ProfileName = "quick" | "standard";

export const PROFILE_NAMES: readonly ProfileName[] = ["quick", "standard"];

export const PROFILE_LABELS: Record<ProfileName, string> = { quick: "快速", standard: "标准" };

export interface ProfileSettings {
  /** Maximum number of rounds for each review/fix loop. */
  rounds: { designReview: number; codeReview: number; defectFix: number };
  /** Run the service start check when the design says the project has a long-running service. */
  serviceStart: boolean;
}

/**
 * How the develop phase (design → code review → handoff) and the verify phase
 * (service start → verification → defect fixes) relate. See ADR 0022.
 * - continuous: verification follows straight away (the behaviour before 1.7)
 * - gated: the run stops after the handoff ("研发完成，待测试验证"); someone starts the verify phase later
 * - develop-only: the run ends after the handoff with a development report; people test by hand
 */
export type PhaseMode = "continuous" | "gated" | "develop-only";

export const PHASE_MODES: readonly PhaseMode[] = ["continuous", "gated", "develop-only"];

export const PHASE_MODE_LABELS: Record<PhaseMode, string> = { continuous: "连续", gated: "分阶段", "develop-only": "只做研发" };

/** Where the verify phase checks the result: services started here, or an environment deployed for testing. */
export type VerifyEnvironment = "local" | "deployed";

/** What the verify phase does with defects: fix and re-verify, hand back to a new develop round, or only record them. */
export type DefectHandling = "fix" | "handback" | "report";

export interface VerifyPhaseSettings {
  environment: VerifyEnvironment;
  /** Agents for the verify-phase steps, per role; a role left out uses the top-level agents. */
  agents: Partial<Record<"builder" | "reviewer", AgentProfile>>;
  defects: DefectHandling;
  /** Run the service start check in the verify phase; null: as the profile says. Ignored for "deployed". */
  serviceStart: boolean | null;
}

export interface PhaseSettings {
  mode: PhaseMode;
  verify: VerifyPhaseSettings;
}

/**
 * Requirement types with their own playbook (see playbooks.ts and ADR 0023). The spec's
 * "- 类型：" line picks one; anything else (新需求, 小改动) runs the normal flow.
 */
export type RequirementType = "defect" | "refactor" | "assessment";

export const REQUIREMENT_TYPES: readonly RequirementType[] = ["defect", "refactor", "assessment"];

export const REQUIREMENT_TYPE_LABELS: Record<RequirementType, string> = { defect: "缺陷修复", refactor: "重构", assessment: "评估" };

/**
 * One project check the engine runs itself (the quality gate): formatting, lint, type
 * check, tests, build. Commands should read the same on every system (see /req-setup).
 */
export interface CheckDef {
  /** Short name, e.g. "lint", "web 测试". */
  name: string;
  command: string;
  /** Directory to run in, relative to the repository root; default the root. */
  cwd?: string;
  /**
   * Run only when the change touches these paths (prefixes like "web/", or globs with *);
   * default: `cwd` when given, otherwise always. Lets a monorepo check only changed modules.
   */
  paths?: string[];
  /** Minutes before the check is stopped; default qualityGate.timeoutMinutes. */
  timeoutMinutes?: number;
}

export interface QualityGateSettings {
  /** How many times the step agent is asked to fix newly failing checks before the run moves on. */
  fixAttempts: number;
  /** Default time limit of one check. */
  timeoutMinutes: number;
}

/** A repository the step agents may read but never change (e.g. the backend of a frontend project). */
export interface RelatedRepo {
  /** Name used in prompts and reports, e.g. "后端". */
  name: string;
  /** Path on this machine: absolute, "~/…", or relative to the project's checkout. */
  path: string;
  /** What it is for, e.g. "提供登录和订单接口". */
  role?: string;
}

/**
 * 1.12: after the push, a draft merge request made with the machine's own GitLab (or other)
 * command, logged in beforehand. Placeholders: {branch} {target} {title} {description} {card}
 * {cardUrl}. Never merged by req-kit.
 */
export interface MergeRequestSettings {
  command: string;
  args: string[];
  /** Branch the merge request targets; default: the remote's default branch (origin/HEAD), else main. */
  target?: string | null;
  /** Arguments that check the command is logged in (req doctor), e.g. ["auth", "status"]. */
  check?: string[] | null;
  timeoutSeconds?: number;
}

export interface PipelineConfig {
  daemonUrl: string;
  /** Name of the environment variable holding the daemon password, if the daemon has one. */
  daemonPasswordEnv: string;
  /**
   * builder and reviewer; `fallback` (1.12, optional) is used when a step's own agent keeps
   * failing (rate limits or quota after the retries, an agent error): the step is run once
   * more with it instead of stopping.
   */
  agents: Record<"builder" | "reviewer", AgentProfile> & { fallback?: AgentProfile | null };
  /**
   * 1.12: handle failures without a person where that is safe: wait once more for a step that
   * runs over its time, redo a step once after an agent error or an invalid result file.
   */
  selfHeal: boolean;
  /**
   * 1.12: questions the design review says only the requester can decide go to the builder
   * first, who answers what the code, the documents and the spec settle; only the real
   * business choices, each with a recommended answer, reach the requester.
   */
  answerQuestionsFirst: boolean;
  /** Profile used when neither --profile nor the spec names one. */
  defaultProfile: ProfileName;
  profiles: Record<ProfileName, ProfileSettings>;
  stepTimeoutMinutes: Record<StepId, number>;
  /** Send short progress notes to the chat at key points (design settled, review done, fixing defects). */
  notifyMilestones: boolean;
  /** Length of one waitForFinish() call. Long waits are split so a dropped connection costs little. */
  waitChunkSeconds: number;
  /** How often to re-check an agent that is waiting for a permission decision. */
  permissionPollSeconds: number;
  /** How many times to ask an agent to fix a missing or invalid result file. */
  resultFollowUps: number;
  /** Create step agents as subagents of the chat that launched the pipeline. */
  attachToOriginChat: boolean;
  /** Archive each step agent after its step completes. */
  archiveStepAgents: boolean;
  /** Machine config only: path of a team config file merged between the machine and project configs. */
  teamConfig: string | null;
  /** Range of req-kit versions this team or project expects, e.g. ">=1.2.0 <2". Checked, never enforced. */
  requiredVersion: string | null;
  /** Optional review panel: several reviewers in parallel, then a consolidation. Off by default. */
  reviewPanel: ReviewPanelSettings;
  /** External notifiers (e.g. an internal IM). Machine or team config only. */
  notifiers: NotifierConfig[];
  /**
   * 1.12: how to reach people by name, for notifiers that send to a person: the requester's
   * name as the card shows it → their accounts, e.g. { "张广祥": { "um": "ZHANGGX001" } }.
   * Machine or team config only.
   */
  people: Record<string, Record<string, string>>;
  /** External systems kept in step with requirements, e.g. an ALM's CLI (1.9). Machine or team config only: they run commands. */
  integrations: IntegrationConfig[];
  /** Per integration name, values for its {field.*} placeholders; a project's file may set these (e.g. its project id). */
  integrationDefaults: Record<string, Record<string, string>>;
  /**
   * Pushing the branch of a requirement that started from a card, once development is done and
   * the handoff is written (1.10). Off by default; machine or team config only. Never forced,
   * only to branches under `branchPrefix`, never merged.
   */
  push: { enabled: boolean; remote: string; branchPrefix: string; mergeRequest?: MergeRequestSettings | null };
  /**
   * Which cards this repository takes (1.10, written by /req-setup in the project's file): the
   * system, its space (project id) and subsystems; `titleKeywords` tells apart repositories
   * that share a subsystem (e.g. "message-service", "后端").
   */
  cardSource: { system: string; projectId: string | null; subsystems: string[]; titleKeywords: string[] } | null;
  /**
   * The intake process (1.11, `req factory`): how often it looks for new cards, which title tags
   * mark a card for it, and how many requirements it starts per look at most. Machine or team
   * config only.
   */
  factory: { pollMinutes: number; titleTags: string[]; maxNewPerPoll: number };
  /**
   * 1.12: a requirement from a card that is small (quick profile) and has nothing to answer
   * starts this many hours after its summary is on the card, unless the requester objects; 0: off.
   */
  autoConfirm: { hours: number };
  /**
   * 1.13: tokens (input + output, all steps and attempts) one requirement may use before the
   * pipeline stops to ask; null: no limit. A notice at warnPercent; continuing gives one more budget.
   */
  budget: { tokens: number | null; warnPercent: number };
  /** Automatic retries of a step after a transient error (rate limit, dropped connection). */
  retry: { attempts: number; backoffSeconds: number[] };
  /**
   * "auto": when the chat's workspace has service scripts in paseo.json, the pipeline starts
   * them through Paseo (supervised, own port per worktree) for the service start and
   * verification steps, and stops them afterwards. "off": step agents start services themselves.
   */
  paseoServices: "auto" | "off";
  /** How long to wait for Paseo-managed services to report healthy. */
  serviceReadySeconds: number;
  /** Warn before a run when a provider's subscription window is at least this full (percent); 0 turns it off. */
  quotaWarnPercent: number;
  /**
   * Parallel design proposals: before the design step, several agents (different models
   * work best) each propose an approach; the design step compares them and decides.
   * Members default to the builder and the reviewer. Off by default (it costs extra runs).
   */
  designProposals: { enabled: boolean; profiles: ProfileName[]; members: ReviewPanelMember[] };
  /** "auto": tell verification steps to use Paseo's browser tools for web pages when they are on. */
  browserVerify: "auto" | "off";
  /** When /req offers the independent spec review before confirmation: "standard" (standard profile only), "always", "off". */
  specReview: "standard" | "always" | "off";
  /** Machine-wide limit on pipelines running at once; later ones queue. 0: no limit. */
  maxConcurrentPipelines: number;
  /** How often a queued pipeline checks for a free slot. */
  queuePollSeconds: number;
  /** Remind the chat (a Paseo schedule) when a decision has been waited for this long; 0: never. */
  waitingReminderHours: number;
  /** After a stop caused by a transient error, continue automatically after this many minutes (through the chat); 0: never. */
  autoResumeMinutes: number;
  /** How many automatic continuations per attempt. */
  autoResumeMax: number;
  /** Ask the chat to check on a running pipeline this often and continue it if the process died; 0: off. */
  watchdogMinutes: number;
  /** Develop and verify phases: continuous (default), gated, or develop-only, plus verify-phase options. */
  phases: PhaseSettings;
  /** Requirement types whose playbook is used; a type left out runs the normal flow. */
  requirementTypes: RequirementType[];
  /** Project checks for the quality gate; empty: no gate. Usually in the project config, written by /req-setup. */
  checks: CheckDef[];
  qualityGate: QualityGateSettings;
  /**
   * Slice-by-slice implementation: when the design splits the work into vertical slices,
   * each slice is implemented by a fresh agent, committed and checked on its own.
   */
  slices: { profiles: ProfileName[]; max: number };
  /** Repositories the steps may read for reference, never change. */
  relatedRepos: RelatedRepo[];
  /**
   * Design confirmation point (1.8): after the design review, show the requester what they
   * will get (preview.md, a prototype for UI changes) and wait for "yes" before writing code.
   * mode "ui": only when the design says the change is visible in the UI; "always"; "off".
   * autoContinueHours > 0: carry on with the design after that long without an answer.
   */
  designApproval: { mode: "off" | "ui" | "always"; profiles: ProfileName[]; autoContinueHours: number };
  /**
   * Code review in two axes (1.8): the first round runs a spec reviewer (is every AC done, is
   * anything outside the scope) and a standards reviewer (project conventions, tests, security)
   * in parallel; the reviewer consolidates. A configured review panel takes precedence.
   */
  reviewAxes: { enabled: boolean; profiles: ProfileName[] };
}

export const DEFAULT_CONFIG: PipelineConfig = {
  daemonUrl: "ws://127.0.0.1:6767/ws",
  daemonPasswordEnv: "PASEO_DAEMON_PASSWORD",
  agents: {
    builder: { provider: "claude/CHANGE-ME", modeId: "bypassPermissions" },
    reviewer: { provider: "codex/CHANGE-ME", modeId: "full-access" },
  },
  defaultProfile: "standard",
  profiles: {
    quick: { rounds: { designReview: 1, codeReview: 1, defectFix: 1 }, serviceStart: false },
    standard: { rounds: { designReview: 2, codeReview: 3, defectFix: 3 }, serviceStart: true },
  },
  stepTimeoutMinutes: {
    design: 60,
    design_review: 30,
    design_revise: 30,
    implement: 240,
    code_review: 45,
    review_fix: 90,
    service_start: 30,
    verify: 120,
    defect_fix: 120,
    reverify: 90,
    report: 30,
    handoff: 30,
    panel_review: 45,
    spec_review: 20,
    design_proposal: 45,
  },
  notifyMilestones: true,
  waitChunkSeconds: 600,
  permissionPollSeconds: 30,
  resultFollowUps: 2,
  attachToOriginChat: true,
  archiveStepAgents: false,
  teamConfig: null,
  requiredVersion: null,
  reviewPanel: { enabled: false, steps: ["design_review", "code_review"], profiles: ["standard"], members: [] },
  notifiers: [],
  people: {},
  integrations: [],
  integrationDefaults: {},
  push: { enabled: false, remote: "origin", branchPrefix: "req/" },
  cardSource: null,
  factory: { pollMinutes: 5, titleTags: ["[AI]", "【AI】"], maxNewPerPoll: 3 },
  autoConfirm: { hours: 0 },
  budget: { tokens: null, warnPercent: 80 },
  retry: { attempts: 2, backoffSeconds: [60, 300] },
  paseoServices: "auto",
  serviceReadySeconds: 120,
  quotaWarnPercent: 85,
  designProposals: { enabled: false, profiles: ["standard"], members: [] },
  browserVerify: "auto",
  specReview: "standard",
  maxConcurrentPipelines: 0,
  queuePollSeconds: 60,
  waitingReminderHours: 24,
  autoResumeMinutes: 30,
  autoResumeMax: 2,
  watchdogMinutes: 60,
  selfHeal: true,
  answerQuestionsFirst: true,
  phases: { mode: "continuous", verify: { environment: "local", agents: {}, defects: "fix", serviceStart: null } },
  requirementTypes: ["defect", "refactor", "assessment"],
  checks: [],
  qualityGate: { fixAttempts: 2, timeoutMinutes: 20 },
  slices: { profiles: ["standard"], max: 6 },
  relatedRepos: [],
  designApproval: { mode: "ui", profiles: ["standard"], autoContinueHours: 0 },
  reviewAxes: { enabled: true, profiles: ["standard"] },
};

/** Project file, at the repository root, that overrides the machine-wide configuration. */
export const PROJECT_CONFIG_FILE = ".requirement-pipeline.json";

/** Settings that describe this machine, not a project; a project file may not change them. */
export const MACHINE_ONLY_KEYS = ["daemonUrl", "daemonPasswordEnv", "teamConfig"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`${label}不是合法的 JSON（${file}）：${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new ConfigError(`${label}的顶层必须是对象（${file}）`);
  return raw;
}

/** Layers `raw` over `base`. Agents are replaced per role; nested settings are merged per key. */
function merge(base: PipelineConfig, raw: Record<string, unknown>): PipelineConfig {
  const merged: PipelineConfig = { ...base, ...(raw as Partial<PipelineConfig>) };
  merged.agents = { ...base.agents, ...(isRecord(raw.agents) ? raw.agents : {}) } as PipelineConfig["agents"];
  // Integration defaults add up by integration and field: the team sets the shared ones, a project its own.
  if (isRecord(raw.integrationDefaults)) {
    const combined: Record<string, Record<string, string>> = { ...base.integrationDefaults };
    for (const [name, fields] of Object.entries(raw.integrationDefaults)) {
      combined[name] = { ...(combined[name] ?? {}), ...(isRecord(fields) ? (fields as Record<string, string>) : {}) };
    }
    merged.integrationDefaults = combined;
  }
  merged.push = { ...base.push, ...(isRecord(raw.push) ? raw.push : {}) } as PipelineConfig["push"];
  merged.factory = { ...base.factory, ...(isRecord(raw.factory) ? raw.factory : {}) } as PipelineConfig["factory"];
  merged.autoConfirm = { ...base.autoConfirm, ...(isRecord(raw.autoConfirm) ? raw.autoConfirm : {}) } as PipelineConfig["autoConfirm"];
  merged.budget = { ...base.budget, ...(isRecord(raw.budget) ? raw.budget : {}) } as PipelineConfig["budget"];
  if (isRecord(raw.cardSource)) {
    const c = raw.cardSource;
    merged.cardSource = {
      system: c.system as string,
      projectId: c.projectId === undefined || c.projectId === null ? null : String(c.projectId),
      subsystems: (c.subsystems ?? []) as string[],
      titleKeywords: (c.titleKeywords ?? []) as string[],
    };
  }
  merged.stepTimeoutMinutes = {
    ...base.stepTimeoutMinutes,
    ...(isRecord(raw.stepTimeoutMinutes) ? raw.stepTimeoutMinutes : {}),
  } as PipelineConfig["stepTimeoutMinutes"];

  const profiles = { ...base.profiles };
  // COMPAT: configs written before profiles existed had a top-level "rounds" for the standard run.
  if (isRecord(raw.rounds)) {
    profiles.standard = { ...profiles.standard, rounds: { ...profiles.standard.rounds, ...raw.rounds } };
  }
  if (isRecord(raw.profiles)) {
    for (const name of PROFILE_NAMES) {
      const override = raw.profiles[name];
      if (!isRecord(override)) continue;
      profiles[name] = {
        ...profiles[name],
        ...(override as Partial<ProfileSettings>),
        rounds: { ...profiles[name].rounds, ...(isRecord(override.rounds) ? override.rounds : {}) },
      };
    }
  }
  merged.profiles = profiles;
  merged.retry = { ...base.retry, ...(isRecord(raw.retry) ? (raw.retry as Partial<PipelineConfig["retry"]>) : {}) };
  merged.reviewPanel = { ...base.reviewPanel, ...(isRecord(raw.reviewPanel) ? (raw.reviewPanel as Partial<ReviewPanelSettings>) : {}) };
  merged.designProposals = {
    ...base.designProposals,
    ...(isRecord(raw.designProposals) ? (raw.designProposals as Partial<PipelineConfig["designProposals"]>) : {}),
  };
  const rawPhases = isRecord(raw.phases) ? raw.phases : {};
  const rawVerify = isRecord(rawPhases.verify) ? rawPhases.verify : {};
  merged.phases = {
    ...base.phases,
    ...(rawPhases as Partial<PhaseSettings>),
    verify: {
      ...base.phases.verify,
      ...(rawVerify as Partial<VerifyPhaseSettings>),
      agents: { ...base.phases.verify.agents, ...(isRecord(rawVerify.agents) ? rawVerify.agents : {}) },
    },
  };
  merged.qualityGate = { ...base.qualityGate, ...(isRecord(raw.qualityGate) ? (raw.qualityGate as Partial<QualityGateSettings>) : {}) };
  merged.slices = { ...base.slices, ...(isRecord(raw.slices) ? (raw.slices as Partial<PipelineConfig["slices"]>) : {}) };
  merged.designApproval = {
    ...base.designApproval,
    ...(isRecord(raw.designApproval) ? (raw.designApproval as Partial<PipelineConfig["designApproval"]>) : {}),
  };
  merged.reviewAxes = { ...base.reviewAxes, ...(isRecord(raw.reviewAxes) ? (raw.reviewAxes as Partial<PipelineConfig["reviewAxes"]>) : {}) };
  delete (merged as unknown as Record<string, unknown>).rounds;
  return merged;
}

function validateProvider(label: string, profile: unknown): void {
  if (isRecord(profile) && profile.paseoProfile !== undefined) {
    if (typeof profile.paseoProfile !== "string" || profile.paseoProfile.trim() === "") {
      throw new ConfigError(`${label}.paseoProfile 必须是 Paseo 中 agent profile 的名称`);
    }
    if (profile.provider === undefined) return;
  }
  if (!isRecord(profile) || typeof profile.provider !== "string") {
    throw new ConfigError(`${label}.provider 缺失（或用 paseoProfile 写 Paseo 中 agent profile 的名称）`);
  }
  const slash = profile.provider.indexOf("/");
  if (slash <= 0 || slash === profile.provider.length - 1) {
    throw new ConfigError(`${label}.provider 必须是 "provider/model" 格式，当前为 "${profile.provider}"`);
  }
  if (profile.provider.includes("CHANGE-ME")) {
    throw new ConfigError(`${label}.provider 还是示例值，请在终端运行配置向导 req configure（或在 req-kit 安装目录运行 node install.mjs --configure），也可以手工填写真实的 provider/model`);
  }
}

function validatePanel(panel: ReviewPanelSettings): void {
  if (typeof panel.enabled !== "boolean") throw new ConfigError("reviewPanel.enabled 必须是 true 或 false");
  if (!Array.isArray(panel.steps) || !panel.steps.every((s) => s === "design_review" || s === "code_review")) {
    throw new ConfigError('reviewPanel.steps 只能包含 "design_review" 和 "code_review"');
  }
  if (!Array.isArray(panel.profiles) || !panel.profiles.every((p) => PROFILE_NAMES.includes(p))) {
    throw new ConfigError('reviewPanel.profiles 只能包含 "quick" 和 "standard"');
  }
  if (!Array.isArray(panel.members)) throw new ConfigError("reviewPanel.members 必须是数组");
  if (panel.enabled && panel.members.length === 0) {
    throw new ConfigError("开启了 reviewPanel，但 reviewPanel.members 为空。请至少配置一位成员（建议 2–3 位，使用不同的模型）");
  }
  panel.members.forEach((member, i) => validateProvider(`reviewPanel.members[${i}]`, member));
}

function validatePhases(phases: PhaseSettings): void {
  if (!PHASE_MODES.includes(phases.mode)) throw new ConfigError(`phases.mode 只能是 ${PHASE_MODES.map((m) => `"${m}"`).join("、")}`);
  const v = phases.verify;
  if (v.environment !== "local" && v.environment !== "deployed") throw new ConfigError('phases.verify.environment 只能是 "local" 或 "deployed"');
  if (!["fix", "handback", "report"].includes(v.defects)) throw new ConfigError('phases.verify.defects 只能是 "fix"、"handback" 或 "report"');
  if (v.serviceStart !== null && typeof v.serviceStart !== "boolean") throw new ConfigError("phases.verify.serviceStart 必须是 true、false 或 null");
  if (!isRecord(v.agents)) throw new ConfigError("phases.verify.agents 必须是对象，例如 { \"reviewer\": { \"paseoProfile\": \"测试\" } }");
  for (const [role, profile] of Object.entries(v.agents)) {
    if (role !== "builder" && role !== "reviewer") throw new ConfigError("phases.verify.agents 只能包含 builder 和 reviewer");
    validateProvider(`phases.verify.agents.${role}`, profile);
  }
}

function validateChecks(config: PipelineConfig): void {
  if (!Array.isArray(config.requirementTypes) || !config.requirementTypes.every((t) => REQUIREMENT_TYPES.includes(t))) {
    throw new ConfigError(`requirementTypes 只能包含 ${REQUIREMENT_TYPES.map((t) => `"${t}"`).join("、")}`);
  }
  if (!Array.isArray(config.checks)) throw new ConfigError('checks 必须是数组，例如 [{ "name": "test", "command": "npm test" }]');
  const names = new Set<string>();
  config.checks.forEach((c, i) => {
    if (!isRecord(c) || typeof c.name !== "string" || c.name.trim() === "") throw new ConfigError(`checks[${i}].name 必须是非空字符串`);
    if (names.has(c.name)) throw new ConfigError(`checks 中有两个检查都叫 "${c.name}"，名称不能重复`);
    names.add(c.name);
    if (typeof c.command !== "string" || c.command.trim() === "") throw new ConfigError(`checks[${i}].command 必须是要运行的命令`);
    if (c.cwd !== undefined && (typeof c.cwd !== "string" || path.isAbsolute(c.cwd) || c.cwd.split(/[\\/]/).includes(".."))) {
      throw new ConfigError(`checks[${i}].cwd 必须是仓库之内的相对路径`);
    }
    if (c.paths !== undefined && (!Array.isArray(c.paths) || !c.paths.every((p) => typeof p === "string" && p.trim() !== ""))) {
      throw new ConfigError(`checks[${i}].paths 必须是路径数组，例如 ["web/"]`);
    }
    if (c.timeoutMinutes !== undefined && (typeof c.timeoutMinutes !== "number" || c.timeoutMinutes <= 0)) {
      throw new ConfigError(`checks[${i}].timeoutMinutes 必须是正数`);
    }
  });
  const gate = config.qualityGate;
  if (!Number.isInteger(gate.fixAttempts) || gate.fixAttempts < 0) throw new ConfigError("qualityGate.fixAttempts 必须是不小于 0 的整数");
  if (typeof gate.timeoutMinutes !== "number" || gate.timeoutMinutes <= 0) throw new ConfigError("qualityGate.timeoutMinutes 必须是正数");
  if (!Array.isArray(config.slices.profiles) || !config.slices.profiles.every((p) => PROFILE_NAMES.includes(p))) {
    throw new ConfigError('slices.profiles 只能包含 "quick" 和 "standard"（空数组表示不按切片实现）');
  }
  if (!Number.isInteger(config.slices.max) || config.slices.max < 1) throw new ConfigError("slices.max 必须是不小于 1 的整数");
  const approval = config.designApproval;
  if (!["off", "ui", "always"].includes(approval.mode)) throw new ConfigError('designApproval.mode 只能是 "off"、"ui" 或 "always"');
  if (!Array.isArray(approval.profiles) || !approval.profiles.every((p) => PROFILE_NAMES.includes(p))) {
    throw new ConfigError('designApproval.profiles 只能包含 "quick" 和 "standard"');
  }
  if (typeof approval.autoContinueHours !== "number" || approval.autoContinueHours < 0) {
    throw new ConfigError("designApproval.autoContinueHours 必须是不小于 0 的数（0 表示一直等待确认）");
  }
  if (typeof config.reviewAxes.enabled !== "boolean") throw new ConfigError("reviewAxes.enabled 必须是 true 或 false");
  if (!Array.isArray(config.reviewAxes.profiles) || !config.reviewAxes.profiles.every((p) => PROFILE_NAMES.includes(p))) {
    throw new ConfigError('reviewAxes.profiles 只能包含 "quick" 和 "standard"');
  }
  if (!Array.isArray(config.relatedRepos)) throw new ConfigError('relatedRepos 必须是数组，例如 [{ "name": "后端", "path": "../backend" }]');
  config.relatedRepos.forEach((r, i) => {
    if (!isRecord(r) || typeof r.name !== "string" || r.name.trim() === "") throw new ConfigError(`relatedRepos[${i}].name 必须是非空字符串`);
    if (typeof r.path !== "string" || r.path.trim() === "") throw new ConfigError(`relatedRepos[${i}].path 必须是这台机器上的目录`);
    if (r.role !== undefined && typeof r.role !== "string") throw new ConfigError(`relatedRepos[${i}].role 必须是字符串`);
  });
}

/** Where a related repository is on this machine; relative paths start from the project's checkout. */
export function resolveRelatedRepo(repo: RelatedRepo, projectDir: string): string {
  if (repo.path.startsWith("~/") || repo.path.startsWith("~\\")) return path.join(os.homedir(), repo.path.slice(2));
  return path.resolve(projectDir, repo.path);
}

function validate(config: PipelineConfig): void {
  for (const role of ["builder", "reviewer"] as const) validateProvider(`agents.${role}`, config.agents[role]);
  if (config.agents.fallback !== undefined && config.agents.fallback !== null) validateProvider("agents.fallback", config.agents.fallback);
  if (typeof config.selfHeal !== "boolean") throw new ConfigError("selfHeal 必须是 true 或 false");
  if (typeof config.answerQuestionsFirst !== "boolean") throw new ConfigError("answerQuestionsFirst 必须是 true 或 false");
  if (!PROFILE_NAMES.includes(config.defaultProfile)) {
    throw new ConfigError(`defaultProfile 必须是 ${PROFILE_NAMES.join(" 或 ")}`);
  }
  for (const name of PROFILE_NAMES) {
    for (const [key, value] of Object.entries(config.profiles[name].rounds)) {
      if (!Number.isInteger(value) || value < 1) {
        throw new ConfigError(`profiles.${name}.rounds.${key} 必须是不小于 1 的整数`);
      }
    }
    if (typeof config.profiles[name].serviceStart !== "boolean") {
      throw new ConfigError(`profiles.${name}.serviceStart 必须是 true 或 false`);
    }
  }
  for (const [key, value] of Object.entries(config.stepTimeoutMinutes)) {
    if (typeof value !== "number" || value <= 0) throw new ConfigError(`stepTimeoutMinutes.${key} 必须是正数`);
  }
  validatePanel(config.reviewPanel);
  if (!Number.isInteger(config.retry.attempts) || config.retry.attempts < 0) throw new ConfigError("retry.attempts 必须是不小于 0 的整数");
  if (!Array.isArray(config.retry.backoffSeconds) || config.retry.backoffSeconds.length === 0 || !config.retry.backoffSeconds.every((n) => typeof n === "number" && n >= 0)) {
    throw new ConfigError("retry.backoffSeconds 必须是非空的秒数数组，例如 [60, 300]");
  }
  if (!Array.isArray(config.notifiers)) throw new ConfigError("notifiers 必须是数组");
  config.notifiers.forEach((n, i) => {
    if (!isRecord(n) || typeof n.module !== "string" || n.module.trim() === "") {
      throw new ConfigError(`notifiers[${i}].module 必须是通知模块文件的路径`);
    }
    if (n.events !== undefined && (!Array.isArray(n.events) || !n.events.every((e) => NOTIFIER_EVENT_TYPES.includes(e)))) {
      throw new ConfigError(`notifiers[${i}].events 只能包含 ${NOTIFIER_EVENT_TYPES.join("、")}`);
    }
  });
  const integrationProblem = validateIntegrations(config.integrations);
  if (integrationProblem) throw new ConfigError(integrationProblem);
  if (!isRecord(config.integrationDefaults) || !Object.values(config.integrationDefaults).every((m) => isRecord(m) && Object.values(m).every((v) => typeof v === "string"))) {
    throw new ConfigError('integrationDefaults 必须是 { "<集成名称>": { "<字段>": "<值>" } }');
  }
  const push = config.push;
  if (typeof push.enabled !== "boolean") throw new ConfigError("push.enabled 必须是 true 或 false");
  if (typeof push.remote !== "string" || !/^[\w.-]+$/.test(push.remote)) throw new ConfigError('push.remote 必须是远程仓库名，例如 "origin"');
  if (typeof push.branchPrefix !== "string" || !/^[A-Za-z0-9._-]+\/$/.test(push.branchPrefix)) throw new ConfigError('push.branchPrefix 必须是以 / 结尾的分支前缀，例如 "req/"');
  const mr = push.mergeRequest;
  if (mr !== undefined && mr !== null) {
    if (!isRecord(mr) || typeof mr.command !== "string" || !mr.command.trim() || !Array.isArray(mr.args) || !mr.args.every((a) => typeof a === "string")) {
      throw new ConfigError('push.mergeRequest 必须写成 { "command": "glab", "args": ["mr", "create", "--draft", …] }，参数中可以用 {branch} {target} {title} {description}');
    }
    if (!mr.args.some((a) => a.includes("{branch}"))) throw new ConfigError("push.mergeRequest.args 中要有 {branch}（推送的分支）");
  }
  if (!isRecord(config.people) || !Object.values(config.people).every((v) => isRecord(v) && Object.values(v).every((x) => typeof x === "string"))) {
    throw new ConfigError('people 必须写成 { "<姓名>": { "<账号类型>": "<账号>" } }，例如 { "张广祥": { "um": "ZHANGGX001" } }');
  }
  if (typeof config.autoConfirm.hours !== "number" || config.autoConfirm.hours < 0) throw new ConfigError("autoConfirm.hours 必须是不小于 0 的小时数（0 表示关闭）");
  if (config.budget.tokens !== null && (typeof config.budget.tokens !== "number" || !Number.isFinite(config.budget.tokens) || config.budget.tokens <= 0)) {
    throw new ConfigError("budget.tokens 必须是正数（每个需求最多用多少 tokens，例如 3000000），或 null 表示不限");
  }
  if (typeof config.budget.warnPercent !== "number" || config.budget.warnPercent <= 0 || config.budget.warnPercent >= 100) {
    throw new ConfigError("budget.warnPercent 必须在 1 到 99 之间（用到预算的百分之几时提醒）");
  }
  const f = config.factory;
  if (typeof f.pollMinutes !== "number" || !(f.pollMinutes >= 1)) throw new ConfigError("factory.pollMinutes 必须是至少 1 的分钟数");
  if (!Number.isInteger(f.maxNewPerPoll) || f.maxNewPerPoll < 1) throw new ConfigError("factory.maxNewPerPoll 必须是正整数");
  if (!Array.isArray(f.titleTags) || f.titleTags.length === 0 || !f.titleTags.every((t) => typeof t === "string" && t.trim())) throw new ConfigError('factory.titleTags 必须是非空的字符串数组，例如 ["[AI]"]');
  const cs = config.cardSource;
  if (cs !== null) {
    if (typeof cs.system !== "string" || !cs.system.trim()) throw new ConfigError('cardSource.system 必须是对接系统的名称，例如 "ALM"');
    for (const k of ["subsystems", "titleKeywords"] as const) {
      if (!Array.isArray(cs[k]) || !cs[k].every((v) => typeof v === "string" && v.trim())) throw new ConfigError(`cardSource.${k} 必须是字符串数组`);
    }
  }
  if (config.requiredVersion !== null && typeof config.requiredVersion !== "string") {
    throw new ConfigError('requiredVersion 必须是版本范围字符串，例如 ">=1.2.0 <2"');
  }
  if (config.paseoServices !== "auto" && config.paseoServices !== "off") throw new ConfigError('paseoServices 只能是 "auto" 或 "off"');
  if (config.browserVerify !== "auto" && config.browserVerify !== "off") throw new ConfigError('browserVerify 只能是 "auto" 或 "off"');
  if (!["standard", "always", "off"].includes(config.specReview)) throw new ConfigError('specReview 只能是 "standard"、"always" 或 "off"');
  const proposals = config.designProposals;
  if (typeof proposals.enabled !== "boolean") throw new ConfigError("designProposals.enabled 必须是 true 或 false");
  if (!Array.isArray(proposals.profiles) || !proposals.profiles.every((p) => PROFILE_NAMES.includes(p))) {
    throw new ConfigError('designProposals.profiles 只能包含 "quick" 和 "standard"');
  }
  if (!Array.isArray(proposals.members)) throw new ConfigError("designProposals.members 必须是数组");
  proposals.members.forEach((member, i) => validateProvider(`designProposals.members[${i}]`, member));
  if (typeof config.quotaWarnPercent !== "number" || config.quotaWarnPercent < 0 || config.quotaWarnPercent > 100) {
    throw new ConfigError("quotaWarnPercent 必须是 0 到 100 之间的数（0 表示不提醒）");
  }
  for (const key of ["maxConcurrentPipelines", "waitingReminderHours", "autoResumeMinutes", "autoResumeMax", "watchdogMinutes"] as const) {
    if (typeof config[key] !== "number" || config[key] < 0) throw new ConfigError(`${key} 必须是不小于 0 的数（0 表示关闭）`);
  }
  validatePhases(config.phases);
  validateChecks(config);
  for (const key of ["waitChunkSeconds", "permissionPollSeconds", "serviceReadySeconds", "queuePollSeconds"] as const) {
    if (typeof config[key] !== "number" || config[key] <= 0) throw new ConfigError(`${key} 必须是正数`);
  }
}

export interface LoadedConfig {
  config: PipelineConfig;
  /** Files that contributed, in the order they were applied. */
  sources: string[];
  /** Settings a team or project file tried to set but may not, e.g. "项目配置中的 daemonUrl". */
  ignored: string[];
}

/** Keys a project file may not set: they run code or reach outside the repository. */
export const NOT_IN_PROJECT_KEYS = ["notifiers", "integrations", "push", "factory", "people"] as const;

/** Notifier module paths are relative to the file that names them; "~/" is the home directory. */
function resolveNotifiers(raw: Record<string, unknown>, file: string): Record<string, unknown> {
  if (!Array.isArray(raw.notifiers)) return raw;
  raw.notifiers = raw.notifiers.map((n: unknown) => {
    if (!isRecord(n) || typeof n.module !== "string") return n;
    const module = n.module.startsWith("~/") || n.module.startsWith("~\\")
      ? path.join(os.homedir(), n.module.slice(2))
      : path.resolve(path.dirname(file), n.module);
    return { ...n, module };
  });
  return raw;
}

/** Removes machine-only keys from a shared (team or project) file, recording them. */
function stripMachineKeys(
  raw: Record<string, unknown>,
  label: string,
  ignored: string[],
  extra: readonly string[] = [],
): Record<string, unknown> {
  for (const key of [...MACHINE_ONLY_KEYS, ...extra]) {
    if (key in raw) {
      ignored.push(`${label}中的 ${key}`);
      delete raw[key];
    }
  }
  return raw;
}

/**
 * Layers, later wins: machine file (~/.req-kit/config.json by default) → team file named by
 * the machine file's teamConfig → the project's own file at the repository root when `repo`
 * is given. Machine-only keys (daemon address and password, teamConfig) are honoured only
 * in the machine file.
 */
export function loadConfig(configPath: string, repo?: string): LoadedConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      `找不到配置文件 ${configPath}。请在 req-kit 的安装目录运行 node install.mjs，它会生成这个文件；然后填写两个 agent 的 provider/model。`,
    );
  }
  let config = merge(DEFAULT_CONFIG, resolveNotifiers(readJson(configPath, "配置文件"), configPath));
  const sources = [configPath];
  const ignored: string[] = [];

  if (config.teamConfig) {
    const teamFile = path.resolve(path.dirname(configPath), config.teamConfig);
    if (!fs.existsSync(teamFile)) {
      throw new ConfigError(`找不到本机配置中 teamConfig 指向的团队配置文件：${teamFile}`);
    }
    config = merge(config, resolveNotifiers(stripMachineKeys(readJson(teamFile, "团队配置文件"), "团队配置", ignored), teamFile));
    sources.push(teamFile);
  }

  if (repo) {
    const projectFile = path.join(repo, PROJECT_CONFIG_FILE);
    if (fs.existsSync(projectFile)) {
      config = merge(config, stripMachineKeys(readJson(projectFile, "项目配置文件"), "项目配置", ignored, NOT_IN_PROJECT_KEYS));
      sources.push(projectFile);
    }
  }
  validate(config);
  return { config, sources, ignored };
}

