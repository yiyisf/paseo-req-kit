import fs from "node:fs";
import path from "node:path";
import type { StepId } from "./steps.js";

export interface AgentProfile {
  /**
   * "provider/model", split at the first "/". Examples: "claude/claude-sonnet-5",
   * "pi/anthropic/claude-sonnet-5" (Pi model IDs carry their own "upstream/model").
   * Run `npm run smoke -- check` to list what your daemon offers.
   */
  provider: string;
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

export type ProfileName = "quick" | "standard";

export const PROFILE_NAMES: readonly ProfileName[] = ["quick", "standard"];

export const PROFILE_LABELS: Record<ProfileName, string> = { quick: "快速", standard: "标准" };

export interface ProfileSettings {
  /** Maximum number of rounds for each review/fix loop. */
  rounds: { designReview: number; codeReview: number; defectFix: number };
  /** Run the service start check when the design says the project has a long-running service. */
  serviceStart: boolean;
}

export interface PipelineConfig {
  daemonUrl: string;
  /** Name of the environment variable holding the daemon password, if the daemon has one. */
  daemonPasswordEnv: string;
  agents: Record<"builder" | "reviewer", AgentProfile>;
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
  },
  notifyMilestones: true,
  waitChunkSeconds: 600,
  permissionPollSeconds: 30,
  resultFollowUps: 2,
  attachToOriginChat: true,
  archiveStepAgents: false,
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
  delete (merged as unknown as Record<string, unknown>).rounds;
  return merged;
}

function validate(config: PipelineConfig): void {
  for (const role of ["builder", "reviewer"] as const) {
    const profile = config.agents[role];
    if (!isRecord(profile) || typeof profile.provider !== "string") {
      throw new ConfigError(`agents.${role}.provider 缺失`);
    }
    const slash = profile.provider.indexOf("/");
    if (slash <= 0 || slash === profile.provider.length - 1) {
      throw new ConfigError(`agents.${role}.provider 必须是 "provider/model" 格式，当前为 "${profile.provider}"`);
    }
    if (profile.provider.includes("CHANGE-ME")) {
      throw new ConfigError(`agents.${role}.provider 还是示例值，请填写真实的 provider/model（npm run smoke -- check 会列出可用的值）`);
    }
  }
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
  for (const key of ["waitChunkSeconds", "permissionPollSeconds"] as const) {
    if (typeof config[key] !== "number" || config[key] <= 0) throw new ConfigError(`${key} 必须是正数`);
  }
}

export interface LoadedConfig {
  config: PipelineConfig;
  /** Files that contributed, in the order they were applied. */
  sources: string[];
  /** Keys a project file tried to set but may not. */
  ignored: string[];
}

/**
 * Machine-wide file (~/.req-kit/config.json by default), then the project's own file at the
 * repository root when `repo` is given. Later files win.
 */
export function loadConfig(configPath: string, repo?: string): LoadedConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      `找不到配置文件 ${configPath}。请在 req-kit 的安装目录运行 node install.mjs，它会生成这个文件；然后填写两个 agent 的 provider/model。`,
    );
  }
  let config = merge(DEFAULT_CONFIG, readJson(configPath, "配置文件"));
  const sources = [configPath];
  const ignored: string[] = [];

  if (repo) {
    const projectFile = path.join(repo, PROJECT_CONFIG_FILE);
    if (fs.existsSync(projectFile)) {
      const raw = readJson(projectFile, "项目配置文件");
      for (const key of MACHINE_ONLY_KEYS) {
        if (key in raw) {
          ignored.push(key);
          delete raw[key];
        }
      }
      config = merge(config, raw);
      sources.push(projectFile);
    }
  }
  validate(config);
  return { config, sources, ignored };
}

