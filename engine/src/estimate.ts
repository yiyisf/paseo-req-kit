// How long a requirement usually takes and how many tokens it uses (1.13), from this machine's
// run records (~/.req-kit/usage/runs.jsonl): the medians of completed requirements of the same
// profile. Shown when a run starts and in the status, so people know roughly what to expect.
import type { RunRecord } from "./records.js";
import { readRuns, runsFile } from "./records.js";
import type { PipelineState } from "./state.js";
import { byRequirement, dedupe } from "./stats.js";

/** Fewer completed requirements than this, and the numbers say little: no estimate. */
export const MIN_BASIS = 3;

export interface Typical {
  profile: string;
  /** How many completed requirements the medians are from. */
  basis: number;
  /** Median of the agents' working time per requirement (sum of step durations). */
  agentMinutes: number;
  /** Median tokens (input + output) per requirement; null when agents did not report usage. */
  tokens: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function typical(profile: string, runs: RunRecord[] | null = null, env: NodeJS.ProcessEnv = process.env): Typical | null {
  let records = runs;
  if (records === null) {
    try {
      records = readRuns(runsFile(env));
    } catch {
      return null;
    }
  }
  const done = byRequirement(dedupe(records)).filter((q) => q.status === "completed" && q.profile === profile);
  if (done.length < MIN_BASIS) return null;
  const tokens = done.flatMap((q) => (q.inputTokens === null && q.outputTokens === null ? [] : [(q.inputTokens ?? 0) + (q.outputTokens ?? 0)]));
  return {
    profile,
    basis: done.length,
    agentMinutes: median(done.map((q) => q.agentMinutes)) ?? 0,
    tokens: tokens.length >= MIN_BASIS ? median(tokens) : null,
  };
}

export function minutesText(m: number): string {
  const total = Math.max(0, Math.round(m));
  if (total < 60) return `${total} 分钟`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

export function tokenText(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000) / 10} 万` : String(Math.round(n));
}

const PROFILE_NAMES: Record<string, string> = { quick: "快速档", standard: "标准档" };

/** One line for a run that is starting. */
export function typicalLine(t: Typical | null): string | null {
  if (!t) return null;
  return `参考：本机最近 ${t.basis} 个${PROFILE_NAMES[t.profile] ?? t.profile}需求，agent 合计用时中位数约 ${minutesText(t.agentMinutes)}${t.tokens !== null ? `，约 ${tokenText(t.tokens)} tokens` : ""}（不含等人确认的时间）。`;
}

export interface Progress {
  usedAgentMinutes: number;
  usedTokens: number | null;
  /** Minutes left by the median; 0 when already past it. */
  leftMinutes: number;
  over: boolean;
}

export function progressOf(state: Pick<PipelineState, "history">, t: Typical, now = new Date()): Progress {
  let minutes = 0;
  let tokens: number | null = null;
  for (const h of state.history) {
    const end = h.endedAt ? new Date(h.endedAt) : now;
    minutes += Math.max(0, (end.getTime() - new Date(h.startedAt).getTime()) / 60_000);
    if (h.usage && (h.usage.inputTokens !== undefined || h.usage.outputTokens !== undefined)) tokens = (tokens ?? 0) + (h.usage.inputTokens ?? 0) + (h.usage.outputTokens ?? 0);
  }
  return { usedAgentMinutes: minutes, usedTokens: tokens, leftMinutes: Math.max(0, t.agentMinutes - minutes), over: minutes > t.agentMinutes };
}

/** "预计还要…" for a requirement that is not finished; null without enough history. */
export function remainingLine(state: Pick<PipelineState, "history" | "status" | "profile">, t: Typical | null, now = new Date()): string | null {
  if (!t || state.status === "completed") return null;
  const p = progressOf(state, t, now);
  const used = `已用 ${minutesText(p.usedAgentMinutes)}${p.usedTokens !== null ? `、${tokenText(p.usedTokens)} tokens` : ""}`;
  const basis = `本机最近 ${t.basis} 个${PROFILE_NAMES[t.profile] ?? t.profile}需求的中位数 ${minutesText(t.agentMinutes)}${t.tokens !== null ? `、${tokenText(t.tokens)} tokens` : ""}`;
  return p.over ? `预计：已超过通常的用时（${used}；${basis}），复杂的需求会更久。` : `预计还要：约 ${minutesText(Math.max(5, p.leftMinutes))}（${used}；${basis}；不含等人的时间）`;
}
