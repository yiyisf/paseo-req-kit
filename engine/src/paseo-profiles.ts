// Paseo agent profiles: named launch bundles (provider, model, mode, thinking level,
// features) that people set up once in Paseo's settings. req-kit roles and review
// panel members can name one instead of spelling the settings out:
//
//   "builder": { "paseoProfile": "实现" }
//   "reviewer": { "paseoProfile": "评审", "thinkingOptionId": "high" }   // own fields win
//
// The names are resolved against the daemon when a run starts, so changing the
// profile in Paseo changes the next run without touching req-kit's config.

import type { AgentProfile, PipelineConfig } from "./config.js";

/** The fields of Paseo's AgentProfile that req-kit uses (protocol/src/agent-profile.ts). */
export interface PaseoProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileResolutionError";
  }
}

export function findPaseoProfile(name: string, available: PaseoProfile[]): PaseoProfile | null {
  const wanted = name.trim();
  return (
    available.find((p) => p.name === wanted) ??
    available.find((p) => p.name.toLowerCase() === wanted.toLowerCase()) ??
    available.find((p) => p.id === wanted) ??
    null
  );
}

/**
 * Turns a role that names a Paseo profile into concrete agent settings. Settings
 * written next to `paseoProfile` override the profile's; feature values are merged.
 * Roles without `paseoProfile` are returned unchanged.
 */
export function resolveAgentProfile(label: string, profile: AgentProfile, available: PaseoProfile[] | null): AgentProfile {
  if (!profile.paseoProfile) return profile;
  if (available === null) {
    throw new ProfileResolutionError(`${label} 使用 Paseo profile「${profile.paseoProfile}」，但无法从 daemon 读取 profile 列表`);
  }
  const found = findPaseoProfile(profile.paseoProfile, available);
  if (!found) {
    const names = available.map((p) => `「${p.name}」`).join("、") || "（还没有任何 profile）";
    throw new ProfileResolutionError(
      `${label} 使用的 Paseo profile「${profile.paseoProfile}」不存在。现有的 profile：${names}。在 Paseo 的 设置 → Agents → Agent profiles 中查看或新建`,
    );
  }
  if (!found.model) {
    throw new ProfileResolutionError(`Paseo profile「${found.name}」没有选择模型，req-kit 需要明确的模型。请在 Paseo 设置中为它选择模型`);
  }
  const resolved: AgentProfile = { ...profile, provider: profile.provider ?? `${found.provider}/${found.model}` };
  const modeId = profile.modeId ?? found.modeId;
  const thinking = profile.thinkingOptionId ?? found.thinkingOptionId;
  const features = found.featureValues || profile.featureValues ? { ...found.featureValues, ...profile.featureValues } : undefined;
  if (modeId) resolved.modeId = modeId;
  if (thinking) resolved.thinkingOptionId = thinking;
  if (features) resolved.featureValues = features;
  return resolved;
}

/** "Paseo profile「实现」→ claude/opus（模式 bypassPermissions）" */
export function describeAgentProfile(profile: AgentProfile): string {
  if (!profile.provider) return `Paseo profile「${profile.paseoProfile}」（运行时从 Paseo 读取设置）`;
  const settings = `${profile.provider}${profile.modeId ? `（模式 ${profile.modeId}）` : ""}`;
  return profile.paseoProfile ? `Paseo profile「${profile.paseoProfile}」→ ${settings}` : settings;
}

/** Reads the daemon's profiles from its config. Null when the daemon does not say. */
export function profilesFromDaemonConfig(config: unknown): PaseoProfile[] | null {
  if (typeof config !== "object" || config === null) return null;
  const list = (config as { agentProfiles?: unknown }).agentProfiles;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  return list.filter(
    (p): p is PaseoProfile =>
      typeof p === "object" && p !== null && typeof (p as PaseoProfile).name === "string" && typeof (p as PaseoProfile).provider === "string",
  );
}

/** Whether any role or panel member names a Paseo profile. */
export function usesPaseoProfiles(config: PipelineConfig): boolean {
  return [
    config.agents.builder,
    config.agents.reviewer,
    ...config.reviewPanel.members,
    ...config.designProposals.members,
    ...Object.values(config.phases.verify.agents),
  ].some((p) =>
    Boolean(p.paseoProfile),
  );
}

/** The config with every Paseo profile name replaced by its settings. Throws ProfileResolutionError. */
export function resolveConfigProfiles(config: PipelineConfig, available: PaseoProfile[] | null): PipelineConfig {
  return {
    ...config,
    agents: {
      builder: resolveAgentProfile("agents.builder", config.agents.builder, available),
      reviewer: resolveAgentProfile("agents.reviewer", config.agents.reviewer, available),
    },
    reviewPanel: {
      ...config.reviewPanel,
      members: config.reviewPanel.members.map((m, i) => ({ ...m, ...resolveAgentProfile(`reviewPanel.members[${i}]`, m, available) })),
    },
    designProposals: {
      ...config.designProposals,
      members: config.designProposals.members.map((m, i) => ({
        ...m,
        ...resolveAgentProfile(`designProposals.members[${i}]`, m, available),
      })),
    },
    phases: {
      ...config.phases,
      verify: {
        ...config.phases.verify,
        agents: Object.fromEntries(
          Object.entries(config.phases.verify.agents).map(([role, p]) => [role, resolveAgentProfile(`phases.verify.agents.${role}`, p, available)]),
        ),
      },
    },
  };
}
