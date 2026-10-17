// What the plugin's app side asks its daemon side. The daemon side answers by running
// `req api …` (contracts/cli-json.md in req-kit); these types mirror that format.
import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export type Attention = "approval" | "business" | "interrupted" | "not_completed" | null;

export interface Usage {
  steps: number;
  agentMinutes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface Requirement {
  key: string;
  project: string;
  repo: string;
  sourceRepo: string | null;
  workspaceId: string | null;
  featureDir: string;
  name: string;
  title: string;
  type: string | null;
  profile: string | null;
  branch: string | null;
  stage: string;
  status: string | null;
  running: boolean;
  phase: string | null;
  attention: Attention;
  current: Array<{ key: string; title: string; agentId: string }>;
  updatedAt: string;
  usage: Usage | null;
  present: boolean;
}

export interface Step {
  key: string;
  stepId: string;
  title: string;
  phase: string | null;
  attempt: number;
  round: number | null;
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  outcome: "running" | "completed" | "failed";
  result: string | null;
  error: string | null;
}

export interface GateRun {
  key: string;
  attempt: number;
  at: string;
  checks: Array<{ name: string; result: string; failedBefore: boolean }>;
  newFailures: string[];
  fixRounds: number;
  passed: boolean;
}

export interface RequirementDetail extends Requirement {
  files: string[];
  run: {
    attempt: number;
    startedAt: string;
    updatedAt: string;
    phaseMode: string | null;
    stopReason: string | null;
    outcome: string | null;
    queuedSince: string | null;
    verifyAt: string | null;
    approval: { attempt: number; status: string; at: string } | null;
    originAgentId: string | null;
  } | null;
  steps: Step[];
  gate: { runs: GateRun[] } | null;
  joint: Array<{ name: string; repo: string; branch: string; workspaceId: string; gate: { runs: GateRun[] } | null }>;
  /** Cards in external systems (req-kit 1.9.0+; absent before). */
  external?: Array<{ name: string; id: string | null; url: string | null; status: string | null; syncedAt: string | null; pending: number; lastError: string | null }>;
}

export interface StatsSummary {
  period: { label: string };
  machines: string[];
  active: number;
  completed: { total: number; byOutcome: Record<string, number> };
  byType: Record<string, number>;
  cycleHours: { median: number | null; average: number | null };
  steps: Array<{ stepId: string; title: string; count: number; averageMinutes: number; totalMinutes: number }>;
  rework: { averageReviewRounds: number | null; withDefectRounds: number | null; gateRuns: number; gateFailed: number };
  waits: Array<{ kind: string; label: string; requirements: number; averageMinutes: number }>;
  usage: { agentMinutes: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}

export interface KitInfo {
  kitVersion: string;
  kitRoot: string;
  apiSchema: number;
  paseo: string | null;
  /** Where the daemon side found req-kit (the kit home it read active.json from). */
  kitHome: string;
}

/** Where a requirement is: as `req api` names it. */
const target = z.object({ repo: z.string().min(1), featureDir: z.string().min(1) });

export const versionRpc = defineRpc({
  name: "req.version",
  input: z.object({}),
  output: z.custom<KitInfo>(),
});

export const listRpc = defineRpc({
  name: "req.list",
  input: z.object({}),
  output: z.custom<Requirement[]>(),
});

export const statusRpc = defineRpc({
  name: "req.status",
  input: target,
  output: z.custom<RequirementDetail>(),
});

/** Documents the plugin shows; req api only allows its own list (READABLE_FILES). */
export const fileRpc = defineRpc({
  name: "req.file",
  input: target.extend({ file: z.string().min(1) }),
  output: z.custom<{ file: string; size: number; truncated: boolean; content: string }>(),
});

export const statsRpc = defineRpc({
  name: "req.stats",
  input: z.object({ since: z.string().optional(), month: z.string().optional() }),
  output: z.custom<StatsSummary>(),
});

export const ACTIONS = ["approve", "stop", "resume", "verify", "sync"] as const;
export type Action = (typeof ACTIONS)[number];

export const runRpc = defineRpc({
  name: "req.run",
  input: target.extend({
    action: z.enum(ACTIONS),
    /** For verify: local | deployed. */
    verifyEnv: z.enum(["local", "deployed"]).optional(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Agent settings, as req-kit writes them (1.12). */
export interface AgentProfileData {
  provider?: string;
  paseoProfile?: string;
  modeId?: string;
  [key: string]: unknown;
}

export interface AgentChoiceData {
  id: string;
  label: string;
  provider: string;
  profile: AgentProfileData;
}

export interface ModelsData {
  current: { builder?: AgentProfileData; reviewer?: AgentProfileData; fallback?: AgentProfileData | null } | null;
  choices: AgentChoiceData[];
  recommended: { builder?: AgentProfileData; reviewer?: AgentProfileData; fallback?: AgentProfileData | null } | null;
}

/** What Paseo offers for builder, reviewer and the fallback model, and what is set now. */
export const modelsRpc = defineRpc({
  name: "req.models",
  input: z.object({}),
  output: z.custom<ModelsData>(),
});

const profile = z.record(z.string(), z.unknown());

/** Writes the agents to this machine's req-kit config (refused when the plugin is read-only). */
export const setAgentsRpc = defineRpc({
  name: "req.setAgents",
  input: z.object({ builder: profile, reviewer: profile, fallback: profile.nullable() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Show requirements and documents only; hide stop, resume, approve and verify. */
    readOnly: z.boolean().default(false),
    /** How often an open screen refreshes, in seconds. */
    refreshSeconds: z.number().int().min(3).max(300).default(10),
    /** req-kit's machine directory when it is not ~/.req-kit (REQ_KIT_HOME). */
    kitHome: z.string().default(""),
  }),
});
