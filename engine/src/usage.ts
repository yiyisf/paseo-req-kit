// Time and token usage per step, as reported by the agents, and plain-language summaries.

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

interface UsageRecord {
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  usage?: AgentUsage | null;
}

export interface UsageTotals {
  steps: number;
  /** Sum of step durations (steps of a review panel overlap, so this can exceed wall time). */
  agentMinutes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

function add(total: number | null, value: number | undefined): number | null {
  return typeof value === "number" ? (total ?? 0) + value : total;
}

export function totals(records: UsageRecord[], now = new Date()): UsageTotals {
  let agentMinutes = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  for (const r of records) {
    const end = r.endedAt ? new Date(r.endedAt) : now;
    agentMinutes += Math.max(0, (end.getTime() - new Date(r.startedAt).getTime()) / 60_000);
    inputTokens = add(inputTokens, r.usage?.inputTokens);
    outputTokens = add(outputTokens, r.usage?.outputTokens);
    costUsd = add(costUsd, r.usage?.totalCostUsd);
  }
  return { steps: records.length, agentMinutes, inputTokens, outputTokens, costUsd };
}

function tokens(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万` : String(n);
}

function minutes(m: number): string {
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${Math.round(m)} 分钟`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

/** e.g. "6 个步骤，agent 合计用时 2 小时 5 分；输入 120 万 tokens，输出 8.3 万 tokens，约 $4.20" */
export function describeTotals(t: UsageTotals): string {
  const parts = [`${t.steps} 个步骤，agent 合计用时 ${minutes(t.agentMinutes)}`];
  const usage: string[] = [];
  if (t.inputTokens !== null) usage.push(`输入 ${tokens(t.inputTokens)} tokens`);
  if (t.outputTokens !== null) usage.push(`输出 ${tokens(t.outputTokens)} tokens`);
  if (t.costUsd !== null) usage.push(`约 $${t.costUsd.toFixed(2)}`);
  if (usage.length > 0) parts.push(usage.join("，"));
  else parts.push("agent 没有报告 token 用量");
  return parts.join("；");
}
